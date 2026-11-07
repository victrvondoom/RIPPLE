import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';
import { buildTree, proofFor, verifyStep, type ProofStep } from '../../capabilities/seal/merkle.js';
import { syntheticSession, stepText } from './fixture.js';

/**
 * Flipside review: a reviewer's agent asks why a change was made in a PR written by ANOTHER team's coding agent.
 * The author's agent session is private and sealed (Merkle root over every step) before review. The author can share exactly ONE step;
 * RIPPLE checks that step against the seal. A whole-session request is refused: no action type exists for it.
 *  - Deterministic only: no model decides anything (analyzer ids say so).
 *  - Only the author answers the question and approves the disclosure (assigneeOnly + ActionSpec.approver).
 *  - The verifier re-reads the stored disclosure and recomputes the proof from the baseline seal; an edited copy gets PROOF_FAIL.
 *  - Limits: the seal proves a step is in the session that was sealed. It does not prove the step is true, that the author's agent
 *    behaved well, or that the PR is safe. The sample session is a synthetic fixture, and the delivery is a local dry-run outbox.
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const planSchema = z.object({
  pr: z.object({ repo: z.string().min(1), number: z.number().int().positive(), title: z.string().min(1), description: z.string(), files: z.array(z.object({ path: z.string().min(1), summary: z.string() })).min(1) }),
  authorEmail: z.string().email(),     // owns the sealed session; the only person who may answer or approve
  reviewerEmail: z.string().email(),
  seal: z.object({ root: z.string().regex(/^[0-9a-f]{64}$/), leafCount: z.number().int().positive(), leafHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1), commit: z.string().min(4), sealedAt: z.string() }),
});
export const changeSchema = z.object({
  request: z.object({ file: z.string().min(1), question: z.string().default('Why was this file changed?') }),
  wholeSessionRequested: z.boolean().default(false),
  forgedCopy: z.object({ index: z.number().int(), content: z.string(), proof: z.array(z.object({ hash: z.string(), side: z.enum(['left', 'right']) })) }).optional(),
});
type Plan = z.infer<typeof planSchema>; type Change = z.infer<typeof changeSchema>;

export function sealSession(prNumber: number, commit: string, sealedAt = '2026-11-06T11:26:00Z') {
  const contents = syntheticSession(prNumber).map(stepText); const t = buildTree(contents);
  return { root: t.root, leafCount: contents.length, leafHashes: t.levels[0], commit, sealedAt };
}
const sealConsistent = (plan: Plan) => rootFromLeaves(plan.seal.leafHashes) === plan.seal.root && plan.seal.leafHashes.length === plan.seal.leafCount;
/** Recompute the root from the public leaf hashes (commitments), without any step content. */
function rootFromLeaves(leaves: string[]): string {
  let level = leaves;
  while (level.length > 1) { const next: string[] = []; for (let i = 0; i < level.length; i += 2) next.push(sha1node(level[i], level[i + 1] ?? level[i])); level = next; }
  return level[0];
}
const sha1node = (l: string, r: string) => createHash('sha256').update(Buffer.from([1])).update(l + r).digest('hex');

export const explainsInDescription = (plan: Plan, file: string) => { const base = file.split('/').pop()!.toLowerCase(); return plan.pr.description.toLowerCase().includes(base) || plan.pr.description.toLowerCase().includes(file.toLowerCase()); };
/** The author's agent picks the one step that explains the requested file: the reasoning step, else the edit step. Returns undefined when nothing matches. */
export function chooseStep(plan: Plan, file: string): { index: number; content: string; proof: ProofStep[] } | { error: string } {
  const steps = syntheticSession(plan.pr.number); const contents = steps.map(stepText); const tree = buildTree(contents);
  if (tree.root !== plan.seal.root) return { error: 'The author-side session does not match the sealed root, so nothing can be disclosed.' };
  const cand = steps.find((s) => s.file === file && s.kind === 'reasoning') ?? steps.find((s) => s.file === file && s.kind === 'edit');
  if (!cand) return { error: `No session step mentions ${file}.` };
  return { index: cand.index, content: contents[cand.index], proof: proofFor(tree, cand.index) };
}

const DISCLOSURE_RE = /```flipside-disclosure\n([\s\S]*?)\n```/;
export interface Disclosure { index: number; content: string; proof: ProofStep[] }
export const renderDisclosure = (plan: Plan, d: Disclosure) => `# Flipside disclosure: PR #${plan.pr.number} (${plan.pr.repo})\n\nSeal root: \`${plan.seal.root}\` (${plan.seal.leafCount} steps, commit ${plan.seal.commit})\n\n**1 of ${plan.seal.leafCount} session steps disclosed** (step ${d.index}). The other ${plan.seal.leafCount - 1} steps were not shown and stay with the author.\n\n> ${d.content}\n\n\`\`\`flipside-disclosure\n${JSON.stringify(d)}\n\`\`\`\n\n_The seal proves this step is in the session sealed before review. It does not prove the step is correct or that the change is safe. Delivered to a local dry-run outbox only._`;
export function parseDisclosure(text: string): Disclosure | undefined {
  const m = DISCLOSURE_RE.exec(text); if (!m) return undefined;
  try { const d = JSON.parse(m[1]); return typeof d.index === 'number' && typeof d.content === 'string' && Array.isArray(d.proof) ? d : undefined; } catch { return undefined; }
}
/** PROOF_FAIL / OK, exactly as the review room reports it. */
export const proofResult = (plan: Plan, d: Disclosure) => { const r = verifyStep(plan.seal.root, plan.seal.leafCount, d.index, d.content, d.proof as ProofStep[]); return { verdict: r.ok ? 'OK' as const : 'PROOF_FAIL' as const, reason: r.reason }; };

export const flipsidePack: WorkflowPack = {
  id: 'flipside-review',
  name: 'Flipside Review',
  domain: 'Code Review',
  version: '1.0.0',
  description: 'Ask the author\'s agent why. A reviewer\'s agent requests the one session step behind a change; the author approves sharing that single step; RIPPLE proves it appears in the session sealed before review. Whole-session requests are refused. Deterministic: no model decides anything.',
  labels: { baseline: 'Sealed Session', change: 'Review Request', changeVerb: 'Ask the author', plan: 'PR & Seal', mission: 'Flipside Review', blurb: 'The reviewer gets the step behind the change, with proof it is in the sealed session. The author shares one step, not the session. Only the author answers and approves.' },
  roles: [
    { key: 'flip_reviewer_agent', name: 'Reviewer Agent', kind: 'agent', responsibility: 'Reads the public PR, finds the change the description does not explain, and asks the author why', department: 'Code Review', scope: 'read' },
    { key: 'flip_author_agent', name: 'Author Agent', kind: 'agent', responsibility: 'Holds the private session; proposes disclosing exactly one step, never the session', department: 'Code Review' },
    { key: 'flip_verifier', name: 'Seal Verifier', kind: 'agent', responsibility: 'Checks the disclosed step against the sealed root, rejects an edited copy (PROOF_FAIL), and writes the reviewer\'s brief', department: 'Code Review', scope: 'read' },
    { key: 'flip_author', name: 'PR Author', kind: 'human', responsibility: 'Owns the session; the only person who answers the why-question and approves the disclosure', department: 'Code Review' },
    { key: 'flip_reviewer', name: 'Reviewer', kind: 'human', responsibility: 'Receives the verified step and decides the review', department: 'Code Review' },
  ],
  roleOrder: ['flip_reviewer_agent', 'flip_author_agent', 'flip_verifier', 'flip_author', 'flip_reviewer'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'review_gap', label: 'Unexplained change', department: 'Code Review', ownerRole: 'flip_reviewer_agent', description: 'The PR file whose reason the description omits' },
    { key: 'disclosure', label: 'Disclosed session step', department: 'Code Review', ownerRole: 'flip_author_agent', description: 'One step plus its Merkle proof; no other step' },
    { key: 'review_brief', label: 'Reviewer brief', department: 'Code Review', ownerRole: 'flip_verifier', description: 'The answer, the verified step, and the steps that were not shown' },
  ],
  rules: [],
  artifactEdges: [
    { from: 'review_gap', to: 'disclosure', relation: 'requests', why: 'The disclosure answers one specific gap' },
    { from: 'disclosure', to: 'review_brief', relation: 'verified_into', why: 'Only a step that passes the seal check reaches the brief' },
  ],
  decisions: [{ key: 'disclose_one_step', label: 'The author alone decides whether to share the one requested step', ownerRole: 'flip_author', gates: ['disclosure', 'review_brief'] }],

  sample() {
    const seal = sealSession(142, 'b43b8d0');
    return {
      title: 'PR #142: Add CSV export to the reports page (why did auth/session.py change?)',
      plan: {
        pr: { repo: 'acme/reports-service', number: 142, title: 'Add CSV export to the reports page', description: 'Adds a CSV export button to the reports page, streamed from the existing report query. PDF export is unchanged.', files: [{ path: 'reports/export.py', summary: 'new streaming CSV writer' }, { path: 'reports/templates/reports.html', summary: 'Export CSV button' }, { path: 'auth/session.py', summary: 'validate_session() changed' }] },
        authorEmail: 'noor@harborvine.example', reviewerEmail: 'omar@harborvine.example', seal,
      },
      change: {
        request: { file: 'auth/session.py', question: 'auth/session.py changed and the description never says why. Which step explains it?' },
        wholeSessionRequested: true,
        // An edited copy of the real step (a reviewer-side forgery test): same index, softened wording.
        forgedCopy: { index: 5, content: '[reasoning auth/session.py] Cosmetic rename only; no behaviour change.', proof: proofFor(buildTree(syntheticSession(142).map(stepText)), 5) },
      },
    };
  },

  detectChanges(plan: Plan, change: Change): ChangeItem[] {
    const f = plan.pr.files.find((x) => x.path === change.request.file);
    const items: ChangeItem[] = [{ field: 'request.file', label: `Reviewer asks why ${change.request.file} changed`, before: f ? 'in the public diff' : 'not in the diff', after: explainsInDescription(plan, change.request.file) ? 'explained in the description' : 'not explained in the description', kind: 'modified', severity: f && !explainsInDescription(plan, change.request.file) ? 'high' : 'low' }];
    if (change.wholeSessionRequested) items.push({ field: 'request.wholeSession', label: 'Whole-session disclosure requested', before: 'one step per approved request', after: 'whole session', kind: 'modified', severity: 'high', note: 'Refused by policy' });
    if (change.forgedCopy) items.push({ field: 'request.copyCheck', label: `An edited copy of step ${change.forgedCopy.index} was posted for checking`, before: 'sealed step', after: 'posted copy', kind: 'modified', severity: 'medium' });
    return items;
  },
  applyChange(plan: Plan): Plan { return structuredClone(plan); },

  parseAnswer(key, text) {
    const t = text.trim();
    if (key === 'why_change') return t.length >= 10 ? { value: t } : { error: 'Answer in your own words (at least 10 characters).' };
    return { value: t };
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const A = 'flipside-deterministic';
    const plan = ctx.plan as Plan; const change = ctx.change as Change;
    const file = change.request.file; const inDiff = plan.pr.files.some((f) => f.path === file);
    const gap = inDiff && !explainsInDescription(plan, file);
    const why = ctx.answers.why_change?.text;

    if (role === 'flip_reviewer_agent') {
      const o = new Out(role, `${A}-reviewer@1`);
      if (!inDiff) { o.warn(`${file} is not in the public diff of PR #${plan.pr.number}; nothing to ask.`, true); return o.done('No question: the file is not in the PR.'); }
      if (!gap) { o.info(`The description already mentions ${file}; no step is requested.`); return o.done('No gap found.'); }
      o.risk(`${file} changed and the PR description never says why. Only the public PR was read.`);
      o.draft({ kind: 'review_gap', name: `Gap: ${file}`, artifactKey: 'review_gap', content: `# Unexplained change in PR #${plan.pr.number}\n\n${table(['File', 'Public summary', 'In description?'], plan.pr.files.map((f) => [f.path, f.summary, explainsInDescription(plan, f.path) ? 'yes' : 'no']))}\n\nQ1 to the author: ${change.request.question}\n\nRequest: the one session step behind \`${file}\`. Not the session.` });
      o.ask({ key: 'why_change', text: `Q1: ${change.request.question} (answer in your own words; then you will be asked to approve sharing the one step that explains it)`, blocking: true, assigneeRole: 'flip_author', assigneeOnly: true });
      return o.done(`Asked Q1 about ${file} and requested one session step.`);
    }

    if (role === 'flip_author_agent') {
      const o = new Out(role, `${A}-author@1`);
      if (!gap) return o.done('No disclosure: no gap was found.');
      if (!why) return o.done('Waiting for the author to answer Q1 in their own words. No step is proposed until then.');
      if (!sealConsistent(plan)) { o.warn('The seal in the PR is internally inconsistent (leaf hashes do not recompute to the root). Nothing is disclosed.', true); return o.done('No disclosure: the seal is inconsistent.'); }
      const pick = chooseStep(plan, file);
      if ('error' in pick) { o.warn(pick.error, true); return o.done('No disclosure: ' + pick.error); }
      const d: Disclosure = pick;
      o.info(`One of ${plan.seal.leafCount} steps selected (step ${d.index}). ${plan.seal.leafCount - 1} steps stay private.`);
      o.draft({ kind: 'disclosure', name: `Disclosure: step ${d.index}`, artifactKey: 'disclosure', content: renderDisclosure(plan, d) });
      o.act({ key: 'act-disclose-step', type: 'disclose_session_step', title: `Share session step ${d.index} of ${plan.seal.leafCount} with the reviewer`, connector: 'internal_notify', ownerRole: 'flip_author_agent', consequential: true, draftKind: 'disclosure', approvalRole: 'manager', ackRoles: [], rationale: `Only the author may approve. Approving shares this ONE step with the reviewer; the other ${plan.seal.leafCount - 1} steps are not shared.`, target: `reviewer:${plan.reviewerEmail}`, effectKey: `flip-${plan.pr.repo}-${plan.pr.number}-step-${d.index}-${sha(d.content).slice(0, 12)}`, approver: { email: plan.authorEmail } });
      return o.done(`Proposed disclosing step ${d.index} only; awaiting the author's approval.`);
    }

    if (role === 'flip_verifier') {
      const o = new Out(role, `${A}-verifier@1`);
      if (!sealConsistent(plan)) o.warn('Seal is inconsistent: leaf hashes do not recompute to the root.', true);
      else o.info(`Seal checked: ${plan.seal.leafCount} leaf hashes recompute to root ${plan.seal.root.slice(0, 8)}.`);
      const disclosure = ctx.results['flip_author_agent']?.drafts.find((d) => d.kind === 'disclosure');
      const d = disclosure ? parseDisclosure(disclosure.content) : undefined;
      let verdict: string | undefined;
      if (d) { const r = proofResult(plan, d); verdict = r.verdict; o.info(`Proposed step ${d.index}: ${r.verdict} (${r.reason}).`); }
      let forged: string | undefined;
      if (change.forgedCopy) { const r = proofResult(plan, change.forgedCopy as Disclosure); forged = r.verdict; (r.verdict === 'PROOF_FAIL' ? o.info : o.risk).call(o, `Posted copy of step ${change.forgedCopy.index}: ${r.verdict} (${r.reason}).`); }
      if (change.wholeSessionRequested) o.warn('Whole-session disclosure was requested and is REFUSED: the only thing that can be shared is one approved step.');
      o.data = { sealOk: sealConsistent(plan), proposedVerdict: verdict ?? null, forgedCopyVerdict: forged ?? null, wholeSessionRefused: change.wholeSessionRequested };
      if (d && why) {
        const hidden = Array.from({ length: plan.seal.leafCount }, (_, i) => i).filter((i) => i !== d.index);
        o.draft({ kind: 'review_brief', name: `Brief: PR #${plan.pr.number}`, artifactKey: 'review_brief', content: `# Brief for the reviewer: PR #${plan.pr.number}\n\n**Answer (author, own words):** ${why}\n\n**Verified step ${d.index}** (${verdict}):\n> ${d.content}\n\n**Steps not shown:** ${hidden.length} (${hidden.join(', ')}). They stay with the author.\n\n${change.wholeSessionRequested ? '**Whole session:** requested and refused.\n\n' : ''}${forged ? `**Edited copy posted for checking:** ${forged}.\n\n` : ''}_The brief is drafted before delivery. The step counts as shared only after the author approves and the delivery is read back and re-verified._` });
      }
      return o.done(d ? `Proposed step ${verdict}${forged ? `; edited copy ${forged}` : ''}.` : 'No step to verify yet.');
    }
    return new Out(role, `${A}-human@1`).done('Human role: decisions are made by the person.');
  },

  verifyAction(action, observed, _revised, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type !== 'disclose_session_step') return checks;
    const plan = ctx?.baselinePlan as Plan | undefined;
    const d = parseDisclosure(observed.content);
    checks.push({ name: 'stored disclosure carries one step and its proof', passed: !!d, detail: d ? `step ${d.index}` : 'no disclosure block found' });
    if (plan && d) {
      const r = proofResult(plan, d);
      checks.push({ name: 'step re-checked against the sealed root', passed: r.verdict === 'OK', detail: `${r.verdict}: ${r.reason}` });
      const others = syntheticSession(plan.pr.number).filter((s) => s.index !== d.index && observed.content.includes(stepText(s)));
      checks.push({ name: 'no other session step appears in the delivery', passed: others.length === 0, detail: others.length ? `leaked step(s): ${others.map((s) => s.index).join(', ')}` : 'only the one approved step is present' });
    }
    checks.push({ name: 'states the limits of the proof', passed: observed.content.includes('does not prove the step is correct'), detail: 'scope statement present' });
    return checks;
  },

  completionChecks(ctx) {
    const plan = ctx.baselinePlan as Plan; const change = ctx.change as Change;
    const gap = plan.pr.files.some((f) => f.path === change.request.file) && !explainsInDescription(plan, change.request.file);
    const out = [
      { key: 'seal_consistent', label: 'The seal in the PR recomputes from its leaf hashes', passed: sealConsistent(plan), detail: `${plan.seal.leafCount} leaves; root ${plan.seal.root.slice(0, 8)}` },
      { key: 'author_answered', label: 'The author answered the why-question in their own words', passed: !gap || !!ctx.answers.why_change?.text, detail: gap ? (ctx.answers.why_change ? 'answered' : 'unanswered') : 'no gap to explain' },
    ];
    if (change.forgedCopy) { const r = proofResult(plan, change.forgedCopy as Disclosure); out.push({ key: 'edited_copy_rejected', label: 'An edited copy of a step fails the seal check (PROOF_FAIL)', passed: r.verdict === 'PROOF_FAIL', detail: `${r.verdict}: ${r.reason}` }); }
    return out;
  },
};
