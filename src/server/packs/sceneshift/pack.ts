import { z } from 'zod';
import type { ActionSpec, AnalysisContext, ChangeItem, Finding, RoleResult, WorkItemSpec, WorkflowPack, QuestionSpec } from '../../engine/types.js';

const scene = z.object({ n: z.number().int().positive(), slug: z.string(), location: z.string(), status: z.enum(['shot', 'unshot', 'cut', 'reshoot_pending']), takes: z.number().int().min(0), characters: z.array(z.string()), props: z.array(z.string()), wardrobe: z.array(z.string()), continuity: z.string() });
export const planSchema = z.object({ production: z.object({ title: z.string(), scriptVersion: z.string(), remainingShootDays: z.number().int().min(0), editLockDate: z.string() }), scenes: z.array(scene).min(1) });
export const changeSchema = z.object({
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), description: z.string().max(2000).default(''), scriptVersion: z.string().min(1),
  revisions: z.array(z.object({ scene: z.number().int().positive(), kind: z.enum(['dialogue', 'location', 'removed']), summary: z.string().min(1).max(300) })).min(1),
});
type Plan = z.infer<typeof planSchema>; type Change = z.infer<typeof changeSchema>;

const samplePlan = (): Plan => ({
  production: { title: 'Low Tide (feature)', scriptVersion: 'v6', remainingShootDays: 4, editLockDate: '2026-12-01' },
  scenes: [
    { n: 8, slug: 'INT. HARBOR OFFICE – DAY', location: 'Harbor Office', status: 'shot', takes: 7, characters: ['Mara', 'Ellis'], props: ['ledger', 'brass key'], wardrobe: ['Mara – navy coat'], continuity: 'Mara holds the brass key in left hand; rain on window.' },
    { n: 12, slug: 'EXT. PIER 9 – NIGHT', location: 'Pier 9', status: 'shot', takes: 11, characters: ['Mara', 'Ellis', 'Tomas'], props: ['lantern'], wardrobe: ['Mara – navy coat', 'Ellis – grey scarf'], continuity: 'Lantern lit; Ellis scarf over right shoulder; wet planks.' },
    { n: 15, slug: 'INT. FERRY CABIN – NIGHT', location: 'Ferry cabin set', status: 'unshot', takes: 0, characters: ['Mara', 'Tomas'], props: ['ledger'], wardrobe: ['Mara – navy coat'], continuity: 'Ledger already torn (page 3 missing).' },
    { n: 19, slug: 'EXT. LIGHTHOUSE – DAWN', location: 'Lighthouse', status: 'unshot', takes: 0, characters: ['Mara', 'Ellis'], props: [], wardrobe: ['Mara – no coat'], continuity: 'Mara has no coat (given away in sc.12).' },
  ],
});
const sampleChange = (): Change => ({ receivedOn: '2026-11-09', description: 'Script v7: Tomas now hands Mara the lantern in sc.12 (new dialogue); sc.15 moves to the Lighthouse; sc.8 is cut.', scriptVersion: 'v7',
  revisions: [{ scene: 12, kind: 'dialogue', summary: 'Tomas gives Mara the lantern; new 6-line exchange' }, { scene: 15, kind: 'location', summary: 'Lighthouse gallery' }, { scene: 8, kind: 'removed', summary: 'Scene cut from script' }] });

function detect(plan: Plan, ch: Change): ChangeItem[] {
  return ch.revisions.map((r) => {
    const s = plan.scenes.find((x) => x.n === r.scene);
    const st = s?.status === 'shot' ? 'shot' : 'unshot';
    return { field: `scene.${r.scene}.${r.kind}.${st}`, label: `Scene ${r.scene} ${r.kind}`, before: s ? (r.kind === 'location' ? s.location : s.slug) : '(not in baseline)', after: r.summary, kind: r.kind === 'removed' ? 'removed' : 'modified', severity: st === 'shot' ? 'high' : 'medium', note: s ? `already ${st === 'shot' ? `SHOT (${s.takes} takes)` : 'unshot'}` : 'scene not in approved baseline' } as ChangeItem;
  });
}
const sceneOf = (i: ChangeItem) => Number(i.field.split('.')[1]);
const kindOf = (i: ChangeItem) => i.field.split('.')[2];
const shotOf = (i: ChangeItem) => i.field.endsWith('.shot');

function apply(plan: Plan, ch: Change, answers: AnalysisContext['answers']): Plan {
  const p: Plan = structuredClone(plan); p.production.scriptVersion = ch.scriptVersion;
  for (const r of ch.revisions) {
    const s = p.scenes.find((x) => x.n === r.scene); if (!s) continue;
    if (r.kind === 'removed') s.status = 'cut';
    else if (r.kind === 'location') { s.location = r.summary; s.slug = s.slug.replace(/^(INT\.|EXT\.)\s.*?(\s–.*)$/, `$1 ${r.summary.toUpperCase()}$2`); }
    else if (s.status === 'shot') { s.status = answers.reshoot_decision?.value === 'adr' ? 'shot' : 'reshoot_pending'; s.continuity += ` [v${ch.scriptVersion}: ${r.summary}]`; }
    else s.continuity += ` [${ch.scriptVersion}: ${r.summary}]`;
  }
  return p;
}
const T = (head: string[], rows: (string | number)[][]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function analyze(role: string, ctx: AnalysisContext): RoleResult {
  const plan = ctx.plan as Plan, rev = ctx.revisedPlan as Plan;
  const items = ctx.items;
  const shot = items.filter((i) => shotOf(i) && kindOf(i) !== 'removed');
  const unshotMoved = items.filter((i) => !shotOf(i) && kindOf(i) === 'location');
  const cutShot = items.filter((i) => shotOf(i) && kindOf(i) === 'removed');
  const find = (n: number) => plan.scenes.find((s) => s.n === n);
  const noAct: ActionSpec[] = [];
  if (role === 'change') {
    return { roleKey: role, summary: `${items.length} script revisions vs ${plan.production.scriptVersion}: ${shot.length} touch already-shot scenes.`, findings: items.map((i) => ({ severity: shotOf(i) ? 'warning' : 'info', text: `${i.label}: ${i.note}` }) as Finding), questions: [], workItems: [], actions: noAct, analyzer: 'rule-engine/sceneshift-change@1',
      drafts: [{ kind: 'change_summary', name: 'Script revision summary', ownerRole: 'change', content: `# Script revision ${plan.production.scriptVersion} → ${(ctx.change as Change).scriptVersion}\n\n${T(['Scene', 'Change', 'Detail', 'Status in baseline'], items.map((i) => [sceneOf(i), kindOf(i), String(i.after), String(i.note)]))}` }] };
  }
  if (role === 'continuity') {
    const findings: Finding[] = []; const wi: WorkItemSpec[] = []; const qs: QuestionSpec[] = [];
    for (const i of shot) { const s = find(sceneOf(i))!; findings.push({ severity: 'risk', needsHumanReview: true, text: `Scene ${s.n} is already shot (${s.takes} takes). ${kindOf(i) === 'dialogue' ? 'Existing takes no longer match the script; reshoot or ADR needed.' : 'Existing takes may be unusable.'}` }); wi.push({ key: `cont-takes-${s.n}`, title: `Flag ${s.takes} takes of scene ${s.n} as superseded by script ${(ctx.change as Change).scriptVersion}`, detail: `Continuity at wrap: ${s.continuity}`, department: 'Script Supervision', roleKey: 'human_pm', kind: 'review', artifactKey: 'takes_log' }); }
    for (const i of cutShot) { const s = find(sceneOf(i))!; findings.push({ severity: 'warning', text: `Scene ${s.n} is cut but ${s.takes} takes exist; keep as alternate? Editorial to confirm.` }); }
    for (const i of unshotMoved) { const s = find(sceneOf(i))!; findings.push({ severity: 'warning', text: `Scene ${s.n} moves to a new location: continuity "${s.continuity}" must be re-checked (e.g. props in set dressing).` }); wi.push({ key: `cont-notes-${s.n}`, title: `Update continuity notes for scene ${s.n}`, detail: s.continuity, department: 'Script Supervision', roleKey: 'human_pm', kind: 'task', artifactKey: 'continuity_notes' }); }
    // downstream continuity: scene 19 depends on what happened in scene 12
    for (const i of shot) for (const s of plan.scenes) if (s.n !== sceneOf(i) && s.continuity.includes(`sc.${sceneOf(i)}`)) findings.push({ severity: 'warning', text: `Scene ${s.n} continuity references scene ${sceneOf(i)} ("${s.continuity}") — verify it still holds after the revision.` });
    if (shot.length) qs.push({ key: 'reshoot_decision', text: `Scene(s) ${shot.map(sceneOf).join(', ')} already shot: reshoot or fix with ADR? (answer "reshoot" or "adr")`, blocking: false, assigneeRole: 'human_pm' });
    return { roleKey: role, summary: `${findings.filter((f) => f.severity === 'risk').length} shot scenes invalidated; ${wi.length} continuity items.`, findings, questions: qs, workItems: wi, actions: noAct, drafts: [], analyzer: 'rule-engine/sceneshift-continuity@1' };
  }
  if (role === 'production') {
    const reshoots = rev.scenes.filter((s) => s.status === 'reshoot_pending');
    const added = Math.ceil(reshoots.length * 0.5) + unshotMoved.length * 0;
    const findings: Finding[] = [{ severity: reshoots.length ? 'risk' : 'info', text: `${reshoots.length} scene(s) need reshoot → about +${added} shoot day(s) vs ${plan.production.remainingShootDays} remaining.`, needsHumanReview: !!reshoots.length }];
    const wi: WorkItemSpec[] = reshoots.map((s) => ({ key: `prod-reshoot-${s.n}`, title: `Schedule reshoot for scene ${s.n}`, detail: `Cast: ${s.characters.join(', ')}; location ${s.location}; edit lock ${plan.production.editLockDate}.`, department: 'Production', roleKey: 'human_pm', kind: 'decision', artifactKey: 'shooting_schedule' }));
    wi.push({ key: 'prod-callsheet', title: 'Reissue call sheet for affected days', detail: 'Locations / cast changed.', department: 'Production', roleKey: 'human_pm', kind: 'task', artifactKey: 'call_sheet' });
    const md = `# Revised shooting schedule (DRAFT)\n\nRemaining days: ${plan.production.remainingShootDays} → **${plan.production.remainingShootDays + added}**\n\n${T(['Scene', 'Status', 'Location'], rev.scenes.map((s) => [s.n, s.status, s.location]))}`;
    return { roleKey: role, summary: `Schedule +${added} day(s); ${reshoots.length} reshoot(s).`, findings, questions: [], workItems: wi, drafts: [{ kind: 'schedule_update', name: 'Revised shooting schedule', content: md, ownerRole: 'production', artifactKey: 'shooting_schedule' }],
      actions: [{ key: 'publish_schedule', type: 'publish_schedule', title: 'Publish revised shooting schedule', connector: 'document_store', ownerRole: 'human_pm', consequential: true, draftKind: 'schedule_update', approvalRole: 'manager', ackRoles: [], rationale: 'Crew plan their days from this schedule.', target: 'Document store', effectKey: 'schedule' }], analyzer: 'rule-engine/sceneshift-production@1' };
  }
  if (role === 'departments') {
    const wi: WorkItemSpec[] = []; const findings: Finding[] = [];
    for (const i of items) {
      const s = find(sceneOf(i)); if (!s) continue;
      if (kindOf(i) === 'removed') { findings.push({ severity: 'info', text: `Scene ${s.n} cut: release props (${s.props.join(', ') || 'none'}) and wardrobe (${s.wardrobe.join(', ') || 'none'}) holds.` }); wi.push({ key: `dept-release-${s.n}`, title: `Release holds for cut scene ${s.n}`, detail: `${s.props.join(', ')}; ${s.wardrobe.join(', ')}`, department: 'Art & Wardrobe', roleKey: 'human_pm', kind: 'task', artifactKey: 'wardrobe_props' }); }
      if (kindOf(i) === 'location') wi.push({ key: `dept-dress-${s.n}`, title: `Re-dress set / source props for scene ${s.n} at new location`, detail: `Props: ${s.props.join(', ') || 'none'}`, department: 'Art & Wardrobe', roleKey: 'human_pm', kind: 'task', artifactKey: 'wardrobe_props' });
      if (kindOf(i) === 'dialogue' && shotOf(i)) wi.push({ key: `dept-adr-${s.n}`, title: `Sound: prepare ADR/reshoot audio plan for scene ${s.n}`, detail: 'New dialogue cannot be covered by existing audio.', department: 'Sound', roleKey: 'human_pm', kind: 'task', artifactKey: 'sound_adr' });
    }
    wi.push({ key: 'dept-edit', title: 'Editorial: re-assemble affected scenes', detail: 'Remove superseded takes from assembly.', department: 'Editorial', roleKey: 'human_pm', kind: 'task', artifactKey: 'edit_assembly' });
    const md = `# Department notices (DRAFT)\n\n${wi.map((w) => `- **${w.department}**: ${w.title} — ${w.detail}`).join('\n')}`;
    return { roleKey: role, summary: `${wi.length} department tasks across ${new Set(wi.map((w) => w.department)).size} departments.`, findings, questions: [], workItems: wi, drafts: [{ kind: 'department_notice', name: 'Department notices', content: md, ownerRole: 'departments', artifactKey: 'wardrobe_props' }],
      actions: [{ key: 'notify_departments', type: 'notify_departments', title: 'Notify departments of script revision', connector: 'internal_notify', ownerRole: 'human_pm', consequential: true, draftKind: 'department_notice', approvalRole: 'manager', ackRoles: ['human_pm'], rationale: 'Commits department time and budget.', target: 'Department heads', effectKey: 'dept-notice' }], analyzer: 'rule-engine/sceneshift-departments@1' };
  }
  return { roleKey: role, summary: 'Consolidated.', findings: [], questions: [], workItems: [{ key: 'coord-approve', title: 'Approve revised schedule and notices', detail: 'Review all drafts.', department: 'Production', roleKey: 'human_pm', kind: 'decision', artifactKey: 'shooting_schedule' }], drafts: [], actions: noAct, analyzer: 'rule-engine/sceneshift-coordinator@1' };
}

export const sceneShiftPack: WorkflowPack = {
  tier: 'core', system: 'creative',
  id: 'sceneshift', name: 'SceneShift', domain: 'Creative Production', version: '0.1.0',
  description: 'A script revision lands after scenes are shot: find invalidated takes, continuity breaks and department work.',
  roles: [
    { key: 'change', name: 'Script Change Agent', kind: 'agent', responsibility: 'Diffs the revised script against the approved version.' },
    { key: 'continuity', name: 'Continuity Agent', kind: 'agent', responsibility: 'Shot takes, continuity notes and downstream scene dependencies.', department: 'Script Supervision' },
    { key: 'production', name: 'Production Agent', kind: 'agent', responsibility: 'Reshoot scheduling and shoot-day impact.', department: 'Production' },
    { key: 'departments', name: 'Department Agent', kind: 'agent', responsibility: 'Art, wardrobe, sound and editorial tasks.', department: 'Departments' },
    { key: 'coordinator', name: 'Production Coordinator Agent', kind: 'agent', responsibility: 'Consolidates and requests approvals.', department: 'Production' },
    { key: 'human_pm', name: 'Production Manager (human)', kind: 'human', responsibility: 'Decides reshoot vs ADR and approves schedule changes.', department: 'Production' },
  ],
  roleOrder: ['change', 'continuity', 'production', 'departments', 'coordinator'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'takes_log', label: 'Takes log', department: 'Script Supervision', ownerRole: 'human_pm', description: 'Which takes are usable' },
    { key: 'continuity_notes', label: 'Continuity notes', department: 'Script Supervision', ownerRole: 'human_pm', description: 'Wrap continuity per scene' },
    { key: 'shooting_schedule', label: 'Shooting schedule', department: 'Production', ownerRole: 'human_pm', description: 'Remaining shoot days' },
    { key: 'call_sheet', label: 'Call sheets', department: 'Production', ownerRole: 'human_pm', description: 'Daily calls' },
    { key: 'wardrobe_props', label: 'Wardrobe & props lists', department: 'Art & Wardrobe', ownerRole: 'human_pm', description: 'Holds and sourcing' },
    { key: 'sound_adr', label: 'Sound / ADR plan', department: 'Sound', ownerRole: 'human_pm', description: 'Audio coverage' },
    { key: 'edit_assembly', label: 'Edit assembly', department: 'Editorial', ownerRole: 'human_pm', description: 'Current cut' },
  ],
  rules: [
    { id: 'shot→takes', trigger: (i) => i.field.endsWith('.shot') && !i.field.includes('.removed.'), to: 'takes_log', relation: 'invalidates', why: 'Takes were shot to the old script' },
    { id: 'shot→sound', trigger: (i) => i.field.includes('.dialogue.shot'), to: 'sound_adr', relation: 'requires', why: 'New dialogue needs audio' },
    { id: 'shot→sched', trigger: (i) => i.field.endsWith('.shot') && i.field.includes('.dialogue.'), to: 'shooting_schedule', relation: 'adds_days', why: 'Reshoot' },
    { id: 'loc→sched', trigger: (i) => i.field.includes('.location.'), to: 'shooting_schedule', relation: 'moves', why: 'Location changes the day plan' },
    { id: 'loc→cont', trigger: (i) => i.field.includes('.location.'), to: 'continuity_notes', relation: 'rechecks', why: 'Set dressing continuity' },
    { id: 'loc→props', trigger: (i) => i.field.includes('.location.'), to: 'wardrobe_props', relation: 'resources', why: 'Re-dress set' },
    { id: 'cut→props', trigger: (i) => i.field.includes('.removed.'), to: 'wardrobe_props', relation: 'releases', why: 'Release holds' },
    { id: 'cut→edit', trigger: (i) => i.field.includes('.removed.'), to: 'edit_assembly', relation: 'trims', why: 'Remove from cut' },
    { id: 'cut→sched', trigger: (i) => i.field.includes('.removed.'), to: 'shooting_schedule', relation: 'frees', why: 'Frees schedule' },
  ],
  artifactEdges: [
    { from: 'shooting_schedule', to: 'call_sheet', relation: 'drives', why: 'Calls derive from schedule' },
    { from: 'takes_log', to: 'edit_assembly', relation: 'drives', why: 'Editorial uses usable takes' },
    { from: 'sound_adr', to: 'edit_assembly', relation: 'drives', why: 'ADR flows into edit' },
  ],
  decisions: [{ key: 'approve_schedule', label: 'Approve revised schedule', ownerRole: 'human_pm', gates: ['shooting_schedule'] }],
  sample: () => ({ title: 'Low Tide — Script v6 → v7', plan: samplePlan(), change: sampleChange() }),
  detectChanges: detect, applyChange: apply, analyzeRole: analyze,
  parseAnswer(key, text) { if (key === 'reshoot_decision') { if (/adr/i.test(text)) return { value: 'adr' }; if (/reshoot/i.test(text)) return { value: 'reshoot' }; return { error: 'Answer "reshoot" or "adr".' }; } return { value: text.trim() }; },
  verifyAction(action, observed) {
    const needle = action.type === 'publish_schedule' ? 'Revised shooting schedule' : 'Department notices';
    return [{ name: 'expected heading present', passed: observed.content.includes(needle), detail: `observed content ${observed.content.includes(needle) ? 'contains' : 'MISSING'} "${needle}"` }];
  },
};
