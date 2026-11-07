/**
 * TCFB oracle: an independent, brute-force implementation of the documented semantics.
 *
 * It shares no code with the engine. It enumerates every clock-offset assignment on the lattice (±1 ms, because
 * closed point ranges can put an optimum 1 ms off a lattice value), checks consistency of each assignment by
 * direct pairwise and point tests, computes downtime with an event sweep and its own episode logic, and applies the
 * documented authority policy by direct enumeration. It is exact when the case has ≤ 2 uncertain clocks and
 * lattice-aligned data (`view.exact`); its cost is exponential in the number of uncertain clocks, which is why the
 * engine needs branch-and-bound and the oracle does not scale.
 */
import { truthMeasure } from './generator.js';
import { LATTICE, RESOLVE_GAP, type OracleRecord, type OracleView } from './lib.js';

export type Cls = 'BREACH_CONFIRMED' | 'BREACH_POSSIBLE' | 'NO_BREACH' | 'INDETERMINATE' | 'NOT_APPLICABLE';
export interface OracleResult { classification: Cls; lo: number | null; hi: number | null; contested: boolean; uncovered: [number, number][]; setAside: string[] }

type Off = Record<string, number>;

const pos = (r: OracleRecord, off: Off): [number, number] => [r.sHi + (off[r.clock] ?? 0), r.eLo + (off[r.clock] ?? 0)]; // shrunk interval
const prange = (r: OracleRecord, off: Off): [number, number] => [r.sLo + (off[r.clock] ?? 0), r.sHi + (off[r.clock] ?? 0)]; // closed point range

function inside(t: number, set: [number, number][]) { return set.some(([s, e]) => s <= t && t < e); }

/** Is the assignment consistent for this set of records? Direct definition, no normalisation. */
function consistent(recs: OracleRecord[], off: Off): boolean {
  const qi = recs.filter((r) => r.kind === 'INTERVAL' && r.polarity === 'Q').map((r) => pos(r, off)).filter(([a, b]) => a < b);
  const ni = recs.filter((r) => r.kind === 'INTERVAL' && r.polarity === 'N').map((r) => pos(r, off)).filter(([a, b]) => a < b);
  for (const [a, b] of qi) for (const [c, d] of ni) if (Math.max(a, c) < Math.min(b, d)) return false;
  for (const r of recs.filter((x) => x.kind === 'POINT')) {
    const opp = r.polarity === 'Q' ? ni : qi; const [p1, p2] = prange(r, off);
    // A free instant exists iff p1 or the end of some opposite interval within [p1, p2] is not covered.
    const probes = [p1, ...opp.map(([, e]) => e).filter((e) => e >= p1 && e <= p2)];
    if (!probes.some((t) => !inside(t, opp))) return false;
  }
  return true;
}

function grid(u: number): number[] {
  const v = new Set<number>();
  for (let d = -u; d <= u; d += LATTICE) for (const e of [-1, 0, 1]) if (d + e >= -u && d + e <= u) v.add(d + e);
  if (!v.size) v.add(0);
  return [...v];
}

function assignments(clocks: string[], U: Record<string, number>): Off[] {
  let out: Off[] = [{}];
  for (const c of clocks) { const g = grid(U[c] ?? 0); out = out.flatMap((o) => g.map((d) => ({ ...o, [c]: d }))); }
  return out;
}

const dimsOf = (recs: OracleRecord[], U: Record<string, number>) => [...new Set(recs.map((r) => r.clock))].filter((c) => (U[c] ?? 0) > 0).sort();

export function runOracle(v: OracleView): OracleResult {
  if (v.expected) return { classification: v.expected, lo: null, hi: null, contested: false, uncovered: [], setAside: [] };
  if (!v.rules) return { classification: 'INDETERMINATE', lo: null, hi: null, contested: false, uncovered: [], setAside: [] };
  let recs = relevantRecords(v);
  if (!recs.length) return { classification: 'INDETERMINATE', lo: null, hi: null, contested: false, uncovered: gapsOf(v, recs), setAside: [] };
  const setAside = new Set<string>(); let contested = false;

  // 1. Pairwise definite contradictions: overlap under EVERY assignment of the two clocks involved.
  const pairs: { q: OracleRecord; n: OracleRecord }[] = [];
  for (const q of recs.filter((r) => r.polarity === 'Q')) for (const n of recs.filter((r) => r.polarity === 'N')) {
    const offs = assignments(dimsOf([q, n], v.clocks), v.clocks);
    if (offs.every((o) => !consistent([q, n], o))) pairs.push({ q, n });
  }
  pairs.sort((a, b) => Math.abs(b.q.rank - b.n.rank) - Math.abs(a.q.rank - a.n.rank) || (a.q.id + a.n.id < b.q.id + b.n.id ? -1 : 1));
  for (const { q, n } of pairs) {
    if (setAside.has(q.id) || setAside.has(n.id)) continue;
    if (Math.abs(q.rank - n.rank) >= RESOLVE_GAP) setAside.add(q.rank < n.rank ? q.id : n.id);
    else { setAside.add(q.id); setAside.add(n.id); contested = true; }
  }
  recs = recs.filter((r) => !setAside.has(r.id));

  // 2. Joint consistency by enumeration; documented authority policy when no assignment is consistent.
  let feasible = assignments(dimsOf(recs, v.clocks), v.clocks).filter((o) => consistent(recs, o));
  if (!feasible.length) {
    // The jointly inconsistent group: records that can contradict a record of another clock for some offsets.
    const group = new Set<string>();
    for (const q of recs.filter((r) => r.polarity === 'Q')) for (const n of recs.filter((r) => r.polarity === 'N')) {
      if (q.clock === n.clock) continue;
      if (assignments(dimsOf([q, n], v.clocks), v.clocks).some((o) => !consistent([q, n], o))) { group.add(q.id); group.add(n.id); }
    }
    const members = group.size ? recs.filter((r) => group.has(r.id)) : recs;
    const top = Math.max(...members.map((r) => r.rank));
    const cands = members.filter((r) => r.rank <= top - RESOLVE_GAP).sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
    const works = (drop: Set<string>) => { const rest = recs.filter((r) => !drop.has(r.id)); return assignments(dimsOf(rest, v.clocks), v.clocks).some((o) => consistent(rest, o)); };
    const singles = cands.filter((c) => works(new Set([c.id])));
    let drop: OracleRecord[];
    if (singles.length) { drop = singles.filter((c) => c.rank === singles[0]!.rank); if (drop.length > 1) contested = true; }
    else if (cands.length && works(new Set(cands.map((c) => c.id)))) drop = cands;
    else { drop = members; contested = true; }
    for (const d of drop) setAside.add(d.id);
    recs = recs.filter((r) => !setAside.has(r.id));
    feasible = assignments(dimsOf(recs, v.clocks), v.clocks).filter((o) => consistent(recs, o));
    if (!feasible.length) return { classification: 'INDETERMINATE', lo: null, hi: null, contested: true, uncovered: [], setAside: [...setAside] };
  }

  // 3. Every exclusion scenario × every consistent assignment.
  const R = v.rules; const bp = R.inclusive ? R.thresholdMs : R.thresholdMs + 1;
  const combos: [number, number][][] = [];
  for (let m = 0; m < 1 << v.possibleExclusions.length; m++) combos.push(cut(v.window, [...v.appliedExclusions, ...v.possibleExclusions.filter((_, i) => m & (1 << i))]));
  let allConf = true; let allNone = true; let lo = Infinity; let hi = -Infinity;
  for (const q of combos) {
    let cmin = Infinity; let cmax = -Infinity;
    for (const o of feasible) {
      const down = recs.filter((r) => r.polarity === 'Q' && r.kind === 'INTERVAL').map((r) => pos(r, o)).filter(([a, b]) => a < b);
      const up = recs.filter((r) => r.polarity === 'N' && r.kind === 'INTERVAL').map((r) => pos(r, o)).filter(([a, b]) => a < b);
      cmin = Math.min(cmin, truthMeasure(down, q, R));
      cmax = Math.max(cmax, truthMeasure(complement(q, up), q, R));
    }
    lo = Math.min(lo, cmin); hi = Math.max(hi, cmax);
    if (cmin < bp) allConf = false;
    if (cmax >= bp) allNone = false;
  }
  let cls: Cls = allConf ? 'BREACH_CONFIRMED' : allNone ? 'NO_BREACH' : 'BREACH_POSSIBLE';
  if (contested && cls === 'BREACH_POSSIBLE') cls = 'INDETERMINATE';
  return { classification: cls, lo, hi, contested, uncovered: gapsOf(v, recs), setAside: [...setAside] };
}

function cut(w: [number, number], xs: [number, number][]): [number, number][] {
  let out: [number, number][] = [w];
  for (const [a, b] of xs) out = out.flatMap(([s, e]) => (b <= s || a >= e ? [[s, e]] : [...(a > s ? [[s, a] as [number, number]] : []), ...(b < e ? [[b, e] as [number, number]] : [])]));
  return out;
}

/** q minus the union of `up`. */
function complement(q: [number, number][], up: [number, number][]): [number, number][] {
  let out = q.slice();
  for (const u of up) out = out.flatMap((x) => cut(x, [u]));
  return out;
}

/** Window time that no record in use can speak for under any offset (expected evidence gaps). */
function gapsOf(v: OracleView, recs: OracleRecord[]): [number, number][] {
  const hulls: [number, number][] = recs.map((r) => { const u = v.clocks[r.clock] ?? 0; return r.kind === 'INTERVAL' ? [r.sLo - u, r.eHi + u] : [r.sLo - u, r.sHi + u + 1]; });
  return cut(v.window, hulls).filter(([a, b]) => a < b);
}

/** The documented relevance rule: overlaps the window, or couples to an uncertain clock that does (fixed point). */
function relevantRecords(v: OracleView): OracleRecord[] {
  const U = (r: OracleRecord) => v.clocks[r.clock] ?? 0;
  const hull = (r: OracleRecord): [number, number] => [r.sLo - U(r), (r.kind === 'INTERVAL' ? r.eHi : r.sHi) + U(r) + 1];
  const keep = new Set(v.records.filter((r) => { const [a, b] = hull(r); return b > v.window[0] && a < v.window[1]; }).map((r) => r.id));
  let grew = true;
  while (grew) {
    grew = false;
    const unc = new Set(v.records.filter((r) => keep.has(r.id) && U(r) > 0).map((r) => r.clock));
    for (const r of v.records) {
      if (keep.has(r.id)) continue;
      const [a, b] = hull(r);
      if (unc.has(r.clock) || v.records.some((x) => keep.has(x.id) && x.polarity !== r.polarity && (unc.has(x.clock) || U(r) > 0) && hull(x)[0] < b && a < hull(x)[1])) { keep.add(r.id); grew = true; }
    }
  }
  return v.records.filter((r) => keep.has(r.id));
}
