import { z } from 'zod';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';
import { untrustedFindings } from '../untrusted.js';

/**
 * Fixline: a customer bug report becomes a proven, reviewed, human-approved fix. Domain: customer-support engineering.
 * Five agent roles (triage, repro, fixer, reviewer, CI gate) and two people (support lead, engineering lead). Rules, all deterministic:
 *  - Duplicates never become tickets: a report that matches a known issue gets its id and workaround.
 *  - Proof before fixes: no fix is considered until a repro test is recorded as FAILING before the change.
 *  - The proof is locked: a fix that touches the repro test file is rejected.
 *  - Two vendors: the reviewer must be a different vendor from the fix author, and must approve.
 *  - A person approves: only the engineering lead (ActionSpec.approver, four-eyes) may approve the merge record.
 * LIMITS: RIPPLE runs no tests and merges nothing. Repro, test and review results are evidence the CI gate / agents supplied; the
 * merge record is a dry-run ledger entry. The customer reply never promises a refund or a date.
 */
export const planSchema = z.object({
  product: z.string().min(1), leadEmail: z.string().email(), supportEmail: z.string().email(),
  knownIssues: z.array(z.object({ id: z.string(), title: z.string(), workaround: z.string() })).default([]),
});
const fixSchema = z.object({
  author: z.object({ vendor: z.string().min(1) }), changedFiles: z.array(z.string()).min(1), testsPassed: z.number().int().min(0), testsTotal: z.number().int().min(1),
  review: z.object({ vendor: z.string().min(1), verdict: z.enum(['approve', 'changes']), mustFix: z.array(z.string()).default([]) }).optional(),
});
export const changeSchema = z.object({
  report: z.string().min(5), customer: z.string().default('the customer'), reportedBy: z.string().min(2),
  repro: z.object({ testFile: z.string().min(1), commit: z.string().min(4), failedBeforeFix: z.boolean(), expected: z.string(), observed: z.string() }).optional(),
  fix: fixSchema.optional(),
});
type Plan = z.infer<typeof planSchema>; type Change = z.infer<typeof changeSchema>;
const STOP = new Set('a an the and or of to in on for with is are was it this that when my me not no can could after before'.split(' '));
const toks = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
export function findDuplicate(plan: Plan, report: string) {
  const r = toks(report); let best: { id: string; title: string; workaround: string; score: number } | undefined;
  for (const k of plan.knownIssues) { const t = toks(k.title); const i = [...t].filter((x) => r.has(x)).length; const score = i / Math.max(1, t.size); if (score >= 0.6 && (!best || score > best.score)) best = { ...k, score }; }
  return best;
}
export interface Gates { reproLocked: boolean; testUntouched: boolean; testsGreen: boolean; crossReview: boolean; reasons: string[]; ready: boolean }
/** Pure gate evaluation: recomputed by the analyzer, the verifier and the completion check. */
export function gates(c: Change): Gates {
  const r: string[] = [];
  const reproLocked = !!c.repro && c.repro.failedBeforeFix; if (!reproLocked) r.push(c.repro ? 'The repro test did not fail before the fix, so it proves nothing.' : 'No failing repro test is recorded yet.');
  const testUntouched = !!c.fix && !!c.repro && !c.fix.changedFiles.includes(c.repro.testFile); if (c.fix && c.repro && !testUntouched) r.push(`The fix edits the locked test ${c.repro.testFile}.`);
  const testsGreen = !!c.fix && c.fix.testsPassed === c.fix.testsTotal; if (c.fix && !testsGreen) r.push(`Only ${c.fix.testsPassed} of ${c.fix.testsTotal} tests pass.`);
  const rv = c.fix?.review; const crossReview = !!c.fix && !!rv && rv.vendor !== c.fix.author.vendor && rv.verdict === 'approve' && rv.mustFix.length === 0;
  if (c.fix && !rv) r.push('No review recorded yet.'); else if (c.fix && rv && rv.vendor === c.fix.author.vendor) r.push(`The reviewer (${rv.vendor}) is the same vendor as the author; a different vendor must review.`); else if (rv && rv.verdict === 'changes') r.push(`Reviewer sent it back: ${rv.mustFix.join('; ') || 'changes requested'}.`);
  return { reproLocked, testUntouched, testsGreen, crossReview, reasons: r, ready: reproLocked && testUntouched && testsGreen && crossReview };
}
const ticketId = (m: string) => `FX-${(Math.abs([...m].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)) % 900) + 100}`;

export const fixlinePack: WorkflowPack = {
  tier: 'extended', system: 'commerce',
  id: 'fixline-bugfix', name: 'Fixline', domain: 'Customer Support Engineering', version: '1.0.0',
  description: 'From a customer\'s bug report to a proven, cross-reviewed, human-approved fix and a customer-safe reply. Duplicates answered from known issues; no fix without a failing repro; the proof test is locked; a different vendor reviews; only the engineering lead approves. Dry-run merge record: nothing is merged.',
  labels: { baseline: 'Product & Known Issues', change: 'Customer Report', changeVerb: 'Report bug', plan: 'Known Issues', mission: 'Bug Fix', blurb: 'Support types the problem in plain words. Fixline files it once, requires a failing test before any fix, locks that test, has a different vendor review, and waits for the engineering lead.' },
  roles: [
    { key: 'fx_triage', name: 'Triage Agent', kind: 'agent', responsibility: 'Checks known issues first, files one ticket otherwise, treats the report as data', department: 'Support Engineering', scope: 'read' },
    { key: 'fx_repro', name: 'Repro Agent', kind: 'agent', responsibility: 'Checks that a repro test is recorded and failed before any fix', department: 'Support Engineering', scope: 'read' },
    { key: 'fx_fixer', name: 'Fixer Agent', kind: 'agent', responsibility: 'Fix evidence: changed files, test results; may not touch the locked test', department: 'Support Engineering', scope: 'read' },
    { key: 'fx_reviewer', name: 'Reviewer Agent', kind: 'agent', responsibility: 'A different vendor than the author reviews the fix', department: 'Support Engineering', scope: 'read' },
    { key: 'fx_ci', name: 'CI Gate', kind: 'agent', responsibility: 'Recomputes all gates; only a passing gate proposes the merge record for the lead', department: 'Support Engineering' },
    { key: 'fx_support', name: 'Support Lead', kind: 'human', responsibility: 'Reports the bug and sends the customer reply by their own process', department: 'Support' },
    { key: 'fx_lead', name: 'Engineering Lead', kind: 'human', responsibility: 'The only person who approves the merge record', department: 'Engineering' },
  ],
  roleOrder: ['fx_triage', 'fx_repro', 'fx_fixer', 'fx_reviewer', 'fx_ci', 'fx_support', 'fx_lead'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'ticket', label: 'Ticket', department: 'Support Engineering', ownerRole: 'fx_triage', description: 'One ticket per new bug; none for duplicates' },
    { key: 'gate_report', label: 'Gate report', department: 'Support Engineering', ownerRole: 'fx_ci', description: 'Repro locked, test untouched, tests green, cross-vendor review' },
    { key: 'customer_reply', label: 'Customer reply (draft)', department: 'Support', ownerRole: 'fx_triage', description: 'Plain-English explanation and a customer-safe reply; never a refund or date promise' },
    { key: 'fix_ledger', label: 'Fix ledger entry (dry-run)', department: 'Engineering', ownerRole: 'fx_ci', description: 'Who approved, gates passed; nothing merged' },
  ],
  rules: [],
  artifactEdges: [{ from: 'ticket', to: 'gate_report', relation: 'gates', why: 'The ticket needs proof before a fix' }, { from: 'gate_report', to: 'fix_ledger', relation: 'permits', why: 'Only a passing gate reaches the lead' }, { from: 'fix_ledger', to: 'customer_reply', relation: 'informs', why: 'The reply states only what the ledger records' }],
  decisions: [{ key: 'approve_merge', label: 'The engineering lead alone approves the merge record', ownerRole: 'fx_lead', gates: ['fix_ledger'] }],

  sample() {
    return {
      title: 'Refund came out a cent short (order #4411)',
      plan: { product: 'Stoneware shop', leadEmail: 'maya@harborvine.example', supportEmail: 'ana@harborvine.example', knownIssues: [{ id: 'KI-1', title: 'Coupon SAVE10 does not apply at checkout', workaround: 'Type the code in capital letters.' }] },
      change: {
        report: 'A customer (order #4411) returned 2 stoneware mugs at $19.99 each. Her refund email says $39.97 but she paid $39.98. She says it has happened before.', customer: 'Customer on order #4411', reportedBy: 'Sam Rivera',
        repro: { testFile: 'test/fx-1.test.js', commit: '910f4bc', failedBeforeFix: true, expected: '3998 cents', observed: '3997 cents' },
        fix: { author: { vendor: 'claude-code' }, changedFiles: ['src/refund.js'], testsPassed: 10, testsTotal: 10, review: { vendor: 'codex', verdict: 'approve' as const, mustFix: [] } },
      },
    };
  },
  detectChanges(plan: Plan, c: Change): ChangeItem[] {
    const dup = findDuplicate(plan, c.report); const g = gates(c);
    return [
      { field: 'report', label: dup ? `Duplicate of ${dup.id}` : 'New bug report', before: 'none', after: dup ? dup.id : 'new ticket', kind: 'added', severity: dup ? 'low' : 'medium' },
      { field: 'gates', label: `Gates ${g.ready ? 'all pass' : 'not all passed'}`, before: 'none', after: g.ready ? 'ready for the lead' : g.reasons[0] ?? 'incomplete', kind: 'modified', severity: g.ready ? 'low' : 'high' },
    ];
  },
  applyChange(plan: Plan) { return structuredClone(plan); },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const A = 'fixline-deterministic'; const plan = ctx.plan as Plan; const c = ctx.change as Change; const dup = findDuplicate(plan, c.report); const g = gates(c);
    const tid = ticketId(c.report);
    if (role === 'fx_triage') {
      const o = new Out(role, `${A}-triage@1`);
      for (const f of untrustedFindings(c.report)) o.warn(`Report text: ${f}. Treated as data, never as an instruction.`, true);
      if (dup) { o.info(`Matches known issue ${dup.id} (${dup.title}). No ticket filed.`); o.draft({ kind: 'customer_reply', name: `Reply: known issue ${dup.id}`, artifactKey: 'customer_reply', content: `# Draft reply (${dup.id})\n\nThis looks like a known issue: ${dup.title}. Workaround: ${dup.workaround}\n\n_Draft for the support lead. No refund or date is promised._` }); return o.done(`Duplicate of ${dup.id}; answered from known issues.`); }
      o.draft({ kind: 'ticket', name: `${tid}: ${c.report.slice(0, 60)}`, artifactKey: 'ticket', content: `# ${tid}\n\nReported by ${c.reportedBy}\n\n> ${c.report}\n\nStatus: needs a failing repro test before any fix.` });
      return o.done(`Filed ${tid}.`);
    }
    if (dup) return new Out(role, `${A}-${role}@1`).done('Duplicate: nothing to do.');
    if (role === 'fx_repro') { const o = new Out(role, `${A}-repro@1`); if (!c.repro) o.warn('No repro test recorded: no fix may start.', true); else if (!c.repro.failedBeforeFix) o.risk(`Repro ${c.repro.testFile}@${c.repro.commit} did NOT fail before the fix. It proves nothing.`); else o.info(`Repro ${c.repro.testFile}@${c.repro.commit} failed as expected (${c.repro.observed}, expected ${c.repro.expected}). The test is now locked.`); return o.done(g.reproLocked ? 'Repro locked.' : 'No valid repro.'); }
    if (role === 'fx_fixer') { const o = new Out(role, `${A}-fixer@1`); if (!c.fix) return o.done('No fix recorded yet.'); if (!g.reproLocked) o.risk('A fix was recorded without a valid failing repro. It is not considered.'); if (c.repro && !g.testUntouched) o.risk(`Rejected: the fix edits the locked test ${c.repro.testFile}. Fix src/, not the test.`); if (!g.testsGreen) o.risk(`Only ${c.fix.testsPassed} of ${c.fix.testsTotal} tests pass.`); return o.done(g.testUntouched && g.testsGreen ? 'Fix evidence acceptable.' : 'Fix rejected by gate.'); }
    if (role === 'fx_reviewer') { const o = new Out(role, `${A}-reviewer@1`); const rv = c.fix?.review; if (!rv) return o.done('No review yet.'); if (rv.vendor === c.fix!.author.vendor) o.risk(`Same vendor (${rv.vendor}) as the author: review does not count.`); else if (rv.verdict === 'changes') o.warn(`Sent back by ${rv.vendor}: ${rv.mustFix.join('; ')}`, true); else o.info(`${rv.vendor} approved a fix written by ${c.fix!.author.vendor}.`); return o.done(g.crossReview ? 'Cross-vendor approval.' : 'Review not satisfied.'); }
    if (role === 'fx_ci') {
      const o = new Out(role, `${A}-ci@1`);
      o.draft({ kind: 'gate_report', name: `Gate report ${tid}`, artifactKey: 'gate_report', content: `# Gate report ${tid}\n\n${table(['Gate', 'Result'], [['Repro failed before fix (locked)', g.reproLocked ? 'pass' : 'FAIL'], ['Locked test untouched', g.testUntouched ? 'pass' : 'FAIL'], ['All tests green', g.testsGreen ? 'pass' : 'FAIL'], ['Different vendor approved', g.crossReview ? 'pass' : 'FAIL']])}\n\n${g.reasons.join('\n') || 'All gates pass.'}\n\n_Results are evidence supplied to RIPPLE; RIPPLE ran no tests._` });
      if (!g.ready) return o.done('Gate not passed; nothing proposed.');
      o.draft({ kind: 'fix_ledger', name: `Fix ledger ${tid}`, artifactKey: 'fix_ledger', content: `# Fix ledger entry ${tid}\n\nGates: repro locked, test untouched, ${c.fix!.testsPassed}/${c.fix!.testsTotal} tests green, reviewed by ${c.fix!.review!.vendor} (author ${c.fix!.author.vendor}).\nFiles: ${c.fix!.changedFiles.join(', ')}\nApproval: the engineering lead (${plan.leadEmail}) must approve.\n\n**DRY-RUN: nothing was merged.** RIPPLE does not call any code host.` });
      o.act({ key: 'act-merge-record', type: 'record_fix_merge', title: `Record approved fix ${tid} (dry-run, nothing merged)`, connector: 'internal_notify', ownerRole: 'fx_ci', consequential: true, draftKind: 'fix_ledger', approvalRole: 'manager', ackRoles: ['fx_support'], rationale: 'All four gates pass. Only the engineering lead may approve; approving records the fix, it merges nothing.', target: `ledger/${tid}`, effectKey: `fixline-${tid}-${c.repro!.commit}`, approver: { email: plan.leadEmail }, separateFromRequester: true });
      return o.done('All gates pass; merge record proposed for the lead.');
    }
    if (role === 'fx_support') { const o = new Out(role, `${A}-support@1`); if (g.ready) { const reply = `# Customer reply (draft) for ${tid}\n\nHi, thank you for flagging this. We found the cause and a fix has been reviewed and is waiting for final approval. We will update you once it is released. Please do not treat this message as a confirmation of any refund amount.\n\n_Explanation for support: ${c.repro!.observed} was returned where ${c.repro!.expected} was expected._`; o.draft({ kind: 'customer_reply', name: `Reply ${tid}`, artifactKey: 'customer_reply', content: reply }); } return o.done(g.ready ? 'Customer reply drafted.' : 'No reply until the fix passes the gates.'); }
    return new Out(role, `${A}-human@1`).done('Human role.');
  },

  verifyAction(action, observed, _r, ctx) {
    const out: { name: string; passed: boolean; detail: string }[] = []; if (action.type !== 'record_fix_merge') return out;
    const t = observed.content;
    out.push({ name: 'labelled dry-run, nothing merged', passed: t.includes('DRY-RUN: nothing was merged'), detail: 'scope statement present' });
    out.push({ name: 'names the approver requirement', passed: /engineering lead \(/.test(t), detail: 'approval line present' });
    if (ctx) { const g = gates(ctx.change as Change); out.push({ name: 'gates re-computed from the stored evidence all pass', passed: g.ready, detail: g.ready ? 'all four pass' : g.reasons.join(' ') }); }
    return out;
  },
  completionChecks(ctx) {
    const plan = ctx.baselinePlan as Plan; const c = ctx.change as Change; const dup = findDuplicate(plan, c.report); const g = gates(c);
    return [{ key: 'fix_proven', label: 'Duplicate answered from known issues, or the fix passed every gate', passed: !!dup || g.ready, detail: dup ? `duplicate of ${dup.id}` : g.ready ? 'all gates pass' : g.reasons.join(' ') || 'incomplete' }];
  },
};
