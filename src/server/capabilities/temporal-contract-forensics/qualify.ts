/**
 * The contractual measure μ: turns a set of (possible or established) qualifying-state time into the
 * contract's qualifying downtime, in integer ms.
 *
 *   1. S = D ∩ Q                                  (Q = measured period minus applied exclusions)
 *   2. granularity: bucketise S (ANY / ENTIRE)    (buckets aligned to the measured window start)
 *   3. episodes: components merged across recoveries shorter than `mergeGapMs`
 *   4. per episode: drop if shorter than `minEpisodeMs`; subtract `graceMs`
 *   5. aggregate: Σ (CUMULATIVE) or max (LONGEST_CONTINUOUS)
 *   6. round the total to `rounding.unitMs`
 *
 * Every step is monotone non-decreasing under set inclusion (D₁ ⊆ D₂ ⇒ μ(D₁) ≤ μ(D₂)). The bound engine relies
 * on this: evaluating μ on a subset of every consistent timeline's downtime gives a sound lower bound, and on a
 * superset a sound upper bound. `tests/temporal-contract-forensics/invariants.test.ts` checks it on random sets.
 */
import { bucketize, clip, groupByGap, intersect, measure, type Interval, type IntervalSet } from './intervals.js';

export interface QualificationRules {
  metric: 'CUMULATIVE_DOWNTIME' | 'LONGEST_CONTINUOUS_DOWNTIME';
  granularity: { bucketMs: number; rule: 'ANY' | 'ENTIRE' } | null;
  mergeGapMs: number;
  countMergedGaps: boolean;
  minEpisodeMs: number;
  graceMs: number;
  rounding: { unitMs: number; method: 'FLOOR' | 'CEIL' | 'NEAREST_HALF_UP' } | null;
}

export interface Episode { s: number; e: number; measuredMs: number; countedMs: number }

export function roundMs(x: number, r: QualificationRules['rounding']): number {
  if (!r) return x;
  const u = r.unitMs;
  if (r.method === 'FLOOR') return Math.floor(x / u) * u;
  if (r.method === 'CEIL') return Math.ceil(x / u) * u;
  return Math.floor((2 * x + u) / (2 * u)) * u;
}

export function episodes(down: IntervalSet, q: IntervalSet, origin: number, r: QualificationRules): Episode[] {
  let s: Interval[] = intersect(down, q);
  if (r.granularity) s = bucketize(s, q, origin, r.granularity.bucketMs, r.granularity.rule);
  const out: Episode[] = [];
  for (const g of groupByGap(s, r.mergeGapMs)) {
    const hull: Interval = { s: g[0]!.s, e: g[g.length - 1]!.e };
    const measured = r.countMergedGaps ? measure(clip(q, hull)) : measure(g);
    const counted = measured < r.minEpisodeMs ? 0 : Math.max(0, measured - r.graceMs);
    out.push({ s: hull.s, e: hull.e, measuredMs: measured, countedMs: counted });
  }
  return out;
}

export function qualify(down: IntervalSet, q: IntervalSet, origin: number, r: QualificationRules): number {
  const eps = episodes(down, q, origin, r);
  let v = 0;
  for (const e of eps) v = r.metric === 'CUMULATIVE_DOWNTIME' ? v + e.countedMs : Math.max(v, e.countedMs);
  return roundMs(v, r.rounding);
}

/** True when μ is a continuous function of interval endpoints (no thresholds or buckets that jump). */
export function isContinuousMeasure(r: QualificationRules): boolean {
  return !r.granularity && r.mergeGapMs === 0 && r.minEpisodeMs === 0 && !r.rounding;
}
