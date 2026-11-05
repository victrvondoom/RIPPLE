import { z } from 'zod';
import type { AnalysisContext, ChangeItem, RoleResult, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:MM');
const jstatus = z.enum(['open', 'in_progress', 'blocked', 'done']);
export const planSchema = z.object({
  shift: z.object({ site: z.string().min(1), date, endTime: z.string(), outgoing: z.string().min(1), incoming: z.string().min(1), supervisor: z.string().min(1) }),
  jobs: z.array(z.object({ id: z.string(), title: z.string().min(1), customer: z.string().min(1), status: jstatus, priority: z.enum(['p1', 'p2', 'p3']), slaDeadline: dt.optional(), partsNeeded: z.array(z.object({ part: z.string(), inStock: z.boolean() })).default([]), notes: z.string().default('') }).passthrough()).min(1),
  handovers: z.array(z.any()).default([]),
});
export const changeSchema = z.object({
  receivedOn: date, handoverAt: dt, summary: z.string().max(2000).default(''),
  updates: z.array(z.object({ jobId: z.string().min(1), status: jstatus, notes: z.string().max(1000).default(''), blocker: z.enum(['part_missing', 'access', 'customer_unavailable', 'safety', 'other']).optional(), missingPart: z.string().optional(), partEta: date.optional(), callback: z.object({ customer: z.string(), by: dt, reason: z.string() }).optional() })),
});
type Plan = z.infer<typeof planSchema>; type Ch = z.infer<typeof changeSchema>;
const ms = (t: string) => Date.parse(t + ':00Z'); const hrs = (a: string, b: string) => (ms(b) - ms(a)) / 3600000;
const addH = (t: string, h: number) => new Date(ms(t) + h * 3600000).toISOString().slice(0, 16);

interface Assessed { id: string; title: string; customer: string; priority: string; status: string; resolved: boolean; unreported: boolean; score: number; level: 'critical' | 'high' | 'medium' | 'low'; reasons: string[]; blocker?: string; missingPart?: string; partEta?: string; callback?: { customer: string; by: string; reason: string }; sla?: string; due: string; notes: string }
/** Core domain logic: reconcile the open job board against what the outgoing technician actually reported. */
export function assess(plan: Plan, ch: Ch, answers: AnalysisContext['answers'] = {}): Assessed[] {
  const out: Assessed[] = [];
  for (const j of plan.jobs.filter((x) => x.status !== 'done')) {
    const u = ch.updates.find((x) => x.jobId === j.id); const ans = answers[`status_${j.id}`]?.value as string | undefined;
    const unreported = !u; const status = u?.status ?? ans ?? 'unknown'; const resolved = status === 'done';
    const reasons: string[] = []; let score = { p1: 3, p2: 2, p3: 1 }[j.priority]; reasons.push(`priority ${j.priority}`);
    if (j.slaDeadline) { const h = hrs(ch.handoverAt, j.slaDeadline); if (h < 0) { score += 3; reasons.push(`SLA already breached (${j.slaDeadline})`); } else if (h <= 24) { score += 2; reasons.push(`SLA in ${Math.round(h)}h (${j.slaDeadline})`); } }
    if (u?.blocker === 'part_missing') { score += 1; reasons.push(`missing part: ${u.missingPart ?? 'unspecified'}`); }
    if (u?.blocker === 'safety') { score += 3; reasons.push('safety blocker'); }
    if (u?.callback && hrs(ch.handoverAt, u.callback.by) <= 4) { score += 1; reasons.push(`callback promised by ${u.callback.by}`); }
    const level = score >= 6 ? 'critical' : score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
    out.push({ id: j.id, title: j.title, customer: j.customer, priority: j.priority, status, resolved, unreported: unreported && !ans, score, level, reasons, blocker: u?.blocker, missingPart: u?.missingPart, partEta: u?.partEta ?? (answers[`eta_${j.id}`]?.value as string | undefined), callback: u?.callback, sla: j.slaDeadline, due: j.slaDeadline ?? addH(ch.handoverAt, 24), notes: u?.notes ?? '' });
  }
  return out;
}
const sev = (a: Assessed) => (a.level === 'critical' || a.level === 'high' ? 'high' : a.level === 'medium' ? 'medium' : 'low') as ChangeItem['severity'];
function detect(plan: Plan, ch: Ch, ans: AnalysisContext['answers'] = {}): ChangeItem[] {
  const items: ChangeItem[] = [];
  for (const a of assess(plan, ch, ans)) {
    if (a.resolved) { items.push({ field: `job.${a.id}.resolved`, label: `${a.id} resolved`, before: 'open', after: 'done', kind: 'modified', severity: 'low' }); continue; }
    if (a.unreported) items.push({ field: `job.${a.id}.unreported`, label: `${a.id} not in handover`, before: 'open job on board', after: 'no status reported', kind: 'removed', severity: 'high', note: `${a.title} — handover omitted this open job` });
    else items.push({ field: `job.${a.id}.unresolved`, label: `${a.id} unresolved`, before: 'open', after: `${a.status} · ${a.level.toUpperCase()}`, kind: 'modified', severity: sev(a), note: a.reasons.join('; ') });
    if (a.blocker === 'part_missing') items.push({ field: `job.${a.id}.part_missing`, label: `${a.id} missing part`, before: 'part needed', after: a.missingPart ?? 'unspecified', kind: 'modified', severity: 'medium', note: a.partEta ? `ETA ${a.partEta}` : 'no ETA' });
    if (a.callback) items.push({ field: `job.${a.id}.callback`, label: `${a.id} callback promised`, before: '—', after: `${a.callback.customer} by ${a.callback.by}`, kind: 'added', severity: 'medium', note: a.callback.reason });
  }
  for (const u of ch.updates.filter((x) => !plan.jobs.some((j) => j.id === x.jobId))) items.push({ field: `job.${u.jobId}.new_job`, label: `${u.jobId} new job`, before: '—', after: u.status, kind: 'added', severity: 'medium', note: 'Job not on the shift-start board' });
  if (!items.length) items.push({ field: 'handover.received', label: 'Handover received', before: '—', after: 'all jobs closed', kind: 'added', severity: 'low' });
  return items;
}
function apply(plan: Plan, ch: Ch, answers: AnalysisContext['answers']): Plan {
  const p: Plan = structuredClone(plan); const as = assess(plan, ch, answers);
  for (const a of as) { const j = p.jobs.find((x) => x.id === a.id)!; j.status = a.resolved ? 'done' : (a.status === 'unknown' ? 'open' : a.status) as any; Object.assign(j, { ownerId: a.resolved ? undefined : p.shift.incoming, handedOverAt: ch.handoverAt, level: a.level, blocker: a.blocker, missingPart: a.missingPart, partEta: a.partEta, callback: a.callback }); }
  p.handovers.push({ at: ch.handoverAt, from: p.shift.outgoing, to: p.shift.incoming, unresolved: as.filter((a) => !a.resolved).map((a) => a.id), resolved: as.filter((a) => a.resolved).map((a) => a.id) });
  return p;
}
const A = 'rule-engine/shiftrelay';
function analyze(role: string, ctx: AnalysisContext): RoleResult {
  const plan = ctx.plan as Plan, ch = ctx.change as Ch; const as = assess(plan, ch, ctx.answers); const open = as.filter((a) => !a.resolved);
  const unrep = as.filter((a) => a.unreported); const block = unrep.length > 0; const inc = plan.shift.incoming;
  if (role === 'handover') {
    const o = new Out(role, `${A}-handover@1`);
    o.info(`Shift board had ${plan.jobs.filter((j) => j.status !== 'done').length} open job(s); handover reports ${ch.updates.length} update(s): ${as.filter((a) => a.resolved).length} resolved, ${open.length - unrep.length} still unresolved.`);
    for (const a of unrep) { o.risk(`${a.id} "${a.title}" (${a.customer}) is open on the board but was NOT mentioned in the handover.`); o.ask({ key: `status_${a.id}`, text: `Job ${a.id} (${a.title}) was not in the handover. What is its status now? (open / in progress / blocked / done)`, blocking: true, assigneeRole: 'human_outgoing' }); }
    for (const u of ch.updates.filter((x) => !plan.jobs.some((j) => j.id === x.jobId))) o.warn(`Handover mentions ${u.jobId}, which is not on the shift-start board — verify it exists.`, true);
    o.draft({ kind: 'handover_reconciliation', name: 'Board vs handover reconciliation', artifactKey: 'handover_note', content: `# Board vs handover\n\n${table(['Job', 'Title', 'Board', 'Handover', 'Result'], as.map((a) => [a.id, a.title, plan.jobs.find((j) => j.id === a.id)!.status, a.unreported ? '— not reported —' : a.status, a.resolved ? 'resolved' : a.unreported ? 'OMITTED' : 'unresolved']))}` });
    return o.done(`${open.length} unresolved, ${unrep.length} omitted from handover.`);
  }
  if (role === 'triage') {
    const o = new Out(role, `${A}-triage@1`);
    for (const a of open.sort((x, y) => y.score - x.score)) (a.level === 'critical' || a.level === 'high' ? o.risk : o.warn).call(o, `${a.id} ${a.level.toUpperCase()} (score ${a.score}): ${a.reasons.join('; ')}.`);
    for (const a of open.filter((x) => x.level === 'critical' || x.level === 'high')) o.work({ key: `sr-esc-${a.id}`, title: `Review ${a.level} escalation for ${a.id} (${a.customer})`, detail: a.reasons.join('; '), department: 'Field Operations', roleKey: 'human_supervisor', kind: 'decision', artifactKey: 'escalation', due: addH(ch.handoverAt, 2) });
    const hi = open.filter((x) => x.level === 'critical' || x.level === 'high');
    o.draft({ kind: 'risk_triage', name: 'Risk & urgency triage', artifactKey: 'escalation', content: `# Risk & urgency triage${block ? ' (PROVISIONAL)' : ''}\n\n${table(['Job', 'Level', 'Score', 'Why'], open.map((a) => [a.id, a.level.toUpperCase(), a.score, a.reasons.join('; ')]))}\n\nScoring is a transparent rule (priority + SLA proximity + blockers + promised callbacks); the supervisor decides.` });
    if (!block && hi.length) o.act({ key: 'escalate', type: 'escalate_to_supervisor', title: `Escalate ${hi.length} high-risk job(s) to the supervisor`, connector: 'internal_notify', ownerRole: 'human_supervisor', consequential: true, draftKind: 'risk_triage', approvalRole: 'manager', ackRoles: ['human_supervisor'], rationale: 'Escalation commits supervisor attention and may re-prioritise the route.', target: 'Field Supervisor', effectKey: 'escalation' });
    return o.done(`${hi.length} critical/high job(s); top: ${open[0]?.id ?? '—'}.`);
  }
  if (role === 'parts') {
    const o = new Out(role, `${A}-parts@1`);
    for (const a of open.filter((x) => x.blocker === 'part_missing')) {
      o.risk(`${a.id} is blocked by a missing part: ${a.missingPart ?? 'unspecified'}${a.partEta ? ` (ETA ${a.partEta})` : ' — no ETA known'}.`);
      o.work({ key: `sr-part-${a.id}`, title: `Decide on expedited order for ${a.missingPart ?? 'part'} (${a.id})`, detail: `Customer ${a.customer}; SLA ${a.sla ?? 'none'}.`, department: 'Parts & Logistics', roleKey: 'human_supervisor', kind: 'decision', artifactKey: 'parts_order', due: addH(ch.handoverAt, 3) });
      if (!a.partEta) o.ask({ key: `eta_${a.id}`, text: `What is the ETA (YYYY-MM-DD) for ${a.missingPart ?? 'the part'} for job ${a.id}?`, blocking: false, assigneeRole: 'human_supervisor' });
    }
    for (const a of open.filter((x) => x.callback)) o.work({ key: `sr-cb-${a.id}`, title: `Confirm callback to ${a.callback!.customer} was made (promised by ${a.callback!.by.replace('T', ' ')})`, detail: a.callback!.reason, department: 'Customer Care', roleKey: 'human_incoming', kind: 'review', artifactKey: 'callback_log', due: a.callback!.by });
    o.draft({ kind: 'parts_callbacks', name: 'Parts & callback tracker', artifactKey: 'callback_log', content: `# Parts & callbacks\n\n${table(['Job', 'Missing part', 'ETA', 'Callback promised'], open.filter((a) => a.blocker === 'part_missing' || a.callback).map((a) => [a.id, a.missingPart ?? '—', a.partEta ?? 'UNKNOWN', a.callback ? `${a.callback.customer} by ${a.callback.by.replace('T', ' ')}` : '—']))}` });
    return o.done(`${open.filter((a) => a.blocker === 'part_missing').length} missing part(s); ${open.filter((a) => a.callback).length} callback(s) promised.`);
  }
  const o = new Out(role, `${A}-coordinator@1`);
  for (const a of open) o.work({ key: `sr-own-${a.id}`, title: `Take ownership of ${a.id}: ${a.title} (${a.customer})`, detail: `Status ${a.status}; ${a.notes || 'no notes'}. Next action due by ${a.due.replace('T', ' ')}.`, department: 'Field Operations', roleKey: 'human_incoming', kind: 'task', artifactKey: 'job_board', due: a.due });
  const note = [`# Shift handover — ${plan.shift.site} — ${ch.handoverAt.replace('T', ' ')}${block ? ' (PROVISIONAL)' : ''}`, '', `From **${plan.shift.outgoing}** to **${inc}** · supervisor ${plan.shift.supervisor}`, '', `## UNRESOLVED (${open.length}) — these remain open after this handover`, table(['Job', 'Customer', 'Level', 'Status', 'Owner now', 'Next deadline', 'Blocker'], open.map((a) => [a.id, a.customer, a.level.toUpperCase(), a.status, inc, a.due.replace('T', ' '), a.blocker ? `${a.blocker}${a.missingPart ? `: ${a.missingPart}` : ''}` : '—'])), '', `## Promised callbacks`, ...(open.filter((a) => a.callback).map((a) => `- ${a.callback!.customer} by ${a.callback!.by.replace('T', ' ')} — ${a.callback!.reason} (${a.id})`) || []), ...(open.some((a) => a.callback) ? [] : ['- none']), '', `## Resolved this shift`, ...(as.filter((a) => a.resolved).map((a) => `- ${a.id} ${a.title}`)), ...(as.some((a) => a.resolved) ? [] : ['- none']), '', 'This note is not complete until the outgoing and incoming technicians acknowledge it.'].join('\n');
  o.draft({ kind: 'handover_note', name: 'Handover note & assignments', artifactKey: 'handover_note', content: note });
  o.draft({ kind: 'assignments', name: 'Incoming-shift assignments', artifactKey: 'job_board', content: `# Assignments for ${inc}\n\n${open.map((a) => `- ${a.id} — ${a.title} — next action by ${a.due.replace('T', ' ')} (${a.level.toUpperCase()})`).join('\n') || '- none'}` });
  if (!block) {
    o.act({ key: 'publish_handover', type: 'publish_handover', title: 'Publish handover note (unresolved items stay visible)', connector: 'document_store', ownerRole: 'human_supervisor', consequential: true, draftKind: 'handover_note', approvalRole: 'manager', ackRoles: ['human_outgoing'], rationale: 'Becomes the authoritative record of who owns what after the shift.', target: 'Document store', effectKey: 'handover' });
    o.act({ key: 'notify_incoming', type: 'notify_incoming_tech', title: `Assign ${open.length} open job(s) to ${inc}`, connector: 'internal_notify', ownerRole: 'human_supervisor', consequential: true, draftKind: 'assignments', approvalRole: 'manager', ackRoles: ['human_incoming'], rationale: 'Transfers ownership; the new owner must acknowledge.', target: inc, effectKey: 'assignments' });
  }
  return o.done(`${open.length} job(s) assigned to ${inc}; ${o.actions.length} action(s) proposed.`);
}

export const shiftRelayPack: WorkflowPack = {
  id: 'shiftrelay', name: 'ShiftRelay', domain: 'Field Operations', version: '1.0.0',
  description: 'Shift handover: reconcile the open job board with what was reported, catch omissions, classify urgency, assign owners and deadlines, and require acknowledgement of the transfer.',
  labels: { baseline: 'Open job board', change: 'Shift handover', changeVerb: 'Submit handover', plan: 'job board', mission: 'Shift handover', blurb: 'Nothing gets lost between shifts' },
  roles: [
    { key: 'handover', name: 'Handover Agent', kind: 'agent', responsibility: 'Reconciles the job board with the handover; finds omitted jobs.', department: 'Field Operations' },
    { key: 'triage', name: 'Risk Triage Agent', kind: 'agent', responsibility: 'Scores urgency (priority, SLA, blockers, callbacks) and proposes escalation.', department: 'Field Operations' },
    { key: 'parts', name: 'Parts & Callback Agent', kind: 'agent', responsibility: 'Tracks missing parts and promised customer callbacks.', department: 'Parts & Logistics' },
    { key: 'coordinator', name: 'Shift Coordinator Agent', kind: 'agent', responsibility: 'Drafts the handover note and assignments; requests approvals.', department: 'Field Operations' },
    { key: 'human_supervisor', name: 'Field Supervisor (human)', kind: 'human', responsibility: 'Approves handover, decides escalations and parts.', department: 'Field Operations' },
    { key: 'human_incoming', name: 'Incoming Technician (human)', kind: 'human', responsibility: 'Accepts ownership; makes callbacks.', department: 'Field Operations' },
    { key: 'human_outgoing', name: 'Outgoing Technician (human)', kind: 'human', responsibility: 'Confirms the handover is accurate.', department: 'Field Operations' },
  ],
  roleOrder: ['handover', 'triage', 'parts', 'coordinator'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'handover_note', label: 'Handover note', department: 'Field Operations', ownerRole: 'human_outgoing', description: 'What is being handed over' },
    { key: 'job_board', label: 'Job board & ownership', department: 'Field Operations', ownerRole: 'human_incoming', description: 'Who owns each open job' },
    { key: 'parts_order', label: 'Parts orders', department: 'Parts & Logistics', ownerRole: 'human_supervisor', description: 'Missing parts' },
    { key: 'callback_log', label: 'Customer callbacks', department: 'Customer Care', ownerRole: 'human_incoming', description: 'Promised callbacks' },
    { key: 'escalation', label: 'Supervisor escalation', department: 'Field Operations', ownerRole: 'human_supervisor', description: 'High-risk jobs' },
  ],
  rules: [
    { id: 'unres→note', trigger: (i) => /\.(unresolved|unreported|new_job)$/.test(i.field), to: 'handover_note', relation: 'must_appear_in', why: 'Open work must stay visible' },
    { id: 'unres→board', trigger: (i) => /\.(unresolved|unreported|new_job|resolved)$/.test(i.field), to: 'job_board', relation: 'reassigns', why: 'Ownership changes' },
    { id: 'part→order', trigger: (i) => i.field.endsWith('.part_missing'), to: 'parts_order', relation: 'blocks_on', why: 'Repair needs the part' },
    { id: 'cb→log', trigger: (i) => i.field.endsWith('.callback'), to: 'callback_log', relation: 'promises', why: 'Customer was promised a callback' },
    { id: 'hi→esc', trigger: (i) => i.severity === 'high' && /\.(unresolved|unreported)$/.test(i.field), to: 'escalation', relation: 'escalates', why: 'High urgency' },
  ],
  artifactEdges: [
    { from: 'parts_order', to: 'job_board', relation: 'unblocks', why: 'Part arrival unblocks the job' },
    { from: 'callback_log', to: 'handover_note', relation: 'feeds', why: 'Callbacks are listed in the note' },
    { from: 'escalation', to: 'handover_note', relation: 'feeds', why: 'Escalations are listed in the note' },
    { from: 'handover_note', to: 'job_board', relation: 'drives', why: 'Assignments follow the note' },
  ],
  decisions: [{ key: 'approve_handover', label: 'Approve handover', ownerRole: 'human_supervisor', gates: ['handover_note'] }, { key: 'approve_esc', label: 'Decide escalation', ownerRole: 'human_supervisor', gates: ['escalation'] }],
  sample: () => ({
    title: 'Harbor Field Services — East route handover, 4 Nov',
    plan: { shift: { site: 'Harbor Field Services — East route', date: '2026-11-04', endTime: '18:00', outgoing: 'Jo Park', incoming: 'Omar Reyes', supervisor: 'Tess Kim' },
      jobs: [{ id: 'J-101', title: 'Replace compressor contactor', customer: 'Bayview Dental', status: 'in_progress', priority: 'p2', slaDeadline: '2026-11-05T12:00', partsNeeded: [{ part: 'Contactor 30A', inStock: true }], notes: '' },
        { id: 'J-102', title: 'Boiler no-heat', customer: 'Cedar Court Apartments', status: 'open', priority: 'p1', slaDeadline: '2026-11-04T20:00', partsNeeded: [{ part: 'Igniter module HW-22', inStock: false }], notes: '' },
        { id: 'J-103', title: 'Quarterly filter service', customer: 'Marlow Bakery', status: 'open', priority: 'p3', partsNeeded: [], notes: '' },
        { id: 'J-104', title: 'Intermittent breaker trip', customer: 'Pier 3 Storage', status: 'open', priority: 'p2', partsNeeded: [], notes: '' }], handovers: [] },
    change: { receivedOn: '2026-11-04', handoverAt: '2026-11-04T17:30', summary: 'End of shift: J-102 stuck on a missing igniter module; promised the customer a callback.',
      updates: [{ jobId: 'J-101', status: 'in_progress', notes: 'Contactor fitted; needs a 1h test run tomorrow' }, { jobId: 'J-102', status: 'blocked', notes: 'No heat in 6 units', blocker: 'part_missing', missingPart: 'Igniter module HW-22', callback: { customer: 'Cedar Court Management', by: '2026-11-04T19:00', reason: 'Update on when heat will be restored' } }, { jobId: 'J-103', status: 'done', notes: 'Filters replaced' }] },
  }),
  detectChanges: detect, applyChange: apply, analyzeRole: analyze,
  parseAnswer(key, text) {
    const t = text.trim().toLowerCase();
    if (key.startsWith('status_')) { if (/done|complete|finished/.test(t)) return { value: 'done' }; if (/progress|ongoing/.test(t)) return { value: 'in_progress' }; if (/block|stuck|wait/.test(t)) return { value: 'blocked' }; if (/open|not started|todo/.test(t)) return { value: 'open' }; return { error: 'Answer open, in progress, blocked or done.' }; }
    if (key.startsWith('eta_')) return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { value: t } : { error: 'Enter a date as YYYY-MM-DD.' };
    return t ? { value: text.trim() } : { error: 'Answer cannot be empty.' };
  },
  verifyAction(action, observed, revised: Plan) {
    const c = observed.content; const last = revised.handovers.at(-1) as any; const un: string[] = last?.unresolved ?? []; const out: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type === 'publish_handover') {
      out.push({ name: 'every unresolved job is listed', passed: un.every((id) => c.includes(id)), detail: `${un.length} unresolved job(s): ${un.join(', ')}` });
      out.push({ name: 'unresolved section present (not hidden)', passed: /UNRESOLVED \(\d+\)/.test(c), detail: 'explicit unresolved heading' });
      out.push({ name: 'incoming owner named', passed: c.includes(revised.shift.incoming), detail: revised.shift.incoming });
      for (const j of revised.jobs.filter((x: any) => x.callback && un.includes(x.id))) out.push({ name: `callback to ${(j as any).callback.customer} listed`, passed: c.includes((j as any).callback.customer), detail: `by ${(j as any).callback.by}` });
    }
    if (action.type === 'notify_incoming_tech') out.push({ name: 'every unresolved job assigned', passed: un.every((id) => c.includes(id)), detail: un.join(', ') });
    return out;
  },
};
