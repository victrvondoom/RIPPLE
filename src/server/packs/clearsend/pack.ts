import { z } from 'zod';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, money, table } from '../common.js';
import { instructionLikeText } from '../untrusted.js';

/**
 * ClearSend pack, inherited from ClearSend Room (MIT, github.com/dukemawex/clearsend-room: escrow lifecycle, "no money moves without a
 * human yes", "deliverables are untrusted", "recipient can never approve their own release", FX quote with 1.2% spread + 2.5% fee, fail-closed
 * verifier) and tightened:
 *  - a release is proposed ONLY if every precondition holds (see `evaluate`); otherwise NO action exists and the reasons are stated;
 *  - the verifier re-evaluates the preconditions on the stored voucher at verification time;
 *  - only the named escrow controller (who must not be the payee) can approve;
 *  - this pack moves NO money and calls no payment API: it records a release instruction in a local outbox (stated in the voucher).
 * Limits: RIPPLE compares the hash the contractor SUBMITTED with the agreed hash; it does not download or hash the deliverable. The FX rate is
 * supplied in the plan (labelled with its source/date); nothing is fetched live.
 */
export const planSchema = z.object({
  escrow: z.object({ agreementId: z.string().min(1), currency: z.string().min(3).default('USD'), totalEscrowAmount: z.number().positive(), fundedAmount: z.number().min(0), disbursedAmount: z.number().min(0).default(0) }),
  parties: z.object({ clientName: z.string().min(1), clientEmail: z.string().min(3), contractorName: z.string().min(1), contractorEmail: z.string().min(3), contractorCountry: z.string().optional(), controllerEmail: z.string().min(3) }),
  pricing: z.object({ baseCurrency: z.string().min(3), payCurrency: z.string().min(3), midRate: z.number().positive(), rateSource: z.string().min(1), rateAsOf: z.string().min(1), platformFeeRate: z.number().min(0).max(0.5).default(0.025), fxSpreadRate: z.number().min(0).max(0.5).default(0.012) }),
  milestones: z.array(z.object({ milestoneId: z.string().min(1), title: z.string().min(1), payoutAmount: z.number().positive(), requiredArtifactHash: z.string().min(1), acceptanceCriteria: z.union([z.string(), z.array(z.string())]), status: z.enum(['funded', 'submitted', 'verified', 'rejected', 'released']) })).min(1),
});
export const changeSchema = z.object({
  submissionId: z.string().min(1), milestoneId: z.string().min(1), submittedArtifactHash: z.string().min(1), deliverableUrl: z.string().min(1),
  criteriaEvidence: z.array(z.object({ criterion: z.string(), evidence: z.string() })).default([]),
  contractorNotes: z.string().default(''), submittedAt: z.string(), note: z.string().default(''),
});
type Plan = z.infer<typeof planSchema>;
type Sub = z.infer<typeof changeSchema>;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.]+$/, '').trim();
const criteriaOf = (v: string | string[]) => (Array.isArray(v) ? v : v.split(/\s*[;,]\s*/)).map((s) => s.replace(/[.]+$/, '').trim()).filter(Boolean);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function quote(plan: Plan, amount: number) {
  const p = plan.pricing; const same = p.baseCurrency.toUpperCase() === p.payCurrency.toUpperCase();
  const converted = amount * (same ? 1 : p.midRate); const spread = converted * (same ? 0 : p.fxSpreadRate); const fee = converted * p.platformFeeRate;
  return { converted: r2(converted), spread: r2(spread), fee: r2(fee), total: r2(converted + spread + fee), same };
}

export interface Evaluation {
  ms?: Plan['milestones'][number]; issues: string[]; hashOk: boolean; criteria: { criterion: string; met: boolean; evidence: string }[];
  reserve: number; injection: string[]; eligible: boolean;
}
/** Every release precondition in one place. The analyzer uses it to decide; the verifier re-runs it on the stored voucher. */
export function evaluate(plan: Plan, sub: Sub): Evaluation {
  const issues: string[] = []; const ms = plan.milestones.find((m) => m.milestoneId === sub.milestoneId);
  const reserve = plan.escrow.fundedAmount - plan.escrow.disbursedAmount;
  if (!ms) return { issues: [`Milestone ${sub.milestoneId} is not in the agreement.`], hashOk: false, criteria: [], reserve, injection: [], eligible: false };
  if (ms.status === 'released') issues.push(`Milestone ${ms.milestoneId} is already released: a second release would double-pay.`);
  const hashOk = /^[0-9a-f]{64}$/i.test(sub.submittedArtifactHash) && sub.submittedArtifactHash.toLowerCase() === ms.requiredArtifactHash.toLowerCase();
  if (!/^[0-9a-f]{64}$/i.test(sub.submittedArtifactHash)) issues.push('Submitted hash is not a 64-hex SHA-256 digest.');
  else if (!hashOk) issues.push('Submitted hash does not match the agreed artifact hash.');
  const injection = instructionLikeText([sub.contractorNotes, sub.deliverableUrl, ...sub.criteriaEvidence.map((e) => e.evidence)].join('\n'));
  const criteria = criteriaOf(ms.acceptanceCriteria).map((c) => {
    const e = sub.criteriaEvidence.find((x) => norm(x.criterion) === norm(c));
    const evidence = e?.evidence.trim() ?? '';
    return { criterion: c, met: evidence.length >= 10 && instructionLikeText(evidence).length === 0, evidence };
  });
  const unmet = criteria.filter((c) => !c.met);
  if (unmet.length) issues.push(`${unmet.length} acceptance criterion/criteria without recorded evidence: ${unmet.map((c) => `"${c.criterion}"`).join('; ')} (no evidence = not met).`);
  if (reserve < ms.payoutAmount) issues.push(`Escrow reserve ${money(reserve, plan.escrow.currency)} is below the payout ${money(ms.payoutAmount, plan.escrow.currency)}.`);
  if (plan.parties.controllerEmail.toLowerCase() === plan.parties.contractorEmail.toLowerCase()) issues.push('The release approver is the payee: a recipient can never approve their own release.');
  if (plan.pricing.baseCurrency.toUpperCase() !== plan.escrow.currency.toUpperCase()) issues.push(`Pricing base currency ${plan.pricing.baseCurrency} differs from the escrow currency ${plan.escrow.currency}.`);
  return { ms, issues, hashOk, criteria, reserve, injection, eligible: issues.length === 0 };
}

export const clearsendPack: WorkflowPack = {
  id: 'clearsend',
  name: 'ClearSend Escrow Guard',
  domain: 'Financial Escrow & Milestone Governance',
  version: '1.1.0',
  description: 'Three-party escrow room: a release instruction is proposed only when the hash matches, every acceptance criterion has recorded evidence, the reserve covers it and the approver is not the payee. A named controller approves; nothing is paid by RIPPLE.',
  labels: { baseline: 'Escrow Contract Agreement', change: 'Milestone Deliverable Submission', changeVerb: 'Submit Milestone Deliverable', plan: 'Escrow Schedule', mission: 'Escrow Guard Room', blurb: 'Fail-closed release checks (hash, evidence per criterion, reserve, separation of duties); only the named controller approves; no money moves.' },
  roles: [
    { key: 'escrow_auditor', name: 'Escrow Auditor', kind: 'agent', responsibility: 'Checks agreement terms, reserve, release history and separation of duties', department: 'Treasury' },
    { key: 'milestone_verifier', name: 'Milestone Verifier', kind: 'agent', responsibility: 'Checks the submitted hash and requires recorded evidence for every acceptance criterion', department: 'Operations' },
    { key: 'escrow_controller', name: 'Escrow Release Controller', kind: 'human', responsibility: 'The only approver of a release instruction (never the payee)', department: 'Finance' },
    { key: 'payment_disburser', name: 'Disbursement Dispatcher', kind: 'agent', responsibility: 'Drafts the release voucher and the payer quote; proposes a release only if every precondition holds', department: 'Treasury' },
  ],
  roleOrder: ['escrow_auditor', 'milestone_verifier', 'payment_disburser'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'audit_dossier', label: 'Escrow Balance & Terms Audit', department: 'Treasury', ownerRole: 'escrow_auditor', description: 'Reserve, release history, separation of duties' },
    { key: 'milestone_proof', label: 'Milestone verification (hash + criteria)', department: 'Operations', ownerRole: 'milestone_verifier', description: 'Hash comparison and evidence per acceptance criterion' },
    { key: 'disbursement_voucher', label: 'Release voucher + payer quote', department: 'Treasury', ownerRole: 'payment_disburser', description: 'Release instruction (record only) and the FX/fee quote' },
  ],
  rules: [
    { id: 'clearsend.submission', trigger: (i) => i.field.includes('submission') || i.field.includes('milestone'), to: 'audit_dossier', relation: 'initiates_escrow_audit', why: 'A submission triggers the escrow terms check' },
    { id: 'clearsend.hash', trigger: (i) => i.field.includes('hash') || i.field.includes('criteria'), to: 'milestone_proof', relation: 'initiates_verification', why: 'Hash and criteria evidence must be checked' },
  ],
  artifactEdges: [
    { from: 'audit_dossier', to: 'milestone_proof', relation: 'authorizes_check', why: 'Funding and terms are checked before the deliverable' },
    { from: 'milestone_proof', to: 'disbursement_voucher', relation: 'enables_payout', why: 'Only a fully verified milestone can produce a voucher' },
  ],
  decisions: [{ key: 'escrow_release_auth', label: 'Controller authorises the release instruction', ownerRole: 'escrow_controller', gates: ['disbursement_voucher'] }],

  sample() {
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const criteria = ['100% test pass rate', 'Docker container build artifact signed', 'API swagger contract verified'];
    return {
      title: 'ESC-9104: Milestone MS-2, Cross-Border API Settlement',
      plan: {
        escrow: { agreementId: 'ESC-9104', currency: 'USD', totalEscrowAmount: 75000, fundedAmount: 75000, disbursedAmount: 25000 },
        parties: { clientName: 'Meridian Global Ltd', clientEmail: 'ap@meridian.example', contractorName: 'Apex Distributed Systems Inc', contractorEmail: 'billing@apex.example', contractorCountry: 'Ghana', controllerEmail: 'sam@harborvine.example' },
        pricing: { baseCurrency: 'USD', payCurrency: 'EUR', midRate: 0.92, rateSource: 'plan-supplied illustrative rate (NOT live)', rateAsOf: '2026-11-01', platformFeeRate: 0.025, fxSpreadRate: 0.012 },
        milestones: [{ milestoneId: 'MS-2', title: 'Core Engine Deployment & Sandbox Integration', payoutAmount: 25000, requiredArtifactHash: hash, acceptanceCriteria: criteria, status: 'funded' }],
      },
      change: {
        submissionId: 'SUB-209', milestoneId: 'MS-2', submittedArtifactHash: hash, deliverableUrl: 'https://registry.example.internal/artifacts/apex-settlement-v1.2.tar.gz',
        criteriaEvidence: [
          { criterion: criteria[0], evidence: 'CI run #4412: 318 of 318 tests passed (link in the registry).' },
          { criterion: criteria[1], evidence: 'Image digest signed with cosign; signature stored next to the artifact.' },
          { criterion: criteria[2], evidence: 'Swagger contract validated against the staging API (report attached).' },
        ],
        contractorNotes: 'Milestone 2 completed. Requesting verification.', submittedAt: '2026-11-03T19:10:00Z', note: 'Please review.',
      },
    };
  },

  detectChanges(plan: Plan, sub: Sub): ChangeItem[] {
    const ev = evaluate(plan, sub); const ms = ev.ms;
    return [
      { field: 'milestone.submission', label: `Milestone submission: ${ms?.title ?? sub.milestoneId}`, before: `Status: ${ms?.status ?? 'unknown'}`, after: 'Deliverable submitted for verification', kind: 'modified', severity: 'medium', note: ms ? `Requested release: ${money(ms.payoutAmount, plan.escrow.currency)}` : 'milestone not found' },
      { field: 'milestone.artifact_hash', label: 'Submitted artifact hash vs agreed hash', before: `Agreed: ${ms?.requiredArtifactHash.slice(0, 16) ?? '?'}…`, after: `Submitted: ${sub.submittedArtifactHash.slice(0, 16)}…`, kind: 'modified', severity: ev.hashOk ? 'low' : 'high', note: ev.hashOk ? 'Hashes are equal' : 'HASH MISMATCH' },
      { field: 'milestone.criteria', label: `Acceptance criteria evidence (${ev.criteria.filter((c) => c.met).length}/${ev.criteria.length} met)`, before: `${ev.criteria.length} criteria`, after: `${ev.criteria.filter((c) => c.met).length} with recorded evidence`, kind: 'modified', severity: ev.criteria.every((c) => c.met) ? 'low' : 'high' },
    ];
  },
  applyChange(plan: Plan, sub: Sub): Plan {
    const next = structuredClone(plan); const ms = next.milestones.find((m) => m.milestoneId === sub.milestoneId);
    if (ms && (ms.status === 'funded' || ms.status === 'rejected')) ms.status = 'submitted';
    return next;
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const plan = ctx.plan as Plan; const sub = ctx.change as Sub; const cur = plan.escrow.currency; const A = 'clearsend-analyzer';
    const ev = evaluate(plan, sub); const ms = ev.ms;

    if (role === 'escrow_auditor') {
      const o = new Out(role, `${A}-auditor@2`);
      if (!ms) { o.risk(ev.issues[0]); return o.done('Milestone not found; nothing can be released.'); }
      o.info(`Agreement ${plan.escrow.agreementId}: ${money(plan.escrow.totalEscrowAmount, cur)} total, ${money(plan.escrow.disbursedAmount, cur)} already disbursed, reserve ${money(ev.reserve, cur)}.`);
      for (const i of ev.issues.filter((x) => /reserve|already released|approver|currency/i.test(x))) o.risk(i);
      if (ev.reserve >= ms.payoutAmount) o.info(`Reserve covers the ${money(ms.payoutAmount, cur)} payout.`);
      o.draft({ kind: 'audit_dossier', name: `Escrow Terms & Balance Audit: ${plan.escrow.agreementId}`, artifactKey: 'audit_dossier', content: `# Escrow Terms & Balance Audit\n\n${table(['Parameter', 'Value'], [['Agreement', plan.escrow.agreementId], ['Client', plan.parties.clientName], ['Contractor (payee)', plan.parties.contractorName], ['Total escrow', money(plan.escrow.totalEscrowAmount, cur)], ['Disbursed to date', money(plan.escrow.disbursedAmount, cur)], ['Reserve', money(ev.reserve, cur)], ['This milestone', `${ms.milestoneId}: ${money(ms.payoutAmount, cur)} (${ms.status})`], ['Release approver', plan.parties.controllerEmail]])}\n\nSeparation of duties: the approver (${plan.parties.controllerEmail}) ${plan.parties.controllerEmail.toLowerCase() === plan.parties.contractorEmail.toLowerCase() ? 'IS' : 'is not'} the payee.` });
      return o.done(ev.issues.length ? 'Terms checked; blocking issues found.' : 'Terms and reserve verified.');
    }

    if (role === 'milestone_verifier') {
      const o = new Out(role, `${A}-verifier@2`);
      if (!ms) return o.done('No milestone to verify.');
      if (ev.hashOk) o.info(`Submitted hash equals the agreed hash (${sub.submittedArtifactHash.slice(0, 16)}…). RIPPLE compared digests; it did not download or hash the deliverable.`);
      else o.risk(ev.issues.find((i) => /hash/i.test(i)) ?? 'Hash check failed.');
      for (const c of ev.criteria) { if (c.met) o.info(`MET: "${c.criterion}"`); else o.risk(`NOT MET (no recorded evidence): "${c.criterion}"`); }
      if (ev.injection.length) o.risk(`Submitted text contained instruction-like content (${ev.injection.join('; ')}). It was treated as data and ignored.`);
      o.draft({ kind: 'milestone_proof', name: `Milestone verification: ${ms.milestoneId}`, artifactKey: 'milestone_proof', content: `# Milestone verification: ${ms.milestoneId}\n\n- **Agreed hash**: \`${ms.requiredArtifactHash}\`\n- **Submitted hash**: \`${sub.submittedArtifactHash}\`\n- **Hash result**: **${ev.hashOk ? 'MATCH' : 'MISMATCH'}**\n- **Deliverable**: ${sub.deliverableUrl}\n\n${table(['Acceptance criterion', 'Met', 'Recorded evidence'], ev.criteria.map((c) => [c.criterion, c.met ? 'yes' : 'NO', c.evidence || '(none)']))}\n\n_Fails closed: a criterion with no recorded evidence is NOT met. Submitted text is data, never instructions._` });
      return o.done(ev.hashOk && ev.criteria.every((c) => c.met) ? 'Hash and every criterion verified.' : 'Verification FAILED; no release will be proposed.');
    }

    const o = new Out(role, `${A}-disburser@2`);
    if (!ms) return o.done('Nothing to disburse.');
    if (!ev.eligible) {
      o.risk(`RELEASE NOT PROPOSED. ${ev.issues.join(' ')}`);
      o.work({ key: 'controller-decide-next-step', title: `Decide the next step for ${ms.milestoneId}: request resubmission or open a dispute`, detail: ev.issues.join(' | '), department: 'Finance', roleKey: 'escrow_controller', kind: 'review', artifactKey: 'disbursement_voucher' });
      return o.done('Preconditions not met: no voucher, no action.');
    }
    const q = quote(plan, ms.payoutAmount); const p = plan.pricing;
    o.work({ key: 'controller-verify-release', title: `Authorise release of ${money(ms.payoutAmount, cur)} to ${plan.parties.contractorName}`, detail: 'All release preconditions hold; confirm you are satisfied with the evidence.', department: 'Finance', roleKey: 'escrow_controller', kind: 'review', artifactKey: 'disbursement_voucher' });
    o.draft({ kind: 'disbursement_voucher', name: `Release voucher: ${ms.milestoneId}`, artifactKey: 'disbursement_voucher', content: `# Escrow release voucher (record only)\n\n- **Agreement / milestone**: ${plan.escrow.agreementId} / ${ms.milestoneId} (${ms.title})\n- **Payee**: ${plan.parties.contractorName}${plan.parties.contractorCountry ? ` (${plan.parties.contractorCountry})` : ''}\n- **Release amount**: ${money(ms.payoutAmount, cur)}\n- **Agreed artifact hash**: \`${ms.requiredArtifactHash}\`\n- **Acceptance criteria met**: ${ev.criteria.length}/${ev.criteria.length} (evidence recorded)\n- **Release approver**: ${plan.parties.controllerEmail} (not the payee)\n\n## Payer quote\n${table(['Item', 'Amount'], [[`Payout in ${p.payCurrency} at ${p.midRate}`, `${q.converted} ${p.payCurrency}`], [`FX spread ${(p.fxSpreadRate * 100).toFixed(1)}%`, `${q.spread} ${p.payCurrency}`], [`Platform fee ${(p.platformFeeRate * 100).toFixed(1)}%`, `${q.fee} ${p.payCurrency}`], ['**Total to the payer**', `**${q.total} ${p.payCurrency}**`]])}\nRate source: ${p.rateSource} (as of ${p.rateAsOf}).\n\n> DRY RUN: this records a release instruction in a local outbox. No funds move and no payment or bank API is called.` });
    o.act({ key: 'act-release-escrow', type: 'escrow_fund_release', title: `Record release of ${money(ms.payoutAmount, cur)} to ${plan.parties.contractorName} (no funds move)`, connector: 'internal_notify', ownerRole: 'payment_disburser', consequential: true, draftKind: 'disbursement_voucher', approvalRole: 'owner', ackRoles: ['escrow_controller'], rationale: `Hash matches and all ${ev.criteria.length} acceptance criteria have recorded evidence; reserve covers the payout. Only the controller (${plan.parties.controllerEmail}) may approve.`, target: `treasury/${plan.parties.contractorName}`, effectKey: `escrow-payout-${plan.escrow.agreementId}-${ms.milestoneId}`, approver: { email: plan.parties.controllerEmail } });
    return o.done('Voucher drafted; release gated behind the named controller.');
  },

  verifyAction(action, observed, _revised, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type !== 'escrow_fund_release' || !ctx) return checks;
    const plan = ctx.baselinePlan as Plan; const sub = ctx.change as Sub; const ev = evaluate(plan, sub); const ms = ev.ms; const t = observed.content;
    if (!ms) return [{ name: 'milestone exists', passed: false, detail: 'milestone not in the agreement' }];
    const amount = money(ms.payoutAmount, plan.escrow.currency);
    checks.push({ name: 'exact payout amount present', passed: t.includes(amount), detail: `${amount} expected in the stored voucher` });
    checks.push({ name: 'recipient payee confirmed', passed: t.includes(plan.parties.contractorName), detail: plan.parties.contractorName });
    checks.push({ name: 'agreement, milestone and agreed hash cited', passed: t.includes(plan.escrow.agreementId) && t.includes(ms.milestoneId) && t.includes(ms.requiredArtifactHash), detail: `${plan.escrow.agreementId}/${ms.milestoneId}` });
    checks.push({ name: 'release preconditions still hold at verification time', passed: ev.eligible, detail: ev.eligible ? 'hash, evidence for every criterion, reserve, separation of duties all re-checked' : ev.issues.join(' ') });
    checks.push({ name: 'states that no funds moved', passed: t.includes('No funds move'), detail: 'honest scope statement present' });
    return checks;
  },

  completionChecks(ctx) {
    const plan = ctx.baselinePlan as Plan; const ev = evaluate(plan, ctx.change as Sub);
    return [{ key: 'escrow_solvency', label: 'Escrow reserve covers this release and it is not a repeat', passed: !!ev.ms && ev.reserve >= ev.ms.payoutAmount && ev.ms.status !== 'released', detail: ev.ms ? `reserve ${money(ev.reserve, plan.escrow.currency)} vs payout ${money(ev.ms.payoutAmount, plan.escrow.currency)}; milestone ${ev.ms.status}` : 'milestone missing' }];
  },
};
