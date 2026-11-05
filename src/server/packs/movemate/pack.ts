import { z } from 'zod';
import type { AnalysisContext, ChangeItem, CompletionContext, RoleResult, WorkflowPack } from '../../engine/types.js';
import { Out, addDays, daysBetween, table } from '../common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const evidence = z.object({ kind: z.enum(['photo', 'receipt', 'reading', 'email', 'document']), ref: z.string().min(1) });
export const planSchema = z.object({
  move: z.object({ address: z.string().min(1), leaseEndDate: date, moveOutDate: date, depositAmount: z.number().min(0), currency: z.string(), landlordContact: z.string().min(1), inspectionDate: date.nullable().optional() }),
  roommates: z.array(z.object({ id: z.string(), name: z.string(), roleKey: z.enum(['human_roommate_a', 'human_roommate_b']) })).min(1),
  clauses: z.array(z.object({ id: z.string(), topic: z.string(), text: z.string(), interpretation: z.enum(['clear', 'uncertain']) })).default([]),
  obligations: z.array(z.object({ id: z.string(), title: z.string().min(1), category: z.enum(['utilities', 'bills', 'meter', 'cleaning', 'inspection', 'keys', 'deposit', 'mail']), ownerId: z.string().nullable().optional(), dueBeforeEnd: z.number().int().min(0), minLead: z.number().int().min(0), status: z.enum(['todo', 'done']), evidenceRequired: z.boolean(), evidence: z.array(evidence).default([]), dependsOn: z.array(z.string()).default([]), clauseId: z.string().optional() })).min(1),
});
export const changeSchema = z.object({
  receivedOn: date, note: z.string().max(1000).default(''), leaseEndDate: date.optional(), inspectionDate: date.optional(),
  updates: z.array(z.object({ obligationId: z.string().min(1), status: z.enum(['todo', 'done']).optional(), ownerId: z.string().optional(), addEvidence: evidence.optional() })).default([]),
});
type Plan = z.infer<typeof planSchema>; type Ch = z.infer<typeof changeSchema>;
interface Ob { id: string; title: string; category: string; owner: string | null; ownerRole: string | null; status: string; deadline: string; latestStart: string; effective: string; flags: string[]; evidenceRequired: boolean; evidenceCount: number; dependsOn: string[]; blockedBy: string[]; clauseId?: string; minLead: number }

/** Core domain logic: deadlines, dependency-propagated deadlines, notice lead times, ownership and evidence for every obligation. */
export function assessMove(plan: Plan, ch: Ch, answers: AnalysisContext['answers'] = {}) {
  const leaseEnd = ch.leaseEndDate ?? plan.move.leaseEndDate; const insp = ch.inspectionDate ?? plan.move.inspectionDate ?? null; const today = ch.receivedOn;
  const rm = (id?: string | null) => plan.roommates.find((r) => r.id === id);
  const obs = plan.obligations.map((o) => {
    const u = ch.updates.filter((x) => x.obligationId === o.id); const ans = answers[`owner_${o.id}`]?.value as string | undefined;
    const ownerId = u.map((x) => x.ownerId).filter(Boolean).pop() ?? o.ownerId ?? ans ?? null;
    const status = u.map((x) => x.status).filter(Boolean).pop() ?? o.status; const ev = [...o.evidence, ...u.flatMap((x) => (x.addEvidence ? [x.addEvidence] : []))];
    const deadline = o.category === 'inspection' && insp ? insp : addDays(leaseEnd, -o.dueBeforeEnd);
    return { o, status, ownerId, ev, deadline };
  });
  const byId = new Map(obs.map((x) => [x.o.id, x])); const eff = new Map<string, string>(obs.map((x) => [x.o.id, x.deadline]));
  for (let i = 0; i < obs.length; i++) for (const d of obs) if (d.status !== 'done') for (const p of d.o.dependsOn) { const need = addDays(eff.get(d.o.id)!, -d.o.minLead); if (need < (eff.get(p) ?? '9999')) eff.set(p, need); }
  const out: Ob[] = obs.map(({ o, status, ownerId, ev, deadline }) => {
    const effective = eff.get(o.id)!; const latestStart = addDays(effective, -o.minLead); const flags: string[] = [];
    if (status !== 'done') {
      if (effective < today) flags.push('overdue'); else if (latestStart < today) flags.push('at_risk');
      if (!ownerId) flags.push('unowned');
    } else if (o.evidenceRequired && !ev.length) flags.push('missing_evidence');
    const blockedBy = o.dependsOn.filter((p) => byId.get(p)?.status !== 'done');
    return { id: o.id, title: o.title, category: o.category, owner: rm(ownerId)?.name ?? null, ownerRole: rm(ownerId)?.roleKey ?? null, status, deadline, latestStart, effective, flags, evidenceRequired: o.evidenceRequired, evidenceCount: ev.length, dependsOn: o.dependsOn, blockedBy: status === 'done' ? [] : blockedBy, clauseId: o.clauseId, minLead: o.minLead };
  });
  const open = out.filter((x) => x.status !== 'done');
  const load = plan.roommates.map((r) => ({ name: r.name, n: open.filter((x) => x.owner === r.name).length }));
  const flagged = plan.clauses.filter((c) => c.interpretation === 'uncertain' && open.some((x) => x.clauseId === c.id || c.topic === x.category));
  return { out, open, load, leaseEnd, insp, today, daysLeft: daysBetween(today, leaseEnd), flaggedClauses: flagged };
}
function detect(plan: Plan, ch: Ch, ans: AnalysisContext['answers'] = {}): ChangeItem[] {
  const a = assessMove(plan, ch, ans); const items: ChangeItem[] = [];
  if (a.leaseEnd !== plan.move.leaseEndDate) items.push({ field: 'move.lease_end_changed', label: 'Lease end date', before: plan.move.leaseEndDate, after: a.leaseEnd, kind: 'modified', severity: 'high', note: 'Every obligation deadline is derived from the lease end' });
  if (a.insp && a.insp !== (plan.move.inspectionDate ?? null)) items.push({ field: 'move.inspection_set', label: 'Inspection date', before: plan.move.inspectionDate ?? 'not scheduled', after: a.insp, kind: 'modified', severity: 'medium' });
  for (const o of a.out) for (const f of o.flags) items.push({ field: `ob.${o.category}.${o.id}.${f}`, label: `${o.title}: ${f.replace(/_/g, ' ')}`, before: 'planned', after: f.replace(/_/g, ' '), kind: 'modified', severity: f === 'missing_evidence' ? 'medium' : 'high', note: f === 'at_risk' ? `notice/lead time ${o.minLead}d: latest start ${o.latestStart} is before ${a.today}` : f === 'overdue' ? `needed by ${o.effective}` : undefined });
  for (const c of a.flaggedClauses) items.push({ field: `clause.${c.id}.uncertain`, label: `Lease clause ${c.id} (${c.topic}) — interpretation uncertain`, before: 'clause on file', after: 'needs human confirmation', kind: 'modified', severity: 'medium', note: 'Not a legal conclusion' });
  if (a.load.length > 1 && a.open.length >= 4) { const mx = a.load.reduce((m, x) => (x.n > m.n ? x : m)); if (mx.n / a.open.length > 0.65) items.push({ field: 'checkin.imbalance', label: 'Task load imbalance', before: 'shared', after: `${mx.name} owns ${mx.n}/${a.open.length}`, kind: 'modified', severity: 'low' }); }
  items.push({ field: 'checkin.received', label: 'Move-out check-in', before: `${plan.obligations.filter((o) => o.status === 'done').length} done`, after: `${a.out.filter((o) => o.status === 'done').length} done, ${a.open.length} open, ${a.daysLeft} days left`, kind: 'modified', severity: 'low' });
  return items;
}
function apply(plan: Plan, ch: Ch, answers: AnalysisContext['answers']): Plan {
  const p: Plan = structuredClone(plan); if (ch.leaseEndDate) p.move.leaseEndDate = ch.leaseEndDate; if (ch.inspectionDate) p.move.inspectionDate = ch.inspectionDate;
  const a = assessMove(plan, ch, answers);
  for (const o of p.obligations) { const x = a.out.find((y) => y.id === o.id)!; o.status = x.status as any; o.ownerId = plan.roommates.find((r) => r.name === x.owner)?.id ?? o.ownerId ?? null; o.evidence = [...o.evidence, ...ch.updates.filter((u) => u.obligationId === o.id && u.addEvidence).map((u) => u.addEvidence!)]; }
  return p;
}
const A = 'rule-engine/movemate';
const NL = 'These are planning flags and plain-language questions, not legal advice. Confirm interpretations with the landlord in writing or a qualified advisor.';
function analyze(role: string, ctx: AnalysisContext): RoleResult {
  const plan = ctx.plan as Plan, ch = ctx.change as Ch; const a = assessMove(plan, ch, ctx.answers); const unowned = a.open.filter((x) => !x.owner); const block = unowned.length > 0;
  if (role === 'checklist') {
    const o = new Out(role, `${A}-checklist@1`);
    o.info(`${a.daysLeft} day(s) until lease end (${a.leaseEnd}); ${a.open.length} of ${a.out.length} obligations still open.`);
    for (const x of a.open) { if (x.flags.includes('overdue')) o.risk(`"${x.title}" is OVERDUE (needed by ${x.effective}).`); else if (x.flags.includes('at_risk')) o.risk(`"${x.title}" is AT RISK: it needs ${x.minLead} day(s) notice/lead time, so the latest start was ${x.latestStart} (check-in ${a.today}).`); if (x.blockedBy.length) o.warn(`"${x.title}" cannot finish until: ${x.blockedBy.map((b) => a.out.find((y) => y.id === b)?.title).join('; ')}.`); }
    for (const x of unowned) { o.risk(`"${x.title}" has no owner.`); o.ask({ key: `owner_${x.id}`, text: `Who owns "${x.title}"? (${plan.roommates.map((r) => r.name.split(' ')[0]).join(' or ')})`, blocking: true, assigneeRole: 'human_roommate_a' }); }
    if (a.load.length > 1) o.info(`Open task load: ${a.load.map((l) => `${l.name} ${l.n}`).join(', ')}.`);
    for (const x of a.open) {
      o.work({ key: `mm-${x.id}`, title: `${x.title} — by ${x.effective}`, detail: `${x.owner ?? 'UNASSIGNED'}${x.flags.length ? ` · ${x.flags.join(', ').replace(/_/g, ' ')}` : ''}${x.evidenceRequired ? ' · evidence required' : ''}${x.minLead ? ` · needs ${x.minLead}d lead time` : ''}`, department: x.category[0].toUpperCase() + x.category.slice(1), roleKey: x.ownerRole ?? 'human_roommate_a', kind: 'task', artifactKey: x.category === 'utilities' || x.category === 'bills' ? 'utilities' : ['cleaning', 'inspection'].includes(x.category) ? 'cleaning_inspection' : 'evidence_file', due: x.effective, dependsOn: x.blockedBy.map((b) => `mm-${b}`) });
    }
    if (a.open.some((x) => x.id === 'ob_meter')) { // one real-world action produces evidence used by two other requirements
      o.work({ key: 'mm-util-readings', title: 'Give final meter readings to the utility providers', detail: 'Satisfied by the meter-reading evidence (explicit link).', department: 'Utilities', roleKey: 'human_roommate_b', kind: 'task', artifactKey: 'utilities', satisfiedBy: 'mm-ob_meter' });
      o.work({ key: 'mm-deposit-meter', title: 'Add meter-reading photos to the deposit evidence file', detail: 'Satisfied by the same evidence (explicit link).', department: 'Deposit', roleKey: 'human_roommate_a', kind: 'task', artifactKey: 'evidence_file', satisfiedBy: 'mm-ob_meter' });
    }
    return o.done(`${a.open.length} open; ${a.out.filter((x) => x.flags.includes('overdue') || x.flags.includes('at_risk')).length} overdue/at risk; ${unowned.length} unowned.`);
  }
  if (role === 'evidence') {
    const o = new Out(role, `${A}-evidence@1`);
    for (const x of a.out.filter((y) => y.evidenceRequired)) { if (x.evidenceCount) o.info(`"${x.title}": ${x.evidenceCount} evidence item(s) on file.`); else (x.status === 'done' ? o.risk : o.warn).call(o, `"${x.title}": ${x.status === 'done' ? 'marked done but NO evidence recorded' : 'evidence not yet collected'} — needed for the deposit file.`); }
    o.work({ key: 'mm-deposit-review', title: 'Review the assembled deposit evidence file before sending it to the landlord', detail: 'Check photos are dated, receipts are legible, readings match bills.', department: 'Deposit', roleKey: 'human_roommate_a', kind: 'review', artifactKey: 'evidence_file', dependsOn: a.open.filter((x) => x.evidenceRequired).map((x) => `mm-${x.id}`) });
    o.draft({ kind: 'evidence_status', name: 'Deposit evidence status', artifactKey: 'evidence_file', content: `# Deposit evidence status — ${plan.move.address}\n\nDeposit at stake: ${plan.move.currency} ${plan.move.depositAmount.toLocaleString('en-US')}\n\n${table(['Obligation', 'Status', 'Evidence required', 'Evidence items'], a.out.filter((x) => x.evidenceRequired).map((x) => [x.title, x.status, 'yes', x.evidenceCount]))}` });
    return o.done(`${a.out.filter((x) => x.evidenceRequired && !x.evidenceCount).length} evidence gap(s).`);
  }
  if (role === 'lease') {
    const o = new Out(role, `${A}-lease@1`);
    for (const c of a.flaggedClauses) { o.warn(`Clause ${c.id} (${c.topic}): "${c.text}" — interpretation UNCERTAIN. ${NL}`, true); o.ask({ key: `clause_${c.id}`, text: `Clause ${c.id} says: "${c.text}". Please confirm with the landlord what it requires in practice and record their answer. (RIPPLE cannot interpret the lease.)`, blocking: false, assigneeRole: 'human_roommate_a' }); }
    if (!a.flaggedClauses.length) o.info('No uncertain lease clauses touch the open obligations.');
    return o.done(`${a.flaggedClauses.length} uncertain clause(s) flagged for human confirmation.`);
  }
  const o = new Out(role, `${A}-coordinator@1`);
  const rows = [...a.out].sort((x, y) => x.effective.localeCompare(y.effective)).map((x) => [x.title, x.owner ?? 'UNASSIGNED', x.status === 'done' ? 'done' : x.effective, x.status, x.flags.join(', ').replace(/_/g, ' ') || '—', x.blockedBy.length ? 'after: ' + x.blockedBy.join(', ') : '—']);
  o.draft({ kind: 'move_checklist', name: 'Final move-out checklist', artifactKey: 'checklist', content: `# Final move-out checklist — ${plan.move.address}${block ? ' (PROVISIONAL: unowned items)' : ''}\n\nLease ends ${a.leaseEnd} (${a.daysLeft} days from ${a.today}) · move-out ${plan.move.moveOutDate} · inspection ${a.insp ?? 'not scheduled'}\n\n${table(['Obligation', 'Owner', 'Deadline', 'Status', 'Flags', 'Depends on'], rows)}\n\n## Lease points needing human confirmation\n${a.flaggedClauses.map((c) => `- ${c.id} (${c.topic}): ${c.text}`).join('\n') || '- none'}\n\n> ${NL}` });
  o.draft({ kind: 'roommate_tasks', name: 'Task assignments', artifactKey: 'checklist', content: `# Task assignments\n\n${a.open.map((x) => `- ${x.owner ?? 'UNASSIGNED'}: ${x.title} — by ${x.effective}`).join('\n') || '- all obligations complete'}` });
  o.draft({ kind: 'landlord_email', name: 'Landlord message (draft)', artifactKey: 'landlord_comms', content: `Subject: Move-out at ${plan.move.address} — dates and inspection\n\nHello,\n\nWe are planning to move out on ${plan.move.moveOutDate}, with the lease ending ${a.leaseEnd}.${a.insp ? ` Please confirm the inspection on ${a.insp}.` : ' Could we arrange a move-out inspection?'} We will return the keys at that time and would appreciate a written receipt.\n\nWe plan to provide dated photos and meter readings. If there is anything in the lease about cleaning standards or the deposit process that you expect us to follow, could you point us to it?\n\nThanks,\n${plan.roommates.map((r) => r.name).join(' & ')}` });
  o.work({ key: 'mm-confirm', title: 'Both roommates confirm the final checklist before it is shared', detail: 'Consequential: it commits each of you to deadlines.', department: 'Personal', roleKey: 'human_roommate_a', kind: 'decision', artifactKey: 'checklist' });
  if (!block) {
    o.act({ key: 'publish_checklist', type: 'publish_move_checklist', title: 'Publish the final move-out checklist', connector: 'document_store', ownerRole: 'human_roommate_a', consequential: true, draftKind: 'move_checklist', approvalRole: 'manager', ackRoles: ['human_roommate_a', 'human_roommate_b'], rationale: 'Commits both roommates to owners and deadlines.', target: 'Shared folder', effectKey: 'checklist' });
    o.act({ key: 'notify_roommates', type: 'notify_roommates', title: 'Send task assignments to both roommates', connector: 'internal_notify', ownerRole: 'human_roommate_a', consequential: true, draftKind: 'roommate_tasks', approvalRole: 'manager', ackRoles: [], rationale: 'Assigns shared work.', target: plan.roommates.map((r) => r.name).join(', '), effectKey: 'assignments' });
    o.act({ key: 'email_landlord', type: 'email_landlord', title: 'Email the landlord about move-out and inspection', connector: 'email_outbox', ownerRole: 'human_roommate_a', consequential: true, draftKind: 'landlord_email', approvalRole: 'manager', ackRoles: [], rationale: 'External message to the landlord that can affect the deposit.', target: plan.move.landlordContact, effectKey: 'landlord' });
  }
  return o.done(`Checklist, assignments and landlord email drafted; ${o.actions.length} action(s) proposed.`);
}
const LEGAL = /\b(legally (required|obliged|entitled)|by law|you are obliged|we are entitled|breach of (the )?lease|the lease (requires|states|obliges) us)\b/i;

export const moveMatePack: WorkflowPack = {
  id: 'movemate', name: 'MoveMate', domain: 'Personal Administration', version: '1.0.0',
  description: 'Move-out planning for shared housing: deadlines with notice lead times, dependency-propagated due dates, shared ownership, evidence for the deposit, and uncertain lease points flagged for humans — never legal conclusions.',
  labels: { baseline: 'Lease & move-out plan', change: 'Check-in update', changeVerb: 'Submit check-in', plan: 'move-out plan', mission: 'Move-out', blurb: 'Deadlines, bills, inspection, deposit evidence' },
  roles: [
    { key: 'checklist', name: 'Obligations Agent', kind: 'agent', responsibility: 'Deadlines, notice lead times, dependencies, ownership and workload.', department: 'Personal' },
    { key: 'evidence', name: 'Evidence Agent', kind: 'agent', responsibility: 'Deposit evidence: photos, readings, receipts.', department: 'Deposit' },
    { key: 'lease', name: 'Lease Clause Agent', kind: 'agent', responsibility: 'Flags uncertain clauses for human confirmation; gives no legal conclusions.', department: 'Personal' },
    { key: 'coordinator', name: 'Move Coordinator Agent', kind: 'agent', responsibility: 'Drafts checklist, assignments and landlord message; requests approvals.', department: 'Personal' },
    { key: 'human_roommate_a', name: 'Roommate A (human)', kind: 'human', responsibility: 'Confirms plan, owns cleaning/inspection/deposit tasks.', department: 'Personal' },
    { key: 'human_roommate_b', name: 'Roommate B (human)', kind: 'human', responsibility: 'Confirms plan, owns utilities/bills tasks.', department: 'Personal' },
  ],
  roleOrder: ['checklist', 'evidence', 'lease', 'coordinator'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'checklist', label: 'Final move-out checklist', department: 'Personal', ownerRole: 'human_roommate_a', description: 'Owners and deadlines' },
    { key: 'utilities', label: 'Utilities & bills', department: 'Utilities', ownerRole: 'human_roommate_b', description: 'Closing, transfers, final bills' },
    { key: 'cleaning_inspection', label: 'Cleaning & inspection plan', department: 'Cleaning', ownerRole: 'human_roommate_a', description: 'Clean then inspect' },
    { key: 'evidence_file', label: 'Deposit evidence file', department: 'Deposit', ownerRole: 'human_roommate_a', description: 'Photos, readings, receipts' },
    { key: 'lease_review', label: 'Lease questions', department: 'Personal', ownerRole: 'human_roommate_a', description: 'Uncertain clauses to confirm' },
    { key: 'landlord_comms', label: 'Landlord communication', department: 'Personal', ownerRole: 'human_roommate_a', description: 'What the landlord has been told' },
  ],
  rules: [
    { id: 'util', trigger: (i) => /^ob\.(utilities|bills)\./.test(i.field), to: 'utilities', relation: 'deadline_risk', why: 'Provider notice periods' },
    { id: 'clean', trigger: (i) => /^ob\.(cleaning|inspection)\./.test(i.field), to: 'cleaning_inspection', relation: 'deadline_risk', why: 'Clean before inspection' },
    { id: 'evid', trigger: (i) => /^ob\.(meter|deposit|keys)\./.test(i.field) || i.field.endsWith('.missing_evidence'), to: 'evidence_file', relation: 'needs_evidence', why: 'Deposit disputes are won with evidence' },
    { id: 'clause', trigger: (i) => i.field.startsWith('clause.'), to: 'lease_review', relation: 'questions', why: 'Uncertain interpretation' },
    { id: 'date', trigger: (i) => i.field === 'move.lease_end_changed', to: 'checklist', relation: 'reschedules', why: 'All deadlines derive from lease end' },
    { id: 'insp', trigger: (i) => i.field === 'move.inspection_set', to: 'cleaning_inspection', relation: 'fixes_date', why: 'Cleaning must finish before it' },
    { id: 'any', trigger: (i) => i.field === 'checkin.received' || i.field === 'checkin.imbalance', to: 'checklist', relation: 'updates', why: 'Progress changes the checklist' },
  ],
  artifactEdges: [
    { from: 'utilities', to: 'evidence_file', relation: 'feeds', why: 'Final readings/receipts are deposit evidence' },
    { from: 'cleaning_inspection', to: 'evidence_file', relation: 'feeds', why: 'Cleaning photos/receipts' },
    { from: 'lease_review', to: 'checklist', relation: 'feeds', why: 'Confirmed answers change tasks' },
    { from: 'evidence_file', to: 'checklist', relation: 'feeds', why: 'Checklist shows evidence status' },
    { from: 'checklist', to: 'landlord_comms', relation: 'drives', why: 'Landlord is told dates' },
  ],
  decisions: [{ key: 'confirm_checklist', label: 'Confirm checklist', ownerRole: 'human_roommate_a', gates: ['checklist'] }, { key: 'confirm_landlord', label: 'Confirm landlord message', ownerRole: 'human_roommate_a', gates: ['landlord_comms'] }],
  sample: () => ({
    title: 'Elm Street Apt 3B — move-out (lease ends 14 Nov)',
    plan: { move: { address: '14 Elm Street, Apt 3B', leaseEndDate: '2026-11-14', moveOutDate: '2026-11-13', depositAmount: 2400, currency: 'USD', landlordContact: 'pm@elmstreet.example', inspectionDate: null },
      roommates: [{ id: 'a', name: 'Nina Patel', roleKey: 'human_roommate_a' }, { id: 'b', name: 'Leo Brandt', roleKey: 'human_roommate_b' }],
      clauses: [{ id: 'c_clean', topic: 'cleaning', text: 'Tenant shall return the unit professionally cleaned.', interpretation: 'uncertain' }, { id: 'c_notice', topic: 'notice', text: 'Tenant gives 30 days written notice.', interpretation: 'clear' }, { id: 'c_wear', topic: 'deposit', text: 'Normal wear and tear is excepted from deductions.', interpretation: 'uncertain' }],
      obligations: [
        { id: 'ob_internet', title: 'Cancel internet (provider needs 10 days notice)', category: 'utilities', ownerId: 'b', dueBeforeEnd: 3, minLead: 10, status: 'todo', evidenceRequired: true, evidence: [], dependsOn: [] },
        { id: 'ob_meter', title: 'Record final meter readings with dated photos', category: 'meter', ownerId: 'a', dueBeforeEnd: 1, minLead: 0, status: 'todo', evidenceRequired: true, evidence: [], dependsOn: [] },
        { id: 'ob_bills', title: 'Pay final utility bills', category: 'bills', ownerId: 'b', dueBeforeEnd: 0, minLead: 0, status: 'todo', evidenceRequired: true, evidence: [], dependsOn: ['ob_meter'] },
        { id: 'ob_clean', title: 'Deep clean kitchen, bathroom and floors', category: 'cleaning', ownerId: 'a', dueBeforeEnd: 2, minLead: 3, status: 'todo', evidenceRequired: true, evidence: [], dependsOn: [], clauseId: 'c_clean' },
        { id: 'ob_inspection', title: 'Landlord move-out inspection', category: 'inspection', ownerId: 'a', dueBeforeEnd: 1, minLead: 7, status: 'todo', evidenceRequired: false, evidence: [], dependsOn: ['ob_clean'] },
        { id: 'ob_keys', title: 'Return keys and get a written receipt', category: 'keys', ownerId: null, dueBeforeEnd: 0, minLead: 0, status: 'todo', evidenceRequired: true, evidence: [], dependsOn: ['ob_inspection'] },
        { id: 'ob_deposit', title: 'Assemble deposit evidence file', category: 'deposit', ownerId: 'a', dueBeforeEnd: 0, minLead: 0, status: 'todo', evidenceRequired: false, evidence: [], dependsOn: ['ob_meter', 'ob_clean'], clauseId: 'c_wear' },
        { id: 'ob_mail', title: 'Forward mail / change address', category: 'mail', ownerId: 'b', dueBeforeEnd: 5, minLead: 0, status: 'todo', evidenceRequired: false, evidence: [], dependsOn: [] }] },
    change: { receivedOn: '2026-11-02', note: 'Check-in 12 days before lease end. Landlord offered an inspection slot.', inspectionDate: '2026-11-12', updates: [{ obligationId: 'ob_mail', status: 'done' }] },
  }),
  detectChanges: detect, applyChange: apply, analyzeRole: analyze,
  parseAnswer(key, text, plan: Plan) {
    if (key.startsWith('owner_')) { const t = text.trim().toLowerCase(); const r = plan.roommates.find((x) => x.name.toLowerCase().includes(t) || t === x.id || x.name.toLowerCase().split(' ')[0] === t.split(' ')[0]); return r ? { value: r.id } : { error: `Answer with one of: ${plan.roommates.map((x) => x.name).join(', ')}.` }; }
    return text.trim() ? { value: text.trim() } : { error: 'Answer cannot be empty.' };
  },
  completionChecks(ctx: CompletionContext) {
    const plan = ctx.revisedPlan as Plan; const a = assessMove(plan, { receivedOn: ctx.today, updates: [], note: '' }, ctx.answers);
    const open = a.open; const noEv = a.out.filter((x) => x.status === 'done' && x.evidenceRequired && !x.evidenceCount);
    return [
      { key: 'mm_all_done', label: 'Every move-out obligation is complete', passed: open.length === 0, detail: open.length ? `${open.length} open: ${open.map((x) => x.title).join('; ')}` : 'All obligations done.' },
      { key: 'mm_evidence', label: 'Every obligation that needs evidence has it recorded', passed: noEv.length === 0 && a.out.filter((x) => x.evidenceRequired).every((x) => x.evidenceCount > 0), detail: a.out.filter((x) => x.evidenceRequired && !x.evidenceCount).map((x) => x.title).join('; ') || 'Evidence on file for all required items.' },
    ];
  },
  verifyAction(action, observed, revised: Plan) {
    const c = observed.content; const out: { name: string; passed: boolean; detail: string }[] = [];
    const legal = LEGAL.exec(c); out.push({ name: 'no legal conclusions', passed: !legal, detail: legal ? `contains "${legal[0]}"` : 'no legal-conclusion wording found' });
    if (action.type === 'publish_move_checklist') {
      const open = revised.obligations.filter((o) => o.status !== 'done');
      out.push({ name: 'every obligation listed', passed: revised.obligations.every((o) => c.includes(o.title)), detail: `${revised.obligations.length} obligations` });
      out.push({ name: 'not-legal-advice disclaimer present', passed: /not legal advice/i.test(c), detail: 'disclaimer required by the pack' });
      out.push({ name: 'uncertain clauses flagged for humans', passed: revised.clauses.filter((k) => k.interpretation === 'uncertain' && open.length).every((k) => c.includes(k.id)), detail: 'uncertain clause ids present' });
    }
    if (action.type === 'email_landlord') out.push({ name: 'move-out date stated', passed: c.includes(revised.move.moveOutDate), detail: revised.move.moveOutDate });
    return out;
  },
};
