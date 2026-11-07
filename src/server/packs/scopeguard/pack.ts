import { z } from 'zod';
import type { AnalysisContext, ChangeItem, RoleResult, WorkflowPack } from '../../engine/types.js';
import { Out, addDays, daysBetween, money, round1, table } from '../common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kind = z.enum(['page', 'feature', 'integration', 'service', 'revision']);
export const planSchema = z.object({
  project: z.object({ name: z.string().min(1), client: z.string().min(1), clientContact: z.string().min(1), startDate: date, endDate: date, currency: z.string().min(1) }),
  rateCard: z.array(z.object({ role: z.string(), hourly: z.number().positive() })).min(1),
  team: z.array(z.object({ role: z.string(), hoursPerDay: z.number().positive(), ownerRole: z.enum(['human_pm', 'human_lead']) })).min(1),
  estimation: z.record(z.string(), z.record(z.string(), z.number().min(0))),
  limits: z.object({ pages: z.number().int().min(0), revisionRounds: z.number().int().min(0), integrations: z.array(z.string()) }),
  usage: z.object({ pages: z.number().int().min(0), revisions: z.number().int().min(0) }),
  scope: z.array(z.object({ id: z.string(), title: z.string(), kind, included: z.boolean(), hours: z.number().min(0) }).passthrough()).min(1),
  milestones: z.array(z.object({ id: z.string(), name: z.string(), due: date })),
  changeOrders: z.array(z.any()).default([]),
}).passthrough();
export const changeSchema = z.object({
  receivedOn: date, requestText: z.string().max(3000).default(''),
  items: z.array(z.object({ title: z.string().min(1).max(200), kind, matchesScopeId: z.string().nullable().optional(), pages: z.number().int().min(1).max(50).optional(), integration: z.string().optional(), clarity: z.enum(['clear', 'vague']).default('clear') })).min(1),
});
type Plan = z.infer<typeof planSchema>; type Change = z.infer<typeof changeSchema>;
type Status = 'included' | 'out_of_scope' | 'uncertain';
interface Classified { idx: number; title: string; kind: string; status: Status; reason: string; pages: number; scopeId?: string | null; integration?: string }

/** Core domain logic: compare each requested item with the APPROVED scope, tracking consumed allowances in order. */
export function classify(plan: Plan, ch: Change, answers: AnalysisContext['answers'] = {}): Classified[] {
  let pages = plan.usage.pages, revs = plan.usage.revisions; const out: Classified[] = [];
  ch.items.forEach((it, idx) => {
    const match = it.matchesScopeId ? plan.scope.find((s) => s.id === it.matchesScopeId) : undefined;
    const n = it.pages ?? 1; let status: Status; let reason: string;
    if (it.kind === 'revision') {
      if (revs < plan.limits.revisionRounds) { status = 'included'; revs++; reason = `uses revision round ${revs} of ${plan.limits.revisionRounds} included`; }
      else { status = 'out_of_scope'; reason = `all ${plan.limits.revisionRounds} included revision rounds already used`; }
    } else if (match && !match.included) { status = 'out_of_scope'; reason = `explicitly excluded in approved scope ("${match.title}")`; }
    else if (it.kind === 'page') {
      if (match?.included) { status = 'included'; reason = `covered by approved scope line "${match.title}"`; }
      else if (pages + n <= plan.limits.pages) { status = 'included'; pages += n; reason = `fits page allowance (${pages}/${plan.limits.pages})`; }
      else { status = 'out_of_scope'; reason = `exceeds page limit (${pages} used + ${n} requested > ${plan.limits.pages})`; }
    } else if (it.kind === 'integration') {
      if (it.integration && plan.limits.integrations.some((i) => i.toLowerCase() === it.integration!.toLowerCase())) { status = 'included'; reason = `integration "${it.integration}" is in the approved list`; }
      else { status = 'out_of_scope'; reason = `integration "${it.integration ?? it.title}" is not in the approved integration list`; }
    } else if (match?.included) { status = 'included'; reason = `covered by approved scope line "${match.title}"`; }
    else if (it.clarity === 'vague') { status = 'uncertain'; reason = 'request is too vague to match against the approved scope'; }
    else { status = 'out_of_scope'; reason = 'no matching line in the approved scope'; }
    const ov = answers[`classify_${idx}`]?.value;
    if (status === 'uncertain' && (ov === 'in' || ov === 'out')) { status = ov === 'in' ? 'included' : 'out_of_scope'; reason = `project manager decided: ${ov === 'in' ? 'covered by' : 'outside'} approved scope`; }
    out.push({ idx, title: it.title, kind: it.kind, status, reason, pages: it.kind === 'page' ? n : 0, scopeId: it.matchesScopeId, integration: it.integration });
  });
  return out;
}
function effort(plan: Plan, cl: Classified[]) {
  const byRole: Record<string, number> = {}; const lines: { title: string; hours: Record<string, number> }[] = [];
  for (const c of cl.filter((x) => x.status === 'out_of_scope')) {
    const base = plan.estimation[c.kind] ?? {}; const mult = c.kind === 'page' ? c.pages : 1; const h: Record<string, number> = {};
    for (const [role, hrs] of Object.entries(base)) { h[role] = hrs * mult; byRole[role] = (byRole[role] ?? 0) + hrs * mult; }
    lines.push({ title: c.title, hours: h });
  }
  const rate = (r: string) => plan.rateCard.find((x) => x.role === r)?.hourly ?? 0;
  const cost = Object.entries(byRole).reduce((s, [r, h]) => s + h * rate(r), 0);
  const slipDays = Math.max(0, ...plan.team.map((t) => Math.ceil((byRole[t.role] ?? 0) / t.hoursPerDay)));
  return { byRole, lines, totalHours: Object.values(byRole).reduce((a, b) => a + b, 0), cost, low: cost * 0.85, high: cost * 1.25, slipDays, missingRates: Object.keys(byRole).filter((r) => !rate(r)) };
}
const coRef = (plan: Plan) => `CO-${plan.changeOrders.length + 1}`;
const pending = (ctx: AnalysisContext) => classify(ctx.plan, ctx.change, ctx.answers).some((c) => c.status === 'uncertain');

function detect(plan: Plan, ch: Change, answers: AnalysisContext['answers'] = {}): ChangeItem[] {
  return classify(plan, ch, answers).map((c) => ({ field: `request.${c.idx}.${c.status}`, label: `Request ${c.idx + 1}: ${c.title}`, before: 'not in approved scope baseline', after: c.status.replace(/_/g, ' '), kind: 'added', severity: c.status === 'out_of_scope' ? 'high' : c.status === 'uncertain' ? 'medium' : 'low', note: c.reason } as ChangeItem));
}
function apply(plan: Plan, ch: Change, answers: AnalysisContext['answers']): Plan {
  const p: Plan = structuredClone(plan); const cl = classify(plan, ch, answers); const e = effort(plan, cl); const ref = coRef(plan);
  for (const c of cl) {
    if (c.status === 'included') { if (c.kind === 'revision') p.usage.revisions++; else if (c.kind === 'page' && !c.scopeId) p.usage.pages += c.pages; }
    if (c.status === 'out_of_scope') {
      const hrs = Object.values(e.lines.find((l) => l.title === c.title)?.hours ?? {}).reduce((a, b) => a + b, 0);
      p.scope.push({ id: `${ref}-${c.idx + 1}`, title: c.title, kind: c.kind as any, included: true, hours: hrs, changeOrder: ref } as any);
      if (c.kind === 'page') p.limits.pages += c.pages; if (c.kind === 'integration' && c.integration) p.limits.integrations.push(c.integration);
    }
  }
  if (cl.some((c) => c.status === 'out_of_scope')) p.changeOrders.push({ ref, status: 'issued_pending_client_acceptance', receivedOn: ch.receivedOn, items: cl.filter((c) => c.status === 'out_of_scope').map((c) => c.title), estimateHours: e.totalHours, estimateRange: [Math.round(e.low), Math.round(e.high)], indicativeSlipDays: e.slipDays, note: 'Estimate only; price and dates are NOT committed until the client accepts a change order.' });
  if (cl.some((c) => c.status === 'out_of_scope')) (p.project as any).proposedEndDate = addDays(p.project.endDate, e.slipDays);
  return p;
}

const person = { agent: 'rule-engine/scopeguard' };
function analyze(role: string, ctx: AnalysisContext): RoleResult {
  const plan = ctx.plan as Plan, ch = ctx.change as Change; const cl = classify(plan, ch, ctx.answers); const e = effort(plan, cl); const cur = plan.project.currency;
  const oos = cl.filter((c) => c.status === 'out_of_scope'), unc = cl.filter((c) => c.status === 'uncertain'), inc = cl.filter((c) => c.status === 'included');
  const block = unc.length > 0; const ref = coRef(plan);
  if (role === 'classifier') {
    const o = new Out(role, `${person.agent}-classifier@1`);
    for (const c of cl) (c.status === 'out_of_scope' ? o.risk : c.status === 'uncertain' ? o.warn : o.info).call(o, `Request ${c.idx + 1} "${c.title}" → ${c.status.replace(/_/g, ' ').toUpperCase()}: ${c.reason}.`, ...(c.status === 'uncertain' ? [true] : []) as []);
    for (const c of unc) o.ask({ key: `classify_${c.idx}`, text: `Is "${c.title}" covered by the approved scope? RIPPLE cannot decide this. Answer "in scope" or "out of scope".`, blocking: true, assigneeRole: 'human_pm' });
    o.draft({ kind: 'scope_comparison', name: 'Scope comparison', artifactKey: 'scope_doc', content: `# Scope comparison — ${plan.project.name}\n\nRequest received ${ch.receivedOn}: ${ch.requestText || '(no text)'}\n\n${table(['#', 'Requested item', 'Classification', 'Reason'], cl.map((c) => [c.idx + 1, c.title, c.status.replace(/_/g, ' '), c.reason]))}\n\nIncluded: ${inc.length} · Out of scope: ${oos.length} · Needs human decision: ${unc.length}` });
    return o.done(`${inc.length} included, ${oos.length} out of scope, ${unc.length} need a human decision.`);
  }
  if (role === 'estimator') {
    const o = new Out(role, `${person.agent}-estimator@1`);
    if (!oos.length) return o.info('No out-of-scope work: nothing to price.').done('No billable additional work identified.');
    for (const l of e.lines) o.info(`"${l.title}": ${Object.entries(l.hours).map(([r, h]) => `${h}h ${r}`).join(', ') || 'no estimation model for this kind'}.`);
    if (e.missingRates.length) o.risk(`No rate-card entry for role(s): ${e.missingRates.join(', ')} — cost cannot be fully estimated.`);
    o.warn(`Internal planning estimate ${money(e.low, cur)}–${money(e.high, cur)} (${round1(e.totalHours)}h). This is NOT a quote; the project manager must set the price.`, true);
    o.work({ key: 'sg-estimate-review', title: 'Validate effort estimate against delivery reality', detail: `${round1(e.totalHours)}h across ${Object.keys(e.byRole).join(', ')}.`, department: 'Delivery', roleKey: 'human_lead', kind: 'review', artifactKey: 'estimate' });
    o.work({ key: 'sg-pricing-review', title: 'Finance review of change-order pricing', detail: 'Confirm rate card, discounts and tax before any price is shared.', department: 'Finance', roleKey: 'human_finance', kind: 'review', artifactKey: 'change_order' });
    o.draft({ kind: 'estimate', name: 'Effort & cost estimate (internal)', artifactKey: 'estimate', content: `# Estimate — INTERNAL, not a quote${block ? ' (PROVISIONAL: undecided items excluded)' : ''}\n\n${table(['Item', 'Hours by role'], e.lines.map((l) => [l.title, Object.entries(l.hours).map(([r, h]) => `${h}h ${r}`).join(', ')]))}\n\nTotal ${round1(e.totalHours)}h · indicative cost range ${money(e.low, cur)}–${money(e.high, cur)} (rate card × 0.85–1.25).\n` });
    return o.done(`${round1(e.totalHours)}h estimated; range ${money(e.low, cur)}–${money(e.high, cur)} (internal).`);
  }
  if (role === 'planner') {
    const o = new Out(role, `${person.agent}-planner@1`);
    if (oos.length) {
      o.warn(`Indicative schedule pressure: about +${e.slipDays} working day(s) on the busiest role (capacity ${plan.team.map((t) => `${t.role} ${t.hoursPerDay}h/day`).join(', ')}). Not a committed date.`, true);
      const late = plan.milestones.filter((m) => daysBetween(ch.receivedOn, m.due) < e.slipDays + 5);
      for (const m of late) o.risk(`Milestone "${m.name}" (${m.due}) is within ${e.slipDays + 5} days of the request — likely affected.`);
    }
    for (const l of e.lines) for (const [r, h] of Object.entries(l.hours)) if (h > 0) {
      const t = plan.team.find((x) => x.role === r);
      o.work({ key: `sg-task-${l.title}-${r}`.replace(/\s+/g, '-').slice(0, 60), title: `${r}: ${l.title} (${h}h)`, detail: 'Proposed task — do not start until the client has accepted the change order.', department: 'Delivery', roleKey: t?.ownerRole ?? 'human_lead', kind: 'task', artifactKey: 'task_board', dependsOn: ['sg-co-accepted'] });
    }
    for (const c of inc) o.work({ key: `sg-inc-${c.idx}`, title: `Include in current plan: ${c.title}`, detail: c.reason, department: 'Delivery', roleKey: 'human_lead', kind: 'task', artifactKey: 'task_board' });
    o.draft({ kind: 'task_plan', name: 'Updated task & ownership proposal', artifactKey: 'task_board', content: `# Proposed task & ownership update${block ? ' (PROVISIONAL)' : ''}\n\n${o.workItems.map((w) => `- [${w.roleKey}] ${w.title}${w.dependsOn?.length ? ' — blocked until client accepts change order' : ''}`).join('\n') || '- no new tasks'}\n\nIndicative slip: +${e.slipDays} day(s) — planning estimate only.` });
    if (!block) o.act({ key: 'notify_team', type: 'notify_delivery_team', title: 'Send updated task & ownership proposal to delivery team', connector: 'internal_notify', ownerRole: 'human_pm', consequential: true, draftKind: 'task_plan', approvalRole: 'manager', ackRoles: ['human_lead'], rationale: 'Commits team capacity.', target: 'Delivery Lead', effectKey: 'task-plan' });
    return o.done(`${o.workItems.length} task proposals; indicative slip +${e.slipDays} day(s).`);
  }
  // coordinator
  const o = new Out(role, `${person.agent}-coordinator@1`);
  if (oos.length) {
    o.work({ key: 'sg-co-approve', title: `Approve ${ref} content before it is shared`, detail: 'Project manager reviews scope lines, estimate and wording.', department: 'Account Management', roleKey: 'human_pm', kind: 'decision', artifactKey: 'change_order' });
    o.work({ key: 'sg-co-accepted', title: `Record the client's written acceptance of ${ref}`, detail: 'Work on out-of-scope items must not start before this.', department: 'Account Management', roleKey: 'human_pm', kind: 'review', artifactKey: 'client_comms' });
    o.draft({ kind: 'change_order', name: `Change order ${ref} (draft)`, artifactKey: 'change_order', content: `# Change order ${ref} — DRAFT, pending PM approval and client acceptance\n\nProject: ${plan.project.name} · Client: ${plan.project.client}\n\n## Additional work (outside approved scope)\n${oos.map((c) => `- ${c.title} — ${c.reason}`).join('\n')}\n\n## Commercials\nPrice: TO BE CONFIRMED by the project manager. Internal planning estimate (not a quote): ${money(e.low, cur)}–${money(e.high, cur)}.\nSchedule effect: TO BE CONFIRMED (indicative +${e.slipDays} working day(s)).\n\nNothing in this draft is a commitment until approved by the project manager and accepted in writing by the client.${block ? '\n\n(PROVISIONAL — some requests still need a human decision.)' : ''}` });
  }
  const body = [`Subject: ${plan.project.name} — your recent request`, '', `Hi ${plan.project.clientContact.split(' <')[0]},`, '', 'Thanks for your request. We compared it with the agreed scope:',
    ...cl.map((c) => `- ${c.title}: ${c.status === 'included' ? 'covered by the agreed scope' : c.status === 'out_of_scope' ? 'outside the agreed scope — we will send a change order for your review' : 'we need to confirm how this fits the agreed scope'}`), '',
    oos.length ? 'A change order covering the additional work will follow separately. Pricing and timing will be confirmed in that document, and work on those items starts only after you accept it.' : 'No change to the agreed scope is needed.', '', 'Kind regards,', 'The project team'].join('\n');
  o.draft({ kind: 'client_message', name: 'Client clarification message (draft)', artifactKey: 'client_comms', content: body });
  if (!block) {
    if (oos.length) o.act({ key: 'publish_change_order', type: 'publish_change_order', title: `Publish change order ${ref} (internal, pending client acceptance)`, connector: 'document_store', ownerRole: 'human_pm', consequential: true, draftKind: 'change_order', approvalRole: 'owner', ackRoles: ['human_finance'], rationale: 'Commercial commitment: needs OWNER approval (stricter than routine manager approvals).', target: 'Document store', effectKey: 'change-order' });
    o.act({ key: 'send_client_message', type: 'send_client_message', title: 'Send scope clarification to client', connector: 'email_outbox', ownerRole: 'human_pm', consequential: true, draftKind: 'client_message', approvalRole: 'manager', ackRoles: [], rationale: 'External message about scope; must not commit price or dates.', target: plan.project.clientContact, effectKey: 'client-message' });
  }
  return o.done(`${oos.length ? `Change order ${ref} drafted. ` : ''}Client message drafted; ${o.actions.length} action(s) proposed.`);
}
void pending;

export const scopeGuardPack: WorkflowPack = {
  id: 'scopeguard', name: 'ScopeGuard', domain: 'Agency Operations', version: '1.0.0',
  description: 'Compare a client request with the approved scope, classify included / out-of-scope / uncertain work, estimate effort, and draft a change order without promising price or dates.',
  labels: { baseline: 'Approved scope', change: 'Client request', changeVerb: 'Submit client request', plan: 'proposal / scope', mission: 'Scope request', blurb: 'Included vs out-of-scope vs uncertain' },
  agentLimit: 'Estimates indicative hours; strictly forbidden from promising prices or deadlines',
  roles: [
    { key: 'classifier', name: 'Scope Analyst Agent', kind: 'agent', responsibility: 'Compares each requested item with the approved scope and allowances.', department: 'Account Management' },
    { key: 'estimator', name: 'Estimation Agent', kind: 'agent', responsibility: 'Estimates hours and an internal cost range from the rate card.', department: 'Delivery' },
    { key: 'planner', name: 'Delivery Planner Agent', kind: 'agent', responsibility: 'Schedule pressure, milestones, task and ownership proposals.', department: 'Delivery' },
    { key: 'coordinator', name: 'Account Agent', kind: 'agent', responsibility: 'Drafts the change order and client message; requests approvals.', department: 'Account Management' },
    { key: 'human_pm', name: 'Project Manager (human)', kind: 'human', responsibility: 'Decides uncertain scope, approves change order and client wording.', department: 'Account Management' },
    { key: 'human_lead', name: 'Delivery Lead (human)', kind: 'human', responsibility: 'Validates the estimate; owns task assignments.', department: 'Delivery' },
    { key: 'human_finance', name: 'Finance Controller (human)', kind: 'human', responsibility: 'Reviews pricing before any amount is shared.', department: 'Finance' },
  ],
  roleOrder: ['classifier', 'estimator', 'planner', 'coordinator'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'scope_doc', label: 'Approved scope document', department: 'Account Management', ownerRole: 'human_pm', description: 'Agreed deliverables and allowances' },
    { key: 'estimate', label: 'Effort & cost estimate', department: 'Delivery', ownerRole: 'human_lead', description: 'Hours by role, internal range' },
    { key: 'schedule', label: 'Delivery schedule', department: 'Delivery', ownerRole: 'human_lead', description: 'Milestones and capacity' },
    { key: 'task_board', label: 'Task board & ownership', department: 'Delivery', ownerRole: 'human_lead', description: 'Who does what' },
    { key: 'change_order', label: 'Change order', department: 'Finance', ownerRole: 'human_finance', description: 'Commercial record for out-of-scope work' },
    { key: 'client_comms', label: 'Client communication', department: 'Account Management', ownerRole: 'human_pm', description: 'What the client has been told' },
  ],
  rules: [
    { id: 'oos→scope', trigger: (i) => i.field.endsWith('.out_of_scope'), to: 'scope_doc', relation: 'exceeds', why: 'Request goes beyond the approved scope' },
    { id: 'oos→estimate', trigger: (i) => i.field.endsWith('.out_of_scope'), to: 'estimate', relation: 'requires', why: 'Additional work must be estimated' },
    { id: 'unc→scope', trigger: (i) => i.field.endsWith('.uncertain'), to: 'scope_doc', relation: 'questions', why: 'Needs a human scope decision' },
    { id: 'unc→comms', trigger: (i) => i.field.endsWith('.uncertain'), to: 'client_comms', relation: 'clarify', why: 'Client may need clarification' },
    { id: 'inc→tasks', trigger: (i) => i.field.endsWith('.included'), to: 'task_board', relation: 'adds_tasks', why: 'Covered work still needs tasks' },
    { id: 'any→comms', trigger: () => true, to: 'client_comms', relation: 'informs', why: 'Client is told the outcome' },
  ],
  artifactEdges: [
    { from: 'estimate', to: 'change_order', relation: 'prices', why: 'Estimate informs commercials' },
    { from: 'estimate', to: 'schedule', relation: 'drives', why: 'Hours drive schedule pressure' },
    { from: 'schedule', to: 'task_board', relation: 'drives', why: 'Tasks follow the schedule' },
    { from: 'scope_doc', to: 'change_order', relation: 'scopes', why: 'Change order lists excluded work' },
    { from: 'change_order', to: 'client_comms', relation: 'feeds', why: 'Client is told about the change order' },
  ],
  decisions: [
    { key: 'approve_co', label: 'Approve change order', ownerRole: 'human_pm', gates: ['change_order'] },
    { key: 'approve_msg', label: 'Approve client message', ownerRole: 'human_pm', gates: ['client_comms'] },
  ],
  sample: () => ({
    title: 'Northwind Redesign — booking-flow request',
    plan: { project: { name: 'Northwind website redesign', client: 'Northwind Café Group', clientContact: 'Priyanka Rao <priyanka@northwind.example>', startDate: '2026-10-05', endDate: '2026-12-18', currency: 'USD' },
      rateCard: [{ role: 'designer', hourly: 95 }, { role: 'developer', hourly: 120 }, { role: 'qa', hourly: 85 }, { role: 'pm', hourly: 110 }],
      team: [{ role: 'designer', hoursPerDay: 6, ownerRole: 'human_lead' }, { role: 'developer', hoursPerDay: 6, ownerRole: 'human_lead' }, { role: 'qa', hoursPerDay: 4, ownerRole: 'human_lead' }, { role: 'pm', hoursPerDay: 3, ownerRole: 'human_pm' }],
      estimation: { page: { designer: 6, developer: 8, qa: 2 }, feature: { designer: 24, developer: 50, qa: 12, pm: 6 }, integration: { developer: 20, qa: 6 }, service: { pm: 8 }, revision: { designer: 6 } },
      limits: { pages: 12, revisionRounds: 2, integrations: ['Google Analytics', 'Mailchimp'] }, usage: { pages: 12, revisions: 1 },
      scope: [{ id: 's1', title: 'Homepage', kind: 'page', included: true, hours: 40 }, { id: 's2', title: 'Menu & locations pages', kind: 'page', included: true, hours: 60 }, { id: 's3', title: 'Contact page', kind: 'page', included: true, hours: 12 }, { id: 's4', title: 'Online ordering', kind: 'feature', included: false, hours: 0 }, { id: 's5', title: 'CMS setup', kind: 'feature', included: true, hours: 40 }],
      milestones: [{ id: 'm1', name: 'Design sign-off', due: '2026-11-13' }, { id: 'm2', name: 'Build complete', due: '2026-12-04' }, { id: 'm3', name: 'Launch', due: '2026-12-18' }], changeOrders: [] },
    change: { receivedOn: '2026-11-09', requestText: 'Client email: please add a table-booking flow with online deposit, a Pricing page and a Team page, tweak the contact page copy, one more homepage revision, and make the whole site feel more premium.',
      items: [{ title: 'Table-booking flow with online deposit', kind: 'feature', matchesScopeId: null, clarity: 'clear' }, { title: 'Stripe payments for deposits', kind: 'integration', integration: 'Stripe', clarity: 'clear' }, { title: 'Pricing page', kind: 'page', pages: 1, clarity: 'clear' }, { title: 'Team page', kind: 'page', pages: 1, clarity: 'clear' }, { title: 'Contact page copy tweak', kind: 'page', pages: 1, matchesScopeId: 's3', clarity: 'clear' }, { title: 'Homepage hero revision', kind: 'revision', clarity: 'clear' }, { title: 'Make the whole site feel more premium', kind: 'feature', clarity: 'vague' }] },
  }),
  detectChanges: detect, applyChange: apply, analyzeRole: analyze,
  parseAnswer(key, text) {
    if (key.startsWith('classify_')) { if (/\bout\b|not (in|covered)|outside/i.test(text)) return { value: 'out' }; if (/\bin\b|inside|covered|included/i.test(text)) return { value: 'in' }; return { error: 'Answer "in scope" or "out of scope".' }; }
    return text.trim() ? { value: text.trim() } : { error: 'Answer cannot be empty.' };
  },
  verifyAction(action, observed, revised: Plan) {
    const c = observed.content; const out: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type === 'publish_change_order') {
      const co = (revised.changeOrders.at(-1) as any); const items: string[] = co?.items ?? [];
      out.push({ name: 'change order lists every out-of-scope item', passed: items.every((t) => c.includes(t)) && items.length > 0, detail: `${items.length} item(s) expected in document` });
      out.push({ name: 'marked draft/pending (no commitment)', passed: /pending/i.test(c) && /TO BE CONFIRMED/.test(c), detail: 'document states price/schedule are to be confirmed' });
    }
    if (action.type === 'send_client_message') {
      const price = /[$€£₹]\s?\d|\b\d[\d,.]*\s?(USD|EUR|GBP|INR)\b/i.exec(c); const date = /\b(by|before|on)\s+\d{4}-\d{2}-\d{2}|\d{1,2}\s+(days?|weeks?)\b/i.exec(c); const promise = /\b(guarantee|promise|will be delivered)\b/i.exec(c);
      out.push({ name: 'no price quoted to client', passed: !price, detail: price ? `contains "${price[0]}"` : 'no amount found' });
      out.push({ name: 'no deadline promised to client', passed: !date && !promise, detail: date || promise ? `contains "${(date ?? promise)![0]}"` : 'no date/promise wording found' });
    }
    return out;
  },
};
