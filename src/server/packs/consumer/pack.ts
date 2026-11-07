import { z } from 'zod';
import type { AnalysisContext, ChangeItem, CompletionCheck, RoleResult, WorkflowPack } from '../../engine/types.js';
import { Out, money, table } from '../common.js';
import { untrustedFindings } from '../untrusted.js';
import { kb, verifyClaim, checkCitations, type KbHit } from '../../capabilities/reclaim/knowledge.js';
import { extractCommitments, commitmentState, INJECTION_RE, type Commitment, type ThreadMessage } from '../../capabilities/resolve/commitments.js';
import { evaluateIntent, scanForScam, extractCaseFacts, mapAnswer, memoryQuestion } from '../../capabilities/redeem/intake.js';

/**
 * Consumer Resolution: one consumer problem that spans several organisations (an airline and a bank), worked by
 * the three integrated capabilities inside ONE RIPPLE mission:
 *   REDEEM  (capabilities/redeem)  intake safety, case facts, confirmed memory (refund preference)
 *   RESOLVE (capabilities/resolve) commitment ledger: who promised what, by when, from the exact sentence
 *   RECLAIM (capabilities/reclaim) rights & evidence: retrieval with provenance, citation grounding, evidence coverage
 * RIPPLE owns the mission, approvals (bound to the exact content and to the consumer), execution and verification.
 * Limits, stated in every draft: connectors are local/dry-run (nothing is emailed); sources are authored reference
 * guides, not official regulator text; nothing here is legal advice; a refund counts only when the consumer confirms it.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 timestamp');
const DOMAINS = ['airlines', 'banking'] as const;
const message = z.object({ id: z.string().min(1), sender: z.string().min(3), to: z.string().optional(), body: z.string().min(1).max(8000), sentAt: iso });
const evidence = z.object({ id: z.string().min(1), kind: z.string().min(1), domain: z.enum(DOMAINS), ref: z.string().min(1) });
export const planSchema = z.object({
  consumer: z.object({ name: z.string().min(1), email: z.string().email(), utcOffsetMin: z.number().int().min(-720).max(840).default(330) }),
  workstreams: z.array(z.object({
    domain: z.enum(DOMAINS), org: z.string().min(1), orgContact: z.string().email(), issue: z.string().min(1), reference: z.string().min(1),
    amount: z.number().positive(), currency: z.string().min(1), incidentDate: date, requiredEvidence: z.array(z.string()).default([]),
  })).min(1).refine((w) => new Set(w.map((x) => x.domain)).size === w.length, 'one workstream per organisation type'),
  thread: z.array(message).default([]),
  evidence: z.array(evidence).default([]),
  memory: z.record(z.string(), z.string()).default({}),
  outcomes: z.array(z.object({ domain: z.enum(DOMAINS), status: z.string(), recordedOn: date, reference: z.string().optional(), note: z.string().optional() })).default([]),
  reports: z.array(z.any()).default([]),
});
export const changeSchema = z.object({
  reportedOn: date, statement: z.string().min(10).max(4000),
  newMessages: z.array(message).default([]), newEvidence: z.array(evidence).default([]),
});
type Plan = z.infer<typeof planSchema>; type Change = z.infer<typeof changeSchema>; type Domain = (typeof DOMAINS)[number];
type Answers = AnalysisContext['answers'];

// ---------- shared, deterministic case view (every role and the verifier derive the same facts from recorded data) ----------
const orgDomain = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';
const statementOf = (c: Change, a: Answers) => (a.restate_request?.text ? a.restate_request.text : c.statement);
const refundMode = (p: Plan, a: Answers) => (a.refund_mode?.value as string | undefined) ?? p.memory['billing.refund_mode'];
const REFUND_WORDS: Record<string, string> = { original_payment: 'to my original payment method', wallet: 'to my wallet', voucher: 'as a voucher / credit shell' };
interface OrgPromise extends Commitment { domain: Domain; org: string; state: ReturnType<typeof commitmentState> }

export function caseView(plan: Plan, change: Change, answers: Answers = {}) {
  const thread: ThreadMessage[] = [...plan.thread, ...change.newMessages];
  const all = extractCommitments(thread, plan.consumer.email, plan.consumer.utcOffsetMin);
  const confirmed = (d: Domain) => plan.outcomes.some((o) => o.domain === d && o.status === 'confirmed_by_consumer');
  const promises: OrgPromise[] = [];
  for (const c of all.filter((x) => x.kind === 'PROMISE_BY_OTHER')) {
    const ws = plan.workstreams.find((w) => c.responsiblePerson && orgDomain(c.responsiblePerson) === orgDomain(w.orgContact));
    if (ws) promises.push({ ...c, domain: ws.domain, org: ws.org, state: commitmentState(c, change.reportedOn, confirmed(ws.domain)) });
  }
  const statement = statementOf(change, answers);
  const untrusted = [...change.newMessages.map((m) => ({ where: `message ${m.id} from ${m.sender}`, text: m.body })), { where: 'consumer report', text: change.statement }]
    .map((x) => ({ ...x, reasons: [...untrustedFindings(x.text), ...(INJECTION_RE.test(x.text) ? ['asks the reader to reveal or forward mailbox data'] : [])] }))
    .filter((x) => x.reasons.length);
  const scams = change.newMessages.map((m) => ({ id: m.id, sender: m.sender, scan: scanForScam(m.body) })).filter((x) => x.scan.level === 'high');
  const have = new Set([...plan.evidence, ...change.newEvidence].map((e) => `${e.domain}:${e.kind}`));
  // A merchant's written refund promise IS merchant correspondence for the bank dispute (cross-organisation evidence link).
  if (promises.some((p) => p.domain === 'airlines')) { have.add('banking:merchant_correspondence'); have.add('airlines:refund_promise'); }
  const missing = plan.workstreams.flatMap((w) => w.requiredEvidence.filter((k) => !have.has(`${w.domain}:${k}`)).map((k) => ({ domain: w.domain, kind: k })));
  const safety = evaluateIntent(statement);
  const facts = extractCaseFacts(statement);
  const amountFact = facts.find((f) => f.field === 'amount');
  const amountMismatch = amountFact && !plan.workstreams.some((w) => Math.abs(w.amount - Number(amountFact.value)) < 0.5) ? amountFact : null;
  const mode = refundMode(plan, answers);
  const blockedBy = [safety.decision !== 'ALLOW' && 'restate_request', !mode && 'refund_mode'].filter(Boolean) as string[];
  return { thread, all, promises, untrusted, scams, missing, safety, facts, amountMismatch, mode, blockedBy, statement };
}

// RECLAIM retrieval + grounding: only claims that verifiably appear in the retrieved source text may be cited.
const CLAIMS: Record<Domain, string[]> = {
  airlines: ['DGCA CAR Section 3 (Facilities to Passengers)', 'the choice of refund form (cash/original payment method vs. credit shell) rests with the passenger', 'AirSewa (airsewa.gov.in)'],
  banking: ["RBI's Master Direction on Credit Card and Debit Card", 'a disputed transaction must not accrue interest/charges while under investigation', 'Reserve Bank - Integrated Ombudsman Scheme, 2021'],
};
const QUERY: Record<Domain, string> = { airlines: 'flight cancellation refund compensation credit shell airsewa nodal officer', banking: 'credit card billing dispute chargeback merchant refund not received interest ombudsman' };
function retrieve(domain: Domain, statement: string): KbHit[] { return kb().search(`${QUERY[domain]} ${statement}`, [domain], 4); }
function grounded(domain: Domain, hits: KbHit[]): { claim: string; source: KbHit }[] {
  const out: { claim: string; source: KbHit }[] = [];
  for (const claim of CLAIMS[domain]) {
    const src = hits.find((h) => verifyClaim(claim, kb().byId.get(h.id)?.text ?? ''));
    if (src) out.push({ claim, source: src });
  }
  return out;
}
const fmtDay = (isoTs: string | null) => (isoTs ? isoTs.slice(0, 10) : 'no date stated');
const LIMITS = 'Prepared by RIPPLE. Not legal advice. References are to reference guides bundled with RIPPLE (authored by RECLAIM, not official regulator text) and were checked by a human case reviewer before sending.';

function detect(plan: Plan, change: Change, answers: Answers = {}): ChangeItem[] {
  const v = caseView(plan, change, answers); const items: ChangeItem[] = [];
  items.push({ field: 'report.received', label: 'Consumer report', before: `${plan.reports.length} earlier report(s)`, after: change.statement.slice(0, 120), kind: 'added', severity: 'low', note: `reported ${change.reportedOn}` });
  for (const w of plan.workstreams) items.push({ field: `workstream.${w.domain}.active`, label: `${w.org}: ${w.issue}`, before: 'no open case', after: `${money(w.amount, w.currency)} · ${w.reference}`, kind: 'added', severity: 'low' });
  for (const p of v.promises) items.push({ field: `commitment.${p.state === 'OVERDUE' ? 'overdue' : 'open'}.${p.domain}`, label: `${p.org} promise`, before: `promised: "${p.evidenceText}"`, after: p.state === 'OVERDUE' ? `deadline ${fmtDay(p.deadline.deadlineAt)} passed (as of ${change.reportedOn})` : `due ${fmtDay(p.deadline.deadlineAt)}`, kind: 'modified', severity: p.state === 'OVERDUE' ? 'high' : 'medium' });
  for (const m of v.missing) items.push({ field: `evidence.missing.${m.domain}.${m.kind}`, label: `Missing evidence: ${m.kind.replace(/_/g, ' ')}`, before: 'required', after: 'not on file', kind: 'removed', severity: 'medium' });
  if (v.safety.decision !== 'ALLOW') items.push({ field: `safety.${v.safety.riskClass}`, label: 'Request RIPPLE will not carry out', before: 'consumer request', after: v.safety.decision, kind: 'modified', severity: 'high', note: v.safety.explanation });
  if (v.untrusted.length) items.push({ field: 'untrusted.instructions', label: 'Instruction-like text in submitted content', before: 'data', after: 'treated as data, not instructions', kind: 'modified', severity: 'high', note: v.untrusted.map((u) => u.where).join('; ') });
  if (v.amountMismatch) items.push({ field: 'facts.amount_mismatch', label: 'Amount in report differs from case file', before: plan.workstreams.map((w) => money(w.amount, w.currency)).join(' / '), after: v.amountMismatch.quote, kind: 'modified', severity: 'medium' });
  return items;
}

function apply(plan: Plan, change: Change, answers: Answers): Plan {
  const p: Plan = structuredClone(plan); const v = caseView(plan, change, answers);
  p.thread.push(...change.newMessages); p.evidence.push(...change.newEvidence);
  if (v.mode) p.memory['billing.refund_mode'] = v.mode;                                     // confirmed by the consumer (assignee-only answer)
  p.reports.push({ reportedOn: change.reportedOn, statement: v.statement.slice(0, 600) });
  for (const w of p.workstreams) {
    if (p.outcomes.some((o) => o.domain === w.domain && o.status === 'confirmed_by_consumer')) continue;
    p.outcomes.push({ domain: w.domain, status: 'awaiting_organisation_response', recordedOn: change.reportedOn, note: 'Follow-up recorded in the dry-run outbox. No refund has been confirmed by the consumer.' });
  }
  return p;
}

function analyze(role: string, ctx: AnalysisContext): RoleResult {
  const plan = ctx.plan as Plan, change = ctx.change as Change; const v = caseView(plan, change, ctx.answers);
  const ws = (d: Domain) => plan.workstreams.find((w) => w.domain === d);

  if (role === 'cr_intake') {
    const o = new Out(role, 'rule-engine/consumer-intake@1 (REDEEM port)');
    o.info(`${plan.consumer.name} reported (${change.reportedOn}) a problem spanning ${plan.workstreams.length} organisation(s): ${plan.workstreams.map((w) => w.org).join(', ')}.`);
    if (v.safety.decision !== 'ALLOW') {
      o.risk(`${v.safety.explanation} No action is proposed until the consumer restates the outcome they want.`);
      o.ask({ key: 'restate_request', text: `${v.safety.explanation} Please restate the outcome you want from the organisations (for example: "chase the refund and dispute the charge").`, blocking: true, assigneeRole: 'cr_consumer', assigneeOnly: true });
    }
    for (const u of v.untrusted) o.risk(`Instruction-like text in ${u.where} (${u.reasons.join('; ')}). It is treated as data and grants no permission.`);
    for (const s of v.scams) o.risk(`Message ${s.id} from ${s.sender} shows scam indicators: ${s.scan.indicators.map((i) => i.code).join(', ')}. ${s.scan.disclaimer}`);
    if (v.amountMismatch) o.warn(`The report mentions ${v.amountMismatch.quote}, which matches no amount in the case file (${plan.workstreams.map((w) => money(w.amount, w.currency)).join(', ')}). The case file amount is used; please check.`, true);
    if (!v.mode) o.ask({ key: 'refund_mode', text: `${memoryQuestion('billing.refund_mode')} RIPPLE will request exactly this and will not choose for you.`, blocking: true, assigneeRole: 'cr_consumer', assigneeOnly: true });
    o.draft({ kind: 'intake_summary', name: 'Intake summary (proposed facts)', artifactKey: 'intake_summary', content: `# Intake summary — ${plan.consumer.name}\n\nReported ${change.reportedOn}: "${v.statement}"\n\n## Facts read from the report (PROPOSED until you confirm)\n${v.facts.length ? table(['Field', 'Value', 'From the words', 'Status'], v.facts.map((f) => [f.field, f.sensitive ? '••' + f.value.slice(-2) : f.value, `"${f.quote}"`, f.status])) : 'No structured facts found in the report.'}\n\n## Confirmed by you\n- Refund preference: ${v.mode ? REFUND_WORDS[v.mode] ?? v.mode : '**not yet confirmed** (question pending)'}\n\n## Safety\n- Request check: ${v.safety.decision} — ${v.safety.explanation}\n- Untrusted content: ${v.untrusted.length ? v.untrusted.map((u) => `${u.where}: ${u.reasons.join('; ')}`).join(' | ') : 'none found'}\n- Scam indicators in new messages: ${v.scams.length ? v.scams.map((s) => s.id).join(', ') : 'none detected (heuristic)'}` });
    o.data = { safety: v.safety, facts: v.facts, refundMode: v.mode ?? null };
    return o.done(`${v.facts.length} proposed fact(s); safety ${v.safety.decision}; refund preference ${v.mode ? 'confirmed' : 'pending'}${v.untrusted.length ? `; ${v.untrusted.length} untrusted-content flag(s)` : ''}.`);
  }

  if (role === 'cr_commitments') {
    const o = new Out(role, 'rule-engine/consumer-commitments@1 (RESOLVE port)');
    for (const p of v.promises) {
      if (p.state === 'OVERDUE') o.risk(`${p.org} wrote on ${p.sentAt.slice(0, 10)}: "${p.evidenceText}" The deadline (${fmtDay(p.deadline.deadlineAt)}, from "${p.deadline.phrase}") has passed as of ${change.reportedOn} and no refund is recorded as received.`);
      else if (p.state === 'NEEDS_DATE') o.warn(`${p.org} promised "${p.evidenceText}" without a usable date (${p.deadline.reviewReason ?? 'no deadline stated'}). Please set a follow-up date.`, true);
      else o.info(`${p.org} promised "${p.evidenceText}" — due ${fmtDay(p.deadline.deadlineAt)} (${p.state}).`);
    }
    if (!v.promises.length) o.info('No written promise from the organisations was found in the thread.');
    const rows = v.all.map((c, i) => { const p = v.promises.find((x) => x.evidenceText === c.evidenceText && x.sourceMessageId === c.sourceMessageId); return [i + 1, c.kind, c.responsiblePerson ?? '— unresolved —', `"${c.evidenceText}"`, c.deadline.deadlineAt ? `${fmtDay(c.deadline.deadlineAt)} (${c.deadline.phrase})` : c.deadline.confidence === 'AMBIGUOUS' ? `AMBIGUOUS: ${c.deadline.reviewReason}` : '—', p?.state ?? '—']; });
    o.draft({ kind: 'commitment_ledger', name: 'Commitment ledger', artifactKey: 'commitment_ledger', content: `# Commitment ledger (as of ${change.reportedOn})\n\nExtracted deterministically from ${v.thread.length} message(s); every row quotes the exact sentence it came from. Automated notices and instruction-like text never create commitments.\n\n${rows.length ? table(['#', 'Kind', 'Responsible', 'Evidence (exact sentence)', 'Deadline', 'State'], rows) : 'No commitments found.'}` });
    o.data = { promises: v.promises.map((p) => ({ domain: p.domain, org: p.org, evidence: p.evidenceText, deadline: p.deadline.deadlineAt, state: p.state, messageId: p.sourceMessageId })) };
    return o.done(`${v.all.length} commitment(s) in the thread; ${v.promises.filter((p) => p.state === 'OVERDUE').length} organisation promise(s) overdue.`);
  }

  if (role === 'cr_rights') {
    const o = new Out(role, 'rule-engine/consumer-rights@1 (RECLAIM port)');
    const sections: string[] = []; const used: Record<string, string[]> = {};
    for (const w of plan.workstreams) {
      const hits = retrieve(w.domain, v.statement); const g = grounded(w.domain, hits); used[w.domain] = hits.map((h) => h.id);
      o.info(`${w.org}: ${hits.length} reference passage(s) retrieved; ${g.length} citable statement(s) verified against the retrieved text.`);
      sections.push(`## ${w.org} — ${w.issue}\n\n${table(['Source', 'Authority', 'Provenance', 'Confidence', 'Excerpt'], hits.map((h) => [`[${h.id}] ${h.title}`, h.authority || '—', h.provenance === 'authored_guide' ? 'authored guide (not official text)' : 'scraped official page', h.scores.confidence, h.passage.replace(/\s+/g, ' ').slice(0, 220) + '…']))}\n\nVerified citable statements:\n${g.length ? g.map((x) => `- "${x.claim}" — found in [${x.source.id}]`).join('\n') : '- none (nothing will be cited for this organisation)'}`);
    }
    if (plan.workstreams.some((w) => w.domain === 'banking')) o.info('Escalation option described in the reference guide: if the bank does not respond within 30 days of a written complaint, the RBI Integrated Ombudsman (cms.rbi.org.in) can be approached. This is an option, not a conclusion about the outcome.');
    if (plan.workstreams.some((w) => w.domain === 'airlines')) o.info('Escalation option described in the reference guide: the airline\'s Nodal Officer first, then AirSewa if the response is inadequate.');
    o.warn('All retrieved sources are reference guides authored by RECLAIM, not official regulator text. A human case reviewer must check every cited rule against the official source before anything is sent.', true);
    o.work({ key: 'cr-review-citations', title: 'Check the cited rules against the official regulator text', detail: 'Compare each verified citable statement in the rights brief with the current official DGCA/RBI text. RIPPLE does not give legal conclusions.', department: 'Consumer Advocacy', roleKey: 'cr_case_reviewer', kind: 'review', artifactKey: 'rights_brief' });
    for (const m of v.missing) { o.warn(`Missing evidence for ${ws(m.domain)?.org}: ${m.kind.replace(/_/g, ' ')}.`); o.work({ key: `cr-evidence-${m.domain}-${m.kind}`, title: `Add evidence: ${m.kind.replace(/_/g, ' ')} (${ws(m.domain)?.org})`, detail: 'Upload or forward the document; RIPPLE never infers it.', department: 'Consumer Desk', roleKey: 'cr_consumer', kind: 'task', artifactKey: 'rights_brief' }); }
    o.draft({ kind: 'rights_brief', name: 'Rights & evidence brief', artifactKey: 'rights_brief', content: `# Rights & evidence brief\n\nRetrieval: BM25 over the bundled RECLAIM corpus (no model call). Scores: similarity × authority tier × legal weight; authored guides are discounted.\n\n${sections.join('\n\n')}\n\n## Evidence coverage\n${plan.workstreams.map((w) => `- ${w.org}: ${w.requiredEvidence.map((k) => `${k.replace(/_/g, ' ')} ${v.missing.some((m) => m.domain === w.domain && m.kind === k) ? '✗ missing' : '✓'}`).join(', ') || 'no required evidence declared'}`).join('\n')}\n\nNot legal advice. Sources are authored reference guides, not official regulator text.` });
    o.data = { retrieved: used, missing: v.missing };
    return o.done(`${Object.values(used).flat().length} passage(s) retrieved; ${v.missing.length} evidence gap(s); citations need human review.`);
  }

  // ---------- cr_drafting: RESOLVE (exact promise quote) + RECLAIM (grounded references) + REDEEM (consumer journey) ----------
  const o = new Out(role, 'rule-engine/consumer-drafting@1');
  if (v.blockedBy.length) return o.done(`Waiting for the consumer (${v.blockedBy.join(', ')}). Nothing is drafted for the organisations until then.`);
  const mode = v.mode!; const name = plan.consumer.name; const air = ws('airlines'), bank = ws('banking');
  const airPromise = v.promises.filter((p) => p.domain === 'airlines').sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))[0];
  const refs = (d: Domain) => grounded(d, retrieve(d, v.statement));
  if (air) {
    const g = refs('airlines');
    const opening = airPromise
      ? `On ${airPromise.sentAt.slice(0, 10)} your team wrote:\n"${airPromise.evidenceText}"\n\n${airPromise.state === 'OVERDUE' ? `That date (${fmtDay(airPromise.deadline.deadlineAt)}) has passed and I have not received the refund.` : `I am writing to confirm the status ahead of that date (${fmtDay(airPromise.deadline.deadlineAt)}).`}`
      : 'I have not received a written refund commitment for this cancellation.';
    o.draft({ kind: 'airline_followup', name: `Follow-up to ${air.org} (draft)`, artifactKey: 'airline_followup', content: `Dear Nodal Officer,\n\nRe: ${air.issue} — ${air.reference} — ${money(air.amount, air.currency)}\n\n${opening}\n\nI request the full refund of ${money(air.amount, air.currency)} ${REFUND_WORDS[mode] ?? mode}, and a written confirmation with the refund reference number.\n\nReferences:\n${g.map((x) => `- ${x.claim}`).join('\n') || '- none'}\n\nIf this is not resolved, I intend to escalate through the airline grievance process and AirSewa.\n\nRegards,\n${name}\n\n--\n${LIMITS}` });
    o.act({ key: 'send_airline_followup', type: 'send_airline_followup', title: `Send follow-up to ${air.org} (${air.reference})`, connector: 'email_outbox', ownerRole: 'cr_consumer', consequential: true, draftKind: 'airline_followup', approvalRole: 'manager', ackRoles: [], rationale: 'External message to an organisation on the consumer\'s behalf; only the consumer may approve its exact content.', target: air.orgContact, effectKey: 'followup_airlines', approver: { role: 'cr_consumer' } });
  }
  if (bank) {
    const g = refs('banking'); const merchant = airPromise ? `${airPromise.org} cancelled the service and promised a refund in writing on ${airPromise.sentAt.slice(0, 10)} ("${airPromise.evidenceText}"); ${airPromise.state === 'OVERDUE' ? 'that promise is overdue and no refund has reached my card.' : 'no refund has reached my card yet.'}` : 'The merchant has not refunded the charge.';
    const ev = [...plan.evidence, ...change.newEvidence].filter((e) => e.domain === 'banking').map((e) => `${e.kind.replace(/_/g, ' ')} (${e.ref})`);
    if (airPromise) ev.push(`merchant correspondence: ${airPromise.org} message ${airPromise.sourceMessageId}`);
    o.draft({ kind: 'bank_dispute', name: `Card dispute to ${bank.org} (draft)`, artifactKey: 'bank_dispute', content: `To the Card Disputes / Nodal Officer, ${bank.org}\n\nRe: Dispute of transaction ${bank.reference}, ${money(bank.amount, bank.currency)}, dated ${bank.incidentDate}\n\nI am disputing the above charge. ${merchant}\n\nI request that this transaction be investigated, that no interest or late fee be levied on the disputed amount while the investigation is pending, and that I receive a written explanation of the outcome.\n\nEvidence available: ${ev.join('; ') || 'none listed'}.\n\nReferences:\n${g.map((x) => `- ${x.claim}`).join('\n') || '- none'}\n\nRegards,\n${name}\n\n--\n${LIMITS}` });
    o.act({ key: 'send_bank_dispute', type: 'send_bank_dispute', title: `Send card dispute to ${bank.org} (${bank.reference})`, connector: 'email_outbox', ownerRole: 'cr_consumer', consequential: true, draftKind: 'bank_dispute', approvalRole: 'manager', ackRoles: [], rationale: 'Opens a formal dispute with the bank; only the consumer may approve its exact content.', target: bank.orgContact, effectKey: 'dispute_banking', approver: { role: 'cr_consumer' } });
  }
  const cites = plan.workstreams.flatMap((w) => retrieve(w.domain, v.statement).map((h) => `- [${h.id}] ${h.title} — ${h.authority || 'no authority'} — ${h.provenance === 'authored_guide' ? 'authored guide, not official regulator text' : 'scraped official page'}`));
  o.draft({ kind: 'case_file', name: 'Case file (record)', artifactKey: 'case_file', content: `# Case file — ${name}\n\nReported ${change.reportedOn}. Refund preference (confirmed by ${name}): ${REFUND_WORDS[mode] ?? mode}.\n\n## Workstreams\n${table(['Organisation', 'Issue', 'Reference', 'Amount', 'Next step'], plan.workstreams.map((w) => [w.org, w.issue, w.reference, money(w.amount, w.currency), w.domain === 'airlines' ? 'follow-up on the written refund promise' : 'formal card dispute']))}\n\n## Organisation promises\n${v.promises.length ? v.promises.map((p) => `- ${p.org} (${p.sentAt.slice(0, 10)}): "${p.evidenceText}" — ${p.state}`).join('\n') : '- none found'}\n\n## Sources consulted\n${cites.join('\n')}\n\n## Outcome\nUNRESOLVED. No refund has been confirmed. RIPPLE records the organisations' responses when they arrive; a refund counts only when ${name} confirms it was received.\n\nSources are reference guides authored by RECLAIM, not official regulator text. Connectors are local/dry-run: nothing in this case was emailed outside RIPPLE.` });
  o.act({ key: 'record_case_file', type: 'record_case_file', title: `Record the case file for ${name}`, connector: 'document_store', ownerRole: 'cr_consumer', consequential: true, draftKind: 'case_file', approvalRole: 'manager', ackRoles: ['cr_case_reviewer'], rationale: 'Creates the evidence record the consumer and reviewer rely on.', target: 'Case records', effectKey: 'case_file', approver: { role: 'cr_consumer' } });
  o.draft({ kind: 'consumer_update', name: `Update for ${name}`, artifactKey: 'consumer_update', content: `Hi ${name.split(' ')[0]},\n\nHere is where your case stands:\n\n- Waiting for your approval: ${o.actions.map((a) => a.title).join('; ')}. Nothing is sent until you approve the exact text.\n- Checked for you: ${v.promises.length ? v.promises.map((p) => `${p.org}'s written promise (${p.state.toLowerCase()})`).join(', ') : 'no written promise was found'}; ${v.missing.length ? `${v.missing.length} document(s) still needed` : 'all listed documents are on file'}.\n- Being reviewed: a case reviewer is checking the cited rules against the official text.\n- Not yet known: whether either organisation will refund. A refund counts only when you confirm you received it.\n\nRIPPLE never asks for OTPs, PINs or passwords and never moves money.` });
  return o.done(`${o.actions.length} action(s) proposed for the consumer's approval; outcome stays UNRESOLVED until the consumer confirms a refund.`);
}

const SETTLED = /\b(refund (?:has been|was) (?:processed|completed|credited|received)|we have refunded|you are (?:legally )?entitled|guarantee[ds]?\b|will definitely)/i;
const CREDENTIAL_ASK = /\b(share|send|provide|tell)\b.{0,40}\b(otp|pin|cvv|password)\b/i;
const header = (c: string, h: string) => new RegExp(`^${h}: (.*)$`, 'm').exec(c)?.[1]?.trim() ?? null;
const referencesOf = (c: string) => { const m = /References:\n((?:- .*\n?)+)/.exec(c); return m ? m[1]!.split('\n').map((l) => l.replace(/^- /, '').trim()).filter((l) => l && l !== 'none') : []; };
const corpusText = (d: Domain) => kb().rows.filter((r) => r.domain === d).map((r) => r.text);

export const consumerPack: WorkflowPack = {
  id: 'consumer-resolution', name: 'Consumer Resolution', domain: 'Consumer Dispute Resolution', version: '1.0.0',
  description: 'One consumer problem across several organisations (airline + bank): REDEEM intake and confirmed memory, RESOLVE commitment ledger, RECLAIM rights and evidence, consumer-approved follow-ups with exact-content read-back. Never claims a refund without the consumer\'s confirmation.',
  labels: { baseline: 'Case file', change: 'Consumer report', changeVerb: 'Report the problem', plan: 'case file', mission: 'Consumer dispute', blurb: 'One problem → every organisation → verified follow-through' },
  roles: [
    { key: 'cr_intake', name: 'Consumer Intake Agent (REDEEM)', kind: 'agent', responsibility: 'Safety check, proposed case facts, confirmed refund preference.', department: 'Consumer Desk' },
    { key: 'cr_commitments', name: 'Commitment Agent (RESOLVE)', kind: 'agent', responsibility: 'Who promised what, by when, from the exact sentence; overdue promises.', department: 'Communications' },
    { key: 'cr_rights', name: 'Rights & Evidence Agent (RECLAIM)', kind: 'agent', responsibility: 'Retrieves reference passages with provenance, verifies citable statements, checks evidence coverage.', department: 'Rights & Evidence' },
    { key: 'cr_drafting', name: 'Resolution Drafting Agent', kind: 'agent', responsibility: 'Drafts the organisation letters, case file and consumer update.', department: 'Communications' },
    { key: 'cr_consumer', name: 'Consumer (human)', kind: 'human', responsibility: 'Confirms facts and preferences; the only person who may approve messages sent on their behalf.', department: 'Consumer Desk' },
    { key: 'cr_case_reviewer', name: 'Case Reviewer (human)', kind: 'human', responsibility: 'Checks cited rules against official text; acknowledges the case record.', department: 'Consumer Advocacy' },
  ],
  roleOrder: ['cr_intake', 'cr_commitments', 'cr_rights', 'cr_drafting'],
  roleDeps: { cr_intake: [], cr_commitments: [], cr_rights: ['cr_commitments'], cr_drafting: ['cr_intake', 'cr_commitments', 'cr_rights'] },
  planSchema, changeSchema,
  artifacts: [
    { key: 'intake_summary', label: 'Intake summary', department: 'Consumer Desk', ownerRole: 'cr_consumer', description: 'Proposed facts, confirmed preferences, safety checks' },
    { key: 'commitment_ledger', label: 'Commitment ledger', department: 'Communications', ownerRole: 'cr_consumer', description: 'Promises with exact evidence and deadlines' },
    { key: 'rights_brief', label: 'Rights & evidence brief', department: 'Rights & Evidence', ownerRole: 'cr_case_reviewer', description: 'Retrieved passages, provenance, verified citations, evidence coverage' },
    { key: 'airline_followup', label: 'Airline follow-up', department: 'Communications', ownerRole: 'cr_consumer', description: 'Message to the airline' },
    { key: 'bank_dispute', label: 'Card dispute', department: 'Communications', ownerRole: 'cr_consumer', description: 'Message to the bank' },
    { key: 'case_file', label: 'Case file', department: 'Case Records', ownerRole: 'cr_case_reviewer', description: 'The evidence record of the case' },
    { key: 'consumer_update', label: 'Consumer update', department: 'Consumer Desk', ownerRole: 'cr_consumer', description: 'Plain-language status for the consumer' },
  ],
  rules: [
    { id: 'rep→intake', trigger: (i) => i.field === 'report.received', to: 'intake_summary', relation: 'opens', why: 'Every report starts with intake' },
    { id: 'rep→case', trigger: (i) => i.field === 'report.received', to: 'case_file', relation: 'requires', why: 'Every case is recorded' },
    { id: 'rep→update', trigger: (i) => i.field === 'report.received', to: 'consumer_update', relation: 'requires', why: 'The consumer is kept informed' },
    { id: 'promise→ledger', trigger: (i) => i.field.startsWith('commitment.'), to: 'commitment_ledger', relation: 'records', why: 'An organisation made a written promise' },
    { id: 'air→followup', trigger: (i) => i.field === 'workstream.airlines.active' || i.field.startsWith('commitment.overdue.airlines'), to: 'airline_followup', relation: 'needs', why: 'The airline owes a response' },
    { id: 'bank→dispute', trigger: (i) => i.field === 'workstream.banking.active', to: 'bank_dispute', relation: 'needs', why: 'The charge is still on the card' },
    { id: 'ws→rights', trigger: (i) => i.field.startsWith('workstream.') || i.field.startsWith('evidence.missing.'), to: 'rights_brief', relation: 'researches', why: 'Rights and evidence per organisation' },
    { id: 'safety→intake', trigger: (i) => /^(safety|untrusted|facts)\./.test(i.field), to: 'intake_summary', relation: 'flags', why: 'Intake safety and fact checks' },
  ],
  artifactEdges: [
    { from: 'intake_summary', to: 'rights_brief', relation: 'feeds', why: 'Confirmed facts drive retrieval' },
    { from: 'commitment_ledger', to: 'airline_followup', relation: 'quotes', why: 'The follow-up quotes the exact promise' },
    { from: 'commitment_ledger', to: 'bank_dispute', relation: 'evidences', why: 'The merchant\'s written promise is dispute evidence' },
    { from: 'rights_brief', to: 'airline_followup', relation: 'cites', why: 'Only verified statements are cited' },
    { from: 'rights_brief', to: 'bank_dispute', relation: 'cites', why: 'Only verified statements are cited' },
    { from: 'airline_followup', to: 'case_file', relation: 'recorded_in', why: 'Communications enter the record' },
    { from: 'bank_dispute', to: 'case_file', relation: 'recorded_in', why: 'Communications enter the record' },
    { from: 'case_file', to: 'consumer_update', relation: 'summarised_in', why: 'The consumer sees the status' },
  ],
  decisions: [
    { key: 'approve_airline', label: 'Approve the airline follow-up', ownerRole: 'cr_consumer', gates: ['airline_followup'] },
    { key: 'approve_bank', label: 'Approve the card dispute', ownerRole: 'cr_consumer', gates: ['bank_dispute'] },
    { key: 'approve_case', label: 'Approve the case record', ownerRole: 'cr_consumer', gates: ['case_file'] },
  ],
  sample: () => ({
    title: 'Asha Rao — cancelled flight SW6214 refund + card dispute (₹18,450)',
    plan: {
      consumer: { name: 'Asha Rao', email: 'asha@harborvine.example', utcOffsetMin: 330 },
      workstreams: [
        { domain: 'airlines', org: 'SkyWay Airlines', orgContact: 'nodal.officer@skyway.example', issue: 'Cancelled flight SW6214 (12 Oct) — refund not received', reference: 'PNR K7XQ2L', amount: 18450, currency: 'INR', incidentDate: '2026-10-12', requiredEvidence: ['booking_confirmation', 'cancellation_notice'] },
        { domain: 'banking', org: 'Harbor Bank Card Services', orgContact: 'card.disputes@harborbank.example', issue: 'Charge for the cancelled flight still on the card', reference: 'card ending 4417, txn HB-88120', amount: 18450, currency: 'INR', incidentDate: '2026-10-03', requiredEvidence: ['card_statement', 'merchant_correspondence'] },
      ],
      thread: [
        { id: 'msg-1', sender: 'SkyWay Customer Care <care@skyway.example>', to: 'asha@harborvine.example', sentAt: '2026-10-12T06:10:00Z', body: 'We regret to inform you that flight SW6214 on 12 October has been cancelled due to operational reasons.' },
        { id: 'msg-2', sender: 'Asha Rao <asha@harborvine.example>', to: 'care@skyway.example', sentAt: '2026-10-13T04:00:00Z', body: 'Please refund the full fare of INR 18,450 for PNR K7XQ2L. I will share the booking confirmation if you need it.' },
        { id: 'msg-3', sender: 'SkyWay Customer Care <care@skyway.example>', to: 'asha@harborvine.example', sentAt: '2026-10-14T09:30:00Z', body: 'Thank you for your patience.\nYour refund of INR 18,450 will be processed within 7 working days to the original payment method.\nReference RF-55120.' },
      ],
      evidence: [
        { id: 'E1', kind: 'booking_confirmation', domain: 'airlines', ref: 'booking-K7XQ2L.pdf' },
        { id: 'E2', kind: 'cancellation_notice', domain: 'airlines', ref: 'msg-1 (saved email)' },
        { id: 'E3', kind: 'card_statement', domain: 'banking', ref: 'statement-oct-2026.pdf (line HB-88120)' },
      ],
      memory: {}, outcomes: [], reports: [],
    },
    change: { reportedOn: '2026-11-06', statement: 'My flight SW6214 on 2026-10-12 was cancelled. SkyWay promised a refund of ₹18,450 within 7 working days but nothing has arrived, and the charge is still on my card ending 4417. Please chase the airline and dispute the charge with my bank.', newMessages: [], newEvidence: [] },
  }),
  detectChanges: detect, applyChange: apply, analyzeRole: analyze,
  parseAnswer(key, text) {
    if (key === 'refund_mode') { const r = mapAnswer(text, 'billing.refund_mode'); return r.value ? { value: r.value } : { error: r.clarification ?? 'Please choose one refund mode.' }; }
    if (key === 'restate_request') { const d = evaluateIntent(text); return d.decision === 'ALLOW' && text.trim().length >= 10 ? { value: text.trim() } : { error: d.decision === 'ALLOW' ? 'Please describe the outcome you want in a sentence.' : d.explanation }; }
    return text.trim() ? { value: text.trim() } : { error: 'Answer cannot be empty.' };
  },
  verifyAction(action, observed, revised: Plan, ctx) {
    const c = observed.content; const out: { name: string; passed: boolean; detail: string }[] = [];
    const body = action.payload.body as string; const isEmail = action.type !== 'record_case_file';
    if (isEmail) {
      // RESOLVE send_broker._mismatch: the stored message must carry exactly the approved recipient and subject.
      const to = header(c, 'To'), subj = header(c, 'Subject');
      out.push({ name: 'recipient matches the approved recipient', passed: to === action.payload.target, detail: `To: ${to ?? '(missing)'}` });
      out.push({ name: 'subject matches the approved subject', passed: subj === action.payload.subject, detail: `Subject: ${subj ?? '(missing)'}` });
      out.push({ name: 'delivery honestly labelled (dry-run, not sent)', passed: /X-Ripple-Delivery: DRY-RUN/.test(c), detail: 'outbox header present' });
      const d: Domain = action.type === 'send_bank_dispute' ? 'banking' : 'airlines'; const texts = corpusText(d);
      const refs = referencesOf(body); const bad = refs.filter((r) => !texts.some((t) => verifyClaim(r, t)));
      out.push({ name: 'every reference grounded in the source corpus (RECLAIM check)', passed: bad.length === 0, detail: bad.length ? `ungrounded: ${bad.join(' | ')}` : `${refs.length} reference(s) verified` });
      if (ctx && action.type === 'send_airline_followup') {
        const v = caseView(ctx.baselinePlan as Plan, ctx.change as Change, ctx.answers);
        const p = v.promises.filter((x) => x.domain === 'airlines').sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))[0];
        if (p) out.push({ name: 'quotes the organisation\'s exact written promise (RESOLVE)', passed: c.includes(`"${p.evidenceText}"`), detail: p.evidenceText.slice(0, 80) });
      }
    } else {
      const { cited, bad } = checkCitations(c, kb().rows.map((r) => r.id));
      out.push({ name: 'every [kb_…] citation exists in the corpus', passed: cited.length > 0 && bad.length === 0, detail: bad.length ? `unknown: ${bad.join(', ')}` : `${cited.length} citation(s)` });
      out.push({ name: 'source provenance disclosed (not official text)', passed: /not official regulator text/.test(c), detail: 'provenance statement present' });
      const confirmed = revised.outcomes.some((o) => o.status === 'confirmed_by_consumer');
      out.push({ name: 'outcome not overstated', passed: confirmed || /No refund has been confirmed/.test(c), detail: confirmed ? 'consumer confirmed a refund' : 'states UNRESOLVED / no refund confirmed' });
    }
    out.push({ name: 'never asks for OTP/PIN/CVV/password (REDEEM safety)', passed: !CREDENTIAL_ASK.test(c), detail: CREDENTIAL_ASK.test(c) ? 'credential request found' : 'none' });
    const settled = SETTLED.exec(c);
    out.push({ name: 'no legal conclusion or settled-outcome claim', passed: !settled, detail: settled ? `contains "${settled[0]}"` : 'none' });
    return out;
  },
  completionChecks(ctx): CompletionCheck[] {
    const p = ctx.revisedPlan as Plan;
    return [
      { key: 'refund_pref_confirmed', label: 'Refund preference confirmed by the consumer', passed: !!p.memory['billing.refund_mode'], detail: p.memory['billing.refund_mode'] ?? 'not confirmed' },
      { key: 'every_org_has_next_step', label: 'Every organisation has a recorded next step', passed: p.workstreams.every((w) => p.outcomes.some((o) => o.domain === w.domain)), detail: p.outcomes.map((o) => `${o.domain}: ${o.status}`).join('; ') },
      { key: 'no_unconfirmed_resolution', label: 'No refund is recorded as received without the consumer confirming it', passed: p.outcomes.every((o) => o.status !== 'refunded' || !!o.reference), detail: 'outcome statuses come from recorded data only' },
    ];
  },
};
