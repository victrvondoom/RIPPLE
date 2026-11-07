/**
 * Mathematical invariants, checked on seeded random cases with an INDEPENDENT bitmap model (10-second cells).
 */
import { describe, expect, it } from 'vitest';
import { extremum } from '../../src/server/capabilities/temporal-contract-forensics/bounds.js';
import type { NormRecord } from '../../src/server/capabilities/temporal-contract-forensics/evidence.js';
import { createTemporalContractForensics } from '../../src/server/capabilities/temporal-contract-forensics/index.js';
import { normalize, union, type Interval } from '../../src/server/capabilities/temporal-contract-forensics/intervals.js';
import { qualify, type QualificationRules } from '../../src/server/capabilities/temporal-contract-forensics/qualify.js';
import { at, contract, honest, MIN, rng, W } from './helpers.js';

const tcf = createTemporalContractForensics();
const PLAIN: QualificationRules = { metric: 'CUMULATIVE_DOWNTIME', granularity: null, mergeGapMs: 0, countMergedGaps: false, minEpisodeMs: 0, graceMs: 0, rounding: null };

describe('TCF invariant: the contractual measure μ is monotone under set inclusion', () => {
  it('holds for random sets and random rule combinations (3000 seeded cases)', () => {
    const r = rng(7);
    for (let k = 0; k < 3000; k++) {
      const set = () => normalize(Array.from({ length: r.int(0, 5) }, () => { const s = r.int(0, 900); return { s, e: s + r.int(1, 120) }; }));
      const d1 = set(); const d2 = union(d1, set());
      const q = normalize([{ s: r.int(0, 100), e: r.int(500, 1000) }, ...(r.next() < 0.5 ? [{ s: r.int(600, 800), e: r.int(800, 1200) }] : [])]);
      const rules: QualificationRules = {
        metric: r.pick(['CUMULATIVE_DOWNTIME', 'LONGEST_CONTINUOUS_DOWNTIME'] as const),
        granularity: r.next() < 0.4 ? { bucketMs: r.pick([10, 30, 60]), rule: r.pick(['ANY', 'ENTIRE'] as const) } : null,
        mergeGapMs: r.pick([0, 0, 5, 20]), countMergedGaps: r.next() < 0.5, minEpisodeMs: r.pick([0, 0, 15, 40]), graceMs: r.pick([0, 0, 10]),
        rounding: r.next() < 0.3 ? { unitMs: r.pick([10, 60]), method: r.pick(['FLOOR', 'CEIL', 'NEAREST_HALF_UP'] as const) } : null,
      };
      expect(qualify(d1, q, 0, rules)).toBeLessThanOrEqual(qualify(d2, q, 0, rules));
    }
  });
});

// ── Branch-and-bound vs exhaustive search ──────────────────────────────────────────────────────────────────────
// Independent model: an event sweep (no shared interval code). Data lie on a 10 s lattice; with closed point
// ranges the optimum can sit 1 ms off a lattice offset, so offsets lattice−1, lattice, lattice+1 are enumerated.
const CELL = 10_000;
type Seg = [number, number];
/** Measure of (∪ a) ∩ (∪ q) by sweeping +1/−1 events. */
function sweepMeasure(a: Seg[], q: Seg[]): number {
  const ev: [number, number, number][] = []; // time, Δa, Δq
  for (const [s, e] of a) if (s < e) { ev.push([s, 1, 0], [e, -1, 0]); }
  for (const [s, e] of q) if (s < e) { ev.push([s, 0, 1], [e, 0, -1]); }
  ev.sort((x, y) => x[0] - y[0]);
  let ca = 0; let cq = 0; let last = 0; let m = 0;
  for (const [t, da, dq] of ev) { if (ca > 0 && cq > 0) m += t - last; ca += da; cq += dq; last = t; }
  return m;
}
const covered = (a: Seg[], t: number) => a.some(([s, e]) => s <= t && t < e);
function bruteForce(records: NormRecord[], clockU: Map<string, number>, q: Interval[]) {
  const dims = [...new Set(records.map((r) => r.clockId))].filter((c) => (clockU.get(c) ?? 0) > 0).sort();
  const qs: Seg[] = q.map((x) => [x.s, x.e]);
  let min = Infinity; let max = -Infinity; let feasible = false;
  const assign = (i: number, off: Record<string, number>) => {
    if (i < dims.length) {
      const u = clockU.get(dims[i]!)!; const vals = new Set<number>();
      for (let d = -u; d <= u; d += CELL) for (const e of [-1, 0, 1]) if (d + e >= -u && d + e <= u) vals.add(d + e);
      for (const d of vals) assign(i + 1, { ...off, [dims[i]!]: d });
      return;
    }
    const down: Seg[] = []; const up: Seg[] = [];
    for (const r of records) { const d = off[r.clockId] ?? 0; if (r.kind === 'INTERVAL' && r.sHi < r.eLo) (r.polarity === 'Q' ? down : up).push([r.sHi + d, r.eLo + d]); }
    if (sweepMeasure(down, up) > 0) return;
    for (const r of records) if (r.kind === 'POINT') {
      const d = off[r.clockId] ?? 0; const other = r.polarity === 'Q' ? up : down;
      // a free instant exists iff the range start or some opposite interval end inside the range is uncovered
      const probes = [r.sLo + d, ...other.map(([, e]) => e).filter((e) => e >= r.sLo + d && e <= r.sHi + d)];
      if (!probes.some((t) => !covered(other, t))) return;
    }
    feasible = true;
    min = Math.min(min, sweepMeasure(down, qs));
    max = Math.max(max, sweepMeasure(qs, qs) - sweepMeasure(up, qs));
  };
  assign(0, {});
  return { feasible, min, max };
}

describe('TCF invariant: branch-and-bound equals exhaustive search (correlated clock offsets)', () => {
  it('matches an exhaustive search (lattice ± 1 ms, sweep measure) on 300 seeded cases with up to 2 uncertain clocks', () => {
    const r = rng(11);
    let compared = 0; let infeasible = 0; let exact = 0;
    for (let k = 0; k < 300; k++) {
      const clocks = ['a', 'b', 'c'].slice(0, r.int(1, 3));
      const clockU = new Map(clocks.map((c, i) => [c, i < 2 ? r.int(0, 6) * CELL : 0]));
      const records: NormRecord[] = [];
      for (let i = 0; i < r.int(1, 6); i++) {
        const c = r.pick(clocks); const s = r.int(0, 60) * CELL; const len = r.int(1, 30) * CELL; const js = r.int(0, 2) * CELL; const je = r.int(0, 2) * CELL;
        const point = r.next() < 0.15;
        records.push({ key: `r${i}`, evidenceIds: [`r${i}`], system: c, clockId: c, authority: 'SIGNED_MONITORING', rank: 6, polarity: r.next() < 0.55 ? 'Q' : 'N', kind: point ? 'POINT' : 'INTERVAL', sLo: s - js, sHi: s, eLo: point ? s - js : s + len, eHi: point ? s : s + len + je });
      }
      const q = [{ s: r.int(0, 20) * CELL, e: r.int(50, 100) * CELL }];
      const bf = bruteForce(records, clockU, q);
      const prob = { records, clockU, q, origin: 0, rules: PLAIN, budget: 4_000 };
      const mn = extremum(prob, 'min'); const mx = extremum(prob, 'max');
      expect(mn.feasible).toBe(bf.feasible);
      if (!bf.feasible) { infeasible++; expect(mn.provenInfeasible).toBe(true); continue; }
      // Always sound; exact unless the node budget ran out (then labelled SOUND_NOT_TIGHT).
      expect(mn.value).toBeLessThanOrEqual(bf.min); expect(mx.value).toBeGreaterThanOrEqual(bf.max);
      if (mn.status === 'EXACT') { expect(mn.value).toBe(bf.min); exact++; }
      if (mx.status === 'EXACT') { expect(mx.value).toBe(bf.max); exact++; }
      compared++;
    }
    expect(compared).toBeGreaterThan(150);
    expect(infeasible).toBeGreaterThan(0);
    expect(exact / (2 * compared)).toBeGreaterThan(0.95);
  });
});

// ── Soundness against a hidden truth ────────────────────────────────────────────────────────────────────────────
describe('TCF invariant: soundness against hidden truth (no false confirmed breach)', () => {
  it('bounds always contain the true qualifying downtime, and CONFIRMED/NO_BREACH always agree with the truth (250 seeded cases)', () => {
    const r = rng(2026);
    const counts: Record<string, number> = {};
    for (let k = 0; k < 250; k++) {
      const { truth, clocks, evidence } = honest(r);
      const threshold = r.int(5, 60);
      const win = W(0, 120);
      const res = tcf.analyse({ contract: contract({ breach: { type: 'DOWNTIME_EXCEEDS', thresholdMs: threshold * MIN, inclusive: r.next() < 0.5 } }), evidence, measurementWindow: win, clocks });
      const trueMs = truth.reduce((tt, x) => tt + Math.max(0, Math.min(x.e, 120) - Math.max(x.s, 0)), 0) * MIN;
      const inclusive = (res.classificationRule.length, false);
      void inclusive;
      expect(res.bounds).not.toBeNull();
      expect(res.bounds!.qualifyingDowntimeMs.min).toBeLessThanOrEqual(trueMs);
      expect(res.bounds!.qualifyingDowntimeMs.max).toBeGreaterThanOrEqual(trueMs);
      const bp = res.bounds!.breachPointMs!.min;
      if (res.classification === 'BREACH_CONFIRMED') expect(trueMs).toBeGreaterThanOrEqual(bp);
      if (res.classification === 'NO_BREACH') expect(trueMs).toBeLessThan(bp);
      expect(res.conflicts).toEqual([]); // honest evidence never contradicts itself
      counts[res.classification] = (counts[res.classification] ?? 0) + 1;
    }
    expect(Object.keys(counts).sort()).toEqual(['BREACH_CONFIRMED', 'BREACH_POSSIBLE', 'NO_BREACH']);
  });
  it('adding truthful evidence only narrows the envelope (monotone refinement)', () => {
    const r = rng(99);
    for (let k = 0; k < 80; k++) {
      const { clocks, evidence } = honest(r);
      if (evidence.length < 3) continue;
      const cut = r.int(1, evidence.length - 1);
      const input = { contract: contract(), measurementWindow: W(0, 120), clocks };
      const a = tcf.analyse({ ...input, evidence: evidence.slice(0, cut) });
      const b = tcf.analyse({ ...input, evidence });
      if (!a.bounds || !b.bounds) continue;
      const A = a.bounds.qualifyingDowntimeMs; const B = b.bounds.qualifyingDowntimeMs;
      // Exact bounds narrow monotonically; a not-tight bound is only guaranteed sound, so compare exact ones.
      if (A.minStatus === 'EXACT' && B.minStatus === 'EXACT') expect(B.min).toBeGreaterThanOrEqual(A.min);
      if (A.maxStatus === 'EXACT' && B.maxStatus === 'EXACT') expect(B.max).toBeLessThanOrEqual(A.max);
    }
  });
});

describe('TCF invariant: determinism', () => {
  it('identical inputs give byte-identical results; evidence order does not matter', () => {
    const r = rng(5);
    for (let k = 0; k < 30; k++) {
      const { clocks, evidence } = honest(r);
      const input = { contract: contract(), measurementWindow: W(0, 120), clocks };
      const a = JSON.stringify(tcf.analyse({ ...input, evidence }));
      const b = JSON.stringify(tcf.analyse({ ...input, evidence: [...evidence].reverse() }));
      expect(b).toBe(a);
      expect(JSON.stringify(tcf.analyse({ ...input, evidence }))).toBe(a);
    }
  });
  it('no result field depends on the wall clock', () => {
    const input = { contract: contract(), measurementWindow: W(0, 120), evidence: honest(rng(1)).evidence };
    expect(JSON.stringify(tcf.analyse(input))).not.toContain(new Date().toISOString().slice(0, 13));
    expect(at(0)).toBe('2026-03-10T12:00:00Z');
  });
});
