import { describe, it, expect } from 'vitest';
import { makeEnv, row, rows, executeAll, type Env } from './helpers.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { offerroomPack } from '../src/server/packs/offerroom/pack.js';
import { extractSkills } from '../src/server/packs/offerroom/skills.js';
import { allSkills, autoTailor, gradeAnswer, normalizeJob, normalizeProfile, scoreFit, verifyTruth } from '../src/server/packs/offerroom/career.js';

const env = (): Env => makeEnv(new LocalCollab(), extendedRegistry());
const sample = () => offerroomPack.sample();
const profile = () => normalizeProfile(sample().plan.profile);
const job = (over: Record<string, unknown> = {}) => normalizeJob({ ...sample().change, ...over });

/** Creates + baselines an OfferRoom mission, optionally customising the plan/change, then submits the job. */
async function start(e: Env, tweak?: { plan?: (p: any) => void; change?: (c: any) => void }) {
  const s = sample(); tweak?.plan?.(s.plan); tweak?.change?.(s.change);
  const m = await e.engine.createMission(e.maya, { packId: 'offerroom', title: s.title, plan: s.plan });
  e.engine.approveBaseline(e.maya, m.id, 'profile approved in test');
  await e.engine.submitChange(e.maya, m.id, s.change);
  return m.id as string;
}
const state = (e: Env, id: string) => row(e, 'SELECT state FROM missions WHERE id=?', id).state as string;
const openQ = (e: Env, id: string) => rows(e, "SELECT * FROM questions WHERE mission_id=? AND status='open' AND blocking=1", id);
const actions = (e: Env, id: string) => rows(e, 'SELECT * FROM actions WHERE mission_id=? AND status NOT IN (\'stale\',\'superseded\')', id);
const mia = (e: Env) => e.actor('mia@harborvine.example');
const ben = (e: Env) => e.actor('ben@harborvine.example');

describe('OfferRoom pure logic (ported from the OfferRoom project)', () => {
  it('extracts skills with aliases and case-sensitive plain-English words', () => {
    expect(extractSkills('We use k8s, ReactJS and Postgres; Go is a plus')).toEqual(expect.arrayContaining(['Kubernetes', 'React', 'PostgreSQL', 'Go']));
    expect(extractSkills('go ahead and swift reply')).toEqual([]);                      // lower-case "go"/"swift" are English, not skills
    expect(extractSkills('React Native app')).toContain('React Native');
    expect(extractSkills('React Native app')).not.toContain('React');
  });
  it('scores an on-target role high, a different-field role low, and explains why', () => {
    const p = profile();
    const good = scoreFit(p, job(), '2026-11-09');
    expect(good.score).toBeGreaterThanOrEqual(75); expect(good.matched).toEqual(expect.arrayContaining(['Python', 'FastAPI', 'Docker'])); expect(good.missing).toEqual([]);
    expect(good.missingPreferred).toContain('Kubernetes'); expect(good.gaps.some((g) => g.skill === 'Kubernetes')).toBe(true);
    const mk = scoreFit(p, job({ title: 'Marketing Manager', description: 'Requirements: Excel, Communication.' }), '2026-11-09');
    expect(mk.score).toBeLessThanOrEqual(30); expect(mk.cappedBy.length).toBeGreaterThan(0);
    const onsiteFar = scoreFit(p, job({ location: 'Berlin', remote: false }), '2026-11-09');
    expect(onsiteFar.score).toBeLessThanOrEqual(64);
  });
  it('thin evidence (one named skill) cannot look like a perfect match', () => {
    const thin = scoreFit(profile(), job({ description: 'Requirements: Python.' }), '2026-11-09');
    expect(thin.breakdown.required).toBeLessThan(100);
  });
  it('counts a skill that is only in the skills list at 70% and asks for proof', () => {
    const f = scoreFit(profile(), job({ description: 'Requirements: Linux, Java, Python, SQL.' }), '2026-11-09');
    expect(f.proveIt.some((x) => x.includes('Linux'))).toBe(true);
  });
  it('implied skills count: Pytest in a bullet is evidence of Unit Testing', () => { expect(allSkills(profile())['Unit Testing']).toBeTruthy(); });
  it('auto-tailor output always passes its own truth guard', () => { const p = profile(); expect(verifyTruth(autoTailor(p, job()), p).filter((i) => i.severity === 'block')).toEqual([]); });
  it('truth guard blocks invented skills, numbers, entries and untraceable bullets', () => {
    const p = profile(); const t = autoTailor(p, job());
    const bad = structuredClone(t);
    bad.skills.push('Kubernetes');
    bad.summary = 'Led a team that served 10,000 users with Terraform';
    bad.projects[0].bullets.push('Scaled the service to 99999 requests per second');
    bad.experience.push({ id: 'exp-99', bullets: ['Did things at a company that does not exist'] });
    const blocks = verifyTruth(bad, p).filter((i) => i.severity === 'block').map((i) => i.message).join(' | ');
    expect(blocks).toMatch(/Kubernetes.*not in your profile/); expect(blocks).toMatch(/10000/); expect(blocks).toMatch(/Terraform/); expect(blocks).toMatch(/99999/); expect(blocks).toMatch(/unknown entry id 'exp-99'/);
  });
  it('grades a mock-interview answer on a transparent rubric and strips spoken fillers', () => {
    const q = { kind: 'technical' as const, expect: ['event loop', 'async', 'non-blocking'] };
    const strong = gradeAnswer(q, 'Node uses an event loop with non-blocking async I/O, because one thread handles many sockets, for example 300 requests; the trade-off is CPU-bound work. I used it in StudySync with Express and WebSockets, and measured it.');
    const weak = gradeAnswer(q, 'um um um like basically I dunno');
    expect(strong.score).toBeGreaterThan(weak.score); expect(weak.fillers).toBeGreaterThanOrEqual(3); expect(weak.tips.join(' ')).toMatch(/filler/);
    expect(gradeAnswer(q, 'x', 5).coachScore).toBe(5);
  });
});

describe('OfferRoom pack on the shared engine', () => {
  it('sample: fit → resume → critique → mentor brief; only the candidate can approve; verifier re-runs the truth guard on the read-back', async () => {
    const e = env(); const id = await start(e);
    expect(state(e, id)).toBe('awaiting_approval');
    expect(rows(e, 'SELECT kind FROM artifacts WHERE mission_id=?', id).map((a) => a.kind)).toEqual(expect.arrayContaining(['fit_report', 'resume', 'critique', 'interview_plan', 'mentor_brief']));
    const [act] = actions(e, id); expect(act.key).toBe('act-release-resume'); expect(act.connector).toBe('document_store');
    const ap = row(e, 'SELECT * FROM approvals WHERE subject_id=?', act.id);
    expect(ap.approver_label).toMatch(/Mia Chen \(Candidate\)/);
    await expect(e.engine.decideApproval(e.maya, id, ap.id, 'approved', 'boss says so')).rejects.toThrow(/Only Mia Chen/);       // a manager is NOT the candidate
    await expect(e.engine.decideApproval(e.sam, id, ap.id, 'approved', 'owner says so')).rejects.toThrow(/Only Mia Chen/);       // not even the workspace owner
    await e.engine.decideApproval(mia(e), id, ap.id, 'approved', 'I approve this resume');
    await executeAll(e, id);
    expect(row(e, 'SELECT status FROM actions WHERE id=?', act.id).status).toBe('verified');
    const ev = rows(e, "SELECT check_name, passed FROM evidence WHERE action_id=? AND kind='verification'", act.id);
    for (const n of ['resume payload present in read-back', 'truth guard re-run on the stored document', 'stored resume names the right role', 'does not claim an application was submitted']) expect(ev.find((x) => x.check_name === n)?.passed).toBe(1);
    // nothing was submitted anywhere and the honest scope is stated
    expect(rows(e, 'SELECT content FROM artifacts WHERE mission_id=? AND kind=\'resume\'', id)[0].content).toMatch(/never submits applications/);
  });

  it('the verifier is independent: tampering with the stored document after execution fails verification', async () => {
    const e = env(); const id = await start(e);
    const [act] = actions(e, id); const ap = row(e, 'SELECT * FROM approvals WHERE subject_id=?', act.id);
    await e.engine.decideApproval(mia(e), id, ap.id, 'approved', 'ok'); await executeAll(e, id);
    const { readFileSync, writeFileSync } = await import('node:fs');
    const loc = JSON.parse(row(e, 'SELECT result FROM actions WHERE id=?', act.id).result).location as string;
    writeFileSync(loc, readFileSync(loc, 'utf8').replace('"skills":["Python"', '"skills":["Kubernetes","Python"'), 'utf8');
    e.engine.verifyAction(e.maya, row(e, 'SELECT * FROM missions WHERE id=?', id), act.id);
    expect(row(e, 'SELECT status FROM actions WHERE id=?', act.id).status).toBe('verification_failed');
    expect(rows(e, "SELECT * FROM evidence WHERE action_id=? AND check_name='truth guard re-run on the stored document'", act.id)[0].passed).toBe(0);
  });

  it('an invented-claims resume draft is blocked: no action, a blocking question; "remove" falls back to the deterministic tailor', async () => {
    const e = env();
    const id = await start(e, { change: (c) => { c.tailoredDraft = { headline: 'Engineer', summary: 'Led a Kubernetes migration serving 10,000 users', skills: ['Python', 'Kubernetes'], projects: [{ id: 'proj-1', bullets: ['Built a FastAPI service for 99999 users'] }], experience: [], achievements: [] }; } });
    expect(state(e, id)).toBe('blocked'); expect(actions(e, id)).toHaveLength(0);
    const q = openQ(e, id)[0]; expect(q.key).toMatch(/^truth_[0-9a-f]{8}$/); expect(q.text).toMatch(/truth guard blocked/i);
    await expect(e.engine.answerQuestion(mia(e), id, q.id, 'it is fine, ship it')).rejects.toThrow(/Reply "remove"/);
    await e.engine.answerQuestion(mia(e), id, q.id, 'remove them');
    expect(state(e, id)).toBe('awaiting_approval'); expect(actions(e, id)).toHaveLength(1);
    expect(rows(e, "SELECT content FROM artifacts WHERE mission_id=? AND kind='resume' AND status='draft'", id).some((a) => !/Kubernetes|10,000|99999/.test(a.content))).toBe(true);
  });

  it('a weak fit is not tailored unless the candidate says so', async () => {
    const e = env(); const weak = (c: any) => { c.title = 'Senior Marketing Lead'; c.level = 'senior'; c.description = 'Requirements: Excel, Communication.'; };
    const id = await start(e, { change: weak });
    expect(state(e, id)).toBe('blocked'); const q = openQ(e, id)[0]; expect(q.key).toBe('low_fit_proceed');
    expect(actions(e, id)).toHaveLength(0);
    await e.engine.answerQuestion(mia(e), id, q.id, 'no');
    expect(actions(e, id)).toHaveLength(0); expect(rows(e, "SELECT * FROM artifacts WHERE mission_id=? AND kind='resume'", id)).toHaveLength(0);
  });

  it('required human review: assignee-only question bound to the exact resume; the candidate cannot self-review; no approval exists until the reviewer approves', async () => {
    const e = env(); const id = await start(e, { plan: (p) => { p.roster.humanReview = 'required'; } });
    expect(state(e, id)).toBe('blocked'); expect(actions(e, id)).toHaveLength(0);
    const q = openQ(e, id)[0]; expect(q.key).toMatch(/^review_[0-9a-f]{8}$/); expect(q.assignee_only).toBe(1);
    await expect(e.engine.answerQuestion(mia(e), id, q.id, 'approve')).rejects.toThrow(/assigned to can answer/);     // candidate (a manager) cannot answer the reviewer's question
    await expect(e.engine.answerQuestion(e.maya, id, q.id, 'approve')).rejects.toThrow(/assigned to can answer/);     // nor can any other manager
    await expect(e.engine.answerQuestion(ben(e), id, q.id, 'looks fine?')).rejects.toThrow(/approve.*changes/s);
    await e.engine.answerQuestion(ben(e), id, q.id, 'approve');
    expect(state(e, id)).toBe('awaiting_approval'); expect(actions(e, id)).toHaveLength(1);
    expect(rows(e, 'SELECT * FROM audit_events WHERE mission_id=? AND type=\'question_answered\'', id).some((a) => a.actor === 'Ben Ortiz')).toBe(true);
  });

  it('required human review that asks for changes keeps the approval from being requested', async () => {
    const e = env(); const id = await start(e, { plan: (p) => { p.roster.humanReview = 'required'; } });
    await e.engine.answerQuestion(ben(e), id, openQ(e, id)[0].id, 'changes: lead with QueueLess');
    expect(actions(e, id)).toHaveLength(0); expect(rows(e, 'SELECT * FROM approvals WHERE mission_id=?', id).filter((a) => a.status === 'pending')).toHaveLength(0);
  });

  it('named-approver gate is fail-closed when the role is unmapped', async () => {
    const e = env(); e.db.exec("UPDATE agent_roles SET user_id=NULL WHERE pack_id='offerroom' AND key='candidate'");
    const id = await start(e); const [act] = actions(e, id); const ap = row(e, 'SELECT * FROM approvals WHERE subject_id=?', act.id);
    expect(ap.approver_user_id).toBeNull(); expect(ap.approver_label).toMatch(/unmapped role/);
    await expect(e.engine.decideApproval(e.maya, id, ap.id, 'approved', '')).rejects.toThrow(/nobody can decide it/);
    await expect(e.engine.decideApproval(e.sam, id, ap.id, 'approved', '')).rejects.toThrow(/nobody can decide it/);
  });
});
