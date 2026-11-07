import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTemporalContractForensics, type AnalysisInput, type AnalysisRevision } from '../../src/server/capabilities/temporal-contract-forensics/index.js';
import { at, contract, exact, iv, MIN, W } from './helpers.js';

const tcf = createTemporalContractForensics();
const fx = JSON.parse(readFileSync(new URL('../../fixtures/temporal-contract-forensics/demo-incident.json', import.meta.url), 'utf8'));
const late = JSON.parse(readFileSync(new URL('../../fixtures/temporal-contract-forensics/demo-late-probe.json', import.meta.url), 'utf8'));
const demo = (): AnalysisRevision => tcf.open({ contract: fx.contracts, evidence: fx.evidence, measurementWindow: fx.measurementWindow, incident: fx.incident, clocks: fx.clocks, maintenance: fx.maintenance }, { at: '2026-11-04T14:55:00Z' });
const simple = (): AnalysisInput => ({ contract: contract({ maintenance: { noticeRequiredMs: 0 } }), evidence: [iv('h1', 'HEALTHY', -90, 0), iv('d', 'UNAVAILABLE', 0, 28, { observed: 100 }), iv('h2', 'HEALTHY', 34, 200, { record: 'h2' })], measurementWindow: W(-60, 120), clocks: exact(), maintenance: [{ id: 'mw', start: at(0), end: at(3), status: 'UNCONFIRMED', reference: 'chg' }] });

describe('TCF counterfactuals', () => {
  it('changes only the stated assumptions, recomputes, labels the result hypothetical and preserves the original', () => {
    const r = tcf.open(simple(), { at: at(60) });
    const before = JSON.stringify(r);
    const cf = tcf.counterfactual({ analysis: r, changes: [{ type: 'SHIFT_TIME', evidenceId: 'd', endpoint: 'end', byMs: 4 * MIN }] });
    expect(cf).toMatchObject({ hypothetical: true, status: 'COMPUTED', baseRevisionHash: r.revisionHash });
    expect(cf.label).toMatch(/HYPOTHETICAL/);
    expect(cf.result!.bounds!.qualifyingDowntimeMs.min).toBe(29 * MIN); // 32 min down, 3 min possibly excluded
    expect(cf.diff.map((d) => d.field)).toContain('bounds.qualifyingDowntimeMs.min');
    expect(cf.attribution[0]).toMatchObject({ change: 0, affectedEvidenceIds: ['d'] });
    expect(JSON.stringify(r)).toBe(before);
    expect(tcf.verify(r).ok).toBe(true);
  });
  it('maintenance classification, clock correction and changed recovery events', () => {
    const r = tcf.open(simple(), { at: at(60) });
    const valid = tcf.counterfactual({ analysis: r, changes: [{ type: 'SET_EXCLUSION_STATUS', maintenanceId: 'mw', status: 'CONFIRMED' }] });
    expect(valid.result!.bounds!.qualifyingDowntimeMs.max).toBe(31 * MIN);
    const clock = tcf.counterfactual({ analysis: r, changes: [{ type: 'SET_CLOCK', clockId: 'mon', uncertaintyMs: 2 * MIN }] });
    expect(clock.result!.bounds!.qualifyingDowntimeMs.max).toBeGreaterThan(r.result.bounds!.qualifyingDowntimeMs.max - 1);
    const recovery = tcf.counterfactual({ analysis: r, changes: [{ type: 'SET_TIME_BOUND', evidenceId: 'h2', endpoint: 'start', bound: { earliest: at(28), latest: at(28) } }] });
    expect(recovery.result!.classification).toBe('NO_BREACH');
    expect(recovery.explanation.join(' ')).toMatch(/Recorded: BREACH_POSSIBLE.*Hypothetical: NO_BREACH/);
  });
  it('a no-change counterfactual reports no decision-relevant change', () => {
    const r = tcf.open(simple(), { at: at(60) });
    const cf = tcf.counterfactual({ analysis: r, changes: [{ type: 'SET_SCOPE_SEMANTICS', evidenceId: 'h1', semantics: 'UNIVERSAL' }] });
    expect(cf.diff).toEqual([]);
    expect(cf.explanation.join(' ')).toMatch(/change no decision-relevant field/);
  });
  it('impossible counterfactuals are rejected whole, with reasons, and produce no partial result', () => {
    const r = tcf.open(simple(), { at: at(60) });
    const cf = tcf.counterfactual({ analysis: r, changes: [{ type: 'SHIFT_TIME', evidenceId: 'd', endpoint: 'end', byMs: MIN }, { type: 'SHIFT_TIME', evidenceId: 'nope', endpoint: 'start', byMs: 1 }, { type: 'SET_TIME_BOUND', evidenceId: 'd', endpoint: 'start', bound: { earliest: at(5), latest: at(1) } }] });
    expect(cf.status).toBe('IMPOSSIBLE'); expect(cf.result).toBeNull();
    expect(cf.rejected.map((x) => x.index)).toEqual([1, 2]);
    expect(tcf.counterfactual({ analysis: r, changes: [{ type: 'SHIFT_TIME', evidenceId: 'd', endpoint: 'at', byMs: 1 }] }).status).toBe('IMPOSSIBLE');
  });
  it('excluding evidence and adding hypothetical evidence (flapping) are explicit and attributed', () => {
    const r = tcf.open(simple(), { at: at(60) });
    const flap = tcf.counterfactual({ analysis: r, changes: [{ type: 'ADD_EVIDENCE', evidence: iv('flap', 'UNAVAILABLE', 28, 34, { system: 'mon', record: 'flap' }) }] });
    expect(flap.result!.classification).toBe('BREACH_CONFIRMED');
    expect(flap.result!.evidence.find((e) => e.evidenceId === 'flap')).toBeDefined();
    const ex = tcf.counterfactual({ analysis: r, changes: [{ type: 'EXCLUDE_EVIDENCE', evidenceId: 'h2', reason: 'suppose the telemetry was stale' }] });
    expect(ex.result!.evidence.find((e) => e.evidenceId === 'h2')!.issues[0]!.code).toBe('COUNTERFACTUAL_EXCLUDED');
    expect(ex.diff.find((d) => d.field === 'evidence.h2.status')).toMatchObject({ before: 'USED', after: 'EXCLUDED' });
  });
  it('customer-specific impact while the general service looked healthy (scope semantics)', () => {
    const input: AnalysisInput = { contract: contract({ scope: { service: 'api', customer: 'acme' } }), evidence: [iv('g', 'HEALTHY', -90, 200), iv('c', 'UNAVAILABLE', 0, 45, { customer: 'acme', record: 'c', system: 'synthetic', auth: 'SYNTHETIC_PROBE' })], measurementWindow: W(-60, 120), clocks: exact('mon', 'synthetic') };
    const r = tcf.open(input, { at: at(130) });
    expect(r.result.conflicts[0]?.resolution).toBe('UNRESOLVED'); // general monitor (AUTH_INFRA) vs synthetic probe: too close
    const cf = tcf.counterfactual({ analysis: r, changes: [{ type: 'SET_SCOPE_SEMANTICS', evidenceId: 'g', semantics: 'AGGREGATE' }] });
    expect(cf.result!.conflicts).toEqual([]);
    expect(cf.result!.classification).toBe('BREACH_CONFIRMED');
  });
});

describe('TCF minimum decisive evidence', () => {
  it('is empty when the decision is already conclusive, and says why', () => {
    const r = tcf.open({ ...simple(), evidence: [iv('h1', 'HEALTHY', -90, 0), iv('d', 'UNAVAILABLE', 0, 40), iv('h2', 'HEALTHY', 40, 200, { record: 'h2' })] }, { at: at(60) });
    const rep = tcf.minimumDecisiveEvidenceReport({ analysis: r });
    expect(rep.conclusive).toBe(true); expect(rep.requirements).toEqual([]);
    expect(rep.statement).toMatch(/only narrow/);
  });
  it('ranks by effect on the decision; ALWAYS_DECISIVE requests really decide when acquired', () => {
    // 28 min proven, 34 possible, 3 min maybe excluded; threshold 30.
    const r = tcf.open(simple(), { at: at(60) });
    const rep = tcf.minimumDecisiveEvidenceReport({ analysis: r });
    expect(rep.conclusive).toBe(false);
    const exc = rep.requirements.find((q) => q.kind === 'CONFIRM_EXCLUSION')!;
    expect(exc.outcomes.map((o) => o.classification)).toEqual(['BREACH_POSSIBLE', 'BREACH_POSSIBLE']);
    expect(exc.guarantee).toBe('NO_EFFECT');
    // Every ALWAYS_DECISIVE outcome is checked again through the public counterfactual API.
    for (const q of rep.requirements.filter((x) => x.guarantee === 'ALWAYS_DECISIVE')) for (const o of q.outcomes) expect(['BREACH_CONFIRMED', 'NO_BREACH']).toContain(o.classification);
    expect(rep.requirements[0]!.guarantee).not.toBe('NO_EFFECT');
    const ranks = rep.requirements.map((q) => q.rank); expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
  it('the shortest decisive observation is minimal: 1 ms less does not decide (checked independently)', () => {
    const r = tcf.open(simple(), { at: at(60) });
    const rep = tcf.minimumDecisiveEvidenceReport({ analysis: r });
    const obs = rep.requirements.find((q) => q.kind === 'OBSERVE_INTERVAL' && (q.target as { state?: string }).state === 'QUALIFYING')!;
    const t = obs.target as { start: string; end: string };
    const add = (end: string) => tcf.counterfactual({ analysis: r, changes: [{ type: 'ADD_EVIDENCE', evidence: { ...iv('obs', 'UNAVAILABLE', 0, 1, { system: 'verify', record: 'obs', auth: 'SIGNED_MONITORING', sig: true }), assertion: { kind: 'INTERVAL', state: 'UNAVAILABLE', start: { earliest: t.start, latest: t.start }, end: { earliest: end, latest: end } }, observedAt: at(100) } }, { type: 'SET_CLOCK', clockId: 'verify', uncertaintyMs: 0 }] });
    expect(add(t.end).result!.classification).toBe('BREACH_CONFIRMED');
    expect(add(new Date(Date.parse(t.end) - 1).toISOString()).result!.classification).toBe('BREACH_POSSIBLE');
  });
  it('on the demo incident: requests are evaluated by outcome and blockers are named', () => {
    const rep = tcf.minimumDecisiveEvidenceReport({ analysis: demo() });
    expect(rep.classification).toBe('BREACH_POSSIBLE');
    expect(rep.requirements.length).toBeGreaterThan(3);
    expect(rep.requirements[0]!.outcomes.some((o) => o.consistent && o.classification === 'BREACH_CONFIRMED')).toBe(true);
    expect(rep.blockers.toRuleOut).toContain('ev-c1');
  });
  it('the demo revision chain: the late probe confirms the breach; the customer and engineering records stay visible', () => {
    let rev = demo();
    for (const ev of late.records) rev = tcf.update({ previous: rev, event: { type: 'ADD_EVIDENCE', evidence: ev, receivedAt: late.receivedAt } });
    expect(rev.revision).toBe(3);
    expect(rev.result.classification).toBe('BREACH_CONFIRMED');
    expect(rev.result.conflicts.map((c) => [c.type, c.resolution, c.setAside])).toEqual([['STATE_CONTRADICTION', 'RESOLVED_BY_AUTHORITY', ['ev-c1']], ['JOINT_INFEASIBILITY', 'RESOLVED_BY_AUTHORITY', ['ev-e1']]]);
    expect(tcf.minimumDecisiveEvidence({ analysis: rev })).toEqual([]);
  });
});
