/**
 * Exact interval algebra over integer milliseconds.
 *
 * An `Interval` is half-open [s, e) with integer endpoints. An `IntervalSet` is NORMALISED: sorted by start,
 * pairwise disjoint and non-adjacent (adjacent pieces are merged), every piece non-empty (s < e). All
 * operations return normalised sets, run in O(n log n) or better, and never double count: the measure of a
 * set is the Lebesgue measure of the union, however many overlapping intervals produced it.
 * Zero-length intervals ([t, t)) are empty and disappear on normalisation.
 */

export interface Interval { s: number; e: number }
export type IntervalSet = readonly Interval[];

export const EMPTY: IntervalSet = Object.freeze([]) as IntervalSet;

export function interval(s: number, e: number): Interval {
  if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e)) throw new RangeError(`interval endpoints must be safe integers (got ${s}, ${e})`);
  return { s, e };
}

/** Sort, drop empty pieces, merge overlapping and adjacent pieces. */
export function normalize(list: readonly Interval[]): Interval[] {
  const xs = list.filter((i) => i.s < i.e).map((i) => ({ s: i.s, e: i.e })).sort((a, b) => a.s - b.s || a.e - b.e);
  const out: Interval[] = [];
  for (const i of xs) {
    const last = out[out.length - 1];
    if (last && i.s <= last.e) { if (i.e > last.e) last.e = i.e; } else out.push(i);
  }
  return out;
}

export function isNormalized(a: IntervalSet): boolean {
  for (let i = 0; i < a.length; i++) {
    if (!(a[i]!.s < a[i]!.e)) return false;
    if (i > 0 && !(a[i - 1]!.e < a[i]!.s)) return false;
  }
  return true;
}

export function union(a: IntervalSet, b: IntervalSet): Interval[] { return normalize([...a, ...b]); }

export function unionAll(sets: readonly IntervalSet[]): Interval[] { return normalize(sets.flat()); }

/** Two-pointer intersection of normalised sets. */
export function intersect(a: IntervalSet, b: IntervalSet): Interval[] {
  const out: Interval[] = []; let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i]!.s, b[j]!.s); const e = Math.min(a[i]!.e, b[j]!.e);
    if (s < e) out.push({ s, e });
    if (a[i]!.e < b[j]!.e) i++; else j++;
  }
  return out;
}

/** a \ b for normalised sets. */
export function subtract(a: IntervalSet, b: IntervalSet): Interval[] {
  const out: Interval[] = []; let j = 0;
  for (const x of a) {
    let s = x.s;
    while (j < b.length && b[j]!.e <= s) j++;
    let k = j;
    while (k < b.length && b[k]!.s < x.e) {
      if (b[k]!.s > s) out.push({ s, e: b[k]!.s });
      s = Math.max(s, b[k]!.e);
      if (s >= x.e) break;
      k++;
    }
    if (s < x.e) out.push({ s, e: x.e });
  }
  return out;
}

export function complement(a: IntervalSet, within: Interval): Interval[] { return subtract(within.s < within.e ? [within] : [], a); }

export function clip(a: IntervalSet, window: Interval): Interval[] { return intersect(a, window.s < window.e ? [window] : []); }

export function measure(a: IntervalSet): number { let m = 0; for (const i of a) m += i.e - i.s; return m; }

/** True when the sets share positive measure (touching at an endpoint is not an overlap). */
export function overlaps(a: IntervalSet, b: IntervalSet): boolean {
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (Math.max(a[i]!.s, b[j]!.s) < Math.min(a[i]!.e, b[j]!.e)) return true;
    if (a[i]!.e < b[j]!.e) i++; else j++;
  }
  return false;
}

/** Whether instant t lies in the set. */
export function contains(a: IntervalSet, t: number): boolean {
  let lo = 0; let hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; const x = a[mid]!;
    if (t < x.s) hi = mid - 1; else if (t >= x.e) lo = mid + 1; else return true;
  }
  return false;
}

/** Whether [s, e) is entirely inside the set (an empty range is trivially covered). */
export function covers(a: IntervalSet, s: number, e: number): boolean {
  if (s >= e) return true;
  let lo = 0; let hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; const x = a[mid]!;
    if (s < x.s) hi = mid - 1; else if (s >= x.e) lo = mid + 1; else return e <= x.e;
  }
  return false;
}

/** Coverage of `window` by the set, in ms. */
export function coverage(a: IntervalSet, window: Interval): number { return measure(clip(a, window)); }

/** Merge components separated by gaps strictly shorter than `gapMs` (the gaps become part of the result). */
export function mergeGaps(a: IntervalSet, gapMs: number): Interval[] {
  if (gapMs <= 0 || a.length < 2) return a.map((x) => ({ ...x }));
  const out: Interval[] = [{ ...a[0]! }];
  for (let i = 1; i < a.length; i++) {
    const last = out[out.length - 1]!;
    if (a[i]!.s - last.e < gapMs) last.e = a[i]!.e; else out.push({ ...a[i]! });
  }
  return out;
}

/** Group components separated by gaps strictly shorter than `gapMs`, keeping members (for gap-exclusive measures). */
export function groupByGap(a: IntervalSet, gapMs: number): Interval[][] {
  const groups: Interval[][] = [];
  for (const x of a) {
    const g = groups[groups.length - 1];
    if (g && gapMs > 0 && x.s - g[g.length - 1]!.e < gapMs) g.push(x); else groups.push([x]);
  }
  return groups;
}

export function longest(a: IntervalSet): number { let m = 0; for (const i of a) m = Math.max(m, i.e - i.s); return m; }

/** Shift every piece by `d` ms. */
export function shift(a: IntervalSet, d: number): Interval[] { return a.map((x) => ({ s: x.s + d, e: x.e + d })); }

/**
 * Bucketise `set` (assumed ⊆ q) into fixed buckets [origin + k·g, origin + (k+1)·g), restricted to q.
 * ANY: a bucket counts when the set has positive measure in it. ENTIRE: when the set covers all of the bucket's
 * measured part (bucket ∩ q). A counted bucket contributes bucket ∩ q. Both rules are monotone in `set`.
 */
export function bucketize(set: IntervalSet, q: IntervalSet, origin: number, g: number, rule: 'ANY' | 'ENTIRE'): Interval[] {
  if (g <= 0) throw new RangeError('bucket size must be positive');
  const touched = new Set<number>();
  for (const x of set) {
    const k0 = Math.floor((x.s - origin) / g); const k1 = Math.floor((x.e - 1 - origin) / g);
    for (let k = k0; k <= k1; k++) touched.add(k);
  }
  const keys = [...touched].sort((a, b) => a - b);
  const out: Interval[] = [];
  for (const k of keys) {
    const b: Interval = { s: origin + k * g, e: origin + (k + 1) * g };
    const qb = clip(q, b);
    if (rule === 'ANY') { if (measure(clip(set, b)) > 0) out.push(...qb); } else if (measure(qb) > 0 && measure(clip(set, b)) === measure(qb)) out.push(...qb);
  }
  return normalize(out);
}

export function equalSets(a: IntervalSet, b: IntervalSet): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.s !== b[i]!.s || a[i]!.e !== b[i]!.e) return false;
  return true;
}
