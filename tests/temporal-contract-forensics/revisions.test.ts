import { describe, expect, it } from 'vitest';
import { createTemporalContractForensics, TcfInputError, type AnalysisInput } from '../../src/server/capabilities/temporal-contract-forensics/index.js';
import { at, contract, exact, iv, MIN, W } from './helpers.js';

const tcf = createTemporalContractForensics();
const base = (): AnalysisInput => ({ contract: contract(), evidence: [iv('h1', 'HEALTHY', -90, 0), iv('d', 'UNAVAILABLE', 0, 20), iv('h2', 'HEALTHY', 40, 200, { record: 'h2' })], measurementWindow: W(-60, 120), clocks: exact('mon', 'probe') });

describe('TCF versioned revisions', () => {
  it('creates hash-chained revisions with every required field', () => {
    const r1 = tcf.open(base(), { at: at(60) });
    expect(r1).toMatchObject({ revision: 1, parentRevisionHash: null, createdAt: at(60) });
    expect(r1.result.classification).toBe('BREACH_POSSIBLE');
    for (const h of [r1.revisionHash, r1.evidenceSetHash, r1.ledgerHash, r1.contractHash, r1.outputHash]) expect(h).toMatch(/^[0-9a-f]{64}$/);
    const r2 = tcf.update({ previous: r1, event: { type: 'ADD_EVIDENCE', evidence: iv('p', 'UNAVAILABLE', 20, 40, { system: 'probe' }), receivedAt: at(70), reason: 'regional probe backfill' } });
    expect(r2).toMatchObject({ revision: 2, parentRevisionHash: r1.revisionHash, reason: 'regional probe backfill' });
    expect(r2.result.classification).toBe('BREACH_CONFIRMED');
    expect(r2.changedFields.map((c) => c.field)).toEqual(expect.arrayContaining(['classification', 'bounds.qualifyingDowntimeMs.min']));
    expect(r2.changeSummary.join(' ')).toMatch(/BREACH_POSSIBLE → BREACH_CONFIRMED/);
    expect(tcf.verify(r1).ok).toBe(true); expect(tcf.verify(r2).ok).toBe(true);
  });
  it('repeated identical input gives identical hashes', () => {
    const a = tcf.open(base(), { at: at(60) }); const b = tcf.open(base(), { at: at(60) });
    expect(b.revisionHash).toBe(a.revisionHash); expect(b.outputHash).toBe(a.outputHash);
  });
  it('exact re-delivery of the same evidence is idempotent (same revision object)', () => {
    const r1 = tcf.open(base(), { at: at(60) });
    const ev = iv('p', 'UNAVAILABLE', 20, 40, { system: 'probe' });
    const r2 = tcf.update({ previous: r1, event: { type: 'ADD_EVIDENCE', evidence: ev, receivedAt: at(70) } });
    const r3 = tcf.update({ previous: r2, event: { type: 'ADD_EVIDENCE', evidence: { ...ev, ingestedAt: at(75) }, receivedAt: at(75) } });
    expect(r3).toBe(r2);
    expect(() => tcf.update({ previous: r2, event: { type: 'ADD_EVIDENCE', evidence: { ...ev, observedAt: at(50) }, receivedAt: at(75) } })).toThrow(/EVIDENCE_ID_CONFLICT/);
  });
  it('late-arriving evidence: incremental revisions end with the same output as one batch analysis, in any order', () => {
    const extra = [iv('p', 'UNAVAILABLE', 20, 30, { system: 'probe' }), iv('q', 'HEALTHY', 30, 40, { system: 'probe', record: 'q' })];
    const batch = tcf.open({ ...base(), evidence: [...base().evidence, ...extra] }, { at: at(60) });
    let inc = tcf.open(base(), { at: at(60) });
    for (const e of [...extra].reverse()) inc = tcf.update({ previous: inc, event: { type: 'ADD_EVIDENCE', evidence: e, receivedAt: at(80) } });
    expect(inc.outputHash).toBe(batch.outputHash);
    expect(inc.evidenceSetHash).toBe(batch.evidenceSetHash);
    expect(inc.revisionHash).not.toBe(batch.revisionHash); // different history, same facts
  });
  it('corrections supersede (never overwrite) and retractions need a reason; both stay visible', () => {
    const r1 = tcf.open(base(), { at: at(60) });
    const r2 = tcf.update({ previous: r1, event: { type: 'CORRECT_EVIDENCE', targetEvidenceId: 'd', corrected: iv('d.v2', 'UNAVAILABLE', 0, 35, { record: 'd' }), receivedAt: at(70), reason: 'raw log shows the outage ran to :35' } });
    expect(r2.ledger.find((l) => l.evidence.id === 'd')).toMatchObject({ status: 'SUPERSEDED', supersededBy: 'd.v2' });
    expect(r2.result.evidence.find((e) => e.evidenceId === 'd')!.issues[0]!.code).toBe('SUPERSEDED');
    expect(r2.result.bounds!.qualifyingDowntimeMs.min).toBe(35 * MIN);
    expect(() => tcf.update({ previous: r2, event: { type: 'RETRACT_EVIDENCE', evidenceId: 'h2', receivedAt: at(80), reason: ' ' } })).toThrow(TcfInputError);
    const r3 = tcf.update({ previous: r2, event: { type: 'RETRACT_EVIDENCE', evidenceId: 'h2', receivedAt: at(80), reason: 'probe was pointed at the wrong region' } });
    expect(r3.ledger).toHaveLength(r2.ledger.length);
    expect(r3.result.evidence.find((e) => e.evidenceId === 'h2')).toMatchObject({ status: 'EXCLUDED' });
    expect(r3.result.evidence.find((e) => e.evidenceId === 'h2')!.issues[0]).toMatchObject({ code: 'RETRACTED' });
    expect(r3.result.bounds!.qualifyingDowntimeMs.max).toBeGreaterThan(r2.result.bounds!.qualifyingDowntimeMs.max);
  });
  it('historical revisions stay reproducible and immutable; tampering is detected', () => {
    const r1 = tcf.open(base(), { at: at(60) });
    const r2 = tcf.update({ previous: r1, event: { type: 'ADD_EVIDENCE', evidence: iv('p', 'UNAVAILABLE', 20, 40, { system: 'probe' }), receivedAt: at(70) } });
    expect(Object.isFrozen(r1.result)).toBe(true);
    expect(() => { (r1.result as { classification: string }).classification = 'NO_BREACH'; }).toThrow();
    expect(tcf.verify(r1)).toEqual({ ok: true, problems: [] });
    const forged = { ...structuredClone(r2), result: { ...structuredClone(r2.result), classification: 'NO_BREACH' as const } };
    expect(tcf.verify(forged).ok).toBe(false);
    expect(() => tcf.update({ previous: forged, event: { type: 'ADD_EVIDENCE', evidence: iv('z', 'HEALTHY', 50, 60, { system: 'probe', record: 'z' }), receivedAt: at(90) } })).toThrow(/REVISION_INTEGRITY/);
    expect(() => tcf.update({ previous: r2, event: { type: 'ADD_EVIDENCE', evidence: iv('z', 'HEALTHY', 50, 60, { system: 'probe', record: 'z' }), receivedAt: at(65) } })).toThrow(/REVISION_ORDER/);
  });
});
