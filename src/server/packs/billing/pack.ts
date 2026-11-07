import { z } from 'zod';
import type { AnalysisContext, ChangeItem, CompletionCheck, RoleResult, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';
import { untrustedFindings } from '../untrusted.js';
import { verifyClaim } from '../../capabilities/reclaim/knowledge.js';
import { sanitizeAttachments } from '../../capabilities/reclaim/attachments.js';
import { extractCommitments, INJECTION_RE } from '../../capabilities/resolve/commitments.js';
import { duplicates, opBlock, parseState, SANDBOX_LABEL, type Charge } from './ledger.js';

/**
 * Billing & SLA Dispute: ONE company, its internal departments (Support, Engineering/Ops, Finance, Policy) resolving a
 * customer's billing dispute after an outage. The customer stays outside: email in (the change), email out (dry-run outbox).
 * The mission is an OBLIGATION GRAPH: each obligation has an owner department, a source record, a deadline, dependencies
 * and a verification criterion. The engine enforces the dependencies (`blockedUntil`): the customer reply cannot be sent
 * until Finance's refund is verified in the ledger AND Engineering has confirmed the fix.
 * Capabilities reused: RESOLVE commitment extraction (customer request + deadline), RECLAIM claim grounding (every policy
 * statement in the reply must appear in the cited clause) + the RECLAIM attachment guardrail (dispute evidence is
 * inspected by the deterministic sanitizer BEFORE any parsing — the #908 defense), RIPPLE untrusted-text detection.
 * Limits: the ledger is a labelled sandbox (no payment provider, no money moves); email is dry-run; no legal conclusions.
 * Switch Level 3 (session 15): when collaboration is Switch, the engine bootstraps the case topology declared below —
 * #ops-verify-<case> and #finance-settle-<case> linked to the intake room, with the exclusive settlement-signer seat.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 timestamp');
const charge = z.object({ id: z.string().min(1), invoice: z.string().min(1), amount: z.number().positive(), currency: z.string().min(1), capturedAt: iso, source: z.string().min(1) });
export const planSchema = z.object({
  company: z.object({ name: z.string().min(1), supportAddress: z.string().email(), utcOffsetMin: z.number().int().default(-300) }),
  customer: z.object({ name: z.string().min(1), contactName: z.string().min(1), contact: z.string().email(), account: z.string().min(1), plan: z.string().min(1), monthlyFee: z.number().positive(), currency: z.string().min(1) }),
  sla: z.object({ targetUptime: z.number().min(90).max(100), tiers: z.array(z.object({ below: z.number(), creditPct: z.number().min(0).max(100) })).min(1), capPct: z.number().min(0).max(100), clause: z.string().min(1) }),
  policies: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), version: z.string().default('1'), text: z.string().min(10) })).min(1),
  systems: z.object({
    ledger: z.array(charge).min(1),
    outage: z.object({ id: z.string().min(1), start: iso, end: iso, services: z.array(z.string()).default([]), rootCause: z.string().min(1), bug: z.string().min(1) }),
    month: z.string().regex(/^\d{4}-\d{2}$/),
  }),
  scenarioFaults: z.array(z.object({ op: z.enum(['refund', 'credit']), kind: z.literal('lost_response'), label: z.string() })).default([]),
  history: z.array(z.any()).default([]),
});
export const changeSchema = z.object({
  receivedOn: date,
  message: z.object({ id: z.string().min(1), sender: z.string().min(3), to: z.string().optional(), sentAt: iso, body: z.string().min(10).max(8000) }),
  /**
   * Dispute evidence uploaded with the email (files, screenshots, forwarded statements). These are UNTRUSTED:
   * Switch issue #908 — attachments bypass message-text guardrails — so the RECLAIM guardrail inspects every one
   * (deterministic, before any parsing) and intake analysis sees only the sanitized, labelled form.
   */
  attachments: z.array(z.object({
    filename: z.string().min(1).max(300), mimetype: z.string().min(0).default(''), size: z.number().int().nonnegative().default(0),
    mxc: z.string().max(400).optional(), caption: z.string().max(4000).optional(),
  })).max(25).default([]),
});
type Plan = z.infer<typeof planSchema>; type Change = z.infer<typeof changeSchema>; type Answers = AnalysisContext['answers'];

const usd = (n: number, cur = 'USD') => `${cur === 'USD' ? '$' : `${cur} `}${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const num = (s?: string) => (s ? Number(s.replace(/,/g, '')) : null);
const clause = (p: Plan, id: string) => p.policies.find((x) => x.id === id);

export function disputeView(plan: Plan, change: Change, answers: Answers = {}) {
  const body = change.message.body;
  const dup = duplicates(plan.systems.ledger)[0] ?? null;
  const claimed = num(/\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(body)?.[1]);
  const credReq = /\$\s?([\d,]+(?:\.\d{1,2})?)\s+(?:service\s+)?credit|credit of \$\s?([\d,]+(?:\.\d{1,2})?)/i.exec(body);
  const requestedCredit = credReq ? num(credReq[1] ?? credReq[2]) : null;
  const amountConflict = !!(dup && claimed !== null && Math.abs(claimed - dup.duplicate.amount) > 0.005);
  const rec = answers.reconcile_amount?.value as number | 'ledger' | undefined;
  const refundAmount = dup ? (!amountConflict ? dup.duplicate.amount : rec === 'ledger' ? dup.duplicate.amount : typeof rec === 'number' && rec <= dup.duplicate.amount ? rec : null) : null;
  const o = plan.systems.outage; const minutes = Math.max(0, (Date.parse(o.end) - Date.parse(o.start)) / 60000);
  const [y, mo] = plan.systems.month.split('-').map(Number) as [number, number];
  const monthMin = new Date(Date.UTC(y, mo, 0)).getUTCDate() * 1440;
  const uptime = 100 * (1 - minutes / monthMin);
  const tier = [...plan.sla.tiers].sort((a, b) => a.below - b.below).find((t) => uptime < t.below);
  const policyCredit = tier ? Math.round(plan.customer.monthlyFee * tier.creditPct) / 100 : 0;
  const cap = Math.round(plan.customer.monthlyFee * plan.sla.capPct) / 100;
  const dupAfterOutageStart = dup ? Date.parse(dup.duplicate.capturedAt) >= Date.parse(o.start) : false;
  const requests = extractCommitments([change.message], plan.company.supportAddress, plan.company.utcOffsetMin).filter((c) => c.kind === 'REQUEST_TO_USER');
  const untrusted = [...untrustedFindings(body), ...(INJECTION_RE.test(body) ? ['asks the reader to reveal or forward mailbox data'] : [])];
  return { dup, claimed, requestedCredit, amountConflict, refundAmount, minutes, uptime, tier, policyCredit, cap, dupAfterOutageStart, requests, untrusted, creditOverCap: requestedCredit !== null && requestedCredit > cap + 0.005 };
}
type View = ReturnType<typeof disputeView>;
const creditAmount = (v: View) => v.requestedCredit ?? v.policyCredit;

// Statements the reply may make about policy. Each is included only if verifyClaim finds it in the cited clause text.
const POLICY_LINES: { clause: string; claim: string }[] = [
  { clause: 'BILL-7.1', claim: 'the duplicate capture is refunded in full to the original payment method' },
  { clause: 'SLA-4.2', claim: 'Service credits are capped at 25% of the monthly fee' },
];
const grounded = (p: Plan) => POLICY_LINES.filter((l) => verifyClaim(l.claim, clause(p, l.clause)?.text ?? ''));

function detect(plan: Plan, change: Change, answers: Answers = {}): ChangeItem[] {
  const v = disputeView(plan, change, answers); const it: ChangeItem[] = [];
  const quarantined = sanitizeAttachments(change.attachments ?? []).filter((g) => g.quarantined);
  if (quarantined.length) it.push({ field: 'attachment.quarantined', label: `${quarantined.length} uploaded attachment(s) quarantined by the RECLAIM guardrail (#908 defense)`, before: `${change.attachments.length} attachment(s) uploaded`, after: `${quarantined.length} held as data (never used as evidence)`, kind: 'added', severity: 'high', note: quarantined.map((q) => q.findings.map((f) => f.detail).join('; ')).join(' | ' ) });
  it.push({ field: 'email.received', label: `Customer email ${change.message.id}`, before: 'no open dispute', after: change.message.body.slice(0, 120), kind: 'added', severity: 'low', note: `from ${change.message.sender}` });
  it.push({ field: 'outage.window', label: `Outage ${plan.systems.outage.id}`, before: 'service healthy', after: `${Math.round(v.minutes)} min down; monthly uptime ${v.uptime.toFixed(2)}%`, kind: 'modified', severity: v.tier ? 'high' : 'low' });
  if (v.dup) it.push({ field: 'ledger.duplicate', label: `Duplicate capture of ${v.dup.duplicate.invoice}`, before: `${v.dup.original.id} only`, after: `${v.dup.original.id} + ${v.dup.duplicate.id} (${usd(v.dup.duplicate.amount, v.dup.duplicate.currency)})`, kind: 'added', severity: 'high' });
  else it.push({ field: 'ledger.no_duplicate', label: 'No duplicate capture in the ledger', before: 'customer claim', after: 'not supported by the ledger', kind: 'modified', severity: 'medium' });
  if (v.amountConflict) it.push({ field: 'amount.conflict', label: 'Customer amount differs from ledger', before: `ledger ${usd(v.dup!.duplicate.amount)}`, after: `customer ${usd(v.claimed!)}`, kind: 'modified', severity: 'high' });
  if (v.creditOverCap) it.push({ field: 'credit.over_cap', label: 'Requested credit exceeds SLA cap', before: `cap ${usd(v.cap)}`, after: `requested ${usd(v.requestedCredit!)}`, kind: 'modified', severity: 'high' });
  if (v.untrusted.length) it.push({ field: 'untrusted.instructions', label: 'Instruction-like text in customer email', before: 'data', after: 'treated as data', kind: 'modified', severity: 'high', note: v.untrusted.join('; ') });
  return it;
}

function apply(plan: Plan, change: Change, answers: Answers): Plan {
  const p: Plan = structuredClone(plan); const v = disputeView(plan, change, answers);
  p.history.push({ receivedOn: change.receivedOn, messageId: change.message.id, refund: v.dup && v.refundAmount ? { chargeId: v.dup.duplicate.id, amount: v.refundAmount } : null, creditProposed: creditAmount(v) || null, status: 'resolution_in_progress', note: 'The outcome of each obligation is the verified state of its action in RIPPLE; nothing here is inferred.' });
  return p;
}

function analyze(role: string, ctx: AnalysisContext): RoleResult {
  const plan = ctx.plan as Plan, change = ctx.change as Change; const v = disputeView(plan, change, ctx.answers);
  const cur = plan.customer.currency; const out = plan.systems.outage;
  const faultOf = (op: 'refund' | 'credit') => plan.scenarioFaults.find((f) => f.op === op);

  if (role === 'bd_intake') {
    const guard = sanitizeAttachments(change.attachments ?? []);
    const quarantined = guard.filter((g) => g.quarantined);
    const passed = guard.filter((g) => !g.quarantined);
    const o = new Out(role, 'rule-engine/billing-intake@1 (RESOLVE port + RECLAIM attachment guardrail)');
    o.info(`Email ${change.message.id} from ${change.message.sender} (${plan.customer.name}, account ${plan.customer.account}).`);
    if (passed.length) o.info(`Attachment guardrail (Switch #908 defense): ${passed.length} attachment(s) passed deterministic inspection before parsing (${guard.length} inspected, 0 LLM calls).`);
    for (const g of quarantined) o.risk(`Attachment "${g.filename}" (attachment ${g.guard}/3) QUARANTINED by the RECLAIM guardrail: ${g.findings.map((f) => `${f.detail}`).join('; ')}. It stays data: nothing in it is acted on, and it may not serve as evidence.`);
    for (const r of v.requests) o.info(`Customer request: "${r.evidenceText}"${r.deadline.deadlineAt ? ` — due ${r.deadline.deadlineAt.slice(0, 16).replace('T', ' ')} UTC (from "${r.deadline.phrase}")` : r.deadline.confidence === 'AMBIGUOUS' ? ` — deadline AMBIGUOUS (${r.deadline.reviewReason})` : ''}.`);
    if (v.untrusted.length) o.risk(`The email contains instruction-like text (${v.untrusted.join('; ')}). It is customer data and grants no permission.`);
    if (v.requestedCredit !== null) o.warn(`The customer asks for a service credit of ${usd(v.requestedCredit, cur)}.`);
    o.draft({ kind: 'customer_case', name: 'Customer case (intake)', artifactKey: 'customer_case', content: `# Customer case — ${plan.customer.name}\n\nReceived ${change.receivedOn} via email (${change.message.sender}). The customer is outside the company and is answered by email only.\n\n> ${change.message.body.replace(/\n/g, '\n> ')}\n\n## Requests extracted (exact sentences)\n${v.requests.length ? table(['Request', 'Deadline'], v.requests.map((r) => [`"${r.evidenceText}"`, r.deadline.deadlineAt ? `${r.deadline.deadlineAt} (${r.deadline.phrase})` : r.deadline.confidence ?? '—'])) : 'None found.'}\n\n${guard.length ? `## Uploaded evidence (RECLAIM attachment guardrail, #908 defense — deterministic, 0 LLM calls)\n${table(['Attachment', 'Guard', 'Result', 'Findings'], guard.map((g) => [g.safeLabel, `${g.guard}/3`, g.quarantined ? 'QUARANTINED (data, not evidence)' : 'passed', g.findings.length ? g.findings.map((f) => f.detail).join('; ').slice(0, 200) : 'none']))}\nQuarantined attachments are quoted as data and may not serve as evidence.` : 'No attachments were uploaded with this dispute.'}\n\nAmount claimed by the customer: ${v.claimed !== null ? usd(v.claimed, cur) : 'none stated'}. Requested credit: ${v.requestedCredit !== null ? usd(v.requestedCredit, cur) : 'none'}.` });
    return o.done(`${v.requests.length} customer request(s); claimed ${v.claimed !== null ? usd(v.claimed, cur) : 'no amount'}${guard.length ? `; ${guard.length} attachment(s) inspected (${quarantined.length} quarantined)` : ''}.`);
  }

  if (role === 'bd_ops') {
    const o = new Out(role, 'rule-engine/billing-ops@1');
    o.info(`Incident ${out.id}: ${out.services.join(', ') || 'service'} down ${out.start} → ${out.end} (${Math.round(v.minutes)} min). Root cause: ${out.rootCause}.`);
    if (v.dup) o.info(`The duplicate capture ${v.dup.duplicate.id} (${v.dup.duplicate.source}) happened ${v.dupAfterOutageStart ? 'after' : 'before'} the outage started — consistent with ${out.bug}.`);
    o.work({ key: 'bd-patch-confirmed', title: `Confirm ${out.bug} is fixed in production (retries no longer re-capture paid invoices)`, detail: `Root cause of ${out.id}: ${out.rootCause}. The customer reply stays blocked until this is confirmed, so the customer is not told it is fixed before it is.`, department: 'Engineering', roleKey: 'bd_eng_lead', kind: 'task', artifactKey: 'incident_record' });
    o.draft({ kind: 'incident_record', name: `Incident ${out.id} record`, artifactKey: 'incident_record', content: `# Incident ${out.id}\n\n${table(['Field', 'Value'], [['Window (UTC)', `${out.start} → ${out.end}`], ['Duration', `${Math.round(v.minutes)} min`], ['Services', out.services.join(', ')], ['Monthly uptime', `${v.uptime.toFixed(3)}% (target ${plan.sla.targetUptime}%)`], ['Root cause', out.rootCause], ['Defect', out.bug]])}\n\nSource: the company's outage log export recorded in the account record.` });
    return o.done(`Outage ${Math.round(v.minutes)} min; uptime ${v.uptime.toFixed(2)}%; fix confirmation requested from Engineering.`);
  }

  if (role === 'bd_finance') {
    const o = new Out(role, 'rule-engine/billing-finance@1');
    const led = plan.systems.ledger;
    o.draft({ kind: 'ledger_extract', name: 'Ledger extract (Finance)', artifactKey: 'ledger_extract', content: `# Ledger extract — ${plan.customer.account}\n\nFinance working record. Shared channels receive only the verified claim, not this extract.\n\n${table(['Charge', 'Invoice', 'Amount', 'Captured', 'Source'], led.map((c: Charge) => [c.id, c.invoice, usd(c.amount, c.currency), c.capturedAt, c.source]))}` });
    if (!v.dup) { o.risk('The ledger shows no duplicate capture. The customer\'s claim is not supported by the ledger; no refund is proposed. Support should ask for the transaction details.'); return o.done('No duplicate capture found; no refund proposed.'); }
    o.info(`Verified claim: invoice ${v.dup.duplicate.invoice} was captured twice (${v.dup.original.id}, ${v.dup.duplicate.id}). ${v.dup.duplicate.id} is the duplicate, ${usd(v.dup.duplicate.amount, v.dup.duplicate.currency)}; refund eligible under BILL-7.1.`);
    if (v.amountConflict && v.refundAmount === null) {
      o.risk(`Conflict: the customer claims ${usd(v.claimed!, cur)}, the ledger duplicate is ${usd(v.dup.duplicate.amount, cur)}. No refund is proposed until the Finance lead reconciles it.`);
      o.ask({ key: 'reconcile_amount', text: `The customer claims ${usd(v.claimed!, cur)}; the ledger duplicate ${v.dup.duplicate.id} is ${usd(v.dup.duplicate.amount, cur)}. Reply "ledger" to refund the ledger amount, or enter the amount to refund (at most ${usd(v.dup.duplicate.amount, cur)}).`, blocking: true, assigneeRole: 'bd_finance_lead', assigneeOnly: true });
      return o.done('Amount conflict between customer and ledger; waiting for the Finance lead.');
    }
    const amt = v.refundAmount!; const f = faultOf('refund');
    o.draft({ kind: 'refund_op', name: `Refund ${v.dup.duplicate.id}`, artifactKey: 'refund_op', content: `# Refund of duplicate capture ${v.dup.duplicate.id}\n\nInvoice ${v.dup.duplicate.invoice}; original capture ${v.dup.original.id} is kept. Amount: ${usd(amt, cur)} to the original payment method (policy BILL-7.1).\nTarget: ${SANDBOX_LABEL}. No payment provider is contacted.${f ? `\n\nScripted scenario fault on this step (labelled, part of the demo): ${f.label}.` : ''}\n\n${opBlock({ op: 'refund', chargeId: v.dup.duplicate.id, account: plan.customer.account, amount: amt, currency: cur, seed: { account: plan.customer.account, ledger: led }, ...(f ? { fault: f.kind } : {}) })}` });
    o.act({ key: 'refund_duplicate', type: 'billing_refund', title: `Refund duplicate charge ${v.dup.duplicate.id} (${usd(amt, cur)})`, connector: 'billing_sandbox', ownerRole: 'bd_finance_lead', consequential: true, draftKind: 'refund_op', approvalRole: 'manager', approver: { role: 'bd_finance_lead' }, separateFromRequester: true, ackRoles: [], rationale: 'Moves money back to the customer; only the Finance lead may approve the exact payload.', target: `${plan.customer.account}/${v.dup.duplicate.id}`, effectKey: `refund:${v.dup.duplicate.id}` });
    return o.done(`Duplicate ${v.dup.duplicate.id} verified; refund of ${usd(amt, cur)} proposed for the Finance lead.`);
  }

  if (role === 'bd_policy') {
    const o = new Out(role, 'rule-engine/billing-policy@1 (RECLAIM grounding)');
    const sla = clause(plan, plan.sla.clause);
    o.info(`Monthly uptime ${v.uptime.toFixed(2)}% vs target ${plan.sla.targetUptime}% → ${v.tier ? `${v.tier.creditPct}% credit = ${usd(v.policyCredit, cur)}` : 'no SLA credit'} under ${plan.sla.clause}; cap ${plan.sla.capPct}% = ${usd(v.cap, cur)}.`);
    const g = grounded(plan);
    o.draft({ kind: 'sla_assessment', name: 'Policy & SLA assessment', artifactKey: 'sla_assessment', content: `# Policy & SLA assessment\n\nSources are the company's own policies as recorded in the account record (internal, versioned). This is a policy calculation, not a legal conclusion.\n\n${table(['Clause', 'Title', 'Version', 'Text'], plan.policies.map((p) => [p.id, p.title, p.version, p.text]))}\n\n${table(['Item', 'Value'], [['Downtime', `${Math.round(v.minutes)} min`], ['Monthly uptime', `${v.uptime.toFixed(3)}%`], ['Credit tier', v.tier ? `below ${v.tier.below}% → ${v.tier.creditPct}%` : 'none'], ['Policy credit', usd(v.policyCredit, cur)], ['Cap', usd(v.cap, cur)], ['Customer request', v.requestedCredit !== null ? usd(v.requestedCredit, cur) : 'none']])}\n\nStatements verified against clause text: ${g.map((x) => `${x.clause}: "${x.claim}"`).join('; ') || 'none'}.` });
    if (!sla) o.risk(`SLA clause ${plan.sla.clause} is not in the recorded policies; no credit can be grounded.`);
    if (v.creditOverCap) o.risk(`The customer asks for ${usd(v.requestedCredit!, cur)}, above the ${plan.sla.clause} cap of ${usd(v.cap, cur)} (policy credit: ${usd(v.policyCredit, cur)}). Recommendation: REJECT the requested amount; the Finance lead decides.`);
    const amount = creditAmount(v);
    if (sla && amount > 0) {
      const f = faultOf('credit');
      o.draft({ kind: 'credit_op', name: 'Service credit', artifactKey: 'credit_op', content: `# Service credit for ${plan.customer.account}\n\nAmount: ${usd(amount, cur)} ${v.requestedCredit !== null ? `(as requested by the customer; policy credit is ${usd(v.policyCredit, cur)}, cap ${usd(v.cap, cur)})` : `(policy ${plan.sla.clause}: ${v.tier?.creditPct}% of ${usd(plan.customer.monthlyFee, cur)})`}.\nTarget: ${SANDBOX_LABEL}.${f ? `\n\nScripted scenario fault on this step (labelled): ${f.label}.` : ''}\n\n${opBlock({ op: 'credit', account: plan.customer.account, amount, currency: cur, seed: { account: plan.customer.account, ledger: plan.systems.ledger }, ...(f ? { fault: f.kind } : {}) })}` });
      o.act({ key: 'issue_sla_credit', type: 'billing_credit', title: v.requestedCredit !== null ? `Issue customer-requested service credit ${usd(amount, cur)}${v.creditOverCap ? ` — exceeds SLA cap ${usd(v.cap, cur)}` : ''}` : `Issue SLA service credit ${usd(amount, cur)} (${plan.sla.clause})`, connector: 'billing_sandbox', ownerRole: 'bd_finance_lead', consequential: true, draftKind: 'credit_op', approvalRole: 'manager', approver: { role: 'bd_finance_lead' }, separateFromRequester: true, ackRoles: [], rationale: v.creditOverCap ? `Requested by the customer. Policy agent recommends REJECT: above the ${plan.sla.clause} cap.` : 'Credit computed from the recorded outage and the SLA clause.', target: `${plan.customer.account}/credit`, effectKey: `credit:${plan.customer.account}:${change.message.id}` });
    }
    return o.done(`${v.tier ? `SLA breached (${v.uptime.toFixed(2)}%)` : 'SLA met'}; credit ${amount ? usd(amount, cur) : 'none'}${v.creditOverCap ? ' (requested, over cap — reject recommended)' : ''}.`);
  }

  // ---------- bd_comms: obligation graph + customer reply (blocked by the engine until its obligations are met) ----------
  const o = new Out(role, 'rule-engine/billing-comms@1 (RESOLVE)');
  const waiting = v.dup && v.refundAmount === null;
  const policyCredit = !v.creditOverCap && v.requestedCredit === null && v.policyCredit > 0;
  const deadline = v.requests.find((r) => r.deadline.deadlineAt)?.deadline;
  const obligations: (string | number)[][] = [
    ['OB-1', 'Confirm the incident window', 'Engineering/Ops · Incident Agent', `outage log ${out.id}`, '—', '—', 'recorded log', 'window recorded'],
    ['OB-2', `Confirm ${out.bug} is fixed`, 'Engineering · Engineering Lead', `root cause of ${out.id}`, '—', 'OB-1', 'open (work item bd-patch-confirmed)', 'human confirmation'],
    ['OB-3', 'Verify the duplicate capture', 'Finance · Billing Agent', 'payment ledger', '—', '—', v.dup ? 'ledger shows duplicate' : 'NOT supported by ledger', v.amountConflict ? 'Finance lead reconciles amount' : 'ledger record'],
    ['OB-4', v.dup ? `Refund ${v.dup.duplicate.id}${v.refundAmount ? ` (${usd(v.refundAmount, cur)})` : ''}` : 'Refund (none — no duplicate)', 'Finance · Finance Lead approves', 'BILL-7.1', '—', 'OB-3', waiting ? 'blocked: amount conflict' : v.dup ? 'awaiting approval' : 'not applicable', 'ledger read-back: refunded exactly once'],
    ['OB-5', `Service credit${creditAmount(v) ? ` (${usd(creditAmount(v), cur)})` : ''}`, 'Finance · Finance Lead approves', plan.sla.clause, '—', 'OB-1', v.creditOverCap ? 'awaiting decision (over cap)' : creditAmount(v) ? 'awaiting approval' : 'not applicable', `ledger read-back; amount ≤ cap ${usd(v.cap, cur)}`],
    ['OB-6', 'Reply to the customer', 'Support · Support Lead approves', `customer email ${change.message.id}`, deadline?.deadlineAt ?? '—', `OB-2, OB-4${policyCredit ? ', OB-5' : ''}`, 'blocked by the engine until dependencies are met', 'outbox read-back: exact recipient/subject/body'],
  ];
  o.draft({ kind: 'obligation_graph', name: 'Obligation graph', artifactKey: 'obligation_graph', content: `# Obligation graph — ${plan.customer.name} dispute (${out.id})\n\nWho owes what, to whom, from which record, by when, after what. Statuses here are as of analysis; the live state is the engine's (approvals, actions, work items), and dependencies are enforced at execution.\n\n${table(['#', 'Obligation', 'Owner', 'Source', 'Deadline', 'Depends on', 'Status', 'Verified by'], obligations)}` });
  if (waiting) return o.done('Reply not drafted: the refund amount is being reconciled by Finance.');
  const g = grounded(plan); const sig = `${plan.company.name} Support`;
  const lines = v.dup
    ? [`We confirmed that invoice ${v.dup.duplicate.invoice} was captured twice on ${v.dup.duplicate.capturedAt.slice(0, 10)} (${v.dup.original.id} and ${v.dup.duplicate.id}); the second capture was made by an automatic retry during incident ${out.id}.`,
      `We have refunded the duplicate charge ${v.dup.duplicate.id} of ${usd(v.refundAmount!, cur)} to your original payment method; it normally appears within 5–10 business days.`,
      `The defect that caused the duplicate capture (${out.bug}) has been fixed by our engineering team.`]
    : ['We could not find a duplicate capture for your account in our payment ledger. Could you send the transaction date, amount and the last four digits of the card, so we can check again?'];
  if (policyCredit) lines.push(`Under our service level agreement (${plan.sla.clause}) the outage qualifies your account for a service credit of ${usd(v.policyCredit, cur)}, which has been applied to your account.`);
  if (v.requestedCredit !== null) lines.push(`Your request for a ${usd(v.requestedCredit, cur)} service credit is being reviewed by our Finance team under ${plan.sla.clause}; we will reply to it separately.`);
  o.draft({ kind: 'customer_reply', name: `Reply to ${plan.customer.contactName} (draft)`, artifactKey: 'customer_reply', content: `Dear ${plan.customer.contactName},\n\nThank you for reporting this, and we are sorry for the trouble.\n\n${lines.join('\n\n')}\n\nPolicy references:\n${g.map((x) => `- ${x.clause}: ${x.claim}`).join('\n') || '- none'}\n\nKind regards,\n${sig}` });
  o.act({ key: 'send_customer_reply', type: 'customer_reply', title: `Reply to ${plan.customer.name} about ${v.dup ? `${v.dup.duplicate.invoice} and ${out.id}` : 'the reported charge'}`, connector: 'email_outbox', ownerRole: 'bd_support_lead', consequential: true, draftKind: 'customer_reply', approvalRole: 'manager', approver: { role: 'bd_support_lead' }, ackRoles: [], rationale: 'External commitment to the customer (policy COMMS-2.3: only after Finance executed and Engineering confirmed the fix).', target: plan.customer.contact, effectKey: `reply:${change.message.id}`,
    ...(v.dup ? { blockedUntil: { actions: ['refund_duplicate', ...(policyCredit ? ['issue_sla_credit'] : [])], workItems: ['bd-patch-confirmed'] } } : {}) });
  return o.done(`Obligation graph: 6 obligations. Customer reply drafted; the engine holds it until ${v.dup ? `the refund${policyCredit ? ' and credit are' : ' is'} verified and ${out.bug} is confirmed fixed` : 'approval'}.`);
}

const PROMISE = /\b(guarantee[ds]?|will never happen again|legally (?:obliged|required)|we admit liability)\b/i;
const header = (c: string, h: string) => new RegExp(`^${h}: (.*)$`, 'm').exec(c)?.[1]?.trim() ?? null;

export const billingPack: WorkflowPack = {
  id: 'billing-dispute', name: 'Billing & SLA Dispute', domain: 'Customer Billing Resolution', version: '1.0.0',
  description: 'One company, internal departments: a customer\'s duplicate-charge dispute after an outage becomes an obligation graph (Ops → Engineering → Finance → Policy → Support). Refunds and credits run against a labelled sandbox ledger with read-back; the customer reply is engine-blocked until its obligations are verified.',
  labels: { baseline: 'Account & systems record', change: 'Customer email', changeVerb: 'Receive customer email', plan: 'account record', mission: 'Billing dispute', blurb: 'Dispute → obligation graph → approved, verified resolution' },
  roles: [
    { key: 'bd_intake', name: 'Support Intake Agent (RESOLVE)', kind: 'agent', responsibility: 'Reads the customer email; extracts requests and deadlines from exact sentences.', department: 'Support' },
    { key: 'bd_ops', name: 'Incident Agent', kind: 'agent', responsibility: 'Confirms the outage window and root cause; asks Engineering to confirm the fix.', department: 'Engineering' },
    { key: 'bd_finance', name: 'Billing Agent', kind: 'agent', responsibility: 'Checks the payment ledger; shares only the verified claim; proposes the refund.', department: 'Finance' },
    { key: 'bd_policy', name: 'Policy Agent (RECLAIM)', kind: 'agent', responsibility: 'Applies the SLA and billing clauses; computes credit and cap; grounds every policy statement.', department: 'Legal & Policy' },
    { key: 'bd_comms', name: 'Customer Comms Agent (RESOLVE)', kind: 'agent', responsibility: 'Builds the obligation graph and drafts the customer reply.', department: 'Support' },
    { key: 'bd_finance_lead', name: 'Finance Lead (human)', kind: 'human', responsibility: 'Approves or rejects refunds and credits; reconciles disputed amounts.', department: 'Finance' },
    { key: 'bd_eng_lead', name: 'Engineering Lead (human)', kind: 'human', responsibility: 'Confirms the defect is fixed in production.', department: 'Engineering' },
    { key: 'bd_support_lead', name: 'Support Lead (human)', kind: 'human', responsibility: 'Approves the exact reply sent to the customer.', department: 'Support' },
  ],
  roleOrder: ['bd_intake', 'bd_ops', 'bd_finance', 'bd_policy', 'bd_comms'],
  roleDeps: { bd_intake: [], bd_ops: [], bd_finance: ['bd_intake'], bd_policy: ['bd_intake', 'bd_ops'], bd_comms: ['bd_intake', 'bd_ops', 'bd_finance', 'bd_policy'] },
  /**
   * Switch Level 3 case topology (session 15), declared as configuration and executed generically by the engine through
   * the Switch adapter when the mission room is a real Switch room. The coordinator provisions #ops-verify-<case_id> and
   * #finance-settle-<case_id> (members: the arbiter ONLY) linked to the intake room, defines the exclusive settlement-signer
   * role at creation, and the arbiter assumes it with its own identity. No pack ever makes a Switch call itself.
   */
  switchCaseTopology: {
    opsRoom: { roleKeys: ['bd_ops'], label: 'Ops verification', instructions: 'Verification agents for this dispute work here: outage window, root cause, fix confirmation. Findings quote recorded evidence (the outage log, the engineering work item) and never certify more than the evidence supports.' },
    financeRoom: { roleKeys: [], label: 'Finance settlement', instructions: 'The settlement arbiter works here. Refund and credit decisions, and any payout receipt, are posted only by the live holder of the settlement-signer seat; the Switch server refuses a second holder. Amounts are only the rule-engine computed ones, re-read from the labelled billing_sandbox ledger; no provider claim (a "refunded" from a provider message) ever becomes a verified refund here.' },
    exclusiveRole: { name: 'settlement-signer', instructions: 'Draft and countersign settlement statements for this dispute. While you hold this exclusive seat the server refuses any other agent the role, so no second party can emit a conflicting payout receipt. State amounts only as computed by the rule engine and independently re-read; never promise an unverified refund or credit.' },
    arbiterAgentName: 'ripple-arbiter',
  },  planSchema, changeSchema,
  artifacts: [
    { key: 'customer_case', label: 'Customer case', department: 'Support', ownerRole: 'bd_support_lead', description: 'The customer email and extracted requests' },
    { key: 'incident_record', label: 'Incident record', department: 'Engineering', ownerRole: 'bd_eng_lead', description: 'Outage window and root cause' },
    { key: 'ledger_extract', label: 'Ledger extract', department: 'Finance', ownerRole: 'bd_finance_lead', description: 'Finance working record (not shared to other channels)' },
    { key: 'refund_op', label: 'Refund', department: 'Finance', ownerRole: 'bd_finance_lead', description: 'Refund of the duplicate capture' },
    { key: 'sla_assessment', label: 'Policy & SLA assessment', department: 'Legal & Policy', ownerRole: 'bd_finance_lead', description: 'Clauses, uptime, credit and cap' },
    { key: 'credit_op', label: 'Service credit', department: 'Finance', ownerRole: 'bd_finance_lead', description: 'SLA credit' },
    { key: 'obligation_graph', label: 'Obligation graph', department: 'Resolution', ownerRole: 'bd_support_lead', description: 'Who owes what, by when, after what' },
    { key: 'customer_reply', label: 'Customer reply', department: 'Support', ownerRole: 'bd_support_lead', description: 'Email to the customer' },
  ],
  rules: [
    { id: 'email→case', trigger: (i) => i.field === 'email.received', to: 'customer_case', relation: 'opens', why: 'A customer dispute arrived' },
    { id: 'email→graph', trigger: (i) => i.field === 'email.received', to: 'obligation_graph', relation: 'creates', why: 'Every dispute becomes an obligation graph' },
    { id: 'email→reply', trigger: (i) => i.field === 'email.received', to: 'customer_reply', relation: 'requires', why: 'The customer is owed an answer' },
    { id: 'outage→incident', trigger: (i) => i.field === 'outage.window', to: 'incident_record', relation: 'records', why: 'The outage is the root incident' },
    { id: 'outage→sla', trigger: (i) => i.field === 'outage.window', to: 'sla_assessment', relation: 'triggers', why: 'Downtime is measured against the SLA' },
    { id: 'dup→ledger', trigger: (i) => /^ledger\.|^amount\./.test(i.field), to: 'ledger_extract', relation: 'checks', why: 'The claim is checked against the ledger' },
    { id: 'dup→refund', trigger: (i) => i.field === 'ledger.duplicate', to: 'refund_op', relation: 'requires', why: 'A duplicate capture is refunded (BILL-7.1)' },
    { id: 'credit→op', trigger: (i) => i.field === 'outage.window' || i.field === 'credit.over_cap', to: 'credit_op', relation: 'requires', why: 'SLA credit decision' },
    { id: 'untrusted→case', trigger: (i) => i.field === 'untrusted.instructions', to: 'customer_case', relation: 'flags', why: 'Customer text is data' },
  ],
  artifactEdges: [
    { from: 'incident_record', to: 'sla_assessment', relation: 'measures', why: 'Downtime drives the credit' },
    { from: 'ledger_extract', to: 'refund_op', relation: 'evidences', why: 'Only a verified duplicate is refunded' },
    { from: 'sla_assessment', to: 'credit_op', relation: 'sizes', why: 'Credit and cap come from the clause' },
    { from: 'refund_op', to: 'customer_reply', relation: 'blocks', why: 'No refund claim before it is verified' },
    { from: 'incident_record', to: 'customer_reply', relation: 'blocks', why: 'No "fixed" claim before Engineering confirms' },
    { from: 'credit_op', to: 'customer_reply', relation: 'blocks', why: 'No credit claim before it is applied' },
    { from: 'customer_case', to: 'obligation_graph', relation: 'feeds', why: 'Customer requests become obligations' },
  ],
  decisions: [
    { key: 'approve_refund', label: 'Approve the refund payload', ownerRole: 'bd_finance_lead', gates: ['refund_op'] },
    { key: 'approve_credit', label: 'Approve or reject the credit', ownerRole: 'bd_finance_lead', gates: ['credit_op'] },
    { key: 'approve_reply', label: 'Approve the customer reply', ownerRole: 'bd_support_lead', gates: ['customer_reply'] },
  ],
  sample: () => ({
    title: 'INC-402 — Acme Logistics duplicate charge after API outage ($4,200)',
    plan: {
      company: { name: 'Harbor & Vine Cloud', supportAddress: 'support@harborvine.example', utcOffsetMin: -300 },
      customer: { name: 'Acme Logistics', contactName: 'Dana Whitfield', contact: 'ap@acme-logistics.example', account: 'ACME-2231', plan: 'Enterprise', monthlyFee: 12000, currency: 'USD' },
      sla: { targetUptime: 99.9, tiers: [{ below: 99.9, creditPct: 10 }, { below: 99.0, creditPct: 25 }], capPct: 25, clause: 'SLA-4.2' },
      policies: [
        { id: 'BILL-7.1', title: 'Duplicate charges', version: '3', text: 'Where the same invoice is captured more than once, the duplicate capture is refunded in full to the original payment method. A refund is issued only after Finance verifies the duplicate in the payment ledger.' },
        { id: 'SLA-4.2', title: 'Service credits', version: '5', text: 'If monthly uptime falls below 99.9%, the customer receives a service credit of 10% of the monthly fee; below 99.0%, 25%. Service credits are capped at 25% of the monthly fee and are the sole remedy for downtime.' },
        { id: 'COMMS-2.3', title: 'Customer commitments', version: '2', text: 'Support must not confirm a refund or credit to a customer until Finance has executed it, and must not state that a defect is fixed until Engineering has confirmed the fix.' },
      ],
      systems: {
        ledger: [
          { id: 'ch_9918', invoice: 'INV-5530', amount: 4200, currency: 'USD', capturedAt: '2026-11-04T10:02:00Z', source: 'scheduled_billing' },
          { id: 'ch_9921', invoice: 'INV-5530', amount: 4200, currency: 'USD', capturedAt: '2026-11-04T16:41:00Z', source: 'automatic_retry' },
          { id: 'ch_9876', invoice: 'INV-5402', amount: 4200, currency: 'USD', capturedAt: '2026-10-04T10:01:00Z', source: 'scheduled_billing' },
        ],
        outage: { id: 'INC-402', start: '2026-11-04T09:30:00Z', end: '2026-11-04T15:50:00Z', services: ['billing-api', 'payments-webhook'], rootCause: 'the payments webhook timed out, so the retry job re-captured invoices whose first capture had already succeeded', bug: 'BUG-1187' },
        month: '2026-11',
      },
      scenarioFaults: [], history: [],
    },
    change: { receivedOn: '2026-11-05', message: { id: 'em-402-1', sender: 'Dana Whitfield <ap@acme-logistics.example>', to: 'support@harborvine.example', sentAt: '2026-11-05T13:12:00Z', body: 'You double-charged our corporate account $4,200 for invoice INV-5530 after the API outage yesterday, and your automated billing retry failed.\nPlease refund the duplicate charge by Friday.' } },
  }),
  detectChanges: detect, applyChange: apply, analyzeRole: analyze,
  parseAnswer(key, text, plan) {
    if (key === 'reconcile_amount') {
      const t = text.trim().toLowerCase(); if (t === 'ledger') return { value: 'ledger' };
      const max = duplicates((plan as Plan).systems.ledger)[0]?.duplicate.amount ?? 0; const n = Number(t.replace(/[$,]/g, ''));
      return n > 0 && n <= max ? { value: n } : { error: `Reply "ledger" or an amount between 0 and ${usd(max)} (the duplicate charge).` };
    }
    return text.trim() ? { value: text.trim() } : { error: 'Answer cannot be empty.' };
  },
  verifyAction(action, observed, revised: Plan, ctx) {
    const c = observed.content; const out: { name: string; passed: boolean; detail: string }[] = [];
    const v = ctx ? disputeView(ctx.baselinePlan as Plan, ctx.change as Change, ctx.answers) : null;
    if (action.type === 'billing_refund' || action.type === 'billing_credit') {
      const st = parseState(c);
      out.push({ name: 'ledger read back independently', passed: !!st, detail: st ? `account ${st.account}` : 'no ledger state in the read-back' });
      if (st && action.type === 'billing_refund' && v?.dup) {
        const d = st.charges.find((x) => x.id === v.dup!.duplicate.id), orig = st.charges.find((x) => x.id === v.dup!.original.id);
        out.push({ name: 'duplicate refunded exactly once', passed: d?.refunds === 1, detail: `${v.dup.duplicate.id}: ${d?.refunds ?? 0} refund(s)` });
        out.push({ name: 'refunded amount equals the approved amount', passed: !!d && Math.abs(d.refunded - (v.refundAmount ?? -1)) < 0.005, detail: `${d?.refunded ?? 0} refunded` });
        out.push({ name: 'original capture untouched', passed: orig?.refunds === 0, detail: `${v.dup.original.id}: ${orig?.refunds ?? '?'} refund(s)` });
      }
      if (st && action.type === 'billing_credit' && v) {
        const total = st.credits.reduce((s, x) => s + x.amount, 0);
        out.push({ name: `credit within SLA cap (${(ctx!.baselinePlan as Plan).sla.clause})`, passed: total <= v.cap + 0.005, detail: `credited ${total}; cap ${v.cap}` });
      }
    } else {
      const to = header(c, 'To'), subj = header(c, 'Subject');
      out.push({ name: 'recipient matches the approved recipient', passed: to === action.payload.target, detail: `To: ${to ?? '(missing)'}` });
      out.push({ name: 'subject matches the approved subject', passed: subj === action.payload.subject, detail: `Subject: ${subj ?? '(missing)'}` });
      out.push({ name: 'delivery honestly labelled (dry-run, not sent)', passed: /X-Ripple-Delivery: DRY-RUN/.test(c), detail: 'outbox header present' });
      const bad = [...c.matchAll(/^- ([A-Z]+-\d+(?:\.\d+)?): (.*)$/gm)].filter((m) => !verifyClaim(m[2]!, clause(revised, m[1]!)?.text ?? ''));
      out.push({ name: 'every policy statement grounded in the cited clause', passed: bad.length === 0, detail: bad.length ? bad.map((m) => m[1]).join(', ') : 'all references verified' });
      const p = PROMISE.exec(c); out.push({ name: 'no guarantees or liability admissions', passed: !p, detail: p ? `contains "${p[0]}"` : 'none' });
      if (v && v.requestedCredit !== null) out.push({ name: 'does not promise the requested credit', passed: !new RegExp(`credit of \\$${v.requestedCredit.toLocaleString('en-US')}[^.]*applied`, 'i').test(c), detail: 'requested credit is described as under review' });
    }
    return out;
  },
  completionChecks(ctx): CompletionCheck[] {
    const v = disputeView(ctx.baselinePlan as Plan, ctx.change as Change, ctx.answers);
    return [
      { key: 'claim_reconciled', label: 'Customer claim reconciled against the ledger', passed: !v.dup || v.refundAmount !== null, detail: v.dup ? `refund ${v.refundAmount ?? 'pending reconciliation'}` : 'no duplicate in ledger' },
      { key: 'history_recorded', label: 'Resolution recorded on the account', passed: (ctx.revisedPlan as Plan).history.length > 0, detail: `${(ctx.revisedPlan as Plan).history.length} entry(ies)` },
    ];
  },
};
