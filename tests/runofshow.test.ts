import { describe, it, expect } from 'vitest';
import { makeEnv, row, rows, type Env } from './helpers.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { runOfShowPack, planSchema, changeSchema, checkPlan, evaluate, fixOptions, qkey } from '../src/server/packs/runofshow/pack.js';

/** Session 18: event-day run of show. Deterministic checks, then decisions by the affected owners only. */

const sample = () => runOfShowPack.sample();
const plan = () => planSchema.parse(sample().plan);
const change = () => changeSchema.parse(sample().change);
const testEnv = (): Env => makeEnv(new LocalCollab(), extendedRegistry());

describe('run of show: deterministic checks', () => {
  it('the sample schedule passes every check before the report', () => {
    expect(checkPlan(plan())).toEqual([]);
  });

  it('no availability change means no conflict and no proposal', () => {
    const e = evaluate(plan(), { ...change(), availability: [] });
    expect(e.state).toBe('consistent');
    expect(e.chosen).toBeNull();
  });

  it('a late keynote is the only conflict, and the smallest valid fix is the keynote and panel swap', () => {
    const e = evaluate(plan(), change());
    expect(e.violations.map((v) => v.sessionKey)).toEqual(['keynote']);
    expect(e.state).toBe('pending');
    expect(e.chosen?.key).toBe('swap:keynote:panel');
    const s = e.chosen!.sessions;
    expect(s.find((x) => x.key === 'keynote')).toMatchObject({ start: '14:30', end: '15:15' });
    expect(s.find((x) => x.key === 'panel')).toMatchObject({ start: '11:15', end: '12:00' });
    expect(s.find((x) => x.key === 'lunch')).toMatchObject({ start: '12:00', end: '13:00' }); // a fixed session never moves
    expect(e.affected.slice().sort()).toEqual(['ev_panel_lead', 'ev_speaker_keynote', 'ev_venue_av']);
  });

  it('the keynote-after-lunch option is rejected because the breakdown runs past the crew departure', () => {
    const later = evaluate(plan(), change()).options.find((o) => o.key === 'later:keynote:13:00');
    expect(later?.valid).toBe(false);
    expect(later!.violations.map((v) => v.rule)).toContain('crew');
    expect(later!.violations.some((v) => v.text.startsWith('Breakdown'))).toBe(true);
  });

  it('a report about someone not on the plan changes nothing and proposes nothing', () => {
    const e = evaluate(plan(), { ...change(), availability: [{ personKey: 'nobody', availableFrom: '11:45' }] });
    expect(e.state).toBe('unknown_person');
    expect(e.chosen).toBeNull();
  });

  it('a fixed session is never offered for a move', () => {
    const lunch = plan().sessions.find((s) => s.key === 'lunch')!;
    expect(fixOptions(plan(), lunch)).toEqual([]);
  });

  it('a fix is applied to the schedule only when every affected owner approved that exact fix', () => {
    const base = evaluate(plan(), change());
    const yes = Object.fromEntries(base.affected.map((r) => [qkey(base.hash!, r), { text: 'approve', value: 'approve' }]));
    const onlyMaya = { [qkey(base.hash!, 'ev_speaker_keynote')]: { text: 'approve', value: 'approve' } };
    const unchanged = runOfShowPack.applyChange(plan(), change(), onlyMaya as any);
    expect(unchanged.sessions.find((s: { key: string }) => s.key === 'keynote')).toMatchObject({ start: '11:15' });
    const applied = runOfShowPack.applyChange(plan(), change(), yes as any);
    expect(applied.sessions.find((s: { key: string }) => s.key === 'keynote')).toMatchObject({ start: '14:30', end: '15:15' });
    expect(checkPlan(applied)).toEqual([]);
  });
});

describe('run of show mission (through the engine)', () => {
  async function openMission(e: Env) {
    const s = sample();
    const m = await e.engine.createMission(e.maya, { packId: 'run-of-show', title: s.title, plan: s.plan });
    e.engine.approveBaseline(e.maya, m.id, 'test');
    await e.engine.submitChange(e.maya, m.id, s.change);
    return m;
  }
  const decisionQs = (e: Env, missionId: string) => rows(e, "SELECT * FROM questions WHERE mission_id=? AND status='open' AND key LIKE 'ev_decide_%'", missionId);
  const ids = (e: Env, email: string) => e.seeded.userIds[email];

  it('asks exactly the affected owners, and a person who is not affected cannot answer for them', async () => {
    const e = testEnv(); const m = await openMission(e);
    const qs = decisionQs(e, m.id);
    expect(qs.map((q) => q.assignee_user_id).sort()).toEqual([ids(e, 'jamie@harborvine.example'), ids(e, 'maya@harborvine.example'), ids(e, 'sam@harborvine.example')].sort());
    const mayaQ = qs.find((q) => q.assignee_user_id === ids(e, 'maya@harborvine.example'))!;
    await expect(e.engine.answerQuestion(e.priya, m.id, mayaQ.id, 'approve')).rejects.toThrow();
    expect(rows(e, "SELECT id FROM actions WHERE mission_id=? AND type='publish_revision'", m.id)).toHaveLength(0);
  });

  it('a decline needs a reason, and a declined fix never reaches publishing', async () => {
    const e = testEnv(); const m = await openMission(e);
    const jamie = decisionQs(e, m.id).find((q) => q.assignee_user_id === ids(e, 'jamie@harborvine.example'))!;
    await expect(e.engine.answerQuestion(e.actor('jamie@harborvine.example'), m.id, jamie.id, 'decline')).rejects.toThrow();
    await e.engine.answerQuestion(e.actor('jamie@harborvine.example'), m.id, jamie.id, 'decline: the panelists need until 13:00 to travel');
    for (const q of decisionQs(e, m.id)) {
      const email = e.db.get('SELECT email FROM users WHERE id=?', q.assignee_user_id)!.email;
      await e.engine.answerQuestion(e.actor(email), m.id, q.id, 'approve');
    }
    expect(rows(e, "SELECT id FROM actions WHERE mission_id=? AND type='publish_revision' AND status NOT IN ('stale','superseded')", m.id)).toHaveLength(0);
  });

  it('after every affected owner approves, publishing waits for the lead planner (Alex), not for Maya', async () => {
    const e = testEnv(); const m = await openMission(e);
    for (const q of decisionQs(e, m.id)) {
      const email = e.db.get('SELECT email FROM users WHERE id=?', q.assignee_user_id)!.email;
      await e.engine.answerQuestion(e.actor(email), m.id, q.id, 'approve');
    }
    const pub =row(e, "SELECT * FROM actions WHERE mission_id=? AND type='publish_revision' AND status NOT IN ('stale','superseded')", m.id);
    expect(pub).toBeDefined();
    const apr = row(e, 'SELECT * FROM approvals WHERE mission_id=? AND subject_id=?', m.id, pub.id);
    expect(apr.approver_label).toMatch(/Alex Morgan/);
    await expect(e.engine.decideApproval(e.maya, m.id, apr.id, 'approved', 'test')).rejects.toThrow();
    const draft = row(e, "SELECT content FROM artifacts WHERE mission_id=? AND kind='run_of_show_v2'", m.id);
    expect(draft.content).toContain('**Local outbox only.**');
    expect(draft.content).toContain('14:30–15:15');
  });
});

describe('run of show: verification and analyzer output', () => {
  const base = () => evaluate(plan(), change());
  const allApproved = () => Object.fromEntries(base().affected.map((r) => [qkey(base().hash!, r), { text: 'approve', value: 'approve' }]));
  const ctxFor = (answers: Record<string, any>) => ({ today: '2026-11-09', plan: plan(), change: change(), items: [], answers, revisedPlan: runOfShowPack.applyChange(plan(), change(), answers as any), results: {}, impacted: { artifacts: [], departments: [] } }) as any;

  it('the analyst only reports and asks; it never proposes an action', () => {
    const r = runOfShowPack.analyzeRole('ev_analyst', ctxFor({}));
    expect(r.actions).toEqual([]);
    expect(r.questions.every((q) => q.assigneeOnly === true && q.blocking === true)).toBe(true);
  });

  it('the publisher drafts nothing until every affected owner approves', () => {
    expect(runOfShowPack.analyzeRole('ev_publisher', ctxFor({})).actions).toEqual([]);
    const r = runOfShowPack.analyzeRole('ev_publisher', ctxFor(allApproved()));
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ type: 'publish_revision', approver: { role: 'ev_lead_planner' } });
  });

  it('verifies a stored revision that carries the approved times and the local-only label', () => {
    const draft = runOfShowPack.analyzeRole('ev_publisher', ctxFor(allApproved())).drafts[0].content;
    const checks = runOfShowPack.verifyAction!({ type: 'publish_revision', payload: {} }, { content: draft }, ctxFor(allApproved()).revisedPlan, { baselinePlan: plan(), change: change(), answers: allApproved() as any });
    expect(checks.every((c) => c.passed), JSON.stringify(checks)).toBe(true);
  });

  it('fails a stored revision whose session time was changed, and a revision without owner approvals', () => {
    const draft = runOfShowPack.analyzeRole('ev_publisher', ctxFor(allApproved())).drafts[0].content;
    const tampered = draft.replace('14:30–15:15', '11:15–12:00');
    const checks = runOfShowPack.verifyAction!({ type: 'publish_revision', payload: {} }, { content: tampered }, ctxFor(allApproved()).revisedPlan, { baselinePlan: plan(), change: change(), answers: allApproved() as any });
    expect(checks.find((c) => c.name.startsWith('every session time'))?.passed).toBe(false);
    const unapproved = runOfShowPack.verifyAction!({ type: 'publish_revision', payload: {} }, { content: draft }, ctxFor({}).revisedPlan, { baselinePlan: plan(), change: change(), answers: {} as any });
    expect(unapproved.find((c) => c.name.startsWith('every affected owner'))?.passed).toBe(false);
  });

  it('completion requires the fix to be approved (or no change needed) and the revised day to pass every check', () => {
    const ok = runOfShowPack.completionChecks!({ baselinePlan: plan(), revisedPlan: runOfShowPack.applyChange(plan(), change(), allApproved() as any), change: change(), answers: allApproved() as any, today: '2026-11-09' });
    expect(ok.every((c) => c.passed)).toBe(true);
    const open = runOfShowPack.completionChecks!({ baselinePlan: plan(), revisedPlan: plan(), change: change(), answers: {} as any, today: '2026-11-09' });
    expect(open.find((c) => c.key === 'owners_approved')?.passed).toBe(false);
  });
});
