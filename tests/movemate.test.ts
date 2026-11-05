import { describe, it, expect } from 'vitest';
import { assessMove, moveMatePack } from '../src/server/packs/movemate/pack.js';
import { makeEnv, startPack, answer, approveAll, executeAll, ackAll, finishReviews, missionRow, kinds, artifact, row, rows } from './helpers.js';

const S = () => moveMatePack.sample();
const flags = (a: ReturnType<typeof assessMove>) => Object.fromEntries(a.out.map((o) => [o.id, o.flags]));
/** Everything done, each evidence-requiring obligation with evidence. Expressed relative to baseline v1. */
const allDone = (s = S()) => ({ ...s.change, updates: [...s.plan.obligations.map((o: any) => ({ obligationId: o.id, status: 'done', ownerId: o.ownerId ?? 'b' })), ...s.plan.obligations.filter((o: any) => o.evidenceRequired).map((o: any) => ({ obligationId: o.id, addEvidence: { kind: 'photo', ref: `${o.id}.jpg` } }))] });

describe('MoveMate', () => {
  it('rejects invalid input', async () => {
    const env = makeEnv(); const s = S(); const bad: any = structuredClone(s.plan); bad.obligations = [];
    await expect(env.engine.createMission(env.maya, { packId: 'movemate', title: 'x', plan: bad })).rejects.toThrow(/obligations/);
    const r = await startPack(env, 'movemate');
    await expect(env.engine.submitChange(env.maya, r.id, { ...s.change, updates: [{ obligationId: 'ob_mail', status: 'finished' }] })).rejects.toThrow(/validation/);
    await expect(env.engine.submitChange(env.maya, r.id, { ...s.change, receivedOn: 'tomorrow' })).rejects.toThrow(/validation/);
  });

  it('derives deadlines with notice lead times and propagates them through dependencies', () => {
    const s = S(); const a = assessMove(s.plan, s.change); const o = Object.fromEntries(a.out.map((x) => [x.id, x]));
    expect(a.daysLeft).toBe(12); expect(flags(a).ob_internet).toEqual(['at_risk']); expect(o.ob_internet.latestStart).toBe('2026-11-01');   // 10 days' notice before 11-11
    expect(o.ob_clean.deadline).toBe('2026-11-12'); expect(o.ob_clean.effective).toBe('2026-11-05');                                        // inspection (11-12) needs 7d lead after cleaning
    expect(o.ob_bills.blockedBy).toEqual(['ob_meter']); expect(flags(a).ob_keys).toEqual(['unowned']);
    const late = assessMove(s.plan, { ...s.change, receivedOn: '2026-11-12' }); expect(flags(late).ob_internet).toEqual(['overdue']); expect(flags(late).ob_clean).toEqual(['overdue']);
    const moved = assessMove(s.plan, { ...s.change, leaseEndDate: '2026-11-10' }); expect(moved.out.find((x) => x.id === 'ob_bills')!.deadline).toBe('2026-11-10');
    const noEv: any = structuredClone(s.plan); noEv.obligations.find((x: any) => x.id === 'ob_meter').status = 'done'; expect(flags(assessMove(noEv, s.change)).ob_meter).toEqual(['missing_evidence']);
  });

  it('blocks on an unowned obligation and flags uncertain lease clauses without legal conclusions', async () => {
    const env = makeEnv(); const { id, state } = await startPack(env, 'movemate');
    expect(state()).toBe('blocked'); expect(missionRow(env, id).state_reason).toMatch(/keys/i); expect(rows(env, 'SELECT * FROM actions WHERE mission_id=?', id)).toHaveLength(0);
    await expect(answer(env, id, 'owner_ob_keys', 'the landlord')).rejects.toThrow(/Answer with one of/);
    await answer(env, id, 'owner_ob_keys', 'Leo'); expect(state()).toBe('awaiting_approval');
    const q = rows(env, "SELECT * FROM questions WHERE mission_id=? AND key LIKE 'clause_%'", id); expect(q.map((x) => x.key).sort()).toEqual(['clause_c_clean', 'clause_c_wear']); expect(q.every((x) => x.blocking === 0)).toBe(true);
    const findings = JSON.parse(row(env, "SELECT output FROM agent_runs WHERE mission_id=? AND role_key='lease' ORDER BY started_at DESC", id).output).findings;
    expect(findings.every((f: any) => /UNCERTAIN/.test(f.text) && f.needsHumanReview && /not legal advice/.test(f.text))).toBe(true);
    for (const k of ['move_checklist', 'landlord_email', 'evidence_status']) expect(artifact(env, id, k)).not.toMatch(/by law|legally (required|obliged)|entitled/i);
    expect(artifact(env, id, 'move_checklist')).toMatch(/not legal advice/i);
    expect(kinds(env, id)).toEqual(expect.arrayContaining(['artifact:utilities', 'artifact:cleaning_inspection', 'artifact:evidence_file', 'artifact:lease_review', 'artifact:checklist', 'artifact:landlord_comms']));
  });

  it('tracks dependencies as prerequisites and links shared evidence between tasks', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'movemate'); await answer(env, id, 'owner_ob_keys', 'Leo');
    const t = (k: string) => row(env, "SELECT * FROM work_items WHERE mission_id=? AND analysis_rev=? AND data LIKE ?", id, missionRow(env, id).analysis_rev, `%"key":"${k}"%`);
    expect(() => env.engine.updateWorkItem(env.maya, id, t('mm-ob_bills').id, 'done')).toThrow(/prerequisite/);       // final bills need the meter reading first
    expect(() => env.engine.updateWorkItem(env.maya, id, t('mm-ob_inspection').id, 'done')).toThrow(/prerequisite/);   // inspection needs the clean first
    expect(t('mm-util-readings').status).toBe('open'); expect(t('mm-deposit-meter').status).toBe('open');
    env.engine.updateWorkItem(env.maya, id, t('mm-ob_meter').id, 'done');
    expect(t('mm-util-readings').status).toBe('done'); expect(t('mm-deposit-meter').status).toBe('done');             // one piece of evidence satisfies two requirements
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='evidence_linked'", id)).toHaveLength(2);
    env.engine.updateWorkItem(env.maya, id, t('mm-ob_bills').id, 'done');
  });

  it('human confirmation gates every consequential action; completion needs ALL obligations done with evidence', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'movemate'); await answer(env, id, 'owner_ob_keys', 'Leo');
    expect(rows(env, "SELECT key FROM actions WHERE mission_id=? AND status='proposed'", id).map((a) => a.key).sort()).toEqual(['email_landlord', 'notify_roommates', 'publish_checklist']);
    const a = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='email_landlord'", id); await expect(env.engine.executeAction(env.maya, id, a.id)).rejects.toThrow(/only approved/);
    await expect(env.engine.decideApproval(env.actor('dan@harborvine.example'), id, row(env, 'SELECT id FROM approvals WHERE subject_id=?', a.id).id, 'approved', '')).rejects.toThrow(/manager/);
    await approveAll(env, id); await executeAll(env, id);
    expect(rows(env, 'SELECT status FROM actions WHERE mission_id=?', id).every((x) => x.status === 'verified')).toBe(true);
    expect(rows(env, "SELECT check_name FROM evidence WHERE mission_id=? AND kind='verification'", id).map((e) => e.check_name)).toEqual(expect.arrayContaining(['no legal conclusions', 'every obligation listed', 'not-legal-advice disclaimer present', 'move-out date stated']));
    ackAll(env, id); finishReviews(env, id);
    expect(() => env.engine.completeMission(env.maya, id)).toThrow(/Every move-out obligation is complete/);
    expect(missionRow(env, id).state).toBe('verifying');
  });

  it('follow-up check-in with evidence → new revision, identical landlord email is carried over (not re-sent), then completes', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'movemate'); await answer(env, id, 'owner_ob_keys', 'Leo'); await approveAll(env, id); await executeAll(env, id);
    const mail1 = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='email_landlord' AND status='verified'", id);
    await env.engine.submitChange(env.maya, id, allDone());
    const old = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='publish_checklist' AND analysis_rev=?", id, missionRow(env, id).analysis_rev - 1);
    expect(old.status).toBe('verified'); expect(old.stale_reason).toMatch(/outdated/);                      // already-executed effect is flagged outdated, never silently reused
    expect(rows(env, "SELECT * FROM actions WHERE mission_id=? AND key='publish_checklist' AND status='proposed'", id)).toHaveLength(1);
    const carried = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='email_landlord' AND status='verified' AND analysis_rev=?", id, missionRow(env, id).analysis_rev);
    expect(carried.idempotency_key).toBe(mail1.idempotency_key); expect(row(env, 'SELECT status FROM actions WHERE id=?', mail1.id).status).toBe('superseded');
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='action_carried_over'", id).length).toBeGreaterThanOrEqual(1);
    await approveAll(env, id); await executeAll(env, id); ackAll(env, id); finishReviews(env, id);
    env.engine.completeMission(env.maya, id);
    const b2 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=2', id).plan);
    expect(b2.obligations.every((o: any) => o.status === 'done')).toBe(true); expect(b2.obligations.find((o: any) => o.id === 'ob_keys').ownerId).toBe('b');
    expect(missionRow(env, id)).toMatchObject({ state: 'completed', current_baseline_version: 2 });
  });
});
