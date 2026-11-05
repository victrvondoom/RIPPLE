import { z } from 'zod';
import type { AnalysisContext, ChangeItem, CompletionContext, RoleResult, WorkflowPack } from '../../engine/types.js';
import { Out, addDays, daysBetween, table } from '../common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ev = z.object({ kind: z.enum(['file', 'link', 'commit', 'note']), ref: z.string().min(1), verified: z.boolean().default(false), title: z.string().optional(), teamName: z.string().optional() });
export const planSchema = z.object({
  submission: z.object({ course: z.string().min(1), title: z.string().min(1), deadline: date, teamName: z.string().min(1), canonicalTitle: z.string().min(1) }),
  members: z.array(z.object({ id: z.string(), name: z.string(), roleKey: z.enum(['human_teamlead', 'human_member']) })).min(1),
  rubric: z.array(z.object({ id: z.string(), criterion: z.string().min(1), points: z.number().min(0), deliverableIds: z.array(z.string()), kind: z.enum(['deliverable', 'citations']).default('deliverable'), applicable: z.boolean().default(true) })).min(1),
  deliverables: z.array(z.object({ id: z.string(), name: z.string().min(1), type: z.enum(['report', 'presentation', 'repo', 'video', 'citations', 'form']), ownerId: z.string().nullable().optional(), status: z.enum(['not_started', 'draft', 'complete']), evidence: z.array(ev).default([]) })).min(1),
  citations: z.array(z.object({ id: z.string(), source: z.string(), usedIn: z.array(z.string()), verified: z.boolean() })).default([]),
  reports: z.array(z.any()).default([]),
});
export const changeSchema = z.object({
  receivedOn: date, note: z.string().max(1000).default(''),
  updates: z.array(z.object({ deliverableId: z.string().min(1), status: z.enum(['not_started', 'draft', 'complete']).optional(), ownerId: z.string().optional(), addEvidence: ev.optional() })).default([]),
  citations: z.array(z.object({ id: z.string(), source: z.string(), usedIn: z.array(z.string()), verified: z.boolean() })).default([]),
  notApplicable: z.array(z.string()).default([]),
});
type Plan = z.infer<typeof planSchema>; type Ch = z.infer<typeof changeSchema>;
export type ReqStatus = 'verified' | 'incomplete' | 'uncertain' | 'not_applicable';
interface Req { id: string; criterion: string; kind: string; points: number; status: ReqStatus; reason: string; evidence: string[]; deliverables: string[] }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Core domain logic: derive each rubric requirement's status ONLY from deliverable state and recorded, verified evidence. */
export function evaluate(plan: Plan, ch: Ch, answers: AnalysisContext['answers'] = {}) {
  const del = plan.deliverables.map((d) => {
    const u = ch.updates.filter((x) => x.deliverableId === d.id); const ans = answers[`owner_${d.id}`]?.value as string | undefined;
    return { ...d, status: u.map((x) => x.status).filter(Boolean).pop() ?? d.status, ownerId: u.map((x) => x.ownerId).filter(Boolean).pop() ?? d.ownerId ?? ans ?? null, evidence: [...d.evidence, ...u.flatMap((x) => (x.addEvidence ? [x.addEvidence] : []))] };
  });
  const cites = [...plan.citations.filter((c) => !ch.citations.some((x) => x.id === c.id)), ...ch.citations];
  const reqs: Req[] = plan.rubric.map((r) => {
    const base = { id: r.id, criterion: r.criterion, kind: r.kind as string, points: r.points, deliverables: r.deliverableIds };
    const claimed = ch.notApplicable.includes(r.id); const na = r.applicable === false || (claimed && answers[`na_${r.id}`]?.value === 'yes');
    if (na) return { ...base, status: 'not_applicable' as const, reason: r.applicable !== false ? 'confirmed not applicable by a human (answer on record)' : 'marked not applicable in the baseline', evidence: [] };
    if (claimed) return { ...base, status: 'uncertain' as const, reason: 'claimed not applicable but NOT yet confirmed by a human (e.g. instructor)', evidence: [] };
    const ds = r.deliverableIds.map((id) => del.find((d) => d.id === id)).filter(Boolean) as typeof del;
    if (!ds.length) return { ...base, status: 'uncertain' as const, reason: 'no deliverable is mapped to this criterion', evidence: [] };
    const notDone = ds.filter((d) => d.status !== 'complete'); if (notDone.length) return { ...base, status: 'incomplete' as const, reason: `${notDone.map((d) => `${d.name} is ${d.status.replace(/_/g, ' ')}`).join('; ')}`, evidence: [] };
    const noEv = ds.filter((d) => !d.evidence.length); if (noEv.length) return { ...base, status: 'incomplete' as const, reason: `marked complete but NO evidence recorded for ${noEv.map((d) => d.name).join(', ')}`, evidence: [] };
    const unver = ds.filter((d) => !d.evidence.some((e) => e.verified)); const evRefs = ds.flatMap((d) => d.evidence.map((e) => e.ref));
    if (r.kind === 'citations') { const used = cites; if (!used.length) return { ...base, status: 'incomplete' as const, reason: 'no citations recorded', evidence: evRefs }; const bad = used.filter((c) => !c.verified); if (bad.length) return { ...base, status: 'uncertain' as const, reason: `${bad.length} citation(s) not verified: ${bad.map((c) => c.source).join('; ')}`, evidence: evRefs }; }
    if (unver.length) return { ...base, status: 'uncertain' as const, reason: `evidence recorded but not verified for ${unver.map((d) => d.name).join(', ')}`, evidence: evRefs };
    return { ...base, status: 'verified' as const, reason: 'complete with verified evidence', evidence: ds.flatMap((d) => d.evidence.filter((e) => e.verified).map((e) => e.ref)) };
  });
  const issues: string[] = [];
  for (const d of del.filter((x) => ['report', 'presentation', 'video'].includes(x.type))) for (const e of d.evidence.slice(-1)) {   // only the LATEST evidence supersedes older versions
    if (e.title && norm(e.title) !== norm(plan.submission.canonicalTitle)) issues.push(`Title mismatch in ${d.name}: "${e.title}" vs project title "${plan.submission.canonicalTitle}"`);
    if (e.teamName && norm(e.teamName) !== norm(plan.submission.teamName)) issues.push(`Team name mismatch in ${d.name}: "${e.teamName}" vs "${plan.submission.teamName}"`);
  }
  const total = reqs.filter((r) => r.status !== 'not_applicable').reduce((s, r) => s + r.points, 0); const ver = reqs.filter((r) => r.status === 'verified').reduce((s, r) => s + r.points, 0);
  return { del, cites, reqs, issues, total, ver, daysLeft: daysBetween(ch.receivedOn, plan.submission.deadline), unowned: del.filter((d) => d.status !== 'complete' && !d.ownerId) };
}
const SEV = { verified: 'low', incomplete: 'high', uncertain: 'medium', not_applicable: 'low' } as const;
function detect(plan: Plan, ch: Ch, a: AnalysisContext['answers'] = {}): ChangeItem[] {
  const e = evaluate(plan, ch, a); const items: ChangeItem[] = [];
  for (const r of e.reqs) if (r.status !== 'verified') items.push({ field: `req.${r.id}.${r.status}`, label: `${r.id} ${r.criterion}`, before: 'not yet evidenced', after: r.status.replace(/_/g, ' '), kind: 'modified', severity: SEV[r.status], note: r.reason });
  e.issues.forEach((t, i) => items.push({ field: `consistency.${i + 1}`, label: 'Cross-deliverable inconsistency', before: 'consistent', after: 'mismatch', kind: 'modified', severity: 'medium', note: t }));
  for (const d of e.unowned) items.push({ field: `deliverable.${d.id}.unowned`, label: `${d.name} has no owner`, before: '—', after: 'unowned', kind: 'modified', severity: 'high' });
  if (e.cites.some((c) => !c.verified)) items.push({ field: 'citations.unverified', label: 'Unverified citations', before: '—', after: `${e.cites.filter((c) => !c.verified).length} unverified`, kind: 'modified', severity: 'medium' });
  if (e.daysLeft < 0) items.push({ field: 'deadline.passed', label: 'Deadline passed', before: plan.submission.deadline, after: `${-e.daysLeft} day(s) ago`, kind: 'modified', severity: 'high' });
  else if (e.daysLeft <= 5 && e.ver < e.total * 0.7) items.push({ field: 'deadline.at_risk', label: 'Deadline at risk', before: `${e.daysLeft} day(s) left`, after: `${e.ver}/${e.total} points evidenced`, kind: 'modified', severity: 'high' });
  items.push({ field: 'progress.received', label: 'Progress update', before: `${plan.reports.length ? 'previous report' : 'no report'}`, after: `${e.ver}/${e.total} points verified`, kind: 'modified', severity: 'low' });
  return items;
}
function apply(plan: Plan, ch: Ch, answers: AnalysisContext['answers']): Plan {
  const p: Plan = structuredClone(plan); const e = evaluate(plan, ch, answers);
  for (const d of p.deliverables) { const x = e.del.find((y) => y.id === d.id)!; d.status = x.status; d.ownerId = x.ownerId; d.evidence = x.evidence; }
  p.citations = e.cites; for (const r of p.rubric) if (e.reqs.find((x) => x.id === r.id)?.status === 'not_applicable') r.applicable = false;
  p.reports.push({ at: ch.receivedOn, verifiedPoints: e.ver, totalPoints: e.total, statuses: Object.fromEntries(e.reqs.map((r) => [r.id, r.status])) });
  return p;
}
const A = 'rule-engine/submitready';
function analyze(role: string, ctx: AnalysisContext): RoleResult {
  const plan = ctx.plan as Plan, ch = ctx.change as Ch; const e = evaluate(plan, ch, ctx.answers); const block = e.unowned.length > 0;
  const roleOf = (id?: string | null) => plan.members.find((m) => m.id === id)?.roleKey ?? 'human_teamlead'; const nameOf = (id?: string | null) => plan.members.find((m) => m.id === id)?.name ?? 'UNASSIGNED';
  const by = (s: ReqStatus) => e.reqs.filter((r) => r.status === s); const due = addDays(plan.submission.deadline, -1);
  if (role === 'rubric') {
    const o = new Out(role, `${A}-rubric@1`);
    o.info(`${by('verified').length} verified · ${by('incomplete').length} incomplete · ${by('uncertain').length} uncertain · ${by('not_applicable').length} not applicable — ${e.ver}/${e.total} points are evidence-backed.`);
    for (const r of by('incomplete')) o.risk(`${r.id} "${r.criterion}" (${r.points} pts) is INCOMPLETE: ${r.reason}.`);
    for (const r of by('uncertain')) o.warn(`${r.id} "${r.criterion}" (${r.points} pts) is UNCERTAIN, not verified: ${r.reason}.`, true);
    for (const r of by('uncertain').filter((x) => ch.notApplicable.includes(x.id))) o.ask({ key: `na_${r.id}`, text: `You marked "${r.criterion}" as not applicable. Has the instructor/rubric owner confirmed that? Answer "yes" or "no" (RIPPLE will not assume it).`, blocking: false, assigneeRole: 'human_teamlead' });
    for (const d of e.unowned) o.ask({ key: `owner_${d.id}`, text: `Who owns "${d.name}"? (${plan.members.map((m) => m.name.split(' ')[0]).join(', ')})`, blocking: true, assigneeRole: 'human_teamlead' });
    o.draft({ kind: 'compliance_report', name: 'Rubric compliance report', artifactKey: 'compliance_report', content: [`# Rubric compliance report — ${plan.submission.title}${block ? ' (PROVISIONAL: unowned deliverables)' : ''}`, `${plan.submission.course} · team ${plan.submission.teamName} · deadline ${plan.submission.deadline} (${e.daysLeft} day(s) from ${ch.receivedOn})`, `Evidence-backed readiness: **${e.ver}/${e.total} points**. A requirement is VERIFIED only when every mapped deliverable is complete with verified evidence.`, '', ...e.reqs.map((r) => `REQ ${r.id} | ${r.status.toUpperCase()} | ${r.points} pts | ${r.criterion} | ${r.status === 'verified' ? `evidence: ${r.evidence.join(', ')}` : `gap: ${r.reason}`}`), '', '## Cross-deliverable consistency', ...(e.issues.length ? e.issues.map((i) => `- ${i}`) : ['- no inconsistencies detected in recorded evidence metadata']), '', 'Statuses are derived from recorded evidence only. Anything not VERIFIED needs more evidence or a human decision.'].join('\n') });
    return o.done(`${e.ver}/${e.total} points verified; ${by('incomplete').length} incomplete, ${by('uncertain').length} uncertain.`);
  }
  if (role === 'evidence') {
    const o = new Out(role, `${A}-evidence@1`);
    for (const d of e.del) { const v = d.evidence.filter((x) => x.verified).length; if (d.status === 'complete' && !d.evidence.length) o.risk(`${d.name} is marked complete but has no evidence.`); else if (d.evidence.length && !v) o.warn(`${d.name}: ${d.evidence.length} evidence item(s), none verified.`, true); }
    for (const c of e.cites.filter((x) => !x.verified)) o.warn(`Citation "${c.source}" (used in ${c.usedIn.join(', ')}) is not verified.`, true);
    if (e.cites.some((c) => !c.verified)) o.work({ key: 'sr-verify-citations', title: 'Verify every citation against its source', detail: e.cites.filter((c) => !c.verified).map((c) => c.source).join('; '), department: 'Project Team', roleKey: 'human_member', kind: 'review', artifactKey: 'citation_log' });
    for (const d of e.del.filter((x) => x.status === 'complete' && x.evidence.length && !x.evidence.some((y) => y.verified))) o.work({ key: `sr-verify-${d.id}`, title: `Verify the evidence for ${d.name}`, detail: `Evidence: ${d.evidence.map((x) => x.ref).join(', ')}`, department: 'Project Team', roleKey: roleOf(d.ownerId), kind: 'review', artifactKey: 'evidence_log' });
    o.draft({ kind: 'evidence_log', name: 'Evidence log', artifactKey: 'evidence_log', content: `# Evidence log\n\n${table(['Deliverable', 'Status', 'Owner', 'Evidence (✔ verified)'], e.del.map((d) => [d.name, d.status, nameOf(d.ownerId), d.evidence.map((x) => `${x.ref}${x.verified ? ' ✔' : ''}`).join(', ') || '— none —']))}\n\nCitations: ${e.cites.map((c) => `${c.source}${c.verified ? ' ✔' : ' (unverified)'}`).join('; ') || 'none'}` });
    return o.done(`${e.del.filter((d) => d.evidence.some((x) => x.verified)).length}/${e.del.length} deliverables have verified evidence.`);
  }
  if (role === 'consistency') {
    const o = new Out(role, `${A}-consistency@1`);
    for (const i of e.issues) { o.warn(i, true); }
    if (e.issues.length) o.work({ key: 'sr-fix-consistency', title: 'Fix cross-deliverable inconsistencies (titles / team name)', detail: e.issues.join(' | '), department: 'Project Team', roleKey: 'human_teamlead', kind: 'task', artifactKey: 'compliance_report' });
    else o.info('No title or team-name inconsistencies in the recorded evidence metadata.');
    for (const r of [...by('incomplete'), ...by('uncertain')]) for (const id of r.deliverables) { const d = e.del.find((x) => x.id === id)!; o.work({ key: `sr-do-${r.id}-${id}`, title: `${r.id}: ${r.status === 'incomplete' ? 'Complete' : 'Verify'} ${d.name} — ${r.criterion}`, detail: r.reason, department: 'Project Team', roleKey: roleOf(d.ownerId), kind: 'task', artifactKey: 'deliverables', due: `${due}`, satisfiedBy: r.kind === 'citations' ? 'sr-verify-citations' : undefined } as any); }
    o.work({ key: 'sr-lead-review', title: 'Team lead reviews the final compliance report before submission', detail: 'A human must confirm nothing is claimed without evidence.', department: 'Project Team', roleKey: 'human_teamlead', kind: 'review', artifactKey: 'compliance_report', due });
    return o.done(`${e.issues.length} inconsistency(ies); ${o.workItems.length} work item(s).`);
  }
  const o = new Out(role, `${A}-coordinator@1`);
  o.draft({ kind: 'submission_checklist', name: 'Submission package checklist', artifactKey: 'submission_package', content: `# Submission package checklist — due ${plan.submission.deadline}\n\n${e.del.map((d) => `- [${d.status === 'complete' && d.evidence.some((x) => x.verified) ? 'x' : ' '}] ${d.name} (${d.type}) — owner ${nameOf(d.ownerId)} — ${d.status.replace(/_/g, ' ')}${d.evidence.some((x) => x.verified) ? ' — verified evidence' : ' — NO verified evidence'}`).join('\n')}\n- [${e.issues.length ? ' ' : 'x'}] Titles and team name consistent across deliverables\n- [${e.cites.length && e.cites.every((c) => c.verified) ? 'x' : ' '}] All citations verified\n- [${by('verified').length + by('not_applicable').length === e.reqs.length ? 'x' : ' '}] Every applicable rubric requirement verified\n\nReadiness: ${e.ver}/${e.total} points evidence-backed. RIPPLE does not submit anything.` });
  o.draft({ kind: 'team_tasks', name: 'Team assignments', artifactKey: 'deliverables', content: `# Assignments\n\n${table(['Deliverable', 'Owner', 'Status'], e.del.map((d) => [d.name, nameOf(d.ownerId), d.status]))}` });
  if (!block) {
    o.act({ key: 'publish_report', type: 'publish_compliance_report', title: 'Publish the rubric compliance report', connector: 'document_store', ownerRole: 'human_teamlead', consequential: true, draftKind: 'compliance_report', approvalRole: 'manager', ackRoles: ['human_member'], rationale: 'The team plans its remaining work from this report.', target: 'Team folder', effectKey: 'compliance-report' });
    o.act({ key: 'publish_checklist', type: 'publish_submission_checklist', title: 'Publish the submission package checklist', connector: 'document_store', ownerRole: 'human_teamlead', consequential: true, draftKind: 'submission_checklist', approvalRole: 'manager', ackRoles: [], rationale: 'Defines what "ready to submit" means.', target: 'Team folder', effectKey: 'submission-checklist' });
    o.act({ key: 'notify_team', type: 'notify_team_members', title: 'Send assignments to the team', connector: 'internal_notify', ownerRole: 'human_teamlead', consequential: true, draftKind: 'team_tasks', approvalRole: 'manager', ackRoles: [], rationale: 'Commits members to owned deliverables.', target: plan.members.map((m) => m.name).join(', '), effectKey: 'assignments' });
  }
  return o.done(`Checklist and assignments drafted; ${o.actions.length} action(s) proposed.`);
}

export const submitReadyPack: WorkflowPack = {
  id: 'submitready', name: 'SubmitReady', domain: 'Education Workflows', version: '1.0.0',
  description: 'Map a strict rubric to deliverables and recorded evidence; every requirement is verified, incomplete, uncertain or not applicable — never "satisfied" without evidence.',
  labels: { baseline: 'Rubric & deliverables', change: 'Progress update', changeVerb: 'Submit progress update', plan: 'rubric & deliverables', mission: 'Submission readiness', blurb: 'Evidence-backed rubric compliance' },
  roles: [
    { key: 'rubric', name: 'Rubric Agent', kind: 'agent', responsibility: 'Classifies every rubric requirement from recorded evidence.', department: 'Project Team' },
    { key: 'evidence', name: 'Evidence Agent', kind: 'agent', responsibility: 'Tracks evidence and citation verification.', department: 'Project Team' },
    { key: 'consistency', name: 'Consistency Agent', kind: 'agent', responsibility: 'Cross-deliverable checks and per-owner work.', department: 'Project Team' },
    { key: 'coordinator', name: 'Submission Agent', kind: 'agent', responsibility: 'Drafts the checklist and assignments; requests approvals.', department: 'Project Team' },
    { key: 'human_teamlead', name: 'Team Lead (human)', kind: 'human', responsibility: 'Approves reports; confirms not-applicable claims.', department: 'Project Team' },
    { key: 'human_member', name: 'Team Member (human)', kind: 'human', responsibility: 'Owns deliverables; verifies citations.', department: 'Project Team' },
  ],
  roleOrder: ['rubric', 'evidence', 'consistency', 'coordinator'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'compliance_report', label: 'Rubric compliance report', department: 'Project Team', ownerRole: 'human_teamlead', description: 'Requirement statuses' },
    { key: 'deliverables', label: 'Deliverables & ownership', department: 'Project Team', ownerRole: 'human_teamlead', description: 'Report, slides, repo, video, citations' },
    { key: 'evidence_log', label: 'Evidence log', department: 'Project Team', ownerRole: 'human_member', description: 'Files, links, commits' },
    { key: 'citation_log', label: 'Citation log', department: 'Project Team', ownerRole: 'human_member', description: 'Sources and verification' },
    { key: 'submission_package', label: 'Submission package', department: 'Project Team', ownerRole: 'human_teamlead', description: 'Final checklist' },
  ],
  rules: [
    { id: 'inc', trigger: (i) => /^req\.\w+\.(incomplete|uncertain)/.test(i.field), to: 'deliverables', relation: 'needs_work', why: 'Requirement not yet evidenced' },
    { id: 'rep', trigger: (i) => i.field.startsWith('req.') || i.field === 'progress.received', to: 'compliance_report', relation: 'recorded_in', why: 'Statuses appear in the report' },
    { id: 'ev', trigger: (i) => i.field.endsWith('.uncertain'), to: 'evidence_log', relation: 'needs_verification', why: 'Evidence unverified' },
    { id: 'cit', trigger: (i) => i.field === 'citations.unverified', to: 'citation_log', relation: 'needs_verification', why: 'Citations unverified' },
    { id: 'con', trigger: (i) => i.field.startsWith('consistency.'), to: 'deliverables', relation: 'conflicts', why: 'Deliverables disagree' },
    { id: 'own', trigger: (i) => i.field.endsWith('.unowned'), to: 'deliverables', relation: 'unowned', why: 'Nobody is responsible' },
    { id: 'dl', trigger: (i) => i.field.startsWith('deadline.'), to: 'submission_package', relation: 'threatens', why: 'Time pressure' },
  ],
  artifactEdges: [
    { from: 'deliverables', to: 'submission_package', relation: 'feeds', why: 'Package lists deliverables' },
    { from: 'evidence_log', to: 'compliance_report', relation: 'feeds', why: 'Evidence determines status' },
    { from: 'citation_log', to: 'compliance_report', relation: 'feeds', why: 'Citation criterion' },
    { from: 'compliance_report', to: 'submission_package', relation: 'gates', why: 'Readiness gate' },
  ],
  decisions: [{ key: 'approve_report', label: 'Approve compliance report', ownerRole: 'human_teamlead', gates: ['compliance_report'] }, { key: 'approve_pkg', label: 'Approve submission package', ownerRole: 'human_teamlead', gates: ['submission_package'] }],
  sample: () => ({
    title: 'Capstone — Team Orbit (due 20 Nov)',
    plan: { submission: { course: 'CS 4410 Capstone', title: 'Adaptive Routing', deadline: '2026-11-20', teamName: 'Team Orbit', canonicalTitle: 'Orbit: Adaptive Routing' },
      members: [{ id: 'm1', name: 'Mia Chen', roleKey: 'human_teamlead' }, { id: 'm2', name: 'Ben Ortiz', roleKey: 'human_member' }, { id: 'm3', name: 'Zara Ali', roleKey: 'human_member' }, { id: 'm4', name: 'Kofi Mensah', roleKey: 'human_member' }],
      rubric: [{ id: 'R1', criterion: 'Problem statement & motivation', points: 15, deliverableIds: ['d_report'] }, { id: 'R2', criterion: 'Technical design', points: 25, deliverableIds: ['d_report', 'd_repo'] }, { id: 'R3', criterion: 'Working implementation with tests', points: 20, deliverableIds: ['d_repo'] }, { id: 'R4', criterion: 'Demo video (≤ 5 min)', points: 15, deliverableIds: ['d_video'] }, { id: 'R5', criterion: 'Presentation clarity', points: 8, deliverableIds: ['d_slides'] }, { id: 'R6', criterion: 'Citations & references', points: 10, deliverableIds: ['d_cites'], kind: 'citations' }, { id: 'R7', criterion: 'Peer evaluation form', points: 3, deliverableIds: ['d_peer'] }, { id: 'R8', criterion: 'Accessibility statement', points: 4, deliverableIds: ['d_a11y'] }],
      deliverables: [{ id: 'd_report', name: 'Final report', type: 'report', ownerId: 'm1', status: 'draft', evidence: [] }, { id: 'd_slides', name: 'Presentation slides', type: 'presentation', ownerId: 'm2', status: 'draft', evidence: [{ kind: 'file', ref: 'slides-draft.pdf', verified: false, title: 'Orbit: Adaptive Routing v2', teamName: 'Team Orbit' }] },
        { id: 'd_repo', name: 'Code repository', type: 'repo', ownerId: 'm3', status: 'complete', evidence: [{ kind: 'commit', ref: 'github.com/team-orbit/routing@a41f9c2 (CI green)', verified: true }] }, { id: 'd_video', name: 'Demo video', type: 'video', ownerId: null, status: 'not_started', evidence: [] },
        { id: 'd_cites', name: 'Citations list', type: 'citations', ownerId: 'm4', status: 'draft', evidence: [] }, { id: 'd_peer', name: 'Peer evaluation form', type: 'form', ownerId: 'm1', status: 'not_started', evidence: [] }, { id: 'd_a11y', name: 'Accessibility statement', type: 'form', ownerId: 'm2', status: 'not_started', evidence: [] }],
      citations: [{ id: 'c1', source: 'Kleinrock (1975) Queueing Systems', usedIn: ['d_report'], verified: true }, { id: 'c2', source: 'Stanford routing study (2022)', usedIn: ['d_report', 'd_slides'], verified: false }], reports: [] },
    change: { receivedOn: '2026-11-12', note: 'Status check, 8 days before the deadline.', notApplicable: ['R8'],
      updates: [{ deliverableId: 'd_report', status: 'complete', addEvidence: { kind: 'file', ref: 'report-v3.pdf', verified: false, title: 'Orbit: Adaptive Routing', teamName: 'Team Orbit' } }, { deliverableId: 'd_cites', status: 'complete', addEvidence: { kind: 'file', ref: 'citations.bib', verified: true } }], citations: [] },
  }),
  detectChanges: detect, applyChange: apply, analyzeRole: analyze,
  parseAnswer(key, text, plan: Plan) {
    const t = text.trim().toLowerCase();
    if (key.startsWith('owner_')) { const m = plan.members.find((x) => x.name.toLowerCase().includes(t) || x.name.toLowerCase().split(' ')[0] === t.split(' ')[0] || x.id === t); return m ? { value: m.id } : { error: `Answer with one of: ${plan.members.map((x) => x.name).join(', ')}.` }; }
    if (key.startsWith('na_')) return /^(y|yes|confirmed)/.test(t) ? { value: 'yes' } : /^(n|no)/.test(t) ? { value: 'no' } : { error: 'Answer "yes" or "no".' };
    return t ? { value: text.trim() } : { error: 'Answer cannot be empty.' };
  },
  completionChecks(ctx: CompletionContext) {
    const plan = ctx.revisedPlan as Plan; const e = evaluate(plan, { receivedOn: ctx.today, note: '', updates: [], citations: [], notApplicable: [] }, ctx.answers); const bad = e.reqs.filter((r) => !['verified', 'not_applicable'].includes(r.status));
    return [
      { key: 'sr_ready', label: 'Every applicable rubric requirement is evidence-verified (or confirmed not applicable)', passed: bad.length === 0, detail: bad.length ? bad.map((r) => `${r.id} ${r.status}: ${r.reason}`).join(' | ') : `${e.ver}/${e.total} points verified.` },
      { key: 'sr_consistent', label: 'Deliverables are consistent with each other', passed: e.issues.length === 0, detail: e.issues.join(' | ') || 'No inconsistencies recorded.' },
      { key: 'sr_deadline', label: 'Evidence was recorded on or before the deadline', passed: ctx.today <= plan.submission.deadline, detail: `Update dated ${ctx.today}, deadline ${plan.submission.deadline}.` },
    ];
  },
  verifyAction(action, observed, revised: Plan, ctx) {
    const c = observed.content; const out: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type === 'publish_compliance_report') {
      const e = evaluate(ctx!.baselinePlan, ctx!.change, ctx!.answers); const lines = c.split('\n').filter((l) => l.startsWith('REQ '));
      const allEv = new Set(revised.deliverables.flatMap((d) => d.evidence.filter((x) => x.verified).map((x) => x.ref)));
      out.push({ name: 'every rubric requirement appears', passed: revised.rubric.every((r) => lines.some((l) => l.startsWith(`REQ ${r.id} `))), detail: `${lines.length}/${revised.rubric.length} requirement lines` });
      const lies = lines.filter((l) => /\| VERIFIED \|/.test(l)).filter((l) => { const refs = (l.split('evidence: ')[1] ?? '').split(', ').filter(Boolean); return !refs.length || !refs.every((r) => allEv.has(r)); });
      out.push({ name: 'no VERIFIED claim without verified evidence', passed: lies.length === 0, detail: lies.length ? `unsupported: ${lies[0].slice(0, 60)}` : 'every VERIFIED line cites recorded verified evidence' });
      out.push({ name: 'statuses match the recorded evidence', passed: lines.every((l) => { const m = /^REQ (\w+) \| (\w+) \|/.exec(l); return !m || e.reqs.find((r) => r.id === m[1])?.status.toUpperCase() === m[2]; }), detail: 'recomputed independently from the plan' });
    }
    if (action.type === 'publish_submission_checklist') out.push({ name: 'does not claim readiness it cannot show', passed: !(/\[x\] Every applicable rubric requirement verified/.test(c) && evaluate(ctx!.baselinePlan, ctx!.change, ctx!.answers).reqs.some((r) => !['verified', 'not_applicable'].includes(r.status))), detail: 'checkbox state consistent with computed statuses' });
    return out;
  },
};
