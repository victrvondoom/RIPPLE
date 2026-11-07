import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { assertTransition, TRANSITIONS } from '../src/server/engine/states.js';
import { buildImpactGraph } from '../src/server/engine/graph.js';
import { beoPack } from '../src/server/packs/beo/pack.js';
import { samplePlan, sampleChange } from '../src/server/packs/beo/sample.js';
import { makeEnv, newBaselinedMission, row, rows, toAwaitingApproval } from './helpers.js';

describe('state machine', () => {
  it('rejects invalid transitions and allows the documented path', async () => {
    expect(() => assertTransition('draft', 'completed')).toThrow(/cannot move/);
    expect(() => assertTransition('completed', 'executing')).toThrow();
    expect(() => assertTransition('cancelled', 'draft')).toThrow();
    for (const [a, b] of [['draft', 'baseline_ready'], ['baseline_ready', 'analyzing'], ['analyzing', 'awaiting_approval'], ['awaiting_approval', 'executing'], ['executing', 'verifying'], ['verifying', 'completed']] as const) expect(() => assertTransition(a, b)).not.toThrow();
    expect(Object.keys(TRANSITIONS)).toHaveLength(11);
  });
});

describe('impact graph', () => {
  it('propagates only along dependencies actually reached by the change', async () => {
    const plan = samplePlan();
    const items = beoPack.detectChanges(plan, { ...sampleChange(), serviceTime: undefined, addVegan: false, veganCount: null });
    expect(items.map((i) => i.field)).toEqual(['event.guestCount']);
    const g = buildImpactGraph(beoPack, items);
    expect(g.impactedArtifacts).toEqual(expect.arrayContaining(['menu_quantities', 'procurement_list', 'supplier_orders', 'staffing_roster', 'venue_logistics', 'beo', 'client_confirmation']));
    expect(g.impactedArtifacts).not.toContain('dietary_plan');   // guest count alone does not touch dietary plan
    expect(g.checkedNotAffected).toContain('dietary_plan');
    expect(g.edges.some((e) => e.from === 'change:event.guestCount' && e.to === 'artifact:menu_quantities')).toBe(true);
  });
  it('detects no changes when the request equals the baseline', async () => {
    expect(beoPack.detectChanges(samplePlan(), { receivedOn: '2026-11-09', description: '', addVegan: false, guestCount: 120 })).toEqual([]);
  });
});

describe('BEO Rescue end-to-end through the mission engine', () => {
  it('blocks on a missing vegan count, then proceeds after the answer', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe('baseline_ready');
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    const m = row(env, 'SELECT * FROM missions WHERE id=?', mission.id);
    expect(m.state).toBe('blocked');
    expect(m.state_reason).toMatch(/vegan guests/);
    expect(rows(env, 'SELECT * FROM actions WHERE mission_id=?', mission.id)).toHaveLength(0);    // nothing proposed while blocked
    expect(rows(env, "SELECT * FROM artifacts WHERE mission_id=? AND status='provisional'", mission.id).length).toBeGreaterThan(0);
    const q = row(env, "SELECT * FROM questions WHERE mission_id=? AND key='vegan_count'", mission.id);
    await expect(env.engine.answerQuestion(env.maya, mission.id, q.id, 'lots')).rejects.toThrow(/whole number/);
    await env.engine.answerQuestion(env.maya, mission.id, q.id, '18');
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe('awaiting_approval');
    const acts = rows(env, 'SELECT * FROM actions WHERE mission_id=?', mission.id);
    expect(acts.filter((a) => a.status === 'proposed')).toHaveLength(5);
    expect(rows(env, "SELECT * FROM approvals WHERE mission_id=? AND status='pending'", mission.id)).toHaveLength(5);
  });

  it('produces the required outputs with correct, checkable numbers', async () => {
    const env = makeEnv(); const id = await toAwaitingApproval(env);
    const arts = rows(env, "SELECT * FROM artifacts WHERE mission_id=? AND status='draft'", id);
    const by = (k: string) => arts.find((a) => a.kind === k)!.content as string;
    expect(by('revised_beo')).toContain('**145**');
    expect(by('revised_beo')).toContain('**19:30**');
    expect(by('staffing_update')).toMatch(/servers \| 8 \| 10 \| 8 \| \*\*\+2\*\*/);   // ceil(145/15)=10, booked 8
    expect(by('kitchen_instructions')).toContain('Wild mushroom & chestnut wellington');
    expect(by('procurement_update')).toMatch(/Plant Pantry Wholesale.*SHORT/);          // 7-day lead vs 5 days available
    expect(by('client_communication')).toContain('145');
    expect(by('change_summary')).toContain('Guest count');
    // safety: potential allergen conflict flagged for qualified human review, never cleared by agents
    const kitchen = JSON.parse(row(env, "SELECT output FROM agent_runs WHERE mission_id=? AND role_key='kitchen' ORDER BY started_at DESC", id).output);
    expect(kitchen.findings.some((f: any) => f.needsHumanReview && /tree-nut/i.test(f.text))).toBe(true);
    for (const a of arts) expect(a.content).not.toMatch(/\b(certified|guaranteed|100% safe)\b/i);
    // venue capacity 140 < 145 raised as an open non-blocking question
    expect(row(env, "SELECT * FROM questions WHERE mission_id=? AND key='venue_capacity'", id).blocking).toBe(0);
  });

  it('enforces approval before execution and manager-only approvals', async () => {
    const env = makeEnv(); const id = await toAwaitingApproval(env);
    const act = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='publish_beo'", id);
    await expect(env.engine.executeAction(env.maya, id, act.id)).rejects.toThrow(/only approved/);
    const ap = row(env, 'SELECT * FROM approvals WHERE subject_id=?', act.id);
    await expect(env.engine.decideApproval(env.luis, id, ap.id, 'approved', '')).rejects.toThrow(/manager/);
    await expect(env.engine.decideApproval(env.vera, id, ap.id, 'approved', '')).rejects.toThrow(/manager/);
    await expect(env.engine.decideApproval(env.maya, id, ap.id, 'rejected', '')).rejects.toThrow(/reason/);
    await env.engine.decideApproval(env.maya, id, ap.id, 'approved', 'looks right');
    await expect(env.engine.executeAction(env.luis, id, act.id)).rejects.toThrow(/not permitted/);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('executing');
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='approval_approved'", id)).toHaveLength(1);
  });

  it('executes, verifies from independent read-back, requires acks + review, then completes with baseline v2', async () => {
    const env = makeEnv(); const id = await toAwaitingApproval(env);
    for (const ap of rows(env, "SELECT * FROM approvals WHERE mission_id=? AND status='pending'", id)) await env.engine.decideApproval(env.maya, id, ap.id, 'approved', 'ok');
    for (const a of rows(env, "SELECT * FROM actions WHERE mission_id=? AND status='approved'", id)) await env.engine.executeAction(env.maya, id, a.id);
    expect(rows(env, 'SELECT status FROM actions WHERE mission_id=?', id).every((a) => a.status === 'verified')).toBe(true);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('verifying');
    const ev = rows(env, "SELECT * FROM evidence WHERE mission_id=? AND kind='verification'", id);
    expect(ev.length).toBeGreaterThan(15); expect(ev.every((e) => e.passed)).toBe(true);
    expect(ev.every((e) => e.verifier === 'ripple-verifier/readback@1')).toBe(true);

    // completion refused: acks pending, chef review open
    await expect(env.engine.completeMission(env.maya, id)).rejects.toThrow(/acknowledgements|reviews/);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('verifying');
    expect(() => env.engine.acknowledge(env.maya, id, row(env, "SELECT id FROM actions WHERE key='send_kitchen' AND mission_id=?", id).id, '')).toThrow(/not a required recipient/);
    env.engine.acknowledge(env.luis, id, row(env, "SELECT id FROM actions WHERE key='send_kitchen' AND mission_id=?", id).id, 'got it');
    env.engine.acknowledge(env.priya, id, row(env, "SELECT id FROM actions WHERE key='send_procurement' AND mission_id=?", id).id, '');
    env.engine.acknowledge(env.dan, id, row(env, "SELECT id FROM actions WHERE key='send_staffing' AND mission_id=?", id).id, '');
    await expect(env.engine.completeMission(env.maya, id)).rejects.toThrow(/reviews/);
    const review = row(env, "SELECT * FROM work_items WHERE mission_id=? AND kind='review' AND role_key='human_chef'", id);
    expect(() => env.engine.updateWorkItem(env.dan, id, review.id, 'done')).toThrow(/Only the owner/);
    env.engine.updateWorkItem(env.luis, id, review.id, 'done');
    for (const w of rows(env, "SELECT * FROM work_items WHERE mission_id=? AND kind='review' AND status!='done'", id)) env.engine.updateWorkItem(env.maya, id, w.id, 'done');
    await env.engine.completeMission(env.maya, id);
    expect(row(env, 'SELECT * FROM missions WHERE id=?', id)).toMatchObject({ state: 'completed', current_baseline_version: 2 });
    const b2 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=2', id).plan);
    expect(b2.event).toMatchObject({ guestCount: 145, serviceTime: '19:30' }); expect(b2.dietary.vegan).toBe(18);
    expect(JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=1', id).plan).event.guestCount).toBe(120);   // history preserved
    const out = row(env, 'SELECT * FROM outcomes WHERE mission_id=?', id);
    expect(JSON.parse(out.unresolved).join('\n')).toMatch(/venue/i);     // unresolved items are recorded, not hidden
  });

  it('verification fails if the observed effect is tampered with (agent claims are not trusted)', async () => {
    const env = makeEnv(); const id = await toAwaitingApproval(env);
    const act = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='publish_beo'", id);
    await env.engine.decideApproval(env.maya, id, row(env, 'SELECT id FROM approvals WHERE subject_id=?', act.id).id, 'approved', '');
    await env.engine.executeAction(env.maya, id, act.id);
    const loc = JSON.parse(row(env, 'SELECT result FROM actions WHERE id=?', act.id).result).location;
    writeFileSync(loc, 'tampered');
    env.engine.verifyAction(env.maya, row(env, 'SELECT * FROM missions WHERE id=?', id), act.id);
    expect(row(env, 'SELECT status FROM actions WHERE id=?', act.id).status).toBe('verification_failed');
    expect(rows(env, "SELECT * FROM evidence WHERE action_id=? AND passed=0", act.id).length).toBeGreaterThan(0);
  });

  it('failed execution is visible, mission needs recovery, retry is traceable and idempotent', async () => {
    const env = makeEnv(); const id = await toAwaitingApproval(env);
    const act = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='send_client'", id);
    await env.engine.decideApproval(env.maya, id, row(env, 'SELECT id FROM approvals WHERE subject_id=?', act.id).id, 'approved', '');
    env.db.exec("UPDATE connectors SET fail_next=1 WHERE key='email_outbox'");
    await env.engine.executeAction(env.maya, id, act.id);
    expect(row(env, 'SELECT * FROM actions WHERE id=?', act.id)).toMatchObject({ status: 'failed' });
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('recovery_required');
    expect(rows(env, "SELECT * FROM evidence WHERE action_id=? AND passed=0", act.id)).toHaveLength(1);
    expect(existsSync(env.outbox) && readdirSync(env.outbox).length === 0).toBe(true);    // failed => no effect existed
    await env.engine.executeAction(env.maya, id, act.id);                                    // recovery
    expect(row(env, 'SELECT * FROM actions WHERE id=?', act.id)).toMatchObject({ status: 'verified', attempts: 2 });
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='recovery_retry'", id)).toHaveLength(1);
    // connector idempotency: re-executing the same key does not duplicate the effect
    const a2 = row(env, 'SELECT * FROM actions WHERE id=?', act.id); const p = JSON.parse(a2.payload);
    const r = env.engine.connectors.email_outbox.execute({ workspaceId: env.maya.workspaceId, missionId: id, idempotencyKey: a2.idempotency_key, subject: p.subject, target: p.target, body: p.body });
    expect(r.deduped).toBe(true);
    expect(env.engine.connectors.email_outbox.observe({ workspaceId: env.maya.workspaceId, missionId: id, idempotencyKey: a2.idempotency_key }).count).toBe(1);
  });

  it('a later change marks queued actions stale, invalidates approvals and blocks execution', async () => {
    const env = makeEnv(); const id = await toAwaitingApproval(env);
    const act = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='publish_beo'", id);
    await env.engine.decideApproval(env.maya, id, row(env, 'SELECT id FROM approvals WHERE subject_id=?', act.id).id, 'approved', 'approved v1');
    await env.engine.submitChange(env.maya, id, { receivedOn: '2026-11-10', description: 'Client now says 150 guests', guestCount: 150, addVegan: true, veganCount: null });
    expect(row(env, 'SELECT * FROM actions WHERE id=?', act.id)).toMatchObject({ status: 'stale' });
    expect(row(env, 'SELECT stale_reason FROM actions WHERE id=?', act.id).stale_reason).toMatch(/Change #2/);
    expect(row(env, 'SELECT status FROM approvals WHERE subject_id=?', act.id).status).toBe('stale');
    await expect(env.engine.executeAction(env.maya, id, act.id)).rejects.toThrow(/stale/);
    const fresh = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='publish_beo' AND status='proposed'", id);
    expect(fresh.change_seq).toBe(2);
    expect(JSON.parse(fresh.payload).body).toContain('**150**');
    await expect(env.engine.decideApproval(env.maya, id, row(env, 'SELECT id FROM approvals WHERE subject_id=?', act.id).id, 'approved', '')).rejects.toThrow(/stale/);
  });

  it('rejects invalid input and invalid lifecycle operations', async () => {
    const env = makeEnv();
    await expect(env.engine.createMission(env.maya, { packId: 'beo-rescue', title: 'x', plan: { nope: 1 } })).rejects.toThrow(/validation/);
    await expect(env.engine.createMission(env.luis, { packId: 'beo-rescue', title: 'x', plan: samplePlan() })).rejects.toThrow(/not permitted/);
    const m = await env.engine.createMission(env.maya, { packId: 'beo-rescue', title: 'Draft one', plan: samplePlan() });
    await expect(env.engine.submitChange(env.maya, m.id, sampleChange())).rejects.toThrow(/baseline/);
    env.engine.approveBaseline(env.maya, m.id, '');
    await expect(env.engine.submitChange(env.maya, m.id, { receivedOn: '2026-11-09', guestCount: 120 })).rejects.toThrow(/does not differ/);
    await expect(env.engine.submitChange(env.maya, m.id, { receivedOn: 'yesterday', guestCount: 130 })).rejects.toThrow(/validation/);
    await expect(env.engine.completeMission(env.maya, m.id)).rejects.toThrow(/criteria/);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', m.id).state).toBe('baseline_ready');
  });

  it('isolates workspaces', async () => {
    const env = makeEnv(); const { mission } = await newBaselinedMission(env);
    const { seedWorkspace } = await import('../src/server/seed.js');
    const other = seedWorkspace(env.db, env.packs, { name: 'Other Co', password: 'x-1234567', emailDomain: 'other.example' });
    const outsider = env.actor('maya@other.example');
    expect(outsider.workspaceId).toBe(other.workspaceId);
    expect(() => env.engine.mission(outsider.workspaceId, mission.id)).toThrow(/not found/i);
    await expect(env.engine.submitChange(outsider, mission.id, sampleChange())).rejects.toThrow(/not found/i);
  });

  it('every state change is audited', async () => {
    const env = makeEnv(); const id = await toAwaitingApproval(env);
    const states = rows(env, "SELECT summary FROM audit_events WHERE mission_id=? AND type='state_change' ORDER BY created_at, rowid", id).map((r) => r.summary);
    expect(states.join('\n')).toMatch(/Draft → Baseline ready[\s\S]*Analyzing[\s\S]*Blocked[\s\S]*Analyzing[\s\S]*Awaiting approval/);
    expect(readFileSync).toBeDefined();
  });
});
