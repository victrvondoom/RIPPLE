import { describe, expect, it } from 'vitest';
import { createTemporalContractForensics, type AnalysisInput, type TemporalEvidence } from '../../src/server/capabilities/temporal-contract-forensics/index.js';
import { at, contract, exact, iv, MIN, pt, tr, W } from './helpers.js';

const tcf = createTemporalContractForensics();
const run = (evidence: TemporalEvidence[], extra: Partial<AnalysisInput> = {}) => tcf.analyse({ contract: contract(), evidence, measurementWindow: W(-60, 120), clocks: exact(), ...extra });
const status = (r: ReturnType<typeof run>, id: string) => r.evidence.find((e) => e.evidenceId === id)!;
const H = (from: number, to: number, id: string, o = {}) => iv(id, 'HEALTHY', from, to, o);

describe('TCF classification semantics', () => {
  it('BREACH_CONFIRMED only when the minimum crosses; NO_BREACH only when the maximum stays below', () => {
    const conf = run([H(-90, 0, 'h1'), iv('d', 'UNAVAILABLE', 0, 35), H(35, 200, 'h2')]);
    expect(conf.classification).toBe('BREACH_CONFIRMED');
    expect(conf.bounds!.qualifyingDowntimeMs).toMatchObject({ min: 35 * MIN, max: 35 * MIN, minStatus: 'EXACT', maxStatus: 'EXACT' });
    const none = run([H(-90, 0, 'h1'), iv('d', 'UNAVAILABLE', 0, 20), H(20, 200, 'h2')]);
    expect(none.classification).toBe('NO_BREACH');
  });
  it('missing observations widen the maximum and are reported as evidence gaps, not assumed healthy', () => {
    const r = run([H(-90, 0, 'h1'), iv('d', 'UNAVAILABLE', 0, 20), H(35, 200, 'h2')]);
    expect(r.classification).toBe('BREACH_POSSIBLE');
    expect(r.bounds!.qualifyingDowntimeMs).toMatchObject({ min: 20 * MIN, max: 35 * MIN });
    expect(r.envelope.evidenceGaps.map((g) => [g.start, g.end])).toEqual([[at(20), at(35)]]);
    expect(r.sensitivity.additionalDowntimeToConfirmMs).toBe(10 * MIN + 1);
    expect(r.sensitivity.possibleDowntimeToEliminateMs).toBe(5 * MIN);
    expect(r.envelope.uncertain[0]!.causes.map((c) => c.type)).toContain('NO_EVIDENCE');
  });
  it('no evidence about the contracted scope is INDETERMINATE, not a guess', () => {
    expect(run([iv('d', 'UNAVAILABLE', 0, 40, { region: 'us-east-1' })], { contract: contract({ scope: { service: 'api', region: 'eu-west-1' } }) }).classification).toBe('INDETERMINATE');
  });
  it('certain/possible envelopes cite the evidence that establishes them', () => {
    const r = run([H(-90, 0, 'h1'), iv('d', 'UNAVAILABLE', 0, 35), H(35, 200, 'h2')]);
    expect(r.envelope.certainDowntime).toEqual([expect.objectContaining({ start: at(0), end: at(35), evidenceIds: ['d'] })]);
    expect(r.envelope.knownNonQualifying.flatMap((s) => s.evidenceIds).sort()).toEqual(['h1', 'h2']);
  });
});

describe('TCF temporal uncertainty', () => {
  it('applies a known clock offset correction to every record of that clock', () => {
    const r = run([iv('d', 'UNAVAILABLE', 1.5, 41.5, { clock: 'b' }), H(-90, 1.5, 'h1', { clock: 'b' }), H(41.5, 200, 'h2', { clock: 'b' })], { clocks: [{ clockId: 'b', knownOffsetMs: 90_000, uncertaintyMs: 0 }] });
    expect(r.envelope.certainDowntime[0]).toMatchObject({ start: at(0), end: at(40) });
  });
  it('keeps one source\'s records related: a shared clock offset cannot shorten a measured duration', () => {
    // One clock, ±5 min unknown offset; the source measured exactly 40 min of downtime between healthy periods.
    const ev = [H(-120, 0, 'h1', { clock: 'b' }), iv('d', 'UNAVAILABLE', 0, 40, { clock: 'b' }), H(40, 300, 'h2', { clock: 'b' })];
    const r = tcf.analyse({ contract: contract({ breach: { type: 'DOWNTIME_EXCEEDS', thresholdMs: 35 * MIN, inclusive: false } }), evidence: ev, measurementWindow: W(-60, 120), clocks: [{ clockId: 'b', knownOffsetMs: 0, uncertaintyMs: 5 * MIN }] });
    expect(r.bounds!.qualifyingDowntimeMs).toMatchObject({ min: 40 * MIN, max: 40 * MIN, minStatus: 'EXACT', maxStatus: 'EXACT' });
    expect(r.classification).toBe('BREACH_CONFIRMED');
    // The per-endpoint (relaxed) certain set is only 30 min: the engine does not report it as the bound.
    expect(r.envelope.certainDowntime.reduce((t, s) => t + s.durationMs, 0)).toBe(30 * MIN);
  });
  it('does not pair the earliest of one source with the latest of another: exact minimum over a relative offset', () => {
    // A (exact clock) down [0,30); B (±3 min clock) down [2,34). Union is minimised at δ_B ∈ [−3,−2] → 32 min.
    const r = run([iv('a', 'UNAVAILABLE', 0, 30), iv('b', 'UNAVAILABLE', 2, 34, { system: 'lb', clock: 'lb' })], { clocks: [...exact(), { clockId: 'lb', knownOffsetMs: 0, uncertaintyMs: 3 * MIN }] });
    expect(r.bounds!.qualifyingDowntimeMs.min).toBe(32 * MIN);
    expect(r.bounds!.qualifyingDowntimeMs.minStatus).toBe('EXACT');
  });
  it('widens by clock drift since the last sync', () => {
    const r = run([iv('d', 'UNAVAILABLE', 0, 40, { clock: 'd' })], { clocks: [{ clockId: 'd', knownOffsetMs: 0, uncertaintyMs: 0, driftPpm: 100, lastSyncAt: at(-60 * 24 * 10) }] });
    // 10 days × 100 ppm = 86.4 s common offset uncertainty → certain set shrinks by 86.4 s per side (plus window drift).
    const c = r.envelope.certainDowntime[0]!;
    expect(c.durationMs).toBeLessThanOrEqual(40 * MIN - 2 * 86_400);
  });
  it('a record without a clock profile gets the policy default uncertainty, and says so', () => {
    const r = tcf.analyse({ contract: contract(), evidence: [iv('d', 'UNAVAILABLE', 0, 40, { system: 'x' })], measurementWindow: W(-60, 120) });
    expect(status(r, 'd').issues.map((i) => i.code)).toContain('MISSING_CLOCK_METADATA');
    expect(r.disclosures.some((d) => d.includes('policy default'))).toBe(true);
  });
  it('transitions are assembled in EVENT order, not arrival order; UNKNOWN ends a state', () => {
    const ev = [tr('t3', 'HEALTHY', 40, { holds: 200 }), tr('t1', 'HEALTHY', -60), tr('t2', 'UNAVAILABLE', 0)];
    const shuffled = run(ev); const ordered = run([ev[1]!, ev[2]!, ev[0]!]);
    expect(shuffled.bounds).toEqual(ordered.bounds);
    expect(shuffled.bounds!.qualifyingDowntimeMs).toMatchObject({ min: 40 * MIN, max: 40 * MIN });
    const withUnknown = run([tr('t1', 'HEALTHY', -60), tr('t2', 'UNKNOWN', -30), tr('t3', 'UNAVAILABLE', 0), tr('t4', 'HEALTHY', 40, { holds: 200 })]);
    expect(withUnknown.envelope.evidenceGaps.map((g) => [g.start, g.end])).toEqual([[at(-30), at(0)]]);
  });
  it('an open transition (no later event, no holdsUntil) establishes only an instant', () => {
    const r = run([tr('t1', 'UNAVAILABLE', 0)]);
    expect(status(r, 't1').issues.map((i) => i.code)).toContain('OPEN_TRANSITION');
    expect(r.bounds!.qualifyingDowntimeMs.min).toBe(0);
  });
  it('an instantaneous failure report adds no measurable downtime', () => {
    const r = run([H(-90, 0, 'h1'), iv('d', 'UNAVAILABLE', 0, 20), pt('c', 'UNAVAILABLE', 30, { auth: 'CUSTOMER_REPORT', system: 'zd' })], { clocks: exact('mon', 'zd') });
    expect(r.bounds!.qualifyingDowntimeMs.min).toBe(20 * MIN);
  });
});

describe('TCF evidence quality, duplicates and scope', () => {
  it('duplicate source records and duplicate raw content are counted once', () => {
    const a = iv('a', 'UNAVAILABLE', 0, 30);
    const r = run([a, { ...a, id: 'a-resent', ingestedAt: at(50) }, { ...iv('a2', 'UNAVAILABLE', 0, 30, { record: 'other' }), provenance: a.provenance }]);
    expect(status(r, 'a-resent').status).toBe('DUPLICATE');
    expect(status(r, 'a2').status).toBe('DUPLICATE');
    expect(r.bounds!.qualifyingDowntimeMs.min).toBe(30 * MIN);
  });
  it('two sources reporting the same outage never double count', () => {
    const r = run([iv('a', 'UNAVAILABLE', 0, 30), iv('b', 'UNAVAILABLE', 5, 25, { system: 'lb' }), iv('c', 'UNAVAILABLE', 0, 30, { system: 'probe' })], { clocks: exact('mon', 'lb', 'probe') });
    expect(r.bounds!.qualifyingDowntimeMs.min).toBe(30 * MIN);
  });
  it('overlapping incidents on the same scope are a union, and flagged', () => {
    const r = run([iv('a', 'UNAVAILABLE', 0, 30, { incident: 'INC-1' }), iv('b', 'UNAVAILABLE', 20, 45, { incident: 'INC-2', record: 'b' })], { incident: { incidentId: 'INC-1', scope: { service: 'api' } } });
    expect(r.bounds!.qualifyingDowntimeMs.min).toBe(45 * MIN);
    expect(status(r, 'b').issues.map((i) => i.code)).toContain('OTHER_INCIDENT');
  });
  it('a source record id re-used with different content is a collision: both set aside, visible', () => {
    const r = run([iv('a', 'UNAVAILABLE', 0, 40, { record: 'X' }), iv('b', 'UNAVAILABLE', 0, 10, { record: 'X' }), H(-90, 0, 'h1'), H(45, 200, 'h2')]);
    expect(r.conflicts.find((c) => c.type === 'RECORD_ID_COLLISION')?.evidenceIds).toEqual(['a', 'b']);
    expect(status(r, 'a').status).toBe('SET_ASIDE');
    expect(r.classification).toBe('INDETERMINATE');
  });
  it('regional and customer scope: other regions do not apply; aggregate health does not speak for a region', () => {
    const c = contract({ scope: { service: 'api', region: 'eu', customer: 'acme' } });
    const r = run([iv('us', 'UNAVAILABLE', 0, 60, { region: 'us' }), iv('eu', 'UNAVAILABLE', 0, 20, { region: 'eu', record: 'eu' }), H(-90, 0, 'g1', { semantics: 'AGGREGATE' }), H(20, 200, 'g2', { semantics: 'AGGREGATE' }), iv('cust2', 'UNAVAILABLE', 0, 90, { region: 'eu', customer: 'other', record: 'c2' })], { contract: c });
    expect(status(r, 'us').issues[0]!.code).toBe('INCOMPATIBLE_SCOPE');
    expect(status(r, 'cust2').issues[0]!.code).toBe('INCOMPATIBLE_SCOPE');
    expect(status(r, 'g2').issues[0]!.code).toBe('AGGREGATE_HEALTH_NOT_APPLICABLE');
    expect(r.bounds!.qualifyingDowntimeMs.min).toBe(20 * MIN);
    expect(r.bounds!.qualifyingDowntimeMs.max).toBe(180 * MIN); // nothing establishes eu health
  });
  it('rejects records that claim a state after they were recorded, and records without a source', () => {
    const late = { ...iv('late', 'UNAVAILABLE', 0, 40), observedAt: at(10) };
    const anon = { ...iv('anon', 'UNAVAILABLE', 0, 40), source: { system: '', recordId: '', authority: 'SIGNED_MONITORING' as const } };
    const r = run([late, anon]);
    expect(status(r, 'late')).toMatchObject({ status: 'EXCLUDED' });
    expect(status(r, 'late').issues[0]!.code).toBe('EVENT_AFTER_OBSERVATION');
    expect(status(r, 'anon').issues[0]!.code).toBe('MISSING_SOURCE_METADATA');
    expect(r.classification).toBe('INDETERMINATE');
  });
  it('flags stale and delayed records but keeps their event time', () => {
    const r = run([{ ...iv('d', 'UNAVAILABLE', 0, 40), observedAt: at(100), ingestedAt: at(200) }]);
    expect(status(r, 'd').issues.map((i) => i.code)).toEqual(expect.arrayContaining(['STALE_OBSERVATION', 'DELAYED_INGESTION']));
    expect(r.bounds!.qualifyingDowntimeMs.min).toBe(40 * MIN);
  });
  it('an unverified "signed" record loses its authority', () => {
    const r = run([iv('d', 'UNAVAILABLE', 0, 40, { auth: 'SIGNED_MONITORING', sig: false })]);
    expect(status(r, 'd')).toMatchObject({ declaredAuthority: 'SIGNED_MONITORING', effectiveAuthority: 'UNVERIFIED_MANUAL' });
  });
  it('contract evidence requirements: only accepted authorities establish downtime', () => {
    const c = contract({ evidenceRequirements: { establishDowntimeWith: ['SIGNED_MONITORING'] } });
    const r = run([iv('d', 'UNAVAILABLE', 0, 40, { auth: 'CUSTOMER_REPORT' })], { contract: c });
    expect(status(r, 'd').issues[0]!.code).toBe('NOT_ACCEPTED_BY_CONTRACT');
  });
});

describe('TCF conflicts', () => {
  it('resolves a definite contradiction by documented authority and keeps the loser visible', () => {
    const r = run([H(-90, 120, 'mon', { auth: 'SIGNED_MONITORING', sig: true }), iv('cust', 'UNAVAILABLE', 10, 50, { auth: 'CUSTOMER_REPORT', system: 'zd' })], { clocks: exact('mon', 'zd') });
    expect(r.conflicts[0]).toMatchObject({ type: 'STATE_CONTRADICTION', resolution: 'RESOLVED_BY_AUTHORITY', setAside: ['cust'], kept: ['mon'] });
    expect(status(r, 'cust').status).toBe('SET_ASIDE');
    expect(r.classification).toBe('NO_BREACH');
  });
  it('does not auto-resolve a contradiction between similar authorities', () => {
    const r = run([iv('a', 'UNAVAILABLE', 0, 40), H(10, 20, 'b', { system: 'lb' }), H(-90, 0, 'h0'), H(45, 200, 'h1')], { clocks: exact('mon', 'lb') });
    expect(r.conflicts[0]).toMatchObject({ resolution: 'UNRESOLVED', setAside: ['a', 'b'] });
    expect(r.classification).toBe('INDETERMINATE');
    expect(r.bounds!.qualifyingDowntimeMs).toMatchObject({ min: 0, max: 45 * MIN });
  });
  it('a conclusion that holds without either contested record stands, and says so', () => {
    const r = run([iv('a', 'UNAVAILABLE', 0, 40), H(10, 20, 'b', { system: 'lb' }), iv('c', 'UNAVAILABLE', 0, 40, { system: 'probe' })], { clocks: exact('mon', 'lb', 'probe') });
    // 'c' still proves 40 min with 'a' and 'b' contradicting each other? c also conflicts with b → b vs c unresolved too.
    expect(r.conflicts.every((c) => c.resolution === 'UNRESOLVED')).toBe(true);
    const r2 = run([iv('a', 'UNAVAILABLE', 0, 40), pt('b', 'HEALTHY', 50, { system: 'lb' }), iv('c', 'UNAVAILABLE', 45, 80, { system: 'probe' }), H(-90, 0, 'h0')], { clocks: exact('mon', 'lb', 'probe') });
    expect(r2.conflicts[0]?.resolution).toBe('UNRESOLVED');
    expect(r2.classification).toBe('BREACH_CONFIRMED');
    expect(r2.reasons.join(' ')).toMatch(/holds with every contested record set aside/);
  });
  it('detects joint infeasibility across clocks and resolves it only by authority gap', () => {
    // Two exact-clock monitors bracket a recovery the engineering note puts inside the outage.
    const r = run([iv('a', 'UNAVAILABLE', 0, 40, { auth: 'SIGNED_MONITORING', sig: true }), pt('eng', 'HEALTHY', 37.5, { auth: 'ENGINEERING_INCIDENT_REPORT', system: 'desk', sj: 450 }), iv('b', 'UNAVAILABLE', 35, 60, { system: 'lb', clock: 'lb', auth: 'SIGNED_MONITORING', sig: true })], { clocks: [...exact('mon', 'desk'), { clockId: 'lb', knownOffsetMs: 0, uncertaintyMs: 5 * MIN }] });
    // eng's recovery instant lies in [30, 45]; a is down until 40 and b (±5 min) from no later than 40: no single pair
    // contradicts under every offset, but no offset leaves room for the recovery.
    expect(r.conflicts.filter((c) => c.type === 'STATE_CONTRADICTION')).toEqual([]);
    const j = r.conflicts.find((c) => c.type === 'JOINT_INFEASIBILITY');
    expect(j).toMatchObject({ resolution: 'RESOLVED_BY_AUTHORITY', setAside: ['eng'] });
    expect(r.evidence.find((e) => e.evidenceId === 'eng')!.issues.map((i) => i.code)).toContain('SET_ASIDE_JOINT_INFEASIBILITY');
  });
});

describe('TCF exclusions and windows', () => {
  const ev = () => [H(-90, 0, 'h1'), iv('d', 'UNAVAILABLE', 0, 35), H(35, 200, 'h2')];
  const c = contract({ maintenance: { noticeRequiredMs: 72 * 60 * MIN } });
  it('a confirmed, properly announced maintenance window is excluded', () => {
    const r = run(ev(), { contract: c, maintenance: [{ id: 'm', start: at(0), end: at(10), status: 'CONFIRMED', announcedAt: at(-80 * 60), reference: 'x' }] });
    expect(r.bounds!.qualifyingDowntimeMs).toMatchObject({ min: 25 * MIN, max: 25 * MIN });
    expect(r.classification).toBe('NO_BREACH');
  });
  it('an unconfirmed exclusion is enumerated: applied for the minimum, not for the maximum', () => {
    const r = run(ev(), { contract: c, maintenance: [{ id: 'm', start: at(0), end: at(10), status: 'UNCONFIRMED', reference: 'x' }] });
    expect(r.bounds!.qualifyingDowntimeMs).toMatchObject({ min: 25 * MIN, max: 35 * MIN });
    expect(r.classification).toBe('BREACH_POSSIBLE');
    expect(r.envelope.uncertain.flatMap((u) => u.causes.map((x) => x.type))).toContain('POSSIBLE_EXCLUSION');
  });
  it('late notice, other regions and contracts without maintenance terms never exclude', () => {
    const late = run(ev(), { contract: c, maintenance: [{ id: 'm', start: at(0), end: at(10), status: 'CONFIRMED', announcedAt: at(-60), reference: 'x' }] });
    expect(late.envelope.exclusions[0]!.status).toBe('NOT_APPLIED');
    const region = run(ev(), { contract: { ...c, scope: { service: 'api', region: 'eu' } }, maintenance: [{ id: 'm', start: at(0), end: at(10), status: 'CONFIRMED', announcedAt: at(-80 * 60), regions: ['us'], reference: 'x' }] });
    expect(region.envelope.exclusions[0]!.status).toBe('NOT_APPLIED');
    const noTerms = run(ev(), { maintenance: [{ id: 'm', start: at(0), end: at(10), status: 'CONFIRMED', announcedAt: at(-80 * 60), reference: 'x' }] });
    expect(noTerms.bounds!.qualifyingDowntimeMs.min).toBe(35 * MIN);
  });
  it('clips at the measurement window boundary', () => {
    const r = tcf.analyse({ contract: contract(), evidence: ev(), measurementWindow: W(10, 120), clocks: exact() });
    expect(r.bounds!.qualifyingDowntimeMs).toMatchObject({ min: 25 * MIN, max: 25 * MIN });
  });
  it('flapping recovery: longest continuous outage with a merge gap', () => {
    const fl = [H(-90, 0, 'h0'), iv('d1', 'UNAVAILABLE', 0, 20), H(20, 21, 'h1'), iv('d2', 'UNAVAILABLE', 21, 40, { record: 'd2' }), H(40, 200, 'h2')];
    const longest = contract({}, { metric: 'LONGEST_CONTINUOUS_DOWNTIME' });
    expect(run(fl, { contract: longest }).classification).toBe('NO_BREACH');
    const merged = contract({}, { metric: 'LONGEST_CONTINUOUS_DOWNTIME', episodeMergeGapMs: 5 * MIN, countMergedGaps: true });
    expect(run(fl, { contract: merged }).bounds!.qualifyingDowntimeMs.min).toBe(40 * MIN);
  });
  it('timezone boundary: a calendar-month contract measures the local month', () => {
    const cm = contract({}, { period: { type: 'CALENDAR_MONTH', timeZone: 'Asia/Tokyo' } });
    // 2026-03-31T15:00Z..16:00Z is April 1st 00:00–01:00 in Tokyo: outside the March window.
    const evd = [iv('d', 'UNAVAILABLE', 0, 0, {})].map(() => ({ ...iv('d', 'UNAVAILABLE', 0, 1), assertion: { kind: 'INTERVAL' as const, state: 'UNAVAILABLE' as const, start: { earliest: '2026-03-31T15:00:00Z', latest: '2026-03-31T15:00:00Z' }, end: { earliest: '2026-03-31T16:00:00Z', latest: '2026-03-31T16:00:00Z' } }, observedAt: '2026-03-31T16:01:00Z' }));
    const march = tcf.analyse({ contract: cm, evidence: evd, measurementWindow: { calendarMonth: '2026-03' }, clocks: exact() });
    const april = tcf.analyse({ contract: cm, evidence: evd, measurementWindow: { calendarMonth: '2026-04' }, clocks: exact() });
    // March (Tokyo) contains no evidence at all: the record is outside it, so March cannot be bounded.
    expect(march.evidence[0]!.issues.map((i) => i.code)).toContain('OUT_OF_WINDOW');
    expect(march.classification).toBe('INDETERMINATE');
    expect(april.window.measured?.start).toBe('2026-03-31T15:00:00Z');
    expect(april.bounds!.qualifyingDowntimeMs.min).toBe(60 * MIN);
  });
});
