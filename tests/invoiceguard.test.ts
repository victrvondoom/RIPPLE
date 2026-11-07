import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { invoiceGuardPack, reconcile } from '../src/server/packs/invoiceguard/pack.js';
import { makeEnv, startPack, answer, approveAll, executeAll, ackAll, finishReviews, missionRow, kinds, artifact, row, rows } from './helpers.js';

const S = () => invoiceGuardPack.sample();
const codes = (p: any, c: any, a?: any) => reconcile(p, c, a).map((d) => d.code).sort();

describe('InvoiceGuard', () => {
  it('rejects invalid plans and invoices', async () => {
    const env = makeEnv(); const s = S(); const bad: any = structuredClone(s.plan); bad.milestones = [];
    await expect(env.engine.createMission(env.maya, { packId: 'invoiceguard', title: 'x', plan: bad })).rejects.toThrow(/milestones/);
    const r = await startPack(env, 'invoiceguard');
    await expect(env.engine.submitChange(env.maya, r.id, { ...s.change, total: -5 })).rejects.toThrow(/validation/);
    await expect(env.engine.submitChange(env.maya, r.id, { ...s.change, lines: [] })).rejects.toThrow(/validation/);
    await expect(env.engine.submitChange(env.maya, r.id, { ...s.change, invoiceDate: '2/11/2026' })).rejects.toThrow(/validation/);
  });

  it('classifies the ₹48,000 vs ₹40,000 example: variance, unaccepted deliverable, evidence gap, rate cap', async () => {
    const s = S();
    expect(codes(s.plan, s.change)).toEqual(['hours_exceed_evidence', 'rate_over_cap', 'total_exceeds_approved', 'unaccepted_deliverable', 'unmatched_line']);
    const d = reconcile(s.plan, s.change);
    expect(d.find((x) => x.code === 'total_exceeds_approved')!.amount).toBe(8000);
    expect(d.find((x) => x.code === 'hours_exceed_evidence')!.text).toMatch(/32h; only 30h .*W3: 2h has no evidence reference/);
    // arithmetic, duplicates, remaining-amount and quote-total checks
    expect(codes(s.plan, { ...s.change, total: 50000 })).toContain('total_mismatch');
    expect(codes({ ...s.plan, invoices: [{ invoiceNo: 'PF-2026-117' }] }, s.change)).toContain('duplicate_invoice');
    const billed: any = structuredClone(s.plan); billed.milestones[1].billedToDate = 25000;
    expect(codes(billed, s.change)).toContain('over_milestone');
    const nearCap: any = structuredClone(s.plan); nearCap.contract.quoteTotal = 60000;
    expect(codes(nearCap, s.change)).toContain('exceeds_quote_total');
    const pend: any = structuredClone(s.plan); pend.milestones[1].status = 'pending';
    expect(codes(pend, s.change)).toContain('milestone_not_approved');
  });

  it('runs the mission lifecycle: analysis, impact, work items, gated actions', async () => {
    const env = makeEnv(); const { id, state } = await startPack(env, 'invoiceguard');
    expect(state()).toBe('awaiting_approval');
    expect(kinds(env, id)).toEqual(expect.arrayContaining(['artifact:line_comparison', 'artifact:deliverable_acceptance', 'artifact:evidence_file', 'artifact:reconciliation', 'artifact:clarification', 'artifact:invoice_record']));
    const items = rows(env, 'SELECT * FROM work_items WHERE mission_id=?', id);
    expect(items.some((w) => w.kind === 'review' && w.role_key === 'human_reviewer')).toBe(true);
    expect(rows(env, "SELECT key FROM actions WHERE mission_id=? AND status='proposed'", id).map((a) => a.key).sort()).toEqual(['record_reconciliation', 'send_clarification']);
    const clar = artifact(env, id, 'clarification'); const rec = artifact(env, id, 'reconciliation_summary');
    expect(clar).not.toMatch(/fraud|scam|fake|cheat/i); expect(clar).toMatch(/would be grateful for your help/); expect(rec).toMatch(/No payment has been initiated/);
    const act = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='send_clarification'", id);
    await expect(env.engine.executeAction(env.maya, id, act.id)).rejects.toThrow(/only approved/);
  });

  it('explicit evidence link: completing the evidence request satisfies the attach-evidence item (audited)', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'invoiceguard');
    const req = row(env, "SELECT * FROM work_items WHERE mission_id=? AND title LIKE 'Obtain supporting%'", id); const att = row(env, "SELECT * FROM work_items WHERE mission_id=? AND title LIKE 'Attach received evidence%'", id);
    expect(att.status).toBe('open'); env.engine.updateWorkItem(env.maya, id, req.id, 'done');
    expect(row(env, 'SELECT status FROM work_items WHERE id=?', att.id).status).toBe('done');
    expect(rows(env, "SELECT summary FROM audit_events WHERE mission_id=? AND type='evidence_linked'", id)[0].summary).toMatch(/satisfied by evidence from/);
  });

  it('blocks on a foreign-currency invoice until a conversion rate is confirmed', async () => {
    const env = makeEnv(); const r = await startPack(env, 'invoiceguard', (c) => ({ ...c, currency: 'USD', total: 480, lines: [{ description: 'Milestone 2', milestoneId: 'M2', amount: 480, hours: 30, rate: 16 }] }));
    expect(r.state()).toBe('blocked'); expect(missionRow(env, r.id).state_reason).toMatch(/conversion rate/);
    expect(rows(env, 'SELECT * FROM actions WHERE mission_id=?', r.id)).toHaveLength(0);
    await expect(answer(env, r.id, 'fx_rate', 'abc')).rejects.toThrow(/positive number/);
    await answer(env, r.id, 'fx_rate', '83'); expect(r.state()).toBe('awaiting_approval');
    expect(artifact(env, r.id, 'line_comparison')).toMatch(/₹39,840/);       // 480 × 83 converted into the contract currency
  });

  it('executes, verifies wording/coverage, refuses completion until review+acks, records resolution without paying', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'invoiceguard');
    await approveAll(env, id); await executeAll(env, id);
    expect(rows(env, 'SELECT status FROM actions WHERE mission_id=?', id).filter((a) => a.status === 'verified')).toHaveLength(2);
    expect(rows(env, "SELECT check_name FROM evidence WHERE mission_id=? AND kind='verification'", id).map((e) => e.check_name)).toEqual(expect.arrayContaining(['neutral wording (no accusation)', 'every discrepancy recorded', 'states no payment was initiated', 'cites the invoice number']));
    await expect(env.engine.completeMission(env.maya, id)).rejects.toThrow(/acknowledgements|reviews/);
    ackAll(env, id); finishReviews(env, id); await env.engine.completeMission(env.maya, id);
    const b2 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=2', id).plan);
    expect(b2.invoices[0]).toMatchObject({ invoiceNo: 'PF-2026-117', status: 'clarification_requested' }); expect(b2.invoices[0].note).toMatch(/does not initiate payments/);
    expect(b2.milestones[1].billedToDate).toBe(0);          // disputed invoice is NOT booked as billed
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type LIKE '%payment%'", id)).toHaveLength(0);
  });

  it('accusatory wording injected into the sent clarification fails verification', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'invoiceguard'); await approveAll(env, id); await executeAll(env, id);
    const a = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='send_clarification'", id); const loc = JSON.parse(a.result).location;
    writeFileSync(loc, readFileSync(loc, 'utf8') + '\nThis looks like fraud.'); env.engine.verifyAction(env.maya, missionRow(env, id), a.id);
    expect(row(env, 'SELECT status FROM actions WHERE id=?', a.id).status).toBe('verification_failed');
  });

  it('a clean invoice needs only the reconciliation record and books the billed amount', async () => {
    const env = makeEnv(); const s = S(); const plan: any = structuredClone(s.plan);
    plan.deliverables.find((d: any) => d.id === 'D4').accepted = true; plan.worklogs[2].evidenceRef = 'timesheet-oct-w4.csv';
    const m = await env.engine.createMission(env.maya, { packId: 'invoiceguard', title: 'clean', plan }); env.engine.approveBaseline(env.maya, m.id, '');
    await env.engine.submitChange(env.maya, m.id, { ...s.change, total: 40000, lines: [{ description: 'Milestone 2', milestoneId: 'M2', amount: 40000, hours: 32, rate: 1200 }] });
    expect(rows(env, "SELECT key FROM actions WHERE mission_id=? AND status='proposed'", m.id).map((a) => a.key)).toEqual(['record_reconciliation']);
    await approveAll(env, m.id); await executeAll(env, m.id); ackAll(env, m.id); finishReviews(env, m.id); await env.engine.completeMission(env.maya, m.id);
    const b2 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=2', m.id).plan);
    expect(b2.invoices[0].status).toBe('reconciled_clean'); expect(b2.milestones[1].billedToDate).toBe(40000);
  });

  it('a corrected invoice supersedes queued actions (stale)', async () => {
    const env = makeEnv(); const { id, sample } = await startPack(env, 'invoiceguard'); await approveAll(env, id);
    await env.engine.submitChange(env.maya, id, { ...sample.change, invoiceNo: 'PF-2026-117-R1', lines: [sample.change.lines[0]], total: 40000 });
    expect(rows(env, "SELECT * FROM actions WHERE mission_id=? AND status='stale'", id)).toHaveLength(2);
  });
});
