import { z } from 'zod';
import type { AnalysisContext, ChangeItem, RoleResult, WorkflowPack } from '../../engine/types.js';
import { Out, money, table } from '../common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const planSchema = z.object({
  contract: z.object({ vendor: z.string().min(1), vendorContact: z.string().min(1), project: z.string().min(1), currency: z.string().min(1), quoteTotal: z.number().positive(), maxHourlyRate: z.number().positive().optional(), paymentTermsDays: z.number().int().min(0) }),
  milestones: z.array(z.object({ id: z.string(), name: z.string(), amount: z.number().positive(), deliverableIds: z.array(z.string()), status: z.enum(['approved', 'pending']), billedToDate: z.number().min(0).default(0) })).min(1),
  deliverables: z.array(z.object({ id: z.string(), name: z.string(), accepted: z.boolean(), acceptedOn: date.optional() })),
  worklogs: z.array(z.object({ id: z.string(), milestoneId: z.string(), hours: z.number().positive(), description: z.string(), evidenceRef: z.string().optional() })),
  invoices: z.array(z.any()).default([]),
});
export const changeSchema = z.object({
  receivedOn: date, invoiceNo: z.string().min(1).max(60), invoiceDate: date, currency: z.string().min(1), total: z.number().positive(), note: z.string().max(1000).default(''),
  lines: z.array(z.object({ description: z.string().min(1), milestoneId: z.string().nullable().optional(), amount: z.number().positive(), hours: z.number().positive().optional(), rate: z.number().positive().optional() })).min(1),
});
type Plan = z.infer<typeof planSchema>; type Inv = z.infer<typeof changeSchema>;
interface Disc { code: string; severity: 'high' | 'medium' | 'low'; line?: number; text: string; amount?: number }

const fxOf = (plan: Plan, inv: Inv, a: AnalysisContext['answers']) => (inv.currency === plan.contract.currency ? 1 : Number(a.fx_rate?.value) || null);
const needFx = (plan: Plan, inv: Inv, a: AnalysisContext['answers']) => fxOf(plan, inv, a) === null;

/** Line-item comparison of one invoice against the approved quote, milestones, acceptance records and worklog evidence. */
export function reconcile(plan: Plan, inv: Inv, answers: AnalysisContext['answers'] = {}): Disc[] {
  const fx = fxOf(plan, inv, answers) ?? 1; const cur = plan.contract.currency; const d: Disc[] = [];
  const f = (n: number) => money(n * fx, cur);
  if (plan.invoices.some((x: any) => x.invoiceNo === inv.invoiceNo)) d.push({ code: 'duplicate_invoice', severity: 'high', text: `Invoice number ${inv.invoiceNo} was already received on this contract.` });
  const sum = inv.lines.reduce((s, l) => s + l.amount, 0);
  if (Math.abs(sum - inv.total) > 0.5) d.push({ code: 'total_mismatch', severity: 'medium', text: `Line items add up to ${f(sum)} but the invoice total states ${f(inv.total)} (difference ${f(inv.total - sum)}).`, amount: (inv.total - sum) * fx });
  const byMs = new Map<string, number>();
  inv.lines.forEach((l, i) => {
    const ms = l.milestoneId ? plan.milestones.find((m) => m.id === l.milestoneId) : undefined;
    if (!ms) { d.push({ code: 'unmatched_line', severity: 'high', line: i, text: `Line ${i + 1} "${l.description}" (${f(l.amount)}) does not match any milestone in the approved quote.`, amount: l.amount * fx }); return; }
    byMs.set(ms.id, (byMs.get(ms.id) ?? 0) + l.amount * fx);
    if (ms.status !== 'approved') d.push({ code: 'milestone_not_approved', severity: 'medium', line: i, text: `Line ${i + 1} bills milestone "${ms.name}", which is not yet approved for billing.` });
    const unacc = ms.deliverableIds.map((id) => plan.deliverables.find((x) => x.id === id)).filter((x) => x && !x.accepted);
    if (unacc.length) d.push({ code: 'unaccepted_deliverable', severity: 'high', line: i, text: `Line ${i + 1} bills milestone "${ms.name}" but deliverable(s) not accepted: ${unacc.map((x) => `${x!.name} (${x!.id})`).join(', ')}.` });
    if (l.hours !== undefined) {
      const logs = plan.worklogs.filter((w) => w.milestoneId === ms.id); const ev = logs.filter((w) => w.evidenceRef).reduce((s, w) => s + w.hours, 0);
      if (!logs.length) d.push({ code: 'missing_evidence', severity: 'medium', line: i, text: `Line ${i + 1} claims ${l.hours}h but no worklog exists for milestone "${ms.name}".` });
      else if (l.hours > ev + 1e-9) d.push({ code: 'hours_exceed_evidence', severity: 'medium', line: i, text: `Line ${i + 1} claims ${l.hours}h; only ${ev}h are backed by worklog evidence (${logs.filter((w) => !w.evidenceRef).map((w) => `${w.id}: ${w.hours}h has no evidence reference`).join('; ') || 'no unreferenced logs'}).` });
    }
    if (l.rate !== undefined && plan.contract.maxHourlyRate && l.rate * fx > plan.contract.maxHourlyRate + 1e-9) d.push({ code: 'rate_over_cap', severity: 'medium', line: i, text: `Line ${i + 1} rate ${f(l.rate)}/h is above the contract cap of ${money(plan.contract.maxHourlyRate, cur)}/h.` });
  });
  for (const [id, billed] of byMs) { const ms = plan.milestones.find((m) => m.id === id)!; const remaining = ms.amount - ms.billedToDate; if (billed > remaining + 0.5) d.push({ code: 'over_milestone', severity: 'high', text: `Milestone "${ms.name}": billed ${money(billed, cur)} exceeds the remaining approved amount ${money(remaining, cur)} by ${money(billed - remaining, cur)}.`, amount: billed - remaining }); }
  const approvedRef = [...byMs.keys()].reduce((s, id) => s + plan.milestones.find((m) => m.id === id)!.amount, 0);
  if (inv.total * fx > approvedRef + 0.5) d.push({ code: 'total_exceeds_approved', severity: 'high', text: `Invoice total ${f(inv.total)} is ${money(inv.total * fx - approvedRef, cur)} above the approved amount for the milestone(s) it references (${money(approvedRef, cur)}).`, amount: inv.total * fx - approvedRef });
  const billedAll = plan.milestones.reduce((s, m) => s + m.billedToDate, 0);
  if (billedAll + inv.total * fx > plan.contract.quoteTotal + 0.5) d.push({ code: 'exceeds_quote_total', severity: 'high', text: `Billed to date ${money(billedAll, cur)} + this invoice would exceed the approved quote total ${money(plan.contract.quoteTotal, cur)}.` });
  return d;
}
const detect = (plan: Plan, inv: Inv, a: AnalysisContext['answers'] = {}): ChangeItem[] => [
  { field: 'invoice.received', label: `Invoice ${inv.invoiceNo}`, before: `approved quote ${money(plan.contract.quoteTotal, plan.contract.currency)}`, after: `${inv.currency} ${inv.total.toLocaleString('en-US')}`, kind: 'added', severity: 'low', note: `${inv.lines.length} line(s)` },
  ...reconcile(plan, inv, a).map((d) => ({ field: `invoice.${d.code}.${d.line ?? 'all'}`, label: d.code.replace(/_/g, ' '), before: 'matches approved quote', after: 'discrepancy', kind: 'modified' as const, severity: d.severity, note: d.text })),
];
function apply(plan: Plan, inv: Inv, answers: AnalysisContext['answers']): Plan {
  const p: Plan = structuredClone(plan); const d = reconcile(plan, inv, answers); const fx = fxOf(plan, inv, answers) ?? 1;
  const status = d.length ? 'clarification_requested' : 'reconciled_clean';
  p.invoices.push({ invoiceNo: inv.invoiceNo, total: inv.total * fx, currency: plan.contract.currency, receivedOn: inv.receivedOn, status, discrepancyCodes: d.map((x) => x.code), note: 'RIPPLE does not initiate payments; status records the reconciliation outcome only.' });
  if (!d.length) for (const l of inv.lines) { const m = p.milestones.find((x) => x.id === l.milestoneId); if (m) m.billedToDate += l.amount * fx; }
  return p;
}
const SAFE_WORDS = /\b(fraud\w*|scam\w*|fake\w*|cheat\w*|dishonest\w*|steal\w*|lying|lied)\b/i;

function analyze(role: string, ctx: AnalysisContext): RoleResult {
  const plan = ctx.plan as Plan, inv = ctx.change as Inv, cur = plan.contract.currency; const d = reconcile(plan, inv, ctx.answers); const block = needFx(plan, inv, ctx.answers);
  const A = 'rule-engine/invoiceguard';
  if (role === 'intake') {
    const o = new Out(role, `${A}-intake@1`);
    o.info(`Invoice ${inv.invoiceNo} dated ${inv.invoiceDate}: ${inv.currency} ${inv.total.toLocaleString('en-US')} across ${inv.lines.length} line(s) from ${plan.contract.vendor}.`);
    if (block) { o.risk(`Invoice currency ${inv.currency} differs from contract currency ${cur}; amounts cannot be compared without a confirmed conversion rate.`); o.ask({ key: 'fx_rate', text: `Invoice is in ${inv.currency}, contract in ${cur}. What conversion rate applies (1 ${inv.currency} = ? ${cur})? Use the rate your finance policy specifies.`, blocking: true, assigneeRole: 'human_reviewer' }); }
    for (const x of d.filter((y) => ['duplicate_invoice', 'total_mismatch'].includes(y.code))) o.risk(x.text);
    o.warn('RIPPLE reconciles and drafts only. It never initiates payments and does not judge intent: every discrepancy needs human verification.');
    return o.done(`${d.filter((x) => ['duplicate_invoice', 'total_mismatch'].includes(x.code)).length} intake issue(s)${block ? '; conversion rate required' : ''}.`);
  }
  if (role === 'matcher') {
    const o = new Out(role, `${A}-matcher@1`);
    for (const x of d.filter((y) => ['unmatched_line', 'over_milestone', 'total_exceeds_approved', 'exceeds_quote_total', 'rate_over_cap', 'milestone_not_approved'].includes(y.code))) (x.severity === 'high' ? o.risk : o.warn).call(o, x.text);
    const rows = inv.lines.map((l, i) => { const m = plan.milestones.find((x) => x.id === l.milestoneId); const issues = d.filter((x) => x.line === i).map((x) => x.code); return [i + 1, l.description, m ? `${m.name} (${money(m.amount, cur)})` : '— none —', money(l.amount * (fxOf(plan, inv, ctx.answers) ?? 1), cur), issues.join(', ') || 'matches']; });
    o.draft({ kind: 'line_comparison', name: 'Line-item comparison', artifactKey: 'line_comparison', content: `# Line-item comparison — invoice ${inv.invoiceNo}${block ? ' (PROVISIONAL: conversion rate pending)' : ''}\n\n${table(['#', 'Invoice line', 'Approved milestone', 'Invoiced', 'Findings'], rows)}` });
    if (d.some((x) => x.severity === 'high')) o.work({ key: 'iv-verify-high', title: 'Verify high-severity discrepancies against the contract and records', detail: d.filter((x) => x.severity === 'high').map((x) => x.code).join(', '), department: 'Finance', roleKey: 'human_reviewer', kind: 'review', artifactKey: 'line_comparison' });
    return o.done(`${d.filter((x) => x.line !== undefined || ['over_milestone', 'total_exceeds_approved', 'exceeds_quote_total'].includes(x.code)).length} comparison finding(s).`);
  }
  if (role === 'evidence') {
    const o = new Out(role, `${A}-evidence@1`);
    for (const x of d.filter((y) => ['unaccepted_deliverable', 'hours_exceed_evidence', 'missing_evidence'].includes(y.code))) (x.code === 'unaccepted_deliverable' ? o.risk : o.warn).call(o, x.text);
    if (d.some((x) => x.code === 'unaccepted_deliverable')) o.work({ key: 'iv-acceptance', title: 'Confirm acceptance status of the unaccepted deliverable(s) with the project owner', detail: d.filter((x) => x.code === 'unaccepted_deliverable').map((x) => x.text).join(' '), department: 'Project Office', roleKey: 'human_owner', kind: 'task', artifactKey: 'deliverable_acceptance' });
    if (d.some((x) => ['hours_exceed_evidence', 'missing_evidence'].includes(x.code))) {
      o.work({ key: 'iv-request-evidence', title: 'Obtain supporting timesheets / worklog evidence from the vendor', detail: 'See hours-vs-evidence findings.', department: 'Project Office', roleKey: 'human_owner', kind: 'task', artifactKey: 'evidence_file' });
      o.work({ key: 'iv-attach-evidence', title: 'Attach received evidence to the reconciliation file', detail: 'Satisfied automatically when the evidence request above is completed (explicit link).', department: 'Finance', roleKey: 'human_reviewer', kind: 'task', artifactKey: 'reconciliation', satisfiedBy: 'iv-request-evidence' });
    }
    o.draft({ kind: 'evidence_check', name: 'Supporting-evidence check', artifactKey: 'evidence_file', content: `# Evidence check — invoice ${inv.invoiceNo}\n\n${table(['Milestone', 'Deliverables accepted', 'Worklog hours (with evidence ref)'], plan.milestones.filter((m) => inv.lines.some((l) => l.milestoneId === m.id)).map((m) => [m.name, m.deliverableIds.map((id) => { const x = plan.deliverables.find((y) => y.id === id); return `${x?.name ?? id}: ${x?.accepted ? 'accepted' : 'NOT accepted'}`; }).join('; '), `${plan.worklogs.filter((w) => w.milestoneId === m.id).reduce((s, w) => s + w.hours, 0)}h (${plan.worklogs.filter((w) => w.milestoneId === m.id && w.evidenceRef).reduce((s, w) => s + w.hours, 0)}h evidenced)`]))}` });
    return o.done(`${d.filter((x) => ['unaccepted_deliverable', 'hours_exceed_evidence', 'missing_evidence'].includes(x.code)).length} evidence gap(s).`);
  }
  const o = new Out(role, `${A}-resolution@1`); const hi = d.filter((x) => x.severity === 'high').length;
  const status = d.length ? 'CLARIFICATION REQUESTED — human review required' : 'RECONCILED — no discrepancies found';
  o.work({ key: 'iv-resolution', title: 'Record the resolution decision (approve for payment processing, dispute, or partial)', detail: 'RIPPLE does not move money. The reviewer decides and records the outcome in the payment system.', department: 'Finance', roleKey: 'human_reviewer', kind: 'review', artifactKey: 'reconciliation' });
  o.draft({ kind: 'reconciliation_summary', name: 'Reconciliation summary', artifactKey: 'reconciliation', content: `# Reconciliation summary — invoice ${inv.invoiceNo}${block ? ' (PROVISIONAL)' : ''}\n\nVendor: ${plan.contract.vendor} · Project: ${plan.contract.project}\nInvoice total: ${inv.currency} ${inv.total.toLocaleString('en-US')} · Approved quote total: ${money(plan.contract.quoteTotal, cur)}\nStatus: **${status}**\n\n${d.length ? table(['Code', 'Severity', 'Detail'], d.map((x) => [x.code, x.severity, x.text])) : 'No discrepancies against the approved quote, milestones, acceptance records or worklog evidence.'}\n\nNo payment has been initiated by RIPPLE. Findings are discrepancies to verify, not conclusions about intent.` });
  if (d.length) {
    const lines = d.map((x) => `- ${x.text}`).join('\n');
    o.draft({ kind: 'clarification', name: 'Clarification request to vendor (draft)', artifactKey: 'clarification', content: `Subject: Invoice ${inv.invoiceNo} — clarification needed\n\nHello ${plan.contract.vendor.split(' ')[0]},\n\nThank you for invoice ${inv.invoiceNo}. While reconciling it against our approved quote and records we noted the points below and would be grateful for your help clarifying them:\n\n${lines}\n\nCould you share supporting documents (e.g. timesheets, the approved change request, or acceptance confirmation) where relevant? We will review and come back to you.\n\nThank you,\nAccounts review` });
    o.work({ key: 'iv-send-review', title: 'Review the clarification wording before it is sent', detail: 'Neutral, factual tone; no accusations.', department: 'Finance', roleKey: 'human_owner', kind: 'decision', artifactKey: 'clarification' });
  }
  if (!block) {
    o.act({ key: 'record_reconciliation', type: 'record_reconciliation', title: `Record reconciliation file for invoice ${inv.invoiceNo}`, connector: 'document_store', ownerRole: 'human_owner', consequential: true, draftKind: 'reconciliation_summary', approvalRole: 'manager', ackRoles: ['human_reviewer'], rationale: 'Creates the audit record finance relies on.', target: 'Document store', effectKey: 'reconciliation' });
    if (d.length) o.act({ key: 'send_clarification', type: 'send_clarification', title: `Send clarification request to ${plan.contract.vendor}`, connector: 'email_outbox', ownerRole: 'human_owner', consequential: true, draftKind: 'clarification', approvalRole: 'manager', ackRoles: [], rationale: 'External message to a vendor about a payment dispute.', target: plan.contract.vendorContact, effectKey: 'clarification' });
  }
  return o.done(`${status}; ${d.length} discrepancy(ies), ${hi} high severity; ${o.actions.length} action(s) proposed.`);
}

export const invoiceGuardPack: WorkflowPack = {
  id: 'invoiceguard', name: 'InvoiceGuard', domain: 'Financial Reconciliation', version: '1.0.0',
  description: 'Reconcile an invoice against the approved quote, milestones, deliverable acceptance and worklog evidence; classify discrepancies and draft a neutral clarification. Never moves money.',
  labels: { baseline: 'Approved quote & records', change: 'Invoice', changeVerb: 'Submit invoice', plan: 'quote / contract', mission: 'Invoice reconciliation', blurb: 'Quote vs invoice vs evidence' },
  agentLimit: 'Reconciles lines; strictly forbidden from initiating payment or accusatory wording',
  roles: [
    { key: 'intake', name: 'Invoice Intake Agent', kind: 'agent', responsibility: 'Normalizes the invoice; checks duplicates, arithmetic and currency.', department: 'Finance' },
    { key: 'matcher', name: 'Reconciliation Agent', kind: 'agent', responsibility: 'Line-item comparison against milestones, caps and approved amounts.', department: 'Finance' },
    { key: 'evidence', name: 'Evidence Agent', kind: 'agent', responsibility: 'Checks deliverable acceptance and worklog evidence.', department: 'Project Office' },
    { key: 'coordinator', name: 'Resolution Agent', kind: 'agent', responsibility: 'Drafts the reconciliation summary and a neutral clarification request.', department: 'Finance' },
    { key: 'human_reviewer', name: 'Finance Reviewer (human)', kind: 'human', responsibility: 'Verifies discrepancies and records the resolution.', department: 'Finance' },
    { key: 'human_owner', name: 'Project Owner (human)', kind: 'human', responsibility: 'Confirms acceptance, approves vendor communication.', department: 'Project Office' },
  ],
  roleOrder: ['intake', 'matcher', 'evidence', 'coordinator'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'invoice_record', label: 'Invoice record', department: 'Finance', ownerRole: 'human_reviewer', description: 'The received invoice' },
    { key: 'line_comparison', label: 'Line-item comparison', department: 'Finance', ownerRole: 'human_reviewer', description: 'Invoice lines vs quote' },
    { key: 'deliverable_acceptance', label: 'Deliverable acceptance records', department: 'Project Office', ownerRole: 'human_owner', description: 'What has been accepted' },
    { key: 'evidence_file', label: 'Supporting evidence file', department: 'Project Office', ownerRole: 'human_owner', description: 'Timesheets / worklogs' },
    { key: 'reconciliation', label: 'Reconciliation summary', department: 'Finance', ownerRole: 'human_reviewer', description: 'Audit record' },
    { key: 'clarification', label: 'Vendor clarification', department: 'Finance', ownerRole: 'human_owner', description: 'Communication to vendor' },
  ],
  rules: [
    { id: 'recv→rec', trigger: (i) => i.field === 'invoice.received', to: 'invoice_record', relation: 'registers', why: 'Invoice enters the record' },
    { id: 'recv→recon', trigger: (i) => i.field === 'invoice.received', to: 'reconciliation', relation: 'requires', why: 'Every invoice is reconciled' },
    { id: 'amt→lines', trigger: (i) => /^invoice\.(unmatched_line|over_milestone|total_mismatch|total_exceeds_approved|exceeds_quote_total|rate_over_cap)/.test(i.field), to: 'line_comparison', relation: 'differs_in', why: 'Amounts differ from the approved quote' },
    { id: 'acc→deliv', trigger: (i) => /^invoice\.(unaccepted_deliverable|milestone_not_approved)/.test(i.field), to: 'deliverable_acceptance', relation: 'lacks', why: 'Billing precedes acceptance' },
    { id: 'ev→file', trigger: (i) => /^invoice\.(hours_exceed_evidence|missing_evidence)/.test(i.field), to: 'evidence_file', relation: 'lacks', why: 'Claimed hours not backed by evidence' },
    { id: 'dup→rec', trigger: (i) => i.field.startsWith('invoice.duplicate_invoice'), to: 'invoice_record', relation: 'duplicates', why: 'Same invoice number seen before' },
    { id: 'disc→clar', trigger: (i) => i.field !== 'invoice.received', to: 'clarification', relation: 'needs', why: 'Vendor must clarify' },
  ],
  artifactEdges: [
    { from: 'line_comparison', to: 'reconciliation', relation: 'feeds', why: 'Findings enter the summary' },
    { from: 'deliverable_acceptance', to: 'reconciliation', relation: 'feeds', why: 'Acceptance status enters the summary' },
    { from: 'evidence_file', to: 'reconciliation', relation: 'feeds', why: 'Evidence gaps enter the summary' },
    { from: 'invoice_record', to: 'reconciliation', relation: 'feeds', why: 'Header data' },
    { from: 'reconciliation', to: 'clarification', relation: 'drives', why: 'Questions to the vendor come from the summary' },
  ],
  decisions: [{ key: 'approve_clar', label: 'Approve vendor clarification', ownerRole: 'human_owner', gates: ['clarification'] }, { key: 'approve_rec', label: 'Approve reconciliation record', ownerRole: 'human_reviewer', gates: ['reconciliation'] }],
  sample: () => ({
    title: 'Pixel Forge — Invoice PF-2026-117 (₹48,000)',
    plan: { contract: { vendor: 'Pixel Forge Studio (freelancer)', vendorContact: 'accounts@pixelforge.example', project: 'Brand site rebuild', currency: 'INR', quoteTotal: 120000, maxHourlyRate: 1200, paymentTermsDays: 15 },
      milestones: [{ id: 'M1', name: 'Discovery & wireframes', amount: 30000, deliverableIds: ['D1', 'D2'], status: 'approved', billedToDate: 30000 }, { id: 'M2', name: 'Landing page build', amount: 40000, deliverableIds: ['D3', 'D4'], status: 'approved', billedToDate: 0 }, { id: 'M3', name: 'Launch support', amount: 50000, deliverableIds: ['D5'], status: 'pending', billedToDate: 0 }],
      deliverables: [{ id: 'D1', name: 'Sitemap', accepted: true, acceptedOn: '2026-09-20' }, { id: 'D2', name: 'Wireframes', accepted: true, acceptedOn: '2026-09-28' }, { id: 'D3', name: 'Landing page (responsive)', accepted: true, acceptedOn: '2026-10-25' }, { id: 'D4', name: 'CMS handoff documentation', accepted: false }, { id: 'D5', name: 'Launch checklist', accepted: false }],
      worklogs: [{ id: 'W1', milestoneId: 'M2', hours: 18, description: 'Layout & components', evidenceRef: 'timesheet-oct-w3.csv' }, { id: 'W2', milestoneId: 'M2', hours: 12, description: 'Responsive QA', evidenceRef: 'timesheet-oct-w4.csv' }, { id: 'W3', milestoneId: 'M2', hours: 2, description: 'Client call (no timesheet attached)' }], invoices: [] },
    change: { receivedOn: '2026-11-03', invoiceNo: 'PF-2026-117', invoiceDate: '2026-11-02', currency: 'INR', total: 48000, note: 'Invoice emailed by the freelancer.', lines: [{ description: 'Milestone 2 — Landing page build', milestoneId: 'M2', amount: 40000, hours: 32, rate: 1250 }, { description: 'Additional revision work (not in quote)', milestoneId: null, amount: 8000, hours: 8, rate: 1000 }] },
  }),
  detectChanges: detect, applyChange: apply, analyzeRole: analyze,
  parseAnswer(key, text) { if (key === 'fx_rate') { const n = Number(text.trim()); return n > 0 && n < 1e6 ? { value: n } : { error: 'Enter a positive number (conversion rate).' }; } return text.trim() ? { value: text.trim() } : { error: 'Answer cannot be empty.' }; },
  verifyAction(action, observed, revised: Plan) {
    const c = observed.content; const out: { name: string; passed: boolean; detail: string }[] = [];
    const inv = revised.invoices.at(-1) as any; const codes: string[] = inv?.discrepancyCodes ?? [];
    const bad = SAFE_WORDS.exec(c); out.push({ name: 'neutral wording (no accusation)', passed: !bad, detail: bad ? `contains "${bad[0]}"` : 'no accusatory wording found' });
    if (action.type === 'record_reconciliation') {
      out.push({ name: 'every discrepancy recorded', passed: codes.every((k) => c.includes(k)), detail: `${codes.length} discrepancy code(s) expected` });
      out.push({ name: 'states no payment was initiated', passed: /No payment has been initiated/.test(c), detail: 'explicit statement present' });
    }
    if (action.type === 'send_clarification') out.push({ name: 'cites the invoice number', passed: c.includes(String(inv?.invoiceNo)), detail: `invoice ${inv?.invoiceNo}` });
    return out;
  },
};
