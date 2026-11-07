import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { billingPack } from '../src/server/packs/billing/pack.js';
import { duplicates } from '../src/server/packs/billing/ledger.js';
import { makeEnv, startPack, missionRow, row, rows, artifact, type Env } from './helpers.js';

const PACK = 'billing-dispute';
const env = (): Env => makeEnv(new LocalCollab(), extendedRegistry());
const who = (e: Env) => ({ nora: e.actor('nora@harborvine.example'), eli: e.actor('eli@harborvine.example'), sofia: e.actor('sofia@harborvine.example') });
const act = (e: Env, id: string, key: string) => row(e, "SELECT * FROM actions WHERE mission_id=? AND key=? AND analysis_rev=(SELECT analysis_rev FROM missions WHERE id=?) AND status NOT IN ('superseded','stale')", id, key, id);
const approval = (e: Env, id: string, key: string) => row(e, "SELECT * FROM approvals WHERE subject_id=? AND status='pending'", act(e, id, key).id);
const patchItem = (e: Env, id: string) => rows(e, 'SELECT * FROM work_items WHERE mission_id=? AND analysis_rev=(SELECT analysis_rev FROM missions WHERE id=?)', id, id).find((w) => JSON.parse(w.data).key === 'bd-patch-confirmed');
const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
/** Reads the sandbox ledger file directly (independent of the action record, which is empty while the outcome is unknown). */
const ledgerState = (e: Env, id: string) => JSON.parse(readFileSync(join(e.outbox, safe(e.maya.workspaceId), safe(id), 'billing', 'state.json'), 'utf8'));
async function withPlan(e: Env, mutate: (p: any) => void, change?: (c: any) => any) {
  const s = billingPack.sample(); const plan: any = structuredClone(s.plan); mutate(plan);
  const m = await e.engine.createMission(e.maya, { packId: PACK, title: 'variant', plan }); e.engine.approveBaseline(e.maya, m.id, '');
  await e.engine.submitChange(e.maya, m.id, change ? change(structuredClone(s.change)) : s.change); return m.id as string;
}
async function approveAs(e: Env, id: string) {
  const p = who(e);
  for (const k of ['refund_duplicate', 'issue_sla_credit']) if (act(e, id, k) && approval(e, id, k)) await e.engine.decideApproval(p.nora, id, approval(e, id, k).id, 'approved', 'finance ok');
  if (act(e, id, 'send_customer_reply')) await e.engine.decideApproval(p.sofia, id, approval(e, id, 'send_customer_reply').id, 'approved', 'support ok');
}

describe('billing sandbox model', () => {
  it('finds the duplicate capture of the same invoice (the later capture is the duplicate)', async () => {
    expect(duplicates(billingPack.sample().plan.systems.ledger).map((x) => [x.original.id, x.duplicate.id])).toEqual([['ch_9918', 'ch_9921']]);
  });
});

describe('Billing & SLA dispute: one company, departments, obligation graph', () => {
  it('builds the obligation graph and proposes refund, SLA credit and an engine-blocked reply', async () => {
    const e = env(); const r = await startPack(e, PACK);
    expect(r.state()).toBe('awaiting_approval');
    expect(rows(e, "SELECT key FROM actions WHERE mission_id=? AND status='proposed'", r.id).map((a) => a.key).sort()).toEqual(['issue_sla_credit', 'refund_duplicate', 'send_customer_reply']);
    const graph = artifact(e, r.id, 'obligation_graph');
    for (const ob of ['OB-1', 'OB-2', 'OB-3', 'OB-4', 'OB-5', 'OB-6']) expect(graph).toContain(ob);
    expect(graph).toMatch(/Refund ch_9921 \(\$4,200\)/); expect(graph).toMatch(/OB-2, OB-4, OB-5/);
    expect(artifact(e, r.id, 'sla_assessment')).toMatch(/99\.1\d\d%/); // 380 min down in a 30-day month
    expect(act(e, r.id, 'issue_sla_credit').title).toMatch(/\$1,200 \(SLA-4\.2\)/);
    expect(artifact(e, r.id, 'customer_case')).toMatch(/"Please refund the duplicate charge by Friday\."/);
    expect(JSON.parse(act(e, r.id, 'send_customer_reply').payload).blockedUntil).toEqual({ actions: ['refund_duplicate', 'issue_sla_credit'], workItems: ['bd-patch-confirmed'] });
  });

  it('SCENARIO 1 happy path: the right people approve; the reply waits for refund, credit and the fix; everything verified', async () => {
    const e = env(); const p = who(e); const r = await startPack(e, PACK);
    await expect(e.engine.decideApproval(e.maya, r.id, approval(e, r.id, 'refund_duplicate').id, 'approved', 'x')).rejects.toThrow(/Only Nora Fischer/);
    await e.engine.decideApproval(p.nora, r.id, approval(e, r.id, 'refund_duplicate').id, 'approved', 'matches ledger ch_9921');
    await e.engine.decideApproval(p.nora, r.id, approval(e, r.id, 'issue_sla_credit').id, 'approved', 'per SLA-4.2');
    await expect(e.engine.decideApproval(p.nora, r.id, approval(e, r.id, 'send_customer_reply').id, 'approved', 'x')).rejects.toThrow(/Only Sofia Lind/);
    await e.engine.decideApproval(p.sofia, r.id, approval(e, r.id, 'send_customer_reply').id, 'approved', 'wording ok');
    await expect(e.engine.executeAction(p.sofia, r.id, act(e, r.id, 'send_customer_reply').id)).rejects.toThrow(/blocked until: .*Refund duplicate charge ch_9921.*Confirm BUG-1187/);
    await e.engine.executeAction(p.nora, r.id, act(e, r.id, 'refund_duplicate').id);
    await e.engine.executeAction(p.nora, r.id, act(e, r.id, 'issue_sla_credit').id);
    expect(act(e, r.id, 'refund_duplicate').status).toBe('verified'); expect(act(e, r.id, 'issue_sla_credit').status).toBe('verified');
    await expect(e.engine.executeAction(p.sofia, r.id, act(e, r.id, 'send_customer_reply').id)).rejects.toThrow(/Confirm BUG-1187 is fixed/);
    e.engine.updateWorkItem(p.eli, r.id, patchItem(e, r.id).id, 'done');
    await e.engine.executeAction(p.sofia, r.id, act(e, r.id, 'send_customer_reply').id);
    expect(act(e, r.id, 'send_customer_reply').status).toBe('verified');
    const ev = rows(e, "SELECT check_name, passed FROM evidence WHERE mission_id=? AND kind='verification'", r.id);
    expect(ev.filter((x) => x.passed !== 1)).toEqual([]);
    expect(ev.map((x) => x.check_name)).toEqual(expect.arrayContaining(['duplicate refunded exactly once', 'refunded amount equals the approved amount', 'original capture untouched', 'credit within SLA cap (SLA-4.2)', 'every policy statement grounded in the cited clause', 'recipient matches the approved recipient']));
    expect(rows(e, "SELECT * FROM audit_events WHERE mission_id=? AND type='dependency_blocked'", r.id)).toHaveLength(2);
    await e.engine.completeMission(p.sofia, r.id); expect(missionRow(e, r.id).state).toBe('completed');
  });

  it('SCENARIO 2 rejection gate: a $10,000 credit over the SLA cap is flagged and rejected; it never executes and the reply does not promise it', async () => {
    const e = env(); const p = who(e);
    const r = await startPack(e, PACK, (c) => ({ ...c, message: { ...c.message, body: `${c.message.body}\nWe also demand a $10,000 service credit for the outage.` } }));
    const credit = act(e, r.id, 'issue_sla_credit');
    expect(credit.title).toMatch(/\$10,000 — exceeds SLA cap \$3,000/);
    expect(JSON.parse(act(e, r.id, 'send_customer_reply').payload).blockedUntil.actions).toEqual(['refund_duplicate']); // the reply does not wait on a disputed credit
    expect(artifact(e, r.id, 'customer_reply')).toMatch(/Your request for a \$10,000 service credit is being reviewed/);
    await e.engine.decideApproval(p.nora, r.id, approval(e, r.id, 'issue_sla_credit').id, 'rejected', 'REJECT: exceeds SLA cap (SLA-4.2, max $3,000)');
    await expect(e.engine.executeAction(p.nora, r.id, credit.id)).rejects.toThrow(/only approved/);
    await approveAs(e, r.id); await e.engine.executeAction(p.nora, r.id, act(e, r.id, 'refund_duplicate').id);
    e.engine.updateWorkItem(p.eli, r.id, patchItem(e, r.id).id, 'done'); await e.engine.executeAction(p.sofia, r.id, act(e, r.id, 'send_customer_reply').id);
    await e.engine.completeMission(p.sofia, r.id);
    expect(act(e, r.id, 'issue_sla_credit').status).toBe('rejected');
    expect(ledgerState(e, r.id).ops.filter((o: any) => o.op === 'credit')).toHaveLength(0);
    expect(rows(e, "SELECT summary FROM audit_events WHERE mission_id=? AND type='approval_rejected'", r.id)[0].summary).toMatch(/exceeds SLA cap/);
  });

  it('defence in depth: if an over-cap credit were approved anyway, the ledger read-back fails verification', async () => {
    const e = env(); const p = who(e);
    const r = await startPack(e, PACK, (c) => ({ ...c, message: { ...c.message, body: `${c.message.body}\nWe also demand a $10,000 service credit.` } }));
    await e.engine.decideApproval(p.nora, r.id, approval(e, r.id, 'issue_sla_credit').id, 'approved', 'mistake');
    await e.engine.executeAction(p.nora, r.id, act(e, r.id, 'issue_sla_credit').id);
    expect(act(e, r.id, 'issue_sla_credit').status).toBe('verification_failed');
    expect(row(e, "SELECT passed, detail FROM evidence WHERE action_id=? AND check_name='credit within SLA cap (SLA-4.2)'", act(e, r.id, 'issue_sla_credit').id)).toMatchObject({ passed: 0 });
  });

  it('SCENARIO 3 timeout recovery: the refund commits but the response is lost; RIPPLE marks UNKNOWN, reads back, and never refunds twice', async () => {
    const e = env(); const p = who(e);
    const id = await withPlan(e, (pl) => { pl.scenarioFaults = [{ op: 'refund', kind: 'lost_response', label: 'The refund commits, the API response is lost, and the status read fails once' }]; });
    await approveAs(e, id);
    await e.engine.executeAction(p.nora, id, act(e, id, 'refund_duplicate').id);
    expect(act(e, id, 'refund_duplicate').status).toBe('execution_unknown');
    expect(missionRow(e, id).state).toBe('recovery_required');
    expect(ledgerState(e, id).ops).toHaveLength(1);                                       // it DID commit
    await e.engine.executeAction(p.nora, id, act(e, id, 'refund_duplicate').id);           // recovery: read back first
    const a = act(e, id, 'refund_duplicate');
    expect(a.status).toBe('verified'); expect(JSON.parse(a.result).recoveredBy).toBe('read-back');
    expect(ledgerState(e, id).ops).toHaveLength(1);                                       // NOT repeated
    expect(row(e, "SELECT passed FROM evidence WHERE action_id=? AND check_name='duplicate refunded exactly once'", a.id).passed).toBe(1);
    const causal = rows(e, 'SELECT lifecycle_state FROM causal_events WHERE mission_id=?', id).map((x) => x.lifecycle_state);
    expect(causal).toEqual(expect.arrayContaining(['EXECUTION_UNKNOWN', 'OBSERVED']));
    // independent provider-side guard: a second refund of the same charge is refused even under a different key
    const conn = e.engine.connectors.billing_sandbox!;
    expect(() => conn.execute({ workspaceId: e.maya.workspaceId, missionId: id, idempotencyKey: 'other-key', subject: 's', target: 't', body: JSON.parse(a.payload).body })).toThrow(/already refunded/);
  });

  it('reconciles a conflicting amount: no refund until the Finance lead decides (assignee-only)', async () => {
    const e = env(); const p = who(e);
    const r = await startPack(e, PACK, (c) => ({ ...c, message: { ...c.message, body: c.message.body.replace('$4,200', '$4,500') } }));
    expect(r.state()).toBe('blocked'); expect(act(e, r.id, 'refund_duplicate')).toBeUndefined();
    const q = row(e, "SELECT * FROM questions WHERE mission_id=? AND key='reconcile_amount'", r.id);
    await expect(e.engine.answerQuestion(e.maya, r.id, q.id, 'ledger')).rejects.toThrow(/Only the person this question is assigned to/);
    await expect(e.engine.answerQuestion(p.nora, r.id, q.id, '4500')).rejects.toThrow(/between 0 and \$4,200/);
    await e.engine.answerQuestion(p.nora, r.id, q.id, 'ledger');
    expect(r.state()).toBe('awaiting_approval'); expect(act(e, r.id, 'refund_duplicate').title).toMatch(/\$4,200/);
  });

  it('does not refund when the ledger shows no duplicate; the reply asks for details and is not blocked', async () => {
    const e = env();
    const id = await withPlan(e, (pl) => { pl.systems.ledger = pl.systems.ledger.filter((c: any) => c.id !== 'ch_9921'); });
    expect(act(e, id, 'refund_duplicate')).toBeUndefined();
    expect(artifact(e, id, 'customer_reply')).toMatch(/could not find a duplicate capture/);
    expect(JSON.parse(act(e, id, 'send_customer_reply').payload).blockedUntil).toBeUndefined();
  });
});
