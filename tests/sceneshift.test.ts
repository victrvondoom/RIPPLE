import { describe, it, expect } from 'vitest';
import { makeEnv, newBaselinedMission, row, rows } from './helpers.js';

describe('SceneShift runs on the SAME engine (reusability proof)', () => {
  it('script change → shot scenes invalidated, continuity chain found, departments tasked, executed & verified, completes', async () => {
    const env = makeEnv();
    const { mission, sample } = await newBaselinedMission(env, 'sceneshift');
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe('awaiting_approval');
    const nodes = rows(env, 'SELECT kind,key FROM graph_nodes WHERE mission_id=?', mission.id);
    expect(nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['artifact:takes_log', 'artifact:sound_adr', 'artifact:edit_assembly', 'artifact:wardrobe_props', 'artifact:call_sheet']));
    const cont = JSON.parse(row(env, "SELECT output FROM agent_runs WHERE mission_id=? AND role_key='continuity'", mission.id).output);
    expect(cont.findings.some((f: any) => /Scene 12 is already shot \(11 takes\)/.test(f.text))).toBe(true);
    expect(cont.findings.some((f: any) => /Scene 19 continuity references scene 12/.test(f.text))).toBe(true);   // downstream continuity chain
    const depts = [...new Set(rows(env, "SELECT department FROM work_items WHERE mission_id=?", mission.id).map((w) => w.department))];
    expect(depts).toEqual(expect.arrayContaining(['Sound', 'Art & Wardrobe', 'Editorial', 'Production', 'Script Supervision']));

    await env.engine.answerQuestion(env.maya, mission.id, row(env, "SELECT id FROM questions WHERE key='reshoot_decision' AND mission_id=?", mission.id).id, 'reshoot');
    for (const ap of rows(env, "SELECT * FROM approvals WHERE mission_id=? AND status='pending'", mission.id)) await env.engine.decideApproval(env.maya, mission.id, ap.id, 'approved', '');
    for (const a of rows(env, "SELECT * FROM actions WHERE mission_id=? AND status='approved'", mission.id)) await env.engine.executeAction(env.maya, mission.id, a.id);
    expect(rows(env, 'SELECT status FROM actions WHERE mission_id=?', mission.id).filter((a) => a.status === 'verified').length).toBe(2);
    expect(() => env.engine.completeMission(env.maya, mission.id)).toThrow(/reviews|acknowledgements/);   // takes-log review + ack outstanding
    for (const w of rows(env, "SELECT * FROM work_items WHERE mission_id=? AND kind='review' AND status!='done'", mission.id)) env.engine.updateWorkItem(env.maya, mission.id, w.id, 'done');
    for (const a of rows(env, "SELECT id FROM actions WHERE mission_id=? AND key='notify_departments' AND status='verified'", mission.id)) env.engine.acknowledge(env.maya, mission.id, a.id, '');
    env.engine.completeMission(env.maya, mission.id);
    const b2 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=2', mission.id).plan);
    expect(b2.production.scriptVersion).toBe('v7');
    expect(b2.scenes.find((s: any) => s.n === 8).status).toBe('cut');
    expect(b2.scenes.find((s: any) => s.n === 12).status).toBe('reshoot_pending');
  });
});
