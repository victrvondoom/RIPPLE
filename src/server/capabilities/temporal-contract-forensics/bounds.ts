/**
 * Evidence-bounded extremes of the contractual measure μ over every timeline consistent with the evidence.
 *
 * Model. Let θ = (δ_c) be the unknown offsets of the clocks with residual uncertainty U_c > 0 (one dimension per
 * clock; records sharing a clock move together, which keeps the relationships between a source's own records).
 * Per-endpoint uncertainty ε is independent. For fixed θ:
 *   Down(θ) = ∪ [sHi + δ, eLo + δ) over Q intervals   (shrinking every Q interval is admissible and minimises)
 *   Up(θ)   = ∪ [sHi + δ, eLo + δ) over N intervals   (likewise for N intervals)
 * θ is FEASIBLE iff Down(θ) ∩ Up(θ) has measure 0, every Q point can sit outside Up(θ) and every N point outside
 * Down(θ). Then (μ is monotone, see qualify.ts)
 *   min μ over consistent timelines = min_{θ feasible} μ(Down(θ) ∩ Q)
 *   max μ over consistent timelines = max_{θ feasible} μ(Q \ Up(θ))
 * Exact over integer-ms θ.
 *
 * Search. Best-first branch and bound over boxes of θ. For a box B, the relaxation lets every record take its
 * worst offset independently: ForcedDown(B) = ∪ [sHi + δhi, eLo + δlo) ⊆ Down(θ) for all θ ∈ B, so μ(ForcedDown(B))
 * is a sound lower bound for the minimum on B (and symmetrically an upper bound for the maximum). A box is
 * pruned when ForcedDown(B) overlaps ForcedUp(B) (infeasible everywhere in B). On a single-point box the
 * relaxation is exact. The reported bound is the incumbent when the search closes (EXACT) or the best open
 * relaxation when the node budget runs out (SOUND_NOT_TIGHT) — never an unproved value.
 * Branching is 'strong': every dimension is tried and the split that tightens the relaxation most is kept.
 * Complexity: O(nodes · k · n log n) for k uncertain clocks; nodes ≤ policy.maxBranchNodes. k = 0 ⇒ one evaluation.
 */
import type { NormRecord } from './evidence.js';
import { covers, normalize, overlaps, subtract, intersect, type Interval, type IntervalSet } from './intervals.js';
import { qualify, type QualificationRules } from './qualify.js';

export interface BoundProblem {
  records: readonly NormRecord[];
  clockU: ReadonlyMap<string, number>;
  q: IntervalSet;
  origin: number;
  rules: QualificationRules;
  budget: number;
}

export interface BoundResult {
  value: number;
  status: 'EXACT' | 'SOUND_NOT_TIGHT';
  /** A consistent timeline was found. */
  feasible: boolean;
  /** The search proved that no consistent timeline exists. */
  provenInfeasible: boolean;
  /** Offsets of a timeline attaining `value` (when EXACT and feasible). */
  witness: Record<string, number> | null;
  nodes: number;
}

type Box = { lo: number[]; hi: number[] };

export interface Prepared {
  dims: string[]; dimIndex: Map<string, number>; u: number[]; qi: NormRecord[]; ni: NormRecord[]; qp: NormRecord[]; np: NormRecord[];
  /** Forbidden relative offsets ρ = δ_A − δ_B (inclusive integer ranges, normalised) per ordered group pair "A|B";
   *  group = dimension index, or "" for every clock without residual uncertainty (δ = 0). */
  forbid: Map<string, [number, number][]>;
  /** A pair of records contradicts under every offset (same group, or both fixed): nothing is feasible. */
  alwaysInfeasible: boolean;
}

/** Sort and merge inclusive integer ranges (adjacent ranges merge). */
function mergeRanges(xs: [number, number][]): [number, number][] {
  const s = xs.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const [a, b] of s) { const l = out[out.length - 1]; if (l && a <= l[1] + 1) l[1] = Math.max(l[1], b); else out.push([a, b]); }
  return out;
}

/** Whether every integer in [lo, hi] is forbidden. */
function rangeCovered(f: [number, number][] | undefined, lo: number, hi: number): boolean {
  if (!f || lo > hi) return false;
  for (const [a, b] of f) { if (a <= lo && lo <= b) return b >= hi; if (a > lo) return false; }
  return false;
}

/** [lo, hi] minus forbidden ranges, reduced to its hull; null when nothing is left. */
function narrow(f: [number, number][], lo: number, hi: number): [number, number] | null {
  let l = lo; for (const [a, b] of f) { if (a <= l && l <= b) l = b + 1; }
  if (l > hi) return null;
  let h = hi; for (const [a, b] of [...f].reverse()) { if (a <= h && h <= b) h = a - 1; }
  return h < l ? null : [l, h];
}

export function prepare(input: readonly NormRecord[], clockU: ReadonlyMap<string, number>): Prepared {
  // Exact dimension elimination: a clock whose ONLY record is one point affects nothing but that point's own
  // position, so its offset range folds into the point's range without loss.
  const perClock = new Map<string, NormRecord[]>();
  for (const r of input) perClock.set(r.clockId, [...(perClock.get(r.clockId) ?? []), r]);
  const records = input.map((r) => {
    const u = clockU.get(r.clockId) ?? 0; const list = perClock.get(r.clockId)!;
    return u > 0 && list.length === 1 && r.kind === 'POINT' ? { ...r, sLo: r.sLo - u, sHi: r.sHi + u, eLo: r.eLo - u, eHi: r.eHi + u, clockId: `${r.clockId}#folded` } : r;
  });
  const used = new Set(records.map((r) => r.clockId));
  const dims = [...used].filter((c) => (clockU.get(c) ?? 0) > 0).sort();
  const dimIndex = new Map(dims.map((d, i) => [d, i]));
  const qi = records.filter((r) => r.polarity === 'Q' && r.kind === 'INTERVAL'); const ni = records.filter((r) => r.polarity === 'N' && r.kind === 'INTERVAL');
  const qp = records.filter((r) => r.polarity === 'Q' && r.kind === 'POINT'); const np = records.filter((r) => r.polarity === 'N' && r.kind === 'POINT');
  // Constraint propagation data. For a Q interval [a1,b1) of group A and an N interval [a2,b2) of group B, they
  // overlap iff ρ = δA − δB ∈ (a2 − b1, b2 − a1). A point [p1,p2] of group A lies wholly inside a component
  // [u1,u2) of the opposite union of group B iff ρ ∈ [u1 − p1, u2 − p2 − 1].
  const g = (r: NormRecord) => (dimIndex.has(r.clockId) ? String(dimIndex.get(r.clockId)) : '');
  const raw = new Map<string, [number, number][]>();
  const add = (k: string, a: number, b: number) => { if (a <= b) raw.set(k, [...(raw.get(k) ?? []), [a, b]]); };
  for (const q of qi) for (const n of ni) { if (q.sHi < q.eLo && n.sHi < n.eLo) add(`${g(q)}|${g(n)}`, n.sHi - q.eLo + 1, n.eLo - q.sHi - 1); }
  const unionOf = (list: NormRecord[]) => { const by = new Map<string, Interval[]>(); for (const r of list) if (r.sHi < r.eLo) by.set(g(r), [...(by.get(g(r)) ?? []), { s: r.sHi, e: r.eLo }]); return [...by].map(([k, xs]) => [k, normalize(xs)] as const); };
  const uN = unionOf(ni); const uQ = unionOf(qi);
  for (const [pts, opp] of [[qp, uN], [np, uQ]] as const) for (const pnt of pts) for (const [k, comps] of opp) for (const c of comps) add(`${g(pnt)}|${k}`, c.s - pnt.sLo, c.e - pnt.sHi - 1);
  const forbid = new Map<string, [number, number][]>();
  let alwaysInfeasible = false;
  for (const [k, xs] of raw) {
    const m = mergeRanges(xs); forbid.set(k, m);
    const [a, b] = k.split('|');
    if ((a === b) && rangeCovered(m, 0, 0)) alwaysInfeasible = true; // same group: ρ is always 0
  }
  return { dims, dimIndex, u: dims.map((d) => clockU.get(d)!), qi, ni, qp, np, forbid, alwaysInfeasible };
}

/**
 * Bounds-consistency propagation of the pairwise offset constraints (difference constraints with holes): for every
 * group pair A|B the admissible ρ = δA − δB is [ρ range of the box] minus the forbidden set, reduced to its hull
 * [rl, rh]; then δA ∈ [loB + rl, hiB + rh] and δB ∈ [loA − rh, hiA − rl]. Iterated to a fixpoint (bounded rounds).
 * The fixed group has δ = 0. Mutates and returns the box, or null when some pair admits no offset at all.
 * Sound: only offsets at which some pair already contradicts are removed.
 */
export function propagate(p: Prepared, b: Box): Box | null {
  if (p.alwaysInfeasible) return null;
  const get = (k: string): [number, number] => (k === '' ? [0, 0] : [b.lo[Number(k)]!, b.hi[Number(k)]!]);
  const set = (k: string, lo: number, hi: number): boolean => {
    if (lo > hi) return false;
    if (k === '') return lo <= 0 && 0 <= hi;
    const i = Number(k); if (lo > b.lo[i]! || hi < b.hi[i]!) { b.lo[i] = Math.max(lo, b.lo[i]!); b.hi[i] = Math.min(hi, b.hi[i]!); changed = true; }
    return b.lo[i]! <= b.hi[i]!;
  };
  let changed = true;
  for (let round = 0; changed && round < 12; round++) {
    changed = false;
    for (const [k, f] of p.forbid) {
      const [a, c] = k.split('|') as [string, string];
      const [alo, ahi] = get(a); const [clo, chi] = get(c);
      const allowed = narrow(f, alo - chi, ahi - clo);
      if (!allowed) return null;
      const [rl, rh] = allowed;
      if (a === c) { if (rl > 0 || rh < 0) return null; continue; }
      if (!set(a, clo + rl, chi + rh)) return null;
      const [alo2, ahi2] = get(a);
      if (!set(c, alo2 - rh, ahi2 - rl)) return null;
    }
  }
  return b;
}

function range(p: Prepared, b: Box, clockId: string): [number, number] {
  const i = p.dimIndex.get(clockId);
  return i === undefined ? [0, 0] : [b.lo[i]!, b.hi[i]!];
}

/** Interval records shrunk by the worst offsets in the box: present for every θ ∈ B. */
export function forcedSet(p: Prepared, list: readonly NormRecord[], b: Box): Interval[] {
  const out: Interval[] = [];
  for (const r of list) { const [lo, hi] = range(p, b, r.clockId); const s = r.sHi + hi; const e = r.eLo + lo; if (s < e) out.push({ s, e }); }
  return normalize(out);
}

/** Points whose every admissible position (over the box) is covered by the opposite forced set ⇒ infeasible. */
function pointsBlocked(p: Prepared, pts: readonly NormRecord[], opposite: IntervalSet, b: Box): boolean {
  for (const r of pts) { const [lo, hi] = range(p, b, r.clockId); if (covers(opposite, r.sLo + lo, r.sHi + hi + 1)) return true; }
  return false;
}

export function boxInfeasible(p: Prepared, b: Box, fd: IntervalSet, fu: IntervalSet): boolean {
  return overlaps(fd, fu) || pointsBlocked(p, p.qp, fu, b) || pointsBlocked(p, p.np, fd, b);
}

export function rootBox(p: Prepared): Box { return { lo: p.u.map((u) => -u), hi: p.u.slice() }; }

class Heap<T> {
  private a: { k: number; w: number; n: number; v: T }[] = []; private c = 0;
  constructor(private readonly less: (x: number, y: number) => boolean) {}
  get size() { return this.a.length; }
  /** Ties on the bound go to the smaller box (w), then insertion order: dives towards a vertex. */
  push(k: number, v: T, w = 0) { this.a.push({ k, w, n: this.c++, v }); let i = this.a.length - 1; while (i > 0) { const pa = (i - 1) >> 1; if (this.lt(i, pa)) { [this.a[i], this.a[pa]] = [this.a[pa]!, this.a[i]!]; i = pa; } else break; } }
  peekKey(): number | undefined { return this.a[0]?.k; }
  pop(): { k: number; v: T } | undefined {
    const top = this.a[0]; const last = this.a.pop(); if (!top) return undefined;
    if (this.a.length && last) { this.a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < this.a.length && this.lt(l, m)) m = l; if (r < this.a.length && this.lt(r, m)) m = r; if (m === i) break; [this.a[i], this.a[m]] = [this.a[m]!, this.a[i]!]; i = m; } }
    return { k: top.k, v: top.v };
  }
  keys(): number[] { return this.a.map((x) => x.k); }
  private lt(i: number, j: number) { const x = this.a[i]!; const y = this.a[j]!; return x.k === y.k ? (x.w === y.w ? x.n < y.n : x.w < y.w) : this.less(x.k, y.k); }
}

function samplePoints(b: Box): number[][] {
  const k = b.lo.length;
  const pts: number[][] = [b.lo.map((l, i) => Math.floor((l + b.hi[i]!) / 2))];
  if (k === 0) return pts;
  if (k <= 3) { for (let m = 0; m < 1 << k; m++) pts.push(b.lo.map((l, i) => (m & (1 << i) ? b.hi[i]! : l))); }
  else { pts.push(b.lo.slice(), b.hi.slice()); }
  const seen = new Set<string>();
  return pts.filter((p) => { const key = p.join(','); if (seen.has(key)) return false; seen.add(key); return true; });
}

// ── Rigid-body bound (plain cumulative measure only) ──────────────────────────────────────────────────────────
// Records of one clock move TOGETHER. Shrinking every interval by the box width ignores that and loses 2·width per
// interval, which can never prove a flat optimum. For μ = plain measure, a sound bound that respects rigidity is
//   |∪_g X_g| ≥ Σ_g min_{δ_g∈box} |X_g(δ_g) ∩ Q| − Σ_{g<h} min(|Poss_g ∩ Poss_h ∩ Q|, |X_g|, |X_h|)   (Bonferroni)
// (best over subsets of groups) where X_g is clock g's (internally normalised) set and Poss_g its sweep over the box. The 1-D minimum is exact:
// |X_g(δ) ∩ Q| is continuous and piecewise linear in δ with breakpoints where an endpoint of X_g + δ meets an
// endpoint of Q, so it is evaluated at those breakpoints and the box ends.

export function isPlainMeasure(r: QualificationRules): boolean {
  return r.metric === 'CUMULATIVE_DOWNTIME' && !r.granularity && r.mergeGapMs === 0 && r.minEpisodeMs === 0 && r.graceMs === 0 && !r.rounding;
}

interface Group { dim: number | null; set: Interval[]; size: number }

function groups(p: Prepared, list: readonly NormRecord[]): Group[] {
  const by = new Map<string, Interval[]>();
  for (const r of list) { const k = p.dimIndex.has(r.clockId) ? r.clockId : ''; if (r.sHi < r.eLo) by.set(k, [...(by.get(k) ?? []), { s: r.sHi, e: r.eLo }]); }
  return [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, xs]) => { const set = normalize(xs); return { dim: k ? p.dimIndex.get(k)! : null, set, size: set.reduce((t, x) => t + x.e - x.s, 0) }; });
}

function minRigid(set: Interval[], lo: number, hi: number, q: IntervalSet): number {
  const cand = new Set<number>([lo, hi]);
  for (const x of set) for (const y of q) for (const d of [y.s - x.s, y.s - x.e, y.e - x.s, y.e - x.e]) if (d > lo && d < hi) cand.add(d);
  let m = Infinity;
  for (const d of cand) { let v = 0; for (const z of intersect(set.map((x) => ({ s: x.s + d, e: x.e + d })), q)) v += z.e - z.s; if (v < m) m = v; }
  return m;
}

/**
 * Lower bound on |∪ X_i| for rigid groups: for EVERY subset S of groups, Bonferroni's inequality
 *   |∪_{i∈S} X_i| ≥ Σ_{i∈S} |X_i| − Σ_{i<j∈S} |X_i ∩ X_j|
 * holds, and |∪ X_i| ≥ |∪_{i∈S} X_i|. |X_i| is replaced by its exact minimum over the box and |X_i ∩ X_j| by an
 * upper bound (the overlap of their sweeps), so every term stays a valid lower bound; the best subset is taken.
 * (Subsets of size 1 give max_i |X_i|; at most 6 groups are combined exhaustively, beyond that pairs only.)
 */
/** max over ρ ∈ [lo, hi] of |(A + ρ) ∩ B|: continuous piecewise linear in ρ, so exact at breakpoints and ends. */
function maxOverlap(a: Interval[], b: Interval[], lo: number, hi: number): number {
  const cand = new Set<number>([lo, hi]);
  for (const x of a) for (const y of b) for (const d of [y.s - x.s, y.s - x.e, y.e - x.s, y.e - x.e]) if (d > lo && d < hi) cand.add(d);
  let m = 0;
  for (const d of cand) { let v = 0; for (const z of intersect(a.map((x) => ({ s: x.s + d, e: x.e + d })), b)) v += z.e - z.s; if (v > m) m = v; }
  return m;
}

function unionLowerBound(gs: Group[], b: Box, q: IntervalSet): number {
  if (!gs.length) return 0;
  const range = (g: Group): [number, number] => (g.dim === null ? [0, 0] : [b.lo[g.dim]!, b.hi[g.dim]!]);
  const mins: number[] = [];
  const poss = gs.map((g) => { const [lo, hi] = range(g); mins.push(minRigid(g.set, lo, hi, q)); return intersect(normalize(g.set.map((x) => ({ s: x.s + lo, e: x.e + hi }))), q); });
  const n = gs.length;
  const ov: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let v = 0; for (const z of intersect(poss[i]!, poss[j]!)) v += z.e - z.s;
    const [li, hi_] = range(gs[i]!); const [lj, hj] = range(gs[j]!);
    ov[i]![j] = ov[j]![i] = Math.min(v, maxOverlap(gs[i]!.set, gs[j]!.set, li - hj, hi_ - lj));
  }
  let best = Math.max(...mins);
  if (n <= 6) {
    for (let m = 1; m < 1 << n; m++) {
      let v = 0; for (let i = 0; i < n; i++) if (m & (1 << i)) { v += mins[i]!; for (let j = i + 1; j < n; j++) if (m & (1 << j)) v -= ov[i]![j]!; }
      if (v > best) best = v;
    }
  } else for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) best = Math.max(best, mins[i]! + mins[j]! - ov[i]![j]!);
  return best;
}

/** sense 'min': minimise μ(Down ∩ Q); 'max': maximise μ(Q \ Up). */
/**
 * `target` (optional): decision-directed early stop. The search ends as soon as the question "is the extreme
 * ≥ target?" is settled — by a feasible incumbent on the far side, or by every open relaxation on the near side.
 * The returned value is then a proven bound (status SOUND_NOT_TIGHT unless it also happens to be tight).
 */
export function extremum(problem: BoundProblem, sense: 'min' | 'max', pre?: Prepared, target?: number): BoundResult {
  const p = pre ?? prepare(problem.records, problem.clockU);
  const { q, origin, rules } = problem;
  const objective = (fd: IntervalSet, fu: IntervalSet) => (sense === 'min' ? qualify(intersect(fd, q), q, origin, rules) : qualify(subtract(q, fu), q, origin, rules));
  const better = (x: number, y: number) => (sense === 'min' ? x < y : x > y);
  const heap = new Heap<Box>(better);
  let best: number | null = null; let witness: Record<string, number> | null = null; let nodes = 0;

  const plain = isPlainMeasure(rules) && p.dims.length > 0;
  const gq = plain ? groups(p, p.qi) : []; const gn = plain ? groups(p, p.ni) : [];
  const qSize = q.reduce((t, x) => t + x.e - x.s, 0);
  const bound = (b: Box): number | null => {
    if (!propagate(p, b)) return null;
    const fd = forcedSet(p, p.qi, b); const fu = forcedSet(p, p.ni, b);
    if (boxInfeasible(p, b, fd, fu)) return null;
    const v = objective(fd, fu);
    if (!plain) return v;
    return sense === 'min' ? Math.max(v, unionLowerBound(gq, b, q)) : Math.min(v, qSize - unionLowerBound(gn, b, q));
  };
  const root = rootBox(p);
  const rb = bound(root);
  if (rb === null) return { value: 0, status: 'EXACT', feasible: false, provenInfeasible: true, witness: null, nodes: 1 };
  heap.push(rb, root);
  let exhausted = false; let open: number | null = null;
  while (heap.size) {
    const k = heap.peekKey()!;
    if (best !== null && !better(k, best)) break; // nothing left can beat the incumbent: optimal
    if (target !== undefined && ((sense === 'min' && ((best !== null && best < target) || k >= target)) || (sense === 'max' && ((best !== null && best >= target) || k < target)))) { exhausted = true; break; }
    if (nodes >= problem.budget) { exhausted = true; break; }
    const { v: b } = heap.pop()!; nodes++;
    // Evaluate exact points of the box: its centre and its vertices (all of them up to 3 dimensions, else the two
    // extreme ones). Piecewise-linear optima sit on vertices of the offset arrangement, so this finds them early.
    for (const pt of samplePoints(b)) {
      const c: Box = { lo: pt, hi: pt };
      const cv = bound(c);
      if (cv !== null && (best === null || better(cv, best))) { best = cv; witness = Object.fromEntries(p.dims.map((d, i) => [d, pt[i]!])); }
    }
    // Strong branching: split the dimension whose halves tighten the relaxation most (ties: the wider one).
    // Splitting the widest dimension alone can explode when the gap comes from a narrow clock.
    let pick: { score: number; width: number; kids: { box: Box; bound: number | null }[] } | null = null;
    for (let i = 0; i < b.lo.length; i++) {
      const width = b.hi[i]! - b.lo[i]!; if (width <= 0) continue;
      const mid = Math.floor((b.lo[i]! + b.hi[i]!) / 2);
      const kids = ([[b.lo[i]!, mid], [mid + 1, b.hi[i]!]] as const).map(([lo, hi]) => { const box: Box = { lo: b.lo.slice(), hi: b.hi.slice() }; box.lo[i] = lo; box.hi[i] = hi; return { box, bound: bound(box) }; });
      const live = kids.map((x) => x.bound).filter((x): x is number => x !== null);
      // Score = the weakest child bound (the one the search would explore next); all children pruned = best.
      const score = !live.length ? (sense === 'min' ? Infinity : -Infinity) : sense === 'min' ? Math.min(...live) : Math.max(...live);
      if (!pick || (sense === 'min' ? score > pick.score : score < pick.score) || (score === pick.score && width > pick.width)) pick = { score, width, kids };
    }
    if (!pick) continue; // single point: evaluated exactly above
    for (const { box, bound: cb } of pick.kids) if (cb !== null && (best === null || better(cb, best))) heap.push(cb, box, box.hi.reduce((t, h, i) => t + h - box.lo[i]!, 0));
  }
  if (exhausted) { const ks = heap.keys(); open = ks.reduce((m, x) => (better(x, m) ? x : m), ks[0]!); }
  if (best === null && !exhausted) return { value: 0, status: 'EXACT', feasible: false, provenInfeasible: true, witness: null, nodes };
  if (best === null) return { value: open!, status: 'SOUND_NOT_TIGHT', feasible: false, provenInfeasible: false, witness: null, nodes };
  if (open !== null && better(open, best)) return { value: open, status: 'SOUND_NOT_TIGHT', feasible: true, provenInfeasible: false, witness: null, nodes };
  return { value: best, status: 'EXACT', feasible: true, provenInfeasible: false, witness, nodes };
}

/** Sets at the full offset box: certain downtime (⊆ every timeline's) and known non-qualifying time. */
export function envelopeSets(records: readonly NormRecord[], clockU: ReadonlyMap<string, number>): { certain: Interval[]; nonQualifying: Interval[]; feasibleAtRelaxation: boolean } {
  const p = prepare(records, clockU); const b = rootBox(p);
  const fd = forcedSet(p, p.qi, b); const fu = forcedSet(p, p.ni, b);
  return { certain: fd, nonQualifying: fu, feasibleAtRelaxation: !boxInfeasible(p, b, fd, fu) };
}
