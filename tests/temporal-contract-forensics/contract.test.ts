import { describe, expect, it } from 'vitest';
import { availabilityString, breachPoint, compileContract, creditMinor, parseDecimal } from '../../src/server/capabilities/temporal-contract-forensics/contract.js';
import { createTemporalContractForensics, contractHash, TcfInputError } from '../../src/server/capabilities/temporal-contract-forensics/index.js';
import { qualify, type QualificationRules } from '../../src/server/capabilities/temporal-contract-forensics/qualify.js';
import { calendarMonthWindow, formatDuration, parseInstant } from '../../src/server/capabilities/temporal-contract-forensics/time.js';
import { at, contract, exact, iv, MIN, W } from './helpers.js';

const tcf = createTemporalContractForensics();

describe('TCF time handling', () => {
  it('requires an explicit offset and converts offsets exactly', () => {
    expect(() => parseInstant('2026-03-10T12:00:00', 'x')).toThrow(TcfInputError);
    expect(parseInstant('2026-03-10T14:00:00+02:00', 'x')).toBe(parseInstant('2026-03-10T12:00:00Z', 'x'));
    expect(parseInstant('2026-03-10T12:00:00.5Z', 'x') - parseInstant('2026-03-10T12:00:00Z', 'x')).toBe(500);
    expect(() => parseInstant('2026-02-30T00:00:00Z', 'x')).toThrow(/real calendar date/);
  });
  it('computes calendar months in a time zone across DST and year boundaries', () => {
    const [s, e] = calendarMonthWindow('2026-03', 'America/New_York');
    expect(new Date(s).toISOString()).toBe('2026-03-01T05:00:00.000Z'); // EST
    expect(new Date(e).toISOString()).toBe('2026-04-01T04:00:00.000Z'); // EDT
    expect(e - s).toBe(31 * 86_400_000 - 3_600_000); // a DST month is one hour short
    const [s2, e2] = calendarMonthWindow('2026-12', 'Asia/Kolkata');
    expect(new Date(s2).toISOString()).toBe('2026-11-30T18:30:00.000Z');
    expect(new Date(e2).toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });
  it('formats durations exactly', () => {
    expect(formatDuration(1_800_001)).toBe('30m 0.001s');
    expect(formatDuration(3_723_000)).toBe('1h 02m 03s');
  });
});

describe('TCF contract compiler', () => {
  it('hashes content and detects a tampered declared hash', () => {
    const c = contract();
    expect(compileContract({ ...c, contentHash: contractHash(c) }).ok).toBe(true);
    const bad = compileContract({ ...c, contentHash: 'deadbeef' });
    expect(bad.ok).toBe(false);
    expect(bad.review.map((r) => r.code)).toContain('CONTRACT_HASH_MISMATCH');
  });
  it('missing threshold → structured review, INDETERMINATE (never a default)', () => {
    const c = contract(); delete (c as Partial<typeof c>).breach;
    const r = tcf.analyse({ contract: c, evidence: [iv('a', 'UNAVAILABLE', 0, 40)], measurementWindow: W(-10, 60) });
    expect(r.classification).toBe('INDETERMINATE');
    expect(r.reviewRequirements.find((x) => x.field === 'breach')?.code).toBe('CONTRACT_FIELD_MISSING');
    expect(r.bounds).toBeNull();
  });
  it('unsupported clause language becomes a blocking review requirement', () => {
    const c = contract({ clauses: [{ id: '9.3', type: 'FORCE_MAJEURE', text: 'Downtime caused by events beyond reasonable control is excluded.' }] });
    const r = tcf.analyse({ contract: c, evidence: [iv('a', 'UNAVAILABLE', 0, 40)], measurementWindow: W(-10, 60) });
    expect(r.classification).toBe('INDETERMINATE');
    expect(r.reviewRequirements[0]).toMatchObject({ code: 'UNSUPPORTED_CLAUSE', clauseId: '9.3', blocking: true });
  });
  it('selects the version effective at the incident, never the latest', () => {
    const v1 = contract({ version: '1', effectiveFrom: '2025-01-01T00:00:00Z', effectiveTo: '2026-03-01T00:00:00Z', breach: { type: 'DOWNTIME_EXCEEDS', thresholdMs: 20 * MIN, inclusive: false } });
    const v2 = contract({ version: '2', effectiveFrom: '2026-03-01T00:00:00Z', effectiveTo: null, breach: { type: 'DOWNTIME_EXCEEDS', thresholdMs: 60 * MIN, inclusive: false } });
    // Incident on 2026-03-10 (BASE): v2 applies: 40 min < 60 → NO_BREACH. Under v1 it would have been a breach.
    const r = tcf.analyse({ contract: [v2, v1], evidence: [iv('a', 'UNAVAILABLE', 0, 40), iv('h1', 'HEALTHY', -100, 0), iv('h2', 'HEALTHY', 40, 200)], measurementWindow: W(-10, 60), clocks: exact() });
    expect(r.contract?.version).toBe('2');
    expect(r.classification).toBe('NO_BREACH');
    const v3 = { ...v2, version: '3', effectiveFrom: at(30), breach: { type: 'DOWNTIME_EXCEEDS' as const, thresholdMs: 10 * MIN, inclusive: false } };
    const v2b = { ...v2, effectiveTo: at(30) };
    const r2 = tcf.analyse({ contract: [v1, v2b, v3], evidence: [iv('a', 'UNAVAILABLE', 0, 40)], measurementWindow: W(-10, 60) });
    expect(r2.classification).toBe('INDETERMINATE');
    expect(r2.reviewRequirements.map((x) => x.code)).toContain('CONTRACT_VERSION_BOUNDARY_IN_WINDOW');
  });
  it('NOT_APPLICABLE when no version is effective, and when the incident is outside the contract scope', () => {
    const c = contract({ effectiveFrom: '2027-01-01T00:00:00Z' });
    expect(tcf.analyse({ contract: c, evidence: [iv('a', 'UNAVAILABLE', 0, 40)], measurementWindow: W(-10, 60) }).classification).toBe('NOT_APPLICABLE');
    const r = tcf.analyse({ contract: contract(), evidence: [iv('a', 'UNAVAILABLE', 0, 40, { service: 'billing' })], measurementWindow: W(-10, 60), incident: { incidentId: 'INC-1', scope: { service: 'billing' } } });
    expect(r.classification).toBe('NOT_APPLICABLE');
  });
  it('clips the window to the effective period and discloses partial coverage', () => {
    const c = contract({ effectiveFrom: at(20) });
    const r = tcf.analyse({ contract: c, evidence: [iv('a', 'UNAVAILABLE', 0, 40), iv('h', 'HEALTHY', 40, 100)], measurementWindow: W(-10, 60), clocks: exact() });
    expect(r.window.measured?.start).toBe(at(20));
    expect(r.reviewRequirements.map((x) => x.code)).toContain('CONTRACT_COVERAGE_PARTIAL');
    expect(r.bounds?.qualifyingDowntimeMs).toMatchObject({ min: 20 * MIN, max: 20 * MIN });
  });
  it('rejects a calendar-month contract measured over a non-month window', () => {
    const c = contract({}, { period: { type: 'CALENDAR_MONTH', timeZone: 'UTC' } });
    const r = tcf.analyse({ contract: c, evidence: [iv('a', 'UNAVAILABLE', 0, 40)], measurementWindow: W(-10, 60) });
    expect(r.reviewRequirements.map((x) => x.code)).toContain('WINDOW_NOT_CONTRACT_PERIOD');
    expect(r.classification).toBe('INDETERMINATE');
  });
});

describe('TCF threshold arithmetic is exact', () => {
  it('threshold equality: "exceeds" vs "at least"', () => {
    const strict = compileContract(contract()); const incl = compileContract(contract({ breach: { type: 'DOWNTIME_EXCEEDS', thresholdMs: 30 * MIN, inclusive: true } }));
    if (!strict.ok || !incl.ok) throw new Error('compile');
    expect(breachPoint(strict.contract.breach, 0)).toBe(30 * MIN + 1);
    expect(breachPoint(incl.contract.breach, 0)).toBe(30 * MIN);
    for (const [inclusive, expected] of [[false, 'NO_BREACH'], [true, 'BREACH_CONFIRMED']] as const) {
      const c = contract({ breach: { type: 'DOWNTIME_EXCEEDS', thresholdMs: 30 * MIN, inclusive } });
      const r = tcf.analyse({ contract: c, evidence: [iv('h1', 'HEALTHY', -60, 0), iv('a', 'UNAVAILABLE', 0, 30), iv('h2', 'HEALTHY', 30, 90)], measurementWindow: W(-30, 60), clocks: exact() });
      expect(r.classification).toBe(expected);
    }
  });
  it('availability thresholds use integer arithmetic (99.9% of 30 days = 43.2 min)', () => {
    const c = compileContract(contract({ breach: { type: 'AVAILABILITY_BELOW', targetPercent: '99.9', inclusive: false } }));
    if (!c.ok) throw new Error('compile');
    const month = 30 * 86_400_000;
    // availability < 99.9% ⇔ downtime > 0.1% · month = 2_592_000 ms; smallest breaching integer is +1.
    expect(breachPoint(c.contract.breach, month)).toBe(2_592_001);
    expect(availabilityString(2_592_000, month, 'floor')).toBe('99.9000');
    expect(availabilityString(2_592_001, month, 'floor')).toBe('99.8999');
    expect(parseDecimal('99.95')).toEqual({ n: 9995n, scale: 100n });
    expect(parseDecimal('1e3')).toBeNull();
  });
  it('credit tiers pick the highest satisfied tier and respect the cap', () => {
    const c = compileContract(contract({ credit: { monthlyFeeMinor: 100_000, currency: 'USD', tiers: [{ when: { type: 'DOWNTIME_EXCEEDS', thresholdMs: 30 * MIN, inclusive: false }, creditPercent: '10' }, { when: { type: 'DOWNTIME_EXCEEDS', thresholdMs: 60 * MIN, inclusive: false }, creditPercent: '30' }], capPercent: '25' } }));
    if (!c.ok || !c.contract.credit) throw new Error('compile');
    expect(creditMinor(c.contract.credit, 30 * MIN, 0)).toBe(0);
    expect(creditMinor(c.contract.credit, 30 * MIN + 1, 0)).toBe(10_000);
    expect(creditMinor(c.contract.credit, 61 * MIN, 0)).toBe(25_000); // 30% capped at 25%
  });
});

describe('TCF contractual measure μ', () => {
  const R = (o: Partial<QualificationRules> = {}): QualificationRules => ({ metric: 'CUMULATIVE_DOWNTIME', granularity: null, mergeGapMs: 0, countMergedGaps: false, minEpisodeMs: 0, graceMs: 0, rounding: null, ...o });
  const Q = [{ s: 0, e: 1000 }];
  it('grace period and minimum qualifying episode', () => {
    expect(qualify([{ s: 0, e: 100 }, { s: 200, e: 230 }], Q, 0, R({ minEpisodeMs: 50 }))).toBe(100);
    expect(qualify([{ s: 0, e: 100 }, { s: 200, e: 230 }], Q, 0, R({ graceMs: 40 }))).toBe(60);
  });
  it('flapping: merge gap, with and without counting the gaps; longest continuous', () => {
    const d = [{ s: 0, e: 100 }, { s: 110, e: 200 }, { s: 500, e: 520 }];
    expect(qualify(d, Q, 0, R({ metric: 'LONGEST_CONTINUOUS_DOWNTIME' }))).toBe(100);
    expect(qualify(d, Q, 0, R({ metric: 'LONGEST_CONTINUOUS_DOWNTIME', mergeGapMs: 20 }))).toBe(190);
    expect(qualify(d, Q, 0, R({ metric: 'LONGEST_CONTINUOUS_DOWNTIME', mergeGapMs: 20, countMergedGaps: true }))).toBe(200);
  });
  it('granularity and rounding', () => {
    expect(qualify([{ s: 5, e: 6 }], Q, 0, R({ granularity: { bucketMs: 60, rule: 'ANY' } }))).toBe(60);
    expect(qualify([{ s: 5, e: 6 }], Q, 0, R({ granularity: { bucketMs: 60, rule: 'ENTIRE' } }))).toBe(0);
    expect(qualify([{ s: 0, e: 89 }], Q, 0, R({ rounding: { unitMs: 60, method: 'FLOOR' } }))).toBe(60);
    expect(qualify([{ s: 0, e: 89 }], Q, 0, R({ rounding: { unitMs: 60, method: 'CEIL' } }))).toBe(120);
    expect(qualify([{ s: 0, e: 90 }], Q, 0, R({ rounding: { unitMs: 60, method: 'NEAREST_HALF_UP' } }))).toBe(120);
  });
  it('exclusions remove time from the measured set', () => {
    expect(qualify([{ s: 0, e: 100 }], [{ s: 0, e: 40 }, { s: 60, e: 1000 }], 0, R())).toBe(80);
  });
});
