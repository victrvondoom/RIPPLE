import { describe, it, expect } from 'vitest';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { seedWorkspace } from '../src/server/seed.js';
import { buildManifest, disclose, verifyDisclosure, type DisclosableRecord } from '../src/server/capabilities/disclose/manifest.js';
import { sealReceipt, verifyReceipt } from '../src/server/capabilities/verify/receipt.js';
import { routeImpact } from '../src/server/capabilities/route/impact.js';
import { evaluateDecision, parseStrictDecision } from '../src/server/collab/authority.js';
import { investigate, intakeView, resolution } from '../src/server/packs/incident/pack.js';
import { makeEnv, row, rows, actorById, type Env } from './helpers.js';

/** Session 21 flagship: deterministic domain model, capabilities and engine semantics in LOCAL mode (labelled). */
const PACK = 'incident-resolution';
const sample = (env: Env) => env.packs.get(PACK)!.sample();
async function openCase(env: Env, mutate?: (s: ReturnType<typeof sample>) => void) {
  const s = sample(env); mutate?.(s);
  const m = await env.engine.createMission(env.maya, { packId: PACK, title: s.title, plan: s.plan });
  env.engine.approveBaseline(env.maya, m.id, 'b');
  await env.engine.submitChange(env.maya, m.id, s.change);
  return m.id as string;
}
const who = (env: Env, email: string) => env.actor(email);
async function decideAll(env: Env, id: string) {
  for (const ap of rows(env, "SELECT * FROM approvals WHERE mission_id=? AND status='pending' ORDER BY slot", id)) await env.engine.decideApproval(actorById(env, ap.approver_user_id), id, ap.id, 'approved', 'ok');
}
async function runCase(env: Env, id: string) {
  await decideAll(env, id);
  for (const k of ['refund_duplicate', 'issue_sla_credit']) {
    const a = row(env, "SELECT * FROM actions WHERE mission_id=? AND key=? AND status IN ('approved','execution_unknown') ORDER BY analysis_rev DESC", id, k);
    if (!a) continue;
    await env.engine.executeAction(env.maya, id, a.id);
    const again = row(env, 'SELECT status FROM actions WHERE id=?', a.id);
    if (again.status === 'execution_unknown') await env.engine.executeAction(env.maya, id, a.id);
  }
  for (const w of rows(env, "SELECT * FROM work_items WHERE mission_id=? AND status='open' AND analysis_rev=(SELECT analysis_rev FROM missions WHERE id=?) ORDER BY created_at", id, id)) env.engine.updateWorkItem(who(env, 'eli@harborvine.example'), id, w.id, 'done');
  const reply = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='send_customer_reply' AND status='approved'", id);
  if (reply) await env.engine.executeAction(env.maya, id, reply.id);
  await env.engine.completeMission(env.maya, id);
}

describe('incident domain model (deterministic, from fixture rows)', () => {
  const env = makeEnv(undefined, extendedRegistry()); const s = sample(env);
  it('computes SLA downtime by the contract rule: threshold, maintenance exclusion, bounded gap, contradiction', () => {
    const inv = investigate(s.plan);
    expect(inv.certainMin).toBe(335);                       // MON-01 100 + MON-03 85 + MON-04 150; MON-02 (3.1%) below threshold
    expect(inv.inferredMin).toBe(15);                       // GAP-01 bounded by errors on both sides
    expect(inv.intervals.find((x) => x.id === 'MON-00')!.why).toMatch(/excluded: scheduled maintenance MW-1102/);
    expect(inv.est.uptime.toFixed(3)).toBe('99.190');
    expect(inv.tierSensitive).toBe(false);
    expect(inv.contradictions[0]).toMatchObject({ id: 'STAT-2', minutes: 30 });
    expect(inv.affected).toEqual(['checkout-api', 'payments-webhook']);
  });
  it('extracts the request, the overdue promise, contradictory amounts, injection and missing information', () => {
    const ik = intakeView(s.plan, s.change);
    expect(ik.requests[0]!.evidenceText).toMatch(/refund the duplicate charge by Friday/);
    expect(ik.promises[0]).toMatchObject({ sourceMessageId: 'SUP-881', state: 'OVERDUE' });
    expect(ik.chargeAmounts.map((a) => a.amount)).toEqual([4200, 4250]);
    expect(ik.requestedCredit).toBe(3600);
    expect(ik.untrusted.length).toBeGreaterThan(0);
    expect(ik.missing[0]).toMatch(/\$4,250/);
  });
  it('proposes the ledger refund and the capped policy credit, never the customer figures', () => {
    const r = resolution(s.plan, s.change);
    expect(r.dup!.duplicate.id).toBe('ch_9921');
    expect(r.refund).toBe(4200); expect(r.credit).toBe(1200); expect(r.cap).toBe(3000); expect(r.overCap).toBe(true);
    expect(r.captureInWindow).toBe(true);
  });
  it('asks Legal (blocking) when the tier depends on an uncertain gap, and invents no entitlement', async () => {
    const e = makeEnv(undefined, extendedRegistry());
    const id = await openCase(e, (x) => { x.plan.systems.monitoringGaps[0]!.to = '2026-11-04T18:00:00Z'; x.plan.systems.monitoring = x.plan.systems.monitoring.filter((m: any) => m.id !== 'MON-04'); x.plan.contract.tiers = [{ below: 99.9, creditPct: 10 }, { below: 99.15, creditPct: 25 }]; });
    expect(row(e, 'SELECT state FROM missions WHERE id=?', id).state).toBe('blocked');
    const q = row(e, "SELECT * FROM questions WHERE mission_id=? AND key='count_monitoring_gap'", id);
    expect(q.assignee_user_id).toBe(who(e, 'lena@harborvine.example').id);
    expect(rows(e, "SELECT * FROM actions WHERE mission_id=? AND key='issue_sla_credit'", id).length).toBe(0);
    await expect(e.engine.answerQuestion(e.maya, id, q.id, 'yes')).rejects.toMatchObject({ status: 403 });   // only Legal
  });
});

describe('selective evidence disclosure (Merkle manifest)', () => {
  const recs: DisclosableRecord[] = [
    { id: 'MON-01', kind: 'monitor_interval', source: 'm', room: 'investigation', content: 'checkout down 64%' },
    { id: 'ch_9921', kind: 'ledger_row', source: 'l', room: 'finance', content: 'ch_9921 4200' },
    { id: 'SLA-4.2', kind: 'contract_clause', source: 'c', room: 'policy', content: 'credits capped at 25%' },
  ];
  const { manifest } = buildManifest(recs, 'secret-1');
  it('a disclosed record proves membership without revealing the others', () => {
    const d = disclose(recs, 'secret-1', ['MON-01']);
    expect(verifyDisclosure(manifest, d, ['MON-01']).ok).toBe(true);
    expect(JSON.stringify(d)).not.toContain('ch_9921');
  });
  it('refuses forged, modified, incomplete and unrelated evidence', () => {
    const d = disclose(recs, 'secret-1', ['MON-01']);
    const modified = [{ ...d[0]!, record: { ...d[0]!.record, content: 'checkout down 12%' } }];
    expect(verifyDisclosure(manifest, modified, ['MON-01']).items[0]!.reason).toMatch(/forged or modified/);
    const forged = [{ ...d[0]!, record: { id: 'MON-99', kind: 'monitor_interval', source: 'm', room: 'investigation', content: 'fake' } }];
    expect(verifyDisclosure(manifest, forged, ['MON-99']).ok).toBe(false);
    const truncated = [{ ...d[0]!, proof: d[0]!.proof.slice(0, 1) }];
    expect(verifyDisclosure(manifest, truncated, ['MON-01']).items[0]!.reason).toMatch(/incomplete/);
    expect(verifyDisclosure(manifest, d, ['MON-01', 'SLA-4.2']).problems[0]).toMatch(/incomplete: requested record SLA-4.2/);
    const other = buildManifest([{ ...recs[0]!, content: 'other case' }, recs[2]!], 'secret-2');
    const unrelated = disclose([{ ...recs[0]!, content: 'other case' }, recs[2]!], 'secret-2', ['MON-01']);
    expect(verifyDisclosure(manifest, unrelated, ['MON-01']).ok).toBe(false);
    expect(verifyDisclosure(other.manifest, unrelated, ['MON-01']).ok).toBe(true);
    expect(verifyDisclosure(manifest, disclose(recs, 'secret-1', ['SLA-4.2']), ['MON-01']).items[0]!.reason).toMatch(/unrelated/);
  });
  it('the engine discloses only what a room may see; restricted ledger rows stay in Finance', async () => {
    const env = makeEnv(undefined, extendedRegistry()); const id = await openCase(env);
    const d = env.engine.cases.discloseEvidence(env.maya, id, ['MON-03'], 'policy', 'Was checkout down at 12:41?');
    expect(env.engine.cases.verifyDisclosure(d.root, d.count, d.disclosures, ['MON-03']).ok).toBe(true);
    expect(() => env.engine.cases.discloseEvidence(env.maya, id, ['ch_9921'], 'policy', 'amount?')).toThrow(/restricted room/);
    expect(() => env.engine.cases.discloseEvidence(env.maya, id, ['nope'], 'policy', 'x')).toThrow(/not in this case/);
    expect(() => env.engine.cases.discloseEvidence(env.vera, id, ['MON-03'], 'policy', 'x')).toThrow(/Viewers/);
  });
});

describe('receipts, routing and authority (pure)', () => {
  it('a sealed receipt detects any edited byte', () => {
    const r = sealReceipt({ a: 1, b: { c: [1, 2] } });
    expect(verifyReceipt(r).ok).toBe(true);
    expect(verifyReceipt({ ...r, body: { a: 1, b: { c: [1, 3] } } }).ok).toBe(false);
    expect(verifyReceipt({ ...r, sectionRoot: 'f'.repeat(64) }).reason).toMatch(/Merkle/);
  });
  it('routes only the people whose decisions changed and names who is not interrupted', () => {
    const plan = routeImpact({ rev: 2, current: [{ key: 'refund', title: 'Refund', payloadHash: 'h1', approverRoles: ['fin'], room: 'finance', department: 'Finance' }, { key: 'credit', title: 'Credit', payloadHash: 'h3', approverRoles: ['fin'], room: 'finance', department: 'Finance' }],
      previous: [{ key: 'refund', title: 'Refund', payloadHash: 'h1', approverRoles: ['fin'], room: 'finance', department: 'Finance', status: 'stale', approved: true }, { key: 'credit', title: 'Credit', payloadHash: 'h2', approverRoles: ['fin'], room: 'finance', department: 'Finance', status: 'stale', approved: true }],
      impactedArtifacts: [], teams: [{ department: 'Finance', room: 'finance', roles: ['fin'] }, { department: 'Engineering', room: 'inv', roles: ['eng'] }], openQuestions: [] });
    expect(plan.carriedOver).toEqual(['Refund']); expect(plan.blockingApprovals).toEqual(['Credit']); expect(plan.notInterrupted).toEqual(['Engineering']);
  });
  it('strict grammar binds to a 64-hex hash; the authority check is fail-closed on missing facts', () => {
    expect(parseStrictDecision('approve RPL-ABC123 A-00FF11 ' + 'a'.repeat(64))).toMatchObject({ verb: 'approve', hash: 'a'.repeat(64) });
    expect(parseStrictDecision('APPROVE RPL-ABC123 A-00FF11')).toMatchObject({ hash: null });
    expect(parseStrictDecision('please approve RPL-ABC123 A-00FF11')).toBeNull();
    const codes = evaluateDecision({ message: { senderId: '', senderName: 'nora' }, roster: null, agentNames: [], pinned: null, decision: parseStrictDecision('APPROVE RPL-ABC123 A-00FF11')!, mission: { caseRef: 'RPL-ABC123', analysisRev: 1 }, approval: { status: 'pending', analysisRev: 1, expiresAt: null, payloadHash: 'b'.repeat(64), decisionRoomId: 'r1' }, now: new Date().toISOString() }).map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['unverifiable_identity', 'not_room_member', 'identity_not_pinned', 'wrong_room', 'hash_missing']));
    const exp = evaluateDecision({ message: { senderId: '@u', senderName: 'nora', roomId: 'r1' }, roster: [{ id: 'x', name: 'nora', type: 'user' }], agentNames: [], pinned: { userId: 'u', switchName: 'nora', chatUsername: 'nora' }, decision: parseStrictDecision('APPROVE RPL-ABC123 A-00FF11 ' + 'b'.repeat(64))!, mission: { caseRef: 'RPL-ABC123', analysisRev: 1 }, approval: { status: 'pending', analysisRev: 1, expiresAt: '2000-01-01T00:00:00Z', payloadHash: 'b'.repeat(64), decisionRoomId: 'r1' }, now: new Date().toISOString() }).map((r) => r.code);
    expect(exp).toEqual(['expired']);
  });
});

describe('flagship engine semantics (LOCAL mode, labelled)', () => {
  it('runs end to end: two-person control, lost response without a duplicate, verifier PASS, early completion refused', async () => {
    const env = makeEnv(undefined, extendedRegistry()); const id = await openCase(env);
    await expect(env.engine.completeMission(env.maya, id)).rejects.toMatchObject({ code: 'criteria_unmet' });
    const s1 = row(env, "SELECT * FROM approvals WHERE mission_id=? AND title LIKE 'Approve: Refund%'", id);
    const s2 = row(env, "SELECT * FROM approvals WHERE mission_id=? AND title LIKE 'Second approval%'", id);
    const nora = who(env, 'nora@harborvine.example');
    await env.engine.decideApproval(nora, id, s1.id, 'approved', 'ok');
    await expect(env.engine.decideApproval(nora, id, s2.id, 'approved', 'again')).rejects.toMatchObject({ status: 403 });
    await expect(env.engine.executeAction(env.maya, id, s1.subject_id)).rejects.toMatchObject({ code: 'not_approved' });   // one of two people approved
    await env.engine.decideApproval(who(env, 'iris@harborvine.example'), id, s2.id, 'approved', 'ok');
    expect(row(env, 'SELECT decided_via FROM approvals WHERE id=?', s2.id).decided_via).toBe('ripple-ui');
    await runCase(env, id);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('completed');
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='action_unknown'", id).length).toBe(1);
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='action_effect_observed'", id).length).toBe(1);
    expect(row(env, "SELECT result FROM case_receipts WHERE mission_id=? AND kind='verifier' ORDER BY rowid DESC", id).result).toBe('PASS');
    expect(rows(env, "SELECT * FROM room_documents WHERE mission_id=? AND kind='resolution_receipt'", id).length).toBe(2);   // verified-resolution + final
    expect(rows(env, "SELECT * FROM rooms WHERE mission_id=? AND mode='local'", id).length).toBe(5);
  });

  it('carries a granted approval over only for a byte-identical payload; nobody is re-asked', async () => {
    const env = makeEnv(undefined, extendedRegistry()); const id = await openCase(env);
    await decideAll(env, id);
    const s = sample(env);
    await env.engine.submitChange(env.maya, id, { ...s.change, message: { ...s.change.message, id: 'em-402-2', body: `${s.change.message.body}\nFollow-up: please hurry.` } });
    const rev = row(env, 'SELECT analysis_rev FROM missions WHERE id=?', id).analysis_rev;
    const carried = rows(env, 'SELECT a.*, x.key FROM approvals a JOIN actions x ON x.id=a.subject_id WHERE a.mission_id=? AND a.analysis_rev=? AND a.carried_from IS NOT NULL', id, rev);
    // every payload is byte-identical (the follow-up changes nothing the actions say), so every granted approval carries over
    expect(carried.map((c) => c.key).sort()).toEqual(['issue_sla_credit', 'refund_duplicate', 'refund_duplicate', 'send_customer_reply']);
    const route = JSON.parse(row(env, 'SELECT body FROM impact_routes WHERE mission_id=? AND analysis_rev=?', id, rev).body);
    expect(route.carriedOver.length).toBe(3);
    expect(route.deciders).toEqual([]);                          // nobody is re-asked
    expect(rows(env, "SELECT * FROM actions WHERE mission_id=? AND analysis_rev=? AND status='approved'", id, rev).length).toBe(3);
  });

  it('the independent verifier FAILs a tampered payload and issues a work order; completion stays refused', async () => {
    const env = makeEnv(undefined, extendedRegistry()); const id = await openCase(env);
    await decideAll(env, id);
    const credit = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='issue_sla_credit'", id);
    env.db.exec('UPDATE actions SET payload_hash=? WHERE id=?', 'f'.repeat(64), credit.id);   // someone edits the record after approval
    const refund = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='refund_duplicate'", id);
    await env.engine.executeAction(env.maya, id, refund.id); await env.engine.executeAction(env.maya, id, refund.id);
    await env.engine.executeAction(env.maya, id, credit.id);
    const vr = row(env, "SELECT * FROM case_receipts WHERE mission_id=? AND kind='verifier' ORDER BY rowid DESC", id);
    expect(vr.result).toBe('FAIL');
    const wo = JSON.parse(vr.body).workOrder;
    expect(wo.some((w: any) => /executed payload equals the approved payload/.test(w.check) && w.owner === 'ir_finance')).toBe(true);
    expect(env.engine.completionPreview(env.maya, id).checks.find((c) => c.key === 'independent_verifier')!.passed).toBe(false);
    const reply = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='send_customer_reply'", id);
    for (const w of rows(env, "SELECT * FROM work_items WHERE mission_id=? AND status='open'", id)) env.engine.updateWorkItem(who(env, 'eli@harborvine.example'), id, w.id, 'done');
    await expect(env.engine.executeAction(env.maya, id, reply.id)).rejects.toMatchObject({ code: 'verifier_required' });
  });

  it('memory from a completed case changes the next case: no second refund, recurring failure blocks the reply, outdated policy facts are not applied', async () => {
    const env = makeEnv(undefined, extendedRegistry()); const first = await openCase(env); await runCase(env, first);
    const mem = rows(env, 'SELECT kind, status FROM memory_items WHERE pack_id=?', PACK);
    expect(mem.map((m) => m.kind).sort()).toEqual(['commitment', 'failure_pattern', 'refund', 'sla_credit']);
    const second = await openCase(env);
    expect(rows(env, "SELECT * FROM actions WHERE mission_id=? AND key='refund_duplicate'", second).length).toBe(0);
    expect(rows(env, "SELECT * FROM work_items WHERE mission_id=? AND title LIKE '%regression test%'", second).length).toBe(1);
    const reply = row(env, "SELECT payload FROM actions WHERE mission_id=? AND key='send_customer_reply'", second);
    expect(JSON.parse(reply.payload).blockedUntil.workItems).toContain('ir-regression-test');
    expect(row(env, "SELECT body FROM messages WHERE mission_id=? AND sender_name='SLA & Policy Analyst' AND kind='finding'", second).body).toMatch(/1 item|recorded fact|10% tier/);
    const policyFinding = rows(env, "SELECT body FROM messages WHERE mission_id=? AND kind='finding'", second).map((x) => x.body).join('\n');
    expect(policyFinding).toMatch(/Memory \[recorded fact/);
    // an outdated fact (contract version changed) is labelled and NOT applied
    const third = await openCase(env, (x) => { x.plan.policies.find((p: any) => p.id === 'SLA-4.2').version = '6'; });
    expect(rows(env, "SELECT body FROM messages WHERE mission_id=? AND kind='finding'", third).map((x) => x.body).join('\n')).toMatch(/OUTDATED/);
  });

  it('isolates workspaces: receipts, disclosures and memory never cross tenants', async () => {
    const env = makeEnv(undefined, extendedRegistry()); const id = await openCase(env); await runCase(env, id);
    const other = seedWorkspace(env.db, env.packs, { name: 'Other Co', password: 'pw-other-123', emailDomain: 'other.example' });
    const outsider = env.actor('maya@other.example');
    expect(outsider.workspaceId).toBe(other.workspaceId);
    const rc = row(env, "SELECT id FROM case_receipts WHERE mission_id=? AND kind='final'", id);
    expect(() => env.engine.cases.verifyStoredReceipt(outsider.workspaceId, rc.id)).toThrow(/not found/i);
    expect(() => env.engine.cases.discloseEvidence(outsider, id, ['MON-01'], 'policy', 'x')).toThrow(/not found/i);
    expect(env.engine.cases.memoryFor(outsider.workspaceId, env.packs.get(PACK)!).length).toBe(0);
  });
});
