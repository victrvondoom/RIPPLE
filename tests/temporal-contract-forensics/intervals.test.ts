import { describe, expect, it } from 'vitest';
import {
  bucketize, clip, complement, contains, covers, intersect, isNormalized, measure, mergeGaps, normalize, overlaps, subtract, union, type Interval,
} from '../../src/server/capabilities/temporal-contract-forensics/intervals.js';
import { rng } from './helpers.js';

const I = (s: number, e: number): Interval => ({ s, e });

describe('TCF interval algebra — exact cases', () => {
  it('normalises: sorts, merges overlapping and ADJACENT pieces, drops zero-length', () => {
    expect(normalize([I(5, 7), I(0, 2), I(2, 3), I(6, 9), I(4, 4)])).toEqual([I(0, 3), I(5, 9)]);
  });
  it('nested intervals do not double count', () => {
    expect(measure(normalize([I(0, 100), I(10, 20), I(30, 40)]))).toBe(100);
  });
  it('adjacent intervals touch but do not overlap', () => {
    expect(overlaps([I(0, 10)], [I(10, 20)])).toBe(false);
    expect(overlaps([I(0, 10)], [I(9, 20)])).toBe(true);
    expect(union([I(0, 10)], [I(10, 20)])).toEqual([I(0, 20)]);
    expect(intersect([I(0, 10)], [I(10, 20)])).toEqual([]);
  });
  it('subtraction splits, trims and removes', () => {
    expect(subtract([I(0, 100)], [I(10, 20), I(30, 40)])).toEqual([I(0, 10), I(20, 30), I(40, 100)]);
    expect(subtract([I(0, 10)], [I(0, 10)])).toEqual([]);
    expect(subtract([I(0, 10), I(20, 30)], [I(5, 25)])).toEqual([I(0, 5), I(25, 30)]);
    expect(subtract([I(0, 10)], [])).toEqual([I(0, 10)]);
  });
  it('zero-length intervals are empty everywhere', () => {
    expect(measure(normalize([I(3, 3)]))).toBe(0);
    expect(clip([I(0, 10)], I(5, 5))).toEqual([]);
    expect(complement([], I(7, 7))).toEqual([]);
  });
  it('half-open membership and coverage', () => {
    const a = [I(0, 10), I(20, 30)];
    expect(contains(a, 0)).toBe(true); expect(contains(a, 10)).toBe(false); expect(contains(a, 29)).toBe(true);
    expect(covers(a, 0, 10)).toBe(true); expect(covers(a, 5, 21)).toBe(false); expect(covers(a, 4, 4)).toBe(true);
  });
  it('merges flapping gaps strictly shorter than the merge gap', () => {
    expect(mergeGaps([I(0, 10), I(15, 20), I(30, 40)], 5)).toEqual([I(0, 10), I(15, 20), I(30, 40)]);
    expect(mergeGaps([I(0, 10), I(15, 20), I(30, 40)], 6)).toEqual([I(0, 20), I(30, 40)]);
  });
  it('bucketises with ANY and ENTIRE rules, restricted to the measured set', () => {
    const q = [I(0, 100)];
    expect(bucketize([I(5, 6)], q, 0, 10, 'ANY')).toEqual([I(0, 10)]);
    expect(bucketize([I(5, 6)], q, 0, 10, 'ENTIRE')).toEqual([]);
    expect(bucketize([I(10, 30)], q, 0, 10, 'ENTIRE')).toEqual([I(10, 30)]);
    expect(bucketize([I(5, 10)], [I(5, 100)], 0, 10, 'ENTIRE')).toEqual([I(5, 10)]); // bucket's measured part fully down
  });
  it('rejects non-integer endpoints at construction', async () => {
    const { interval } = await import('../../src/server/capabilities/temporal-contract-forensics/intervals.js');
    expect(() => interval(0.5, 3)).toThrow(RangeError);
  });
});

/** Independent model: a bitmap over [0, N). */
const N = 120;
const bits = (a: readonly Interval[]) => { const b = new Array<boolean>(N).fill(false); for (const x of a) for (let t = Math.max(0, x.s); t < Math.min(N, x.e); t++) b[t] = true; return b; };
const fromBits = (b: boolean[]) => { const out: Interval[] = []; let s = -1; for (let t = 0; t <= N; t++) { if (t < N && b[t]) { if (s < 0) s = t; } else if (s >= 0) { out.push(I(s, t)); s = -1; } } return out; };
const randSet = (r: ReturnType<typeof rng>) => Array.from({ length: r.int(0, 6) }, () => { const s = r.int(0, N - 1); return I(s, Math.min(N, s + r.int(0, 30))); });

describe('TCF interval algebra — randomised equivalence with a bitmap model (seeded)', () => {
  const r = rng(20261107);
  it('normalize / union / intersect / subtract / measure / overlaps agree with the bitmap on 2000 cases', () => {
    for (let k = 0; k < 2000; k++) {
      const a = randSet(r); const b = randSet(r);
      const na = normalize(a); const nb = normalize(b);
      expect(isNormalized(na)).toBe(true);
      expect(na).toEqual(fromBits(bits(a)));
      const ba = bits(a); const bb = bits(b);
      expect(union(na, nb)).toEqual(fromBits(ba.map((x, i) => x || bb[i]!)));
      expect(intersect(na, nb)).toEqual(fromBits(ba.map((x, i) => x && bb[i]!)));
      expect(subtract(na, nb)).toEqual(fromBits(ba.map((x, i) => x && !bb[i]!)));
      expect(measure(na)).toBe(ba.filter(Boolean).length);
      expect(overlaps(na, nb)).toBe(ba.some((x, i) => x && bb[i]!));
      // Inclusion–exclusion: |A ∪ B| = |A| + |B| − |A ∩ B| (no double counting).
      expect(measure(union(na, nb))).toBe(measure(na) + measure(nb) - measure(intersect(na, nb)));
    }
  });
});
