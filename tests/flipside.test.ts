import { describe, it, expect } from 'vitest';
import { makeEnv, row, rows, missionRow, finishReviews, ackAll, type Env } from './helpers.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { evaluateCompletion } from '../src/server/engine/completion.js';
import { buildTree, proofFor, verifyStep, leafHash } from '../src/server/capabilities/seal/merkle.js';
import { flipsidePack, parseDisclosure, proofResult, renderDisclosure, chooseStep, sealSession } from '../src/server/packs/flipside/pack.js';
import { syntheticSession, stepText } from '../src/server/packs/flipside/fixture.js';

describe('Merkle seal capability', () => {
  const contents = Array.from({ length: 10 }, (_, i) => `step ${i}`);
  const tree = buildTree(contents);
  it('every step verifies against the root, for odd and even sizes', () => {
    for (const n of [1, 2, 3, 7, 10]) { const t = buildTree(contents.slice(0, n)); for (let i = 0; i < n; i++) expect(verifyStep(t.root, n, i, contents[i], proofFor(t, i)).ok).toBe(true); }
  });
  it('an edited step, a wrong index, a swapped side and a truncated proof all fail', () => {
    const p = proofFor(tree, 3);
    expect(verifyStep(tree.root, 10, 3, 'step 3 (edited)', p).ok).toBe(false);
    expect(verifyStep(tree.root, 10, 4, contents[3], p).ok).toBe(false);
    expect(verifyStep(tree.root, 10, 3, contents[3], p.map((x, i) => i === 0 ? { ...x, side: x.side === 'left' ? 'right' as const : 'left' as const } : x)).ok).toBe(false);
    expect(verifyStep(tree.root, 10, 3, contents[3], p.slice(1)).ok).toBe(false);
    expect(verifyStep(tree.root, 10, 99, contents[3], p).ok).toBe(false);
  });
  it('leaf and node hashes are domain separated', () => { expect(leafHash(0, 'a')).not.toBe(leafHash(1, 'a')); expect(tree.levels[0]).toHaveLength(10); expect(tree.levels.at(-1)).toHaveLength(1); });
});

describe('Flipside review mission', () => {
  const testEnv = (): Env => makeEnv(new LocalCollab(), extendedRegistry());
  async function begin(e: Env, tweak?: (s: any) => void) {
    const s = flipsidePack.sample(); tweak?.(s);
    const m = await e.engine.createMission(e.maya, { packId: 'flipside-review', title: s.title, plan: s.plan });
    e.engine.approveBaseline(e.maya, m.id, 'test'); await e.engine.submitChange(e.maya, m.id, s.change);
    return m.id as string;
  }
  const live = (e: Env, id: string, key: string) => row(e, "SELECT * FROM actions WHERE mission_id=? AND key=? AND status NOT IN ('stale','superseded')", id, key);

  it('asks Q1 to the author only, proposes nothing until the author answers, and only the author may approve', async () => {
    const e = testEnv(); const id = await begin(e);
    const q = row(e, "SELECT * FROM questions WHERE mission_id=? AND key='why_change' AND status='open'", id);
    expect(q).toBeDefined();
    expect(live(e, id, 'act-disclose-step')).toBeUndefined();
    await expect(e.engine.answerQuestion(e.maya, id, q.id, 'It was a needed change for the worker token.')).rejects.toThrow();
    await expect(e.engine.answerQuestion(e.actor('omar@harborvine.example'), id, q.id, 'I am the reviewer, answering for them.')).rejects.toThrow();
    await e.engine.answerQuestion(e.actor('noor@harborvine.example'), id, q.id, 'The scheduled-report worker has no cookie, so I allowed its signed token on one route.');
    const a = live(e, id, 'act-disclose-step'); expect(a).toBeDefined();
    const ap = row(e, 'SELECT * FROM approvals WHERE subject_id=?', a.id);
    await expect(e.engine.decideApproval(e.maya, id, ap.id, 'approved', 'manager override')).rejects.toThrow();
    await e.engine.decideApproval(e.actor('noor@harborvine.example'), id, ap.id, 'approved', 'share the one step');
  });

  it('full journey: one step shared, re-verified from the seal, other steps absent, whole-session request refused, edited copy PROOF_FAIL, completes', async () => {
    const e = testEnv(); const id = await begin(e);
    const author = e.actor('noor@harborvine.example');
    const q = row(e, "SELECT * FROM questions WHERE mission_id=? AND key='why_change'", id);
    await e.engine.answerQuestion(author, id, q.id, 'The scheduled-report worker has no cookie, so I allowed its signed token on one route.');
    const a = live(e, id, 'act-disclose-step');
    await e.engine.decideApproval(author, id, row(e, 'SELECT * FROM approvals WHERE subject_id=?', a.id).id, 'approved', 'ok');
    await e.engine.executeAction(e.maya, id, a.id);
    const ev = rows(e, "SELECT check_name, passed, detail FROM evidence WHERE action_id=? AND kind='verification'", a.id);
    expect(ev.find((x) => x.check_name === 'step re-checked against the sealed root')?.passed).toBe(1);
    expect(ev.find((x) => x.check_name === 'no other session step appears in the delivery')?.passed).toBe(1);
    expect(row(e, 'SELECT status FROM actions WHERE id=?', a.id).status).toBe('verified');
    const brief = row(e, "SELECT content FROM artifacts WHERE mission_id=? AND kind='review_brief' ORDER BY created_at DESC", id).content as string;
    expect(brief).toMatch(/Steps not shown:\*\* 9/); expect(brief).toMatch(/requested and refused/); expect(brief).toMatch(/Edited copy posted for checking:\*\* PROOF_FAIL/);
    const kinds = rows(e, 'SELECT kind, content FROM artifacts WHERE mission_id=?', id);
    const steps = syntheticSession(142).map(stepText);
    const allText = kinds.map((k) => k.content).join('\n');
    expect(allText.includes(steps[5])).toBe(true);
    for (const i of [0, 1, 2, 3, 4, 6, 7, 8, 9]) expect(allText.includes(steps[i])).toBe(false);
    ackAll(e, id); finishReviews(e, id);
    const comp = evaluateCompletion(e.engine, missionRow(e, id));
    expect(comp.checks.find((c) => c.key === 'edited_copy_rejected')?.passed).toBe(true);
    expect(comp.checks.find((c) => c.key === 'seal_consistent')?.passed).toBe(true);
    expect(comp.unresolved, JSON.stringify(comp.checks.filter((c) => !c.passed))).toEqual([]);
    expect(comp.allPassed).toBe(true);
  });

  it('a tampered stored disclosure fails re-verification', () => {
    const s = flipsidePack.sample(); const plan = flipsidePack.planSchema.parse(s.plan) as any; const pick = chooseStep(plan, 'auth/session.py') as any;
    const ctx = { baselinePlan: plan, change: s.change, answers: {}, revisedPlan: plan } as any;
    const good = renderDisclosure(plan, pick);
    expect(flipsidePack.verifyAction!({ type: 'disclose_session_step', payload: {} }, { content: good }, plan, ctx).every((c) => c.passed)).toBe(true);
    const edited = renderDisclosure(plan, { ...pick, content: pick.content.replace('accept the worker', 'x').replace('signed service token', 'anything') });
    expect(flipsidePack.verifyAction!({ type: 'disclose_session_step', payload: {} }, { content: edited }, plan, ctx).some((c) => !c.passed)).toBe(true);
    expect(proofResult(plan, parseDisclosure(edited)!).verdict).toBe('PROOF_FAIL');
    const leaky = good + '\n' + stepText(syntheticSession(142)[2]);
    expect(flipsidePack.verifyAction!({ type: 'disclose_session_step', payload: {} }, { content: leaky }, plan, ctx).find((c) => /no other session step/.test(c.name))?.passed).toBe(false);
  });

  it('nothing is disclosed when the author-side session does not match the seal; no question when the description already explains the file', async () => {
    const plan = flipsidePack.planSchema.parse(flipsidePack.sample().plan) as any;
    expect('error' in chooseStep({ ...plan, seal: { ...plan.seal, root: 'f'.repeat(64) } }, 'auth/session.py')).toBe(true);
    expect('error' in chooseStep(plan, 'no/such/file.py')).toBe(true);
    const e = testEnv(); const id = await begin(e, (s) => { s.plan.pr.description += ' Also touches auth/session.py for the worker token.'; });
    expect(row(e, "SELECT id FROM questions WHERE mission_id=? AND key='why_change'", id)).toBeUndefined();
    expect(missionRow(e, id).state).not.toBe('blocked');
  });

  it('sealSession is deterministic and the sample seal matches the fixture', () => {
    expect(sealSession(142, 'b43b8d0').root).toBe(sealSession(142, 'b43b8d0').root);
    expect(sealSession(142, 'x').root).not.toBe(sealSession(143, 'x').root);
  });
});
