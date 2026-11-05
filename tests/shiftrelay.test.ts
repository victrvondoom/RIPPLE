import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { assess, shiftRelayPack } from '../src/server/packs/shiftrelay/pack.js';
import { makeEnv, startPack, answer, approveAll, executeAll, ackAll, finishReviews, missionRow, kinds, artifact, row, rows, actorById } from './helpers.js';

const S = () => shiftRelayPack.sample();

describe('ShiftRelay', () => {
  it('rejects invalid input', async () => {
    const env = makeEnv(); const s = S(); const bad: any = structuredClone(s.plan); bad.jobs = [];
    await expect(env.engine.createMission(env.maya, { packId: 'shiftrelay', title: 'x', plan: bad })).rejects.toThrow(/jobs/);
    const r = await startPack(env, 'shiftrelay');
    await expect(env.engine.submitChange(env.maya, r.id, { ...s.change, handoverAt: '4 Nov 5pm' })).rejects.toThrow(/YYYY-MM-DDTHH:MM/);
    await expect(env.engine.submitChange(env.maya, r.id, { ...s.change, updates: [{ jobId: 'J-1', status: 'maybe' }] })).rejects.toThrow(/validation/);
  });

  it('scores urgency transparently and detects the omitted job', () => {
    const s = S(); const a = Object.fromEntries(assess(s.plan, s.change).map((x) => [x.id, x]));
    expect(a['J-102']).toMatchObject({ level: 'critical', score: 7, unreported: false }); expect(a['J-102'].reasons.join()).toMatch(/SLA in 3h.*missing part: Igniter module HW-22.*callback promised/);
    expect(a['J-101'].level).toBe('high'); expect(a['J-103'].resolved).toBe(true);
    expect(a['J-104']).toMatchObject({ unreported: true, level: 'medium' });
    const breached = assess({ ...s.plan, jobs: s.plan.jobs.map((j: any) => (j.id === 'J-101' ? { ...j, slaDeadline: '2026-11-04T09:00' } : j)) }, s.change).find((x) => x.id === 'J-101')!;
    expect(breached.reasons.join()).toMatch(/SLA already breached/); expect(breached).toMatchObject({ score: 5, level: 'high' });
  });

  it('blocks on the omitted job, keeps all unresolved items visible, and routes ownership', async () => {
    const env = makeEnv(); const { id, state } = await startPack(env, 'shiftrelay');
    expect(state()).toBe('blocked'); expect(missionRow(env, id).state_reason).toMatch(/J-104/);
    expect(rows(env, 'SELECT * FROM actions WHERE mission_id=?', id)).toHaveLength(0);
    await expect(answer(env, id, 'status_J-104', 'who knows')).rejects.toThrow(/open, in progress/);
    await answer(env, id, 'status_J-104', 'in progress'); expect(state()).toBe('awaiting_approval');
    expect(kinds(env, id)).toEqual(expect.arrayContaining(['artifact:handover_note', 'artifact:job_board', 'artifact:parts_order', 'artifact:callback_log', 'artifact:escalation']));
    const own = rows(env, "SELECT * FROM work_items WHERE mission_id=? AND analysis_rev=? AND title LIKE 'Take ownership%'", id, missionRow(env, id).analysis_rev);
    expect(own.map((w) => w.title.match(/J-\d+/)![0]).sort()).toEqual(['J-101', 'J-102', 'J-104']); expect(own.every((w) => w.role_key === 'human_incoming' && w.due)).toBe(true);
    expect(own.find((w) => /J-102/.test(w.title))!.due).toBe('2026-11-04T20:00');          // SLA is the next deadline
    expect(rows(env, "SELECT * FROM work_items WHERE mission_id=? AND kind='review'", id).map((w) => w.title).join()).toMatch(/callback to Cedar Court Management/);
    expect(rows(env, "SELECT key FROM actions WHERE mission_id=? AND status='proposed'", id).map((a) => a.key).sort()).toEqual(['escalate', 'notify_incoming', 'publish_handover']);
    expect(rows(env, "SELECT * FROM questions WHERE mission_id=? AND key='eta_J-102'", id)[0].blocking).toBe(0);
  });

  it('is NOT complete when the handover document merely exists: both owners must acknowledge and callbacks be confirmed', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'shiftrelay'); await answer(env, id, 'status_J-104', 'blocked');
    await approveAll(env, id); await executeAll(env, id);
    expect(rows(env, "SELECT status FROM actions WHERE mission_id=?", id).every((a) => a.status === 'verified')).toBe(true);
    expect(missionRow(env, id).state).toBe('verifying');
    const note = artifact(env, id, 'handover_note'); expect(note).toMatch(/UNRESOLVED \(3\)/); expect(note).toMatch(/Omar Reyes/);
    expect(() => env.engine.completeMission(env.maya, id)).toThrow(/acknowledgements/);
    const pending = rows(env, "SELECT user_id FROM acknowledgements WHERE mission_id=? AND status='pending'", id).map((k) => actorById(env, k.user_id).name).sort();
    expect(pending).toEqual(['Jo Park', 'Omar Reyes', 'Tess Kim']);
    ackAll(env, id); expect(() => env.engine.completeMission(env.maya, id)).toThrow(/reviews/);          // callback not yet confirmed
    const cb = row(env, "SELECT * FROM work_items WHERE mission_id=? AND kind='review'", id);
    expect(() => env.engine.updateWorkItem(actorById(env, row(env, 'SELECT id FROM users WHERE email=?', 'dan@harborvine.example').id), id, cb.id, 'done')).toThrow(/Only the owner/);
    env.engine.updateWorkItem(actorById(env, cb.owner_user_id), id, cb.id, 'done'); finishReviews(env, id);
    env.engine.completeMission(env.maya, id);
    const out = row(env, 'SELECT * FROM outcomes WHERE mission_id=?', id); const un = JSON.parse(out.unresolved).join('\n');
    expect(un).toMatch(/Take ownership of J-102/); expect(un).toMatch(/Take ownership of J-101/);       // unresolved repairs stay visible
    const b2 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=2', id).plan);
    expect(b2.jobs.find((j: any) => j.id === 'J-102')).toMatchObject({ status: 'blocked', ownerId: 'Omar Reyes', level: 'critical' }); expect(b2.jobs.find((j: any) => j.id === 'J-103').status).toBe('done');
    expect(b2.handovers[0].unresolved).toEqual(['J-101', 'J-102', 'J-104']);
  });

  it('verification fails if a transferred job is missing from the published handover', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'shiftrelay'); await answer(env, id, 'status_J-104', 'open');
    await approveAll(env, id); await executeAll(env, id);
    const a = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='publish_handover'", id); const loc = JSON.parse(a.result).location;
    writeFileSync(loc, readFileSync(loc, 'utf8').replace(/J-102/g, 'J-XXX')); env.engine.verifyAction(env.maya, missionRow(env, id), a.id);
    expect(row(env, 'SELECT status FROM actions WHERE id=?', a.id).status).toBe('verification_failed');
    expect(rows(env, 'SELECT check_name FROM evidence WHERE action_id=? AND passed=0', a.id).map((e) => e.check_name)).toContain('every unresolved job is listed');
  });

  it('supervisor approval is required; a technician cannot approve; a later handover update makes queued actions stale', async () => {
    const env = makeEnv(); const { id, sample } = await startPack(env, 'shiftrelay'); await answer(env, id, 'status_J-104', 'open');
    const ap = row(env, "SELECT * FROM approvals WHERE mission_id=? AND status='pending'", id);
    await expect(env.engine.decideApproval(env.actor('omar@harborvine.example'), id, ap.id, 'approved', '')).rejects.toThrow(/manager/);
    await env.engine.decideApproval(env.actor('tess@harborvine.example'), id, ap.id, 'approved', 'ok');
    await env.engine.submitChange(env.maya, id, { ...sample.change, handoverAt: '2026-11-04T17:50', updates: [...sample.change.updates, { jobId: 'J-104', status: 'done', notes: 'fixed on the way out' }] });
    expect(rows(env, "SELECT * FROM actions WHERE mission_id=? AND status='stale'", id).length).toBeGreaterThanOrEqual(3);
    expect(missionRow(env, id).state).toBe('awaiting_approval');
    expect(rows(env, "SELECT * FROM work_items WHERE mission_id=? AND analysis_rev=? AND title LIKE 'Take ownership%'", id, missionRow(env, id).analysis_rev)).toHaveLength(2);
  });

  it('a clean handover (everything done) still records the transfer', async () => {
    const env = makeEnv(); const s = S();
    const r = await startPack(env, 'shiftrelay', (c) => ({ ...c, updates: [{ jobId: 'J-101', status: 'done' }, { jobId: 'J-102', status: 'done' }, { jobId: 'J-103', status: 'done' }, { jobId: 'J-104', status: 'done' }] }));
    expect(r.state()).toBe('awaiting_approval'); expect(rows(env, "SELECT * FROM work_items WHERE mission_id=? AND title LIKE 'Take ownership%'", r.id)).toHaveLength(0); void s;
    expect(rows(env, "SELECT key FROM actions WHERE mission_id=? AND status='proposed'", r.id).map((a) => a.key)).toEqual(['publish_handover', 'notify_incoming']);
  });
});
