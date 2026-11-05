import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeEnv, newBaselinedMission, row, rows, type Env } from './helpers.js';
import { defaultRegistry } from '../src/server/packs/registry.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { Engine } from '../src/server/engine/engine.js';
import { MAX_PASSES, roleFingerprint, validateRoleResult } from '../src/server/engine/orchestrator.js';
import type { RoleResult, WorkflowPack } from '../src/server/engine/types.js';
import { missionDetail } from '../src/server/api/snapshot.js';
import { EngineError } from '../src/server/engine/types.js';
import { buildConnectors } from '../src/server/connectors/index.js';
import { DeterministicProvider } from '../src/server/agents/provider.js';

// ---------- a test-only pack whose agents depend on each other, so the feedback loop is real and controllable ----------
type Mode = 'converge' | 'diverge' | 'malformed' | 'pausing';
function loopPack(mode: Mode, hooks: { onAlpha?: () => void } = {}): WorkflowPack {
  const out = (roleKey: string, p: Partial<RoleResult>): RoleResult => ({ roleKey, summary: `${roleKey} ran`, findings: [], questions: [], workItems: [], drafts: [], actions: [], analyzer: 'fixture@1', ...p });
  return {
    id: 'loop-fixture', name: 'Loop fixture', domain: 'Test', version: '0.0.1', description: 'test-only pack exercising the orchestrator loop',
    roles: [
      { key: 'alpha', name: 'Alpha', kind: 'agent', responsibility: 'Reads beta and asks for a value.' },
      { key: 'beta', name: 'Beta', kind: 'agent', responsibility: 'Publishes a value derived from alpha.' },
      { key: 'human_manager', name: 'Manager', kind: 'human', responsibility: 'Decides.' },
    ],
    roleOrder: ['alpha', 'beta'],
    roleDeps: { alpha: ['beta'], beta: ['alpha'] },
    planSchema: z.object({ title: z.string().optional(), counter: z.number().int() }),
    changeSchema: z.object({ value: z.number().int(), description: z.string().optional() }),
    artifacts: [], rules: [], artifactEdges: [], decisions: [],
    sample: () => ({ title: 'Loop fixture mission', plan: { counter: 1 }, change: { value: 2 } }),
    detectChanges: (plan, change) => (change.value !== plan.counter ? [{ field: 'counter', label: 'Counter', before: plan.counter, after: change.value, kind: 'modified', severity: 'medium' }] : []),
    applyChange: (plan, change) => ({ ...plan, counter: change.value }),
    analyzeRole(roleKey, ctx) {
      const actionFor = (seen: number) => [{ key: 'publish', type: 'publish_value', title: 'Publish value', connector: 'document_store', ownerRole: 'human_manager', consequential: true, draftKind: 'value_doc', approvalRole: 'manager' as const, ackRoles: [], rationale: `Publishes value ${seen}.`, target: 'value doc', effectKey: 'value-doc' }];
      if (roleKey === 'alpha') {
        hooks.onAlpha?.();
        const seen = (ctx.results.beta?.data?.v as number | undefined) ?? 0;
        const requests = mode === 'converge' && seen === 0 ? [{ roleKey: 'beta', reason: 'Send me your value' }] : undefined;
        const drafts = [{ kind: 'value_doc', name: 'Value', content: `value=${seen}`, ownerRole: 'alpha' }];
        return out('alpha', { summary: `alpha sees ${seen}`, data: { seen }, requests, drafts, actions: actionFor(seen), findings: [{ severity: 'info', text: `seen ${seen}` }] });
      }
      // malformed: beta returns alpha's identity, which the orchestrator must reject
      if (mode === 'malformed') return out('alpha', { summary: 'not beta' });
      const alphaSeen = (ctx.results.alpha?.data?.seen as number | undefined) ?? 0;
      const v = mode === 'diverge' ? alphaSeen + 1 : 1;
      return out('beta', { summary: `beta v=${v}`, data: { v }, findings: [{ severity: 'info', text: `v ${v}` }] });
    },
  };
}
const loopRegistry = (pack: WorkflowPack) => defaultRegistry().register(pack);
const loopEnv = (pack: WorkflowPack) => makeEnv(new LocalCollab(), loopRegistry(pack));
async function startLoop(env: Env) {
  const { mission, sample } = await newBaselinedMission(env, 'loop-fixture');
  await env.engine.submitChange(env.maya, mission.id, sample.change);
  return mission.id as string;
}
const tasksOf = (env: Env, id: string, rev?: number) => (rev ? rows(env, 'SELECT * FROM workflow_tasks WHERE mission_id=? AND analysis_rev=? ORDER BY created_at, rowid', id, rev) : rows(env, 'SELECT * FROM workflow_tasks WHERE mission_id=? ORDER BY created_at, rowid', id));
const auditOf = (env: Env, id: string, type: string) => rows(env, 'SELECT * FROM audit_events WHERE mission_id=? AND type=? ORDER BY created_at, rowid', id, type);

describe('Mission Orchestrator — task graph (BEO Rescue)', () => {
  it('plans and dispatches one task per agent role, in dependency order, with the coordinator waiting on all departments', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    const t = tasksOf(env, mission.id, 1);
    expect(t.map((x) => x.role_key)).toEqual(['change', 'kitchen', 'procurement', 'service', 'coordinator']);
    expect(t.every((x) => x.pass === 1 && x.kind === 'analysis')).toBe(true);
    const coord = t.find((x) => x.role_key === 'coordinator')!;
    expect(JSON.parse(coord.depends_on).sort()).toEqual(['change', 'kitchen', 'procurement', 'service']);
    expect(t.find((x) => x.role_key === 'change')!.depends_on).toBe('[]');
    // capability routing: only agent roles of the pack get tasks; human roles never run as agents
    const kinds = new Map(env.packs.get('beo-rescue')!.roles.map((r) => [r.key, r.kind]));
    expect(t.every((x) => kinds.get(x.role_key) === 'agent')).toBe(true);
    expect(t.every((x) => x.status === 'done' && x.run_id && x.finished_at)).toBe(true);
    const d = missionDetail(env.engine, env.maya.workspaceId, mission.id);
    expect(d.orchestration.progress).toEqual({ total: 5, done: 5, running: 0, queued: 0 });
    expect(d.orchestration.paused).toBe(false);
    expect(d.agents.every((a: any) => a.task && a.task.status === 'done')).toBe(true);
    expect(auditOf(env, mission.id, 'orch_converged').length).toBe(1);
  });

  it('after a human answer, re-runs only the affected roles and reuses the rest (iteration 2)', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    const q = row(env, "SELECT * FROM questions WHERE mission_id=? AND key='vegan_count'", mission.id);
    await env.engine.answerQuestion(env.maya, mission.id, q.id, '18');
    const rev2 = tasksOf(env, mission.id, 2);
    const byRole = new Map(rev2.map((x) => [x.role_key, x]));
    // the Change agent's inputs did not move: its previous result is reused, not re-run
    expect(byRole.get('change')!.status).toBe('reused');
    expect(byRole.get('change')!.reused_from).toBeTruthy();
    expect(byRole.get('change')!.run_id).toBe(tasksOf(env, mission.id, 1).find((x) => x.role_key === 'change')!.run_id);
    // the vegan answer changes the Kitchen's inputs and the Service's gating: both re-run
    expect(byRole.get('kitchen')!.status).toBe('done');
    expect(byRole.get('service')!.status).toBe('done');
    expect(byRole.get('procurement')!.status).toBe('done');
    expect(byRole.get('coordinator')!.status).toBe('done');
    const d = missionDetail(env.engine, env.maya.workspaceId, mission.id);
    expect(d.orchestration.rounds.map((r: any) => r.rev)).toEqual([1, 2]);
    expect(d.orchestration.rounds[1].reused).toBe(1);
    // the reused result is still a real artifact of this revision
    expect(rows(env, "SELECT 1 FROM artifacts WHERE mission_id=? AND kind='change_summary' AND analysis_rev=2", mission.id).length).toBe(1);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe('awaiting_approval');
  });
});

describe('Mission Orchestrator — bounded feedback loop (test-only pack)', () => {
  it('two agents that depend on each other converge: requests are routed, the loop stops when nothing changes', async () => {
    const env = loopEnv(loopPack('converge'));
    const id = await startLoop(env);
    const t = tasksOf(env, id, 1);
    // pass 1 runs both; pass 2 re-runs only alpha (beta's output changed under it); pass 3 re-runs beta
    expect(t.map((x) => `${x.pass}:${x.role_key}:${x.kind}`)).toEqual(['1:alpha:analysis', '1:beta:analysis', '2:alpha:reanalysis', '3:beta:reanalysis']);
    expect(t.find((x) => x.pass === 3)!.reason).toMatch(/after pass 2/);
    expect(auditOf(env, id, 'orch_converged')[0].summary).toMatch(/Converged after 3 pass/);
    // alpha's request for beta was recorded; beta's inputs had not changed at that point, so it was converged (not re-run)
    expect(auditOf(env, id, 'orch_request_converged').length).toBe(1);
    const msgs = rows(env, "SELECT * FROM messages WHERE mission_id=? AND kind='handoff' AND data LIKE '%\"type\":\"request\"%'", id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].to_key).toBe('beta');
    // converged work still goes through approval; nothing executed
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('awaiting_approval');
    expect(rows(env, 'SELECT status FROM approvals WHERE mission_id=?', id).map((x) => x.status)).toEqual(['pending']);
  });

  it('a loop that never converges is stopped at the bound and escalated to a human; no actions are created', async () => {
    const env = loopEnv(loopPack('diverge'));
    const id = await startLoop(env);
    expect(tasksOf(env, id, 1).length).toBe(2 + 1 + 1); // pass 1 (2 tasks) + pass 2 (alpha) + pass 3 (beta)
    expect(Math.max(...tasksOf(env, id, 1).map((x) => x.pass))).toBe(MAX_PASSES);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('blocked');
    const q = row(env, "SELECT * FROM questions WHERE mission_id=? AND key='iteration_limit_1'", id);
    expect(q.blocking).toBe(1);
    expect(q.status).toBe('open');
    expect(auditOf(env, id, 'orch_iteration_limit').length).toBe(1);
    expect(rows(env, 'SELECT * FROM actions WHERE mission_id=?', id).length).toBe(0);
    expect(rows(env, 'SELECT * FROM approvals WHERE mission_id=?', id).length).toBe(0);
    expect(missionDetail(env.engine, env.maya.workspaceId, id).orchestration.iterationLimitReached).toBe(true);
  });

  it('malformed agent output is rejected: nothing from it touches the mission, the mission is blocked for a human, other roles proceed', async () => {
    const env = loopEnv(loopPack('malformed'));
    const id = await startLoop(env);
    const beta = tasksOf(env, id, 1).find((x) => x.role_key === 'beta')!;
    expect(beta.status).toBe('rejected');
    expect(beta.error).toMatch(/belongs to role "alpha"/);
    expect(rows(env, "SELECT 1 FROM artifacts WHERE mission_id=? AND kind='value_doc'", id).length).toBeGreaterThan(0); // alpha's draft kept
    expect(rows(env, "SELECT * FROM work_items WHERE mission_id=? AND role_key='beta'", id).length).toBe(0);
    const q = row(env, "SELECT * FROM questions WHERE mission_id=? AND key='output_rejected_beta_1'", id);
    expect(q.blocking).toBe(1);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('blocked');
    expect(auditOf(env, id, 'orch_output_rejected').length).toBe(1);
  });

  it('pause mid-run stops before the next agent; resume continues and reuses the completed agent work', async () => {
    let missionId = '';
    let fired = false;
    const env: Env = loopEnv(loopPack('pausing', { onAlpha: () => { if (!fired) { fired = true; env.db.exec('UPDATE missions SET paused=1 WHERE id=?', missionId); } } }));
    const { mission, sample } = await newBaselinedMission(env, 'loop-fixture');
    missionId = mission.id;
    await env.engine.submitChange(env.maya, missionId, sample.change);
    expect(row(env, 'SELECT state, paused FROM missions WHERE id=?', missionId)).toMatchObject({ state: 'blocked', paused: 1 });
    expect(tasksOf(env, missionId, 1).map((x) => [x.role_key, x.status])).toEqual([['alpha', 'done'], ['beta', 'interrupted']]);
    // resume: a new revision re-runs the unfinished work; alpha's completed result is reused
    await env.engine.resumeMission(env.maya, missionId);
    expect(tasksOf(env, missionId, 2).find((x) => x.role_key === 'alpha')!.status).toBe('reused');
    expect(tasksOf(env, missionId, 2).find((x) => x.role_key === 'beta')!.status).toBe('done');
    expect(row(env, 'SELECT state, paused FROM missions WHERE id=?', missionId)).toMatchObject({ state: 'awaiting_approval', paused: 0 });
  });
});

describe('Mission Orchestrator — human control, recovery and timeouts', () => {
  it('pausing is manager-only; while paused, agents, answers, changes and executions are refused', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    expect(() => env.engine.pauseMission(env.luis, mission.id, 'try')).toThrow(EngineError); // the chef is a member, not a manager
    env.engine.pauseMission(env.maya, mission.id, 'client on the phone');
    expect(row(env, 'SELECT paused FROM missions WHERE id=?', mission.id).paused).toBe(1);
    expect(() => env.engine.pauseMission(env.maya, mission.id, 'again')).toThrow(/already paused/);
    await expect(env.engine.submitChange(env.maya, mission.id, sample.change)).rejects.toMatchObject({ status: 409, code: 'paused' });
    const q = row(env, "SELECT * FROM questions WHERE mission_id=? AND key='vegan_count'", mission.id);
    await expect(env.engine.answerQuestion(env.maya, mission.id, q.id, '5')).rejects.toMatchObject({ status: 409, code: 'paused' });
    const act = rows(env, 'SELECT * FROM actions WHERE mission_id=? LIMIT 1', mission.id)[0];
    if (act) await expect(env.engine.executeAction(env.maya, mission.id, act.id)).rejects.toMatchObject({ status: 409, code: 'paused' });
    expect(auditOf(env, mission.id, 'orch_paused').length).toBe(1);
    await env.engine.resumeMission(env.maya, mission.id);
    expect(row(env, 'SELECT paused FROM missions WHERE id=?', mission.id).paused).toBe(0);
    await expect(env.engine.resumeMission(env.maya, mission.id)).rejects.toMatchObject({ status: 409, code: 'not_paused' });
  });

  it('reassigning a work item is manager-only, the assignee must be an active member, and every reassignment is audited', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    const wi = rows(env, "SELECT * FROM work_items WHERE mission_id=? AND status='open' LIMIT 1", mission.id)[0];
    expect(() => env.engine.reassignWorkItem(env.luis, mission.id, wi.id, env.priya.id)).toThrow(EngineError);
    expect(() => env.engine.reassignWorkItem(env.maya, mission.id, wi.id, env.vera.id)).toThrow(/not a viewer/);
    env.engine.reassignWorkItem(env.maya, mission.id, wi.id, env.priya.id);
    expect(row(env, 'SELECT owner_user_id FROM work_items WHERE id=?', wi.id).owner_user_id).toBe(env.priya.id);
    expect(auditOf(env, mission.id, 'work_item_reassigned').length).toBe(1);
  });

  it('restart with pending tasks: running work is marked interrupted, the mission is blocked, and a new process can resume it', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    // simulate a crash mid-analysis: a task was running and the mission was still analyzing
    const t = tasksOf(env, mission.id, 1)[1]; // kitchen
    env.db.exec("UPDATE workflow_tasks SET status='running', finished_at=NULL WHERE id=?", t.id);
    env.db.exec("UPDATE missions SET state='analyzing' WHERE id=?", mission.id);
    const fresh = new Engine({ db: env.db, packs: env.packs, collab: new LocalCollab(), connectors: buildConnectors(env.outbox), provider: new DeterministicProvider(), today: () => '2026-11-09' });
    expect(fresh.recoverInterrupted()).toBe(1);
    expect(row(env, 'SELECT status FROM workflow_tasks WHERE id=?', t.id).status).toBe('interrupted');
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe('blocked');
    expect(auditOf(env, mission.id, 'orch_interrupted').length).toBe(1);
    // re-running analysis reuses completed agents; the open vegan question still blocks, as it should
    await fresh.runAnalysis(env.maya, mission.id, 'Retry after restart');
    expect(tasksOf(env, mission.id, 2).find((x) => x.role_key === 'change')!.status).toBe('reused');
    expect(tasksOf(env, mission.id, 2).find((x) => x.role_key === 'kitchen')!.status).toBe('done');
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe('blocked');
  });

  it('a task that never reports is detected as stale, timed out, escalated, and the mission is blocked', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    const t = tasksOf(env, mission.id, 1)[0];
    env.db.exec("UPDATE workflow_tasks SET status='running', started_at='2020-01-01T00:00:00.000Z', finished_at=NULL WHERE id=?", t.id);
    env.db.exec("UPDATE missions SET state='analyzing' WHERE id=?", mission.id);
    expect(env.engine.sweepStaleTasks(60_000)).toBe(1);
    expect(row(env, 'SELECT status FROM workflow_tasks WHERE id=?', t.id).status).toBe('timed_out');
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe('blocked');
    expect(rows(env, "SELECT * FROM messages WHERE mission_id=? AND kind='escalation' AND body LIKE '%time limit%'", mission.id).length).toBe(1);
    expect(auditOf(env, mission.id, 'orch_timed_out').length).toBe(1);
  });

  it('cancelling a mission cancels its queued and running tasks', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    env.db.insert('workflow_tasks', { id: 'wft_manual', workspace_id: env.maya.workspaceId, mission_id: mission.id, analysis_rev: 1, pass: 9, role_key: 'service', kind: 'reanalysis', status: 'queued', fingerprint: '', reason: 'test', depends_on: '[]', created_at: new Date().toISOString() });
    env.engine.cancelMission(env.maya, mission.id, 'scope withdrawn');
    expect(row(env, "SELECT status FROM workflow_tasks WHERE id='wft_manual'").status).toBe('cancelled');
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe('cancelled');
  });
});

describe('Mission Orchestrator — pure rules', () => {
  it('fingerprints are stable for identical inputs and change only when a role input changes', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    const pack = env.packs.get('beo-rescue')!;
    const plan = JSON.parse(env.db.get('SELECT plan FROM baselines WHERE mission_id=? AND version=1', mission.id)!.plan);
    const ctx: any = { today: '2026-11-09', plan, change: sample.change, items: pack.detectChanges(plan, sample.change, {}), answers: {}, revisedPlan: pack.applyChange(plan, sample.change, {}), results: {}, impacted: { artifacts: [], departments: [] } };
    const service = roleFingerprint(pack, 'service', ctx);
    expect(roleFingerprint(pack, 'service', { ...ctx })).toBe(service);
    // an answer that does not change the Service's gating leaves its fingerprint alone
    expect(roleFingerprint(pack, 'service', { ...ctx, answers: { vegan_dessert: { text: 'fruit plate', value: 'fruit_plate' } } })).toBe(service);
    // the Kitchen reads the answers, so the same answer changes its fingerprint
    expect(roleFingerprint(pack, 'kitchen', { ...ctx, answers: { vegan_dessert: { text: 'fruit plate', value: 'fruit_plate' } } })).not.toBe(roleFingerprint(pack, 'kitchen', ctx));
  });

  it('validateRoleResult accepts a well-formed result and rejects unrelated, malformed or self-requesting output', () => {
    const pack = defaultRegistry().get('beo-rescue')!;
    const good = { roleKey: 'kitchen', summary: 'ok', findings: [], questions: [], workItems: [], drafts: [], actions: [], analyzer: 'x@1' };
    expect(validateRoleResult(pack, 'kitchen', good).ok).toBe(true);
    expect(validateRoleResult(pack, 'kitchen', { ...good, roleKey: 'service' })).toMatchObject({ ok: false });
    expect(validateRoleResult(pack, 'kitchen', { ...good, summary: undefined })).toMatchObject({ ok: false });
    expect(validateRoleResult(pack, 'kitchen', { ...good, requests: [{ roleKey: 'nobody', reason: 'x' }] })).toMatchObject({ ok: false });
    expect(validateRoleResult(pack, 'kitchen', { ...good, requests: [{ roleKey: 'kitchen', reason: 'x' }] })).toMatchObject({ ok: false });
    expect(validateRoleResult(pack, 'kitchen', { ...good, workItems: [{ key: 'w', title: 't', roleKey: 'ghost' }] })).toMatchObject({ ok: false });
    expect(validateRoleResult(pack, 'kitchen', { ...good, drafts: [{ kind: 'a', name: 'n', content: 'c', ownerRole: 'kitchen' }, { kind: 'a', name: 'n2', content: 'c2', ownerRole: 'kitchen' }] })).toMatchObject({ ok: false });
    expect(validateRoleResult(pack, 'kitchen', null)).toMatchObject({ ok: false });
  });
});
