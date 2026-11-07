import { describe, it, expect } from 'vitest';
import { makeEnv, row, rows, missionRow, finishReviews, ackAll, type Env } from './helpers.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { evaluateCompletion } from '../src/server/engine/completion.js';
import { fixlinePack, gates, findDuplicate } from '../src/server/packs/fixline/pack.js';
import { recallPack, match, confirmedHits } from '../src/server/packs/recall/pack.js';

const testEnv = (): Env => makeEnv(new LocalCollab(), extendedRegistry());
async function begin(e: Env, packId: string, tweak?: (s: any) => void, submitter?: any) {
  const s = e.packs.get(packId)!.sample(); tweak?.(s);
  const m = await e.engine.createMission(e.maya, { packId, title: s.title, plan: s.plan });
  e.engine.approveBaseline(e.maya, m.id, 'test'); await e.engine.submitChange(submitter ?? e.maya, m.id, s.change);
  return m.id as string;
}
const live = (e: Env, id: string, key: string) => row(e, "SELECT * FROM actions WHERE mission_id=? AND key=? AND status NOT IN ('stale','superseded')", id, key);
const art = (e: Env, id: string, kind: string) => row(e, "SELECT content FROM artifacts WHERE mission_id=? AND kind=? ORDER BY created_at DESC", id, kind)?.content as string | undefined;

describe('Fixline', () => {
  const s = () => fixlinePack.sample(); const ch = (f: (c: any) => void) => { const x = structuredClone(s().change); f(x); return fixlinePack.changeSchema.parse(x) as any; };
  it('gates: repro must fail first, locked test untouched, tests green, different vendor approves', () => {
    expect(gates(ch(() => {})).ready).toBe(true);
    expect(gates(ch((c) => { c.repro.failedBeforeFix = false; })).reproLocked).toBe(false);
    expect(gates(ch((c) => { delete c.repro; })).ready).toBe(false);
    expect(gates(ch((c) => { c.fix.changedFiles.push('test/fx-1.test.js'); })).testUntouched).toBe(false);
    expect(gates(ch((c) => { c.fix.testsPassed = 9; })).testsGreen).toBe(false);
    expect(gates(ch((c) => { c.fix.review.vendor = 'claude-code'; })).crossReview).toBe(false);
    expect(gates(ch((c) => { c.fix.review = { vendor: 'codex', verdict: 'changes', mustFix: ['handle zero qty'] }; })).crossReview).toBe(false);
  });
  it('a duplicate becomes no ticket and no action; it carries the known issue workaround', async () => {
    const e = testEnv(); const id = await begin(e, 'fixline-bugfix', (x) => { x.change = { report: 'save10 coupon does not apply at checkout', reportedBy: 'Sam' }; });
    expect(findDuplicate(fixlinePack.planSchema.parse(s().plan) as any, 'save10 coupon does not apply at checkout')?.id).toBe('KI-1');
    expect(art(e, id, 'ticket')).toBeUndefined(); expect(art(e, id, 'customer_reply')).toMatch(/Type the code in capital letters/); expect(live(e, id, 'act-merge-record')).toBeUndefined();
  });
  it('proof before fixes: a fix without a failing repro proposes nothing; a fix editing the locked test is rejected', async () => {
    const e = testEnv(); const a = await begin(e, 'fixline-bugfix', (x) => { delete x.change.repro; }); expect(live(e, a, 'act-merge-record')).toBeUndefined();
    const b = await begin(e, 'fixline-bugfix', (x) => { x.change.fix.changedFiles.push('test/fx-1.test.js'); }); expect(live(e, b, 'act-merge-record')).toBeUndefined();
    expect(art(e, b, 'gate_report')).toMatch(/Locked test untouched \| FAIL/);
  });
  it('full journey: the owner reports (Sam); only the engineering lead approves (four-eyes); dry-run merge record verifies; mission completes', async () => {
    const e = testEnv(); const ana = e.actor('ana@harborvine.example'); const id = await begin(e, 'fixline-bugfix', undefined, e.sam); const a = live(e, id, 'act-merge-record'); expect(a).toBeDefined();
    const ap = row(e, 'SELECT * FROM approvals WHERE subject_id=?', a.id);
    await expect(e.engine.decideApproval(ana, id, ap.id, 'approved', 'support lead tries')).rejects.toThrow();
    await expect(e.engine.decideApproval(e.sam, id, ap.id, 'approved', 'reporter tries')).rejects.toThrow();
    await e.engine.decideApproval(e.maya, id, ap.id, 'approved', 'lead approves'); await e.engine.executeAction(e.maya, id, a.id);
    const ev = rows(e, "SELECT check_name, passed FROM evidence WHERE action_id=? AND kind='verification'", a.id);
    expect(ev.find((x) => /re-computed/.test(x.check_name))?.passed).toBe(1); expect(row(e, 'SELECT status FROM actions WHERE id=?', a.id).status).toBe('verified');
    expect(art(e, id, 'fix_ledger')).toMatch(/DRY-RUN: nothing was merged/);
    const reply = art(e, id, 'customer_reply')!; expect(reply).toMatch(/not treat this message as a confirmation of any refund/); expect(reply).not.toMatch(/we (have )?refunded|has been refunded|within \d+ (hours|days)|guarantee/i);
    ackAll(e, id); finishReviews(e, id); const comp = evaluateCompletion(e.engine, missionRow(e, id)); expect(comp.unresolved, JSON.stringify(comp.checks.filter((c) => !c.passed))).toEqual([]); expect(comp.allPassed).toBe(true);
  });
});

describe('Recall desk', () => {
  const s = () => recallPack.sample(); const plan = () => recallPack.planSchema.parse(s().plan) as any; const chg = () => recallPack.changeSchema.parse(s().change) as any;
  it('exact matches are certain; the letter-O batch is a look-alike, never auto-matched; unrelated batches do not match', () => {
    const h = match(plan(), chg()); expect(h.filter((x) => x.kind === 'exact').map((x) => x.batch)).toEqual(['PCM-2501']);
    expect(h.filter((x) => x.kind === 'lookalike').map((x) => x.batch)).toEqual(['APRCT-25O1']);
    expect(confirmedHits(plan(), chg(), {}).map((x) => x.batch)).toEqual(['PCM-2501']);
  });
  it('the QA Head alone answers look-alikes and approves; no order until look-alikes are decided; drafts are never sent', async () => {
    const e = testEnv(); const id = await begin(e, 'recall-desk');
    const q = row(e, "SELECT * FROM questions WHERE mission_id=? AND key LIKE 'lookalike_%' AND status='open'", id); expect(q).toBeDefined();
    expect(live(e, id, 'act-stop-sale')).toBeUndefined();
    expect(art(e, id, 'notices')).toMatch(/DRAFTS ONLY: RIPPLE sends nothing/); expect(art(e, id, 'notices')).toMatch(/हिन्दी/);
    await expect(e.engine.answerQuestion(e.maya, id, q.id, 'yes')).rejects.toThrow();
    await e.engine.answerQuestion(e.sam, id, q.id, 'yes');
    const a = live(e, id, 'act-stop-sale'); expect(a).toBeDefined();
    const ap = row(e, 'SELECT * FROM approvals WHERE subject_id=?', a.id);
    await expect(e.engine.decideApproval(e.maya, id, ap.id, 'approved', 'manager tries')).rejects.toThrow();
    await e.engine.decideApproval(e.sam, id, ap.id, 'approved', 'QA Head approves'); await e.engine.executeAction(e.maya, id, a.id);
    expect(row(e, 'SELECT status FROM actions WHERE id=?', a.id).status).toBe('verified');
    const comp = evaluateCompletion(e.engine, missionRow(e, id)); expect(comp.checks.find((c) => c.key === 'shelf_checks')?.passed).toBe(false);
    expect(comp.allPassed).toBe(false);
  });
  it('a "no" answer drops the look-alike from the order; completion needs a shelf read equal to the recalled batch', async () => {
    const e = testEnv(); const id = await begin(e, 'recall-desk'); const q = row(e, "SELECT * FROM questions WHERE mission_id=? AND key LIKE 'lookalike_%'", id);
    await e.engine.answerQuestion(e.sam, id, q.id, 'no'); const a = live(e, id, 'act-stop-sale');
    expect(art(e, id, 'stop_sale')).not.toMatch(/APRCT/); expect(art(e, id, 'stop_sale')).toMatch(/Pune store: Paracetamol 500mg batch PCM-2501/);
    const c = chg(); expect(recallPack.completionChecks!({ baselinePlan: plan(), revisedPlan: plan(), change: c, answers: { [q.key]: { text: 'no', value: 'no' } }, today: 'x' } as any).find((k) => k.key === 'shelf_checks')?.passed).toBe(false);
    c.shelfChecks = [{ storeId: 'pune', batch: 'PCM-2501', batchRead: 'pcm 2501', readBy: 'Store Manager' }];
    expect(recallPack.completionChecks!({ baselinePlan: plan(), revisedPlan: plan(), change: c, answers: { [q.key]: { text: 'no', value: 'no' } }, today: 'x' } as any).every((k) => k.passed)).toBe(true);
    c.shelfChecks[0].batchRead = 'PCM-2599'; expect(recallPack.completionChecks!({ baselinePlan: plan(), revisedPlan: plan(), change: c, answers: { [q.key]: { text: 'no', value: 'no' } }, today: 'x' } as any).find((k) => k.key === 'shelf_checks')?.passed).toBe(false);
    expect(a).toBeDefined();
  });
});
