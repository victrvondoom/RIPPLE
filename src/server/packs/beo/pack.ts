import type { AnalysisContext, ChangeItem, RoleResult, WorkflowPack, ActionSpec, Finding, QuestionSpec, WorkItemSpec } from '../../engine/types.js';
import { beoChangeSchema, beoPlanSchema, type BeoChange, type BeoPlan } from './schema.js';
import { sampleChange, samplePlan } from './sample.js';
import { addMin, daysBetween, ingredientNeeds, portions, staffing, timeline } from './compute.js';

const SAFETY = 'Allergen and dietary information below is derived from the menu data on file. It is NOT a food-safety certification. The Head Chef (qualified human) must review recipes, cross-contact controls and every allergen statement before use.';

function detectChanges(plan: BeoPlan, ch: BeoChange): ChangeItem[] {
  const out: ChangeItem[] = [];
  if (ch.guestCount !== undefined && ch.guestCount !== plan.event.guestCount) {
    const d = ch.guestCount - plan.event.guestCount;
    out.push({ field: 'event.guestCount', label: 'Guest count', before: plan.event.guestCount, after: ch.guestCount, kind: 'modified', severity: 'high', note: `${d > 0 ? '+' : ''}${d} guests (${Math.round((d / plan.event.guestCount) * 100)}%)` });
  }
  if (ch.serviceTime && ch.serviceTime !== plan.event.serviceTime) {
    out.push({ field: 'event.serviceTime', label: 'Service time', before: plan.event.serviceTime, after: ch.serviceTime, kind: 'modified', severity: 'high', note: 'Delivery, call times and prep schedule are derived from service time' });
  }
  if (ch.addVegan) {
    out.push({ field: 'dietary.vegan', label: 'Vegan meals', before: plan.dietary.vegan, after: ch.veganCount ?? 'count not provided', kind: plan.dietary.vegan ? 'modified' : 'added', severity: 'high', note: ch.veganCount ? undefined : 'Client did not state how many vegan meals' });
  }
  return out;
}

function applyChange(plan: BeoPlan, ch: BeoChange, answers: AnalysisContext['answers']): BeoPlan {
  const p: BeoPlan = structuredClone(plan);
  if (ch.guestCount !== undefined) p.event.guestCount = ch.guestCount;
  if (ch.serviceTime) p.event.serviceTime = ch.serviceTime;
  if (ch.addVegan) {
    const n = ch.veganCount ?? (answers.vegan_count?.value as number | undefined);
    if (n && n > 0) {
      p.dietary.vegan = n;
      const keep = (c: string) => p.menu.some((m) => m.vegan && m.serves === 'vegan' && m.course === c);
      for (const opt of p.veganOptions) {
        if (keep(opt.course)) continue;
        if (opt.course === 'dessert' && answers.vegan_dessert?.value === 'fruit_plate') {
          p.menu.push({ ...opt, id: 'v-d-fruit', name: 'Seasonal fruit plate', allergens: [], ingredients: [{ name: 'Seasonal fruit', unit: 'kg', qtyPerPortion: 0.12, supplierId: 'greenfield' }] });
        } else p.menu.push(opt);
      }
    }
  }
  return p;
}

const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const supName = (p: BeoPlan, id: string) => p.suppliers.find((s) => s.id === id)?.name ?? id;
const blocking = (ctx: AnalysisContext) => ctx.change.addVegan && !(ctx.change.veganCount || ctx.answers.vegan_count?.value);

function analyzeChange(ctx: AnalysisContext): RoleResult {
  const findings: Finding[] = ctx.items.map((i) => ({ severity: 'info', text: `${i.label}: ${i.before} → ${i.after}${i.note ? ` (${i.note})` : ''}` }));
  findings.push({ severity: 'warning', text: 'Assumption: vegetarian (6) and gluten-free (4) counts are unchanged by this request. Not stated by the client — confirm.' });
  const md = `# Change summary\n\nReceived: ${ctx.change.receivedOn}\n\n> ${ctx.change.description || '(no description)'}\n\n${table(['Field', 'Approved baseline', 'Requested', 'Note'], ctx.items.map((i) => [i.label, String(i.before), String(i.after), i.note ?? '']))}\n\nCompared against: approved baseline (see version history).`;
  return { roleKey: 'change', summary: `${ctx.items.length} baseline fields affected: ${ctx.items.map((i) => i.label.toLowerCase()).join(', ')}.`, findings, questions: [], workItems: [],
    drafts: [{ kind: 'change_summary', name: 'Change summary', content: md, ownerRole: 'change' }], actions: [], analyzer: 'rule-engine/beo-change@1' };
}

function analyzeKitchen(ctx: AnalysisContext): RoleResult {
  const base = ctx.plan as BeoPlan, rev = ctx.revisedPlan as BeoPlan;
  const bp = portions(base), rp = portions(rev);
  const findings: Finding[] = [];
  const questions: QuestionSpec[] = [];
  const workItems: WorkItemSpec[] = [];
  if (blocking(ctx)) {
    questions.push({ key: 'vegan_count', text: 'The client asked to add vegan meals but did not give a number. How many vegan guests are there (confirm with client)?', blocking: true, assigneeRole: 'human_manager' });
    findings.push({ severity: 'risk', text: 'Cannot size vegan menu, ingredients or prep: vegan meal count is unknown. Vegan quantities are EXCLUDED from this provisional analysis.', needsHumanReview: true });
  }
  if (rev.dietary.vegan > 0) {
    const added = rev.menu.filter((m) => !base.menu.some((b) => b.id === m.id));
    findings.push({ severity: 'info', text: `Added ${rev.dietary.vegan} vegan portions per course: ${added.map((m) => m.name).join('; ')}. Proposed from the kitchen's vegan option catalogue — Head Chef to confirm.` });
    const allergyText = rev.dietary.allergyNotes.join(' ').toLowerCase();
    for (const m of added) {
      for (const a of m.allergens) {
        if (/nut/.test(a) && /nut/.test(allergyText)) {
          findings.push({ severity: 'risk', needsHumanReview: true, text: `Potential allergen conflict: "${m.name}" lists ${a}; guest allergy notes on file: "${rev.dietary.allergyNotes.filter((n) => /nut/i.test(n)).join('; ')}". Requires qualified chef review before service — RIPPLE cannot clear this.` });
        }
      }
    }
    const unsafeStd = rev.menu.filter((m) => m.course === 'main' && !m.vegan && m.serves === 'standard_share').length;
    if (unsafeStd) findings.push({ severity: 'info', text: 'Existing standard mains are not vegan; vegan guests are served only the vegan options.' });
    workItems.push({ key: 'kitchen-recipe-review', title: 'Review vegan recipes, allergen & cross-contact controls', detail: `Head Chef to review ${added.map((m) => m.name).join(', ')} against allergy notes (${rev.dietary.allergyNotes.join('; ')}). This is a qualified-human review.`, department: 'Kitchen', roleKey: 'human_chef', kind: 'review', artifactKey: 'dietary_plan' });
    questions.push({ key: 'vegan_dessert', text: `Vegan dessert: use the coconut panna cotta (allergen: coconut) or a seasonal fruit plate? (answer "panna cotta" or "fruit plate")`, blocking: false, assigneeRole: 'human_chef' });
  }
  const dTotal = Object.keys(rp).map((id) => (rp[id] ?? 0) - (bp[id] ?? 0)).reduce((a, b) => a + Math.abs(b), 0);
  findings.push({ severity: 'info', text: `Portion changes across ${Object.keys(rp).filter((id) => (rp[id] ?? 0) !== (bp[id] ?? 0)).length} menu items (${dTotal} portion-units total).` });
  const tBase = timeline(base), tRev = timeline(rev);
  workItems.push({ key: 'kitchen-prep-reschedule', title: `Re-plan prep schedule: kitchen call ${tBase.kitchenCall} → ${tRev.kitchenCall}`, detail: `Service moves ${base.event.serviceTime} → ${rev.event.serviceTime}; ${rev.event.guestCount - base.event.guestCount >= 0 ? 'higher' : 'lower'} volume affects batch sizes and oven capacity.`, department: 'Kitchen', roleKey: 'human_chef', kind: 'task', artifactKey: 'prep_schedule' });
  workItems.push({ key: 'kitchen-quantities', title: 'Confirm revised portion counts against equipment and station capacity', detail: 'Check combi-oven/cold-storage capacity for the larger volume.', department: 'Kitchen', roleKey: 'human_chef', kind: 'task', artifactKey: 'menu_quantities' });
  findings.push({ severity: 'warning', text: SAFETY, needsHumanReview: true });

  const md = [`# Kitchen instructions (DRAFT${blocking(ctx) ? ' — PROVISIONAL, vegan count unknown' : ''})`, '',
    `Event: ${rev.event.name} · ${rev.event.date} · service ${rev.event.serviceTime} · ${rev.event.guestCount} guests`, '',
    `> ${SAFETY}`, '', '## Portions (approved → revised)', table(['Item', 'Course', 'Approved', 'Revised', 'Allergens on file'],
      rev.menu.map((m) => [m.name, m.course, bp[m.id] ?? 0, rp[m.id] ?? 0, m.allergens.join(', ') || '—'])), '',
    '## Timings', `- Kitchen call: ${tBase.kitchenCall} → **${tRev.kitchenCall}**`, `- Ingredient delivery: ${tBase.delivery} → **${tRev.delivery}**`, `- Service: ${tBase.service} → **${tRev.service}**`, '',
    '## Dietary', `- Vegetarian: ${rev.dietary.vegetarian} · Gluten-free: ${rev.dietary.glutenFree} · Vegan: ${rev.dietary.vegan || 'UNKNOWN'}`,
    `- Guest allergy notes: ${rev.dietary.allergyNotes.join('; ') || 'none'}`, '',
    '## Items requiring qualified review', ...findings.filter((f) => f.needsHumanReview).map((f) => `- ${f.text}`)].join('\n');
  const actions: ActionSpec[] = blocking(ctx) ? [] : [{ key: 'send_kitchen', type: 'send_kitchen_instructions', title: 'Send kitchen instructions to Head Chef', connector: 'internal_notify', ownerRole: 'human_manager', consequential: true, draftKind: 'kitchen_instructions', approvalRole: 'manager', ackRoles: ['human_chef'], rationale: 'Changes what the kitchen prepares and when; chef must acknowledge.', target: 'Head Chef (Kitchen)', effectKey: 'kitchen-instructions' }];
  return { roleKey: 'kitchen', summary: `Portions recalculated; ${questions.length} question(s); ${findings.filter((f) => f.severity === 'risk').length} risk(s) needing human review.`, findings, questions, workItems,
    drafts: [{ kind: 'kitchen_instructions', name: 'Kitchen instructions', content: md, ownerRole: 'kitchen', artifactKey: 'prep_schedule' }], actions, analyzer: 'rule-engine/beo-kitchen@1' };
}

function analyzeProcurement(ctx: AnalysisContext): RoleResult {
  const base = ctx.plan as BeoPlan, rev = ctx.revisedPlan as BeoPlan;
  const bn = new Map(ingredientNeeds(base).map((n) => [n.key, n]));
  const rn = ingredientNeeds(rev);
  const rows = rn.map((n) => ({ ...n, before: bn.get(n.key)?.qty ?? 0, delta: Math.round((n.qty - (bn.get(n.key)?.qty ?? 0)) * 100) / 100 })).filter((r) => r.delta !== 0);
  const findings: Finding[] = [];
  const workItems: WorkItemSpec[] = [];
  const avail = daysBetween(ctx.change.receivedOn, rev.event.date);
  const bySupplier = new Map<string, typeof rows>();
  for (const r of rows) bySupplier.set(r.supplierId, [...(bySupplier.get(r.supplierId) ?? []), r]);
  for (const [sid, rs] of bySupplier) {
    const s = rev.suppliers.find((x) => x.id === sid)!;
    const increase = rs.some((r) => r.delta > 0);
    if (increase && s.leadDays > avail) {
      findings.push({ severity: 'risk', needsHumanReview: true, text: `${s.name} needs ${s.leadDays} days lead time but only ${avail} days remain before ${rev.event.date}. Items: ${rs.map((r) => r.name).join(', ')}. Expedite fee, substitute, or alternate supplier decision needed.` });
      workItems.push({ key: `proc-expedite-${sid}`, title: `Resolve lead-time shortfall with ${s.name}`, detail: `${s.leadDays}d lead vs ${avail}d available. Ask for expedited delivery or approve substitute.`, department: 'Procurement', roleKey: 'human_buyer', kind: 'decision', artifactKey: 'supplier_orders', due: ctx.change.receivedOn });
    }
    if (increase) workItems.push({ key: `proc-order-${sid}`, title: `Place incremental order with ${s.name}`, detail: rs.map((r) => `${r.name}: ${r.delta > 0 ? '+' : ''}${r.delta} ${r.unit}`).join('; '), department: 'Procurement', roleKey: 'human_buyer', kind: 'task', artifactKey: 'supplier_orders' });
  }
  const newSup = [...bySupplier.keys()].filter((s) => !ingredientNeeds(base).some((n) => n.supplierId === s));
  if (newSup.length) findings.push({ severity: 'info', text: `New supplier relationship(s) needed: ${newSup.map((s) => supName(rev, s)).join(', ')}.` });
  const dt = timeline(rev).delivery, dt0 = timeline(base).delivery;
  if (dt !== dt0) workItems.push({ key: 'proc-delivery-window', title: `Move delivery window ${dt0} → ${dt}`, detail: 'Notify all suppliers of the new delivery time; fresh items should not arrive earlier than needed.', department: 'Procurement', roleKey: 'human_buyer', kind: 'task', artifactKey: 'supplier_orders' });
  workItems.push({ key: 'proc-list', title: 'Review revised procurement list', detail: `${rows.length} ingredient lines changed.`, department: 'Procurement', roleKey: 'human_buyer', kind: 'review', artifactKey: 'procurement_list' });
  findings.push({ severity: 'info', text: `${rows.length} ingredient lines change across ${bySupplier.size} supplier(s).` });
  if (blocking(ctx)) findings.push({ severity: 'warning', text: 'Vegan ingredients excluded — quantities are provisional until the vegan count is answered.' });

  const md = [`# Procurement update (DRAFT${blocking(ctx) ? ' — PROVISIONAL' : ''})`, '', `Event ${rev.event.date} · delivery **${dt}** (was ${dt0}) · change received ${ctx.change.receivedOn} (${avail} days to event)`, '',
    table(['Supplier', 'Ingredient', 'Approved qty', 'Revised qty', 'Change', 'Lead time'], rows.map((r) => [supName(rev, r.supplierId), r.name, `${r.before} ${r.unit}`, `${r.qty} ${r.unit}`, `${r.delta > 0 ? '+' : ''}${r.delta} ${r.unit}`, `${rev.suppliers.find((s) => s.id === r.supplierId)!.leadDays}d${rev.suppliers.find((s) => s.id === r.supplierId)!.leadDays > avail && r.delta > 0 ? ' ⚠ SHORT' : ''}`])), '',
    '## Risks', ...findings.filter((f) => f.severity === 'risk').map((f) => `- ${f.text}`)].join('\n');
  const actions: ActionSpec[] = blocking(ctx) ? [] : [{ key: 'send_procurement', type: 'send_procurement_update', title: 'Send procurement update to suppliers', connector: 'email_outbox', ownerRole: 'human_manager', consequential: true, draftKind: 'procurement_update', approvalRole: 'manager', ackRoles: ['human_buyer'], rationale: 'External communication that commits spend with suppliers.', target: [...bySupplier.keys()].map((s) => supName(rev, s)).join(', '), effectKey: 'procurement-update' }];
  return { roleKey: 'procurement', summary: `${rows.length} ingredient lines changed; ${findings.filter((f) => f.severity === 'risk').length} lead-time risk(s).`, findings, questions: [], workItems,
    drafts: [{ kind: 'procurement_update', name: 'Procurement update', content: md, ownerRole: 'procurement', artifactKey: 'procurement_list' }], actions, analyzer: 'rule-engine/beo-procurement@1', data: { lines: rows.length } };
}

function analyzeService(ctx: AnalysisContext): RoleResult {
  const base = ctx.plan as BeoPlan, rev = ctx.revisedPlan as BeoPlan;
  const sb = staffing(base), sr = staffing(rev), tb = timeline(base), tr = timeline(rev);
  const findings: Finding[] = [];
  const workItems: WorkItemSpec[] = [];
  const gaps = (['servers', 'kitchen', 'bartenders', 'captains'] as const).filter((k) => sr.gap[k] > 0);
  for (const k of gaps) {
    findings.push({ severity: 'warning', text: `Staffing gap: ${k} need ${sr.need[k]}, booked ${sr.booked[k]} (short by ${sr.gap[k]}).` });
    workItems.push({ key: `svc-staff-${k}`, title: `Book ${sr.gap[k]} additional ${k}`, detail: `Need ${sr.need[k]} for ${rev.event.guestCount} guests (ratio-based), booked ${sr.booked[k]}.`, department: 'Service', roleKey: 'human_service', kind: 'task', artifactKey: 'staffing_roster', due: ctx.change.receivedOn });
  }
  findings.push({ severity: 'info', text: `Call times: servers ${tb.serverCall} → ${tr.serverCall}; kitchen ${tb.kitchenCall} → ${tr.kitchenCall}. All booked staff must be re-notified of the new times.` });
  workItems.push({ key: 'svc-recall', title: 'Re-confirm availability for new call times with all booked staff', detail: `Server call ${tr.serverCall}; service ${tr.service}–${tr.serviceEnd}; teardown ends ${tr.teardownEnd}.`, department: 'Service', roleKey: 'human_service', kind: 'task', artifactKey: 'service_timeline' });
  if (tr.pastCurfewMin > 0) {
    findings.push({ severity: 'risk', needsHumanReview: true, text: `Teardown ends ${tr.teardownEnd}, ${tr.pastCurfewMin} min after venue curfew ${rev.event.venueCurfew}. Needs venue agreement or a shorter teardown plan.` });
    workItems.push({ key: 'svc-curfew', title: 'Resolve teardown past venue curfew', detail: `Curfew ${rev.event.venueCurfew}; projected teardown end ${tr.teardownEnd} (${tr.pastCurfewMin} min over).`, department: 'Service', roleKey: 'human_service', kind: 'decision', artifactKey: 'service_timeline' });
  }
  const md = [`# Staffing & service update (DRAFT)`, '', `Service ${tb.service}–${tb.serviceEnd} → **${tr.service}–${tr.serviceEnd}**; teardown ends **${tr.teardownEnd}** (curfew ${rev.event.venueCurfew})`, '',
    table(['Role', 'Needed (approved)', 'Needed (revised)', 'Booked', 'Gap'], (['servers', 'kitchen', 'bartenders', 'captains'] as const).map((k) => [k, sb.need[k], sr.need[k], sr.booked[k], sr.gap[k] > 0 ? `**+${sr.gap[k]}**` : '0'])), '',
    table(['Milestone', 'Approved', 'Revised'], [['Kitchen call', tb.kitchenCall, tr.kitchenCall], ['Ingredient delivery', tb.delivery, tr.delivery], ['Server call', tb.serverCall, tr.serverCall], ['Service start', tb.service, tr.service], ['Service end', tb.serviceEnd, tr.serviceEnd], ['Teardown end', tb.teardownEnd, tr.teardownEnd]]), '',
    '## Risks', ...findings.filter((f) => f.severity === 'risk').map((f) => `- ${f.text}`)].join('\n');
  const actions: ActionSpec[] = blocking(ctx) ? [] : [{ key: 'send_staffing', type: 'send_staffing_update', title: 'Send staffing & service update to Service Lead', connector: 'internal_notify', ownerRole: 'human_manager', consequential: true, draftKind: 'staffing_update', approvalRole: 'manager', ackRoles: ['human_service'], rationale: 'Changes staff call times and headcount commitments.', target: 'Service Lead', effectKey: 'staffing-update' }];
  return { roleKey: 'service', summary: `Staffing gaps: ${gaps.map((k) => `${k} +${sr.gap[k]}`).join(', ') || 'none'}; call times shifted.`, findings, questions: [], workItems,
    drafts: [{ kind: 'staffing_update', name: 'Staffing & service update', content: md, ownerRole: 'service', artifactKey: 'staffing_roster' }], actions, analyzer: 'rule-engine/beo-service@1', data: { gaps: sr.gap } };
}

function analyzeCoordinator(ctx: AnalysisContext): RoleResult {
  const base = ctx.plan as BeoPlan, rev = ctx.revisedPlan as BeoPlan;
  const findings: Finding[] = [];
  const questions: QuestionSpec[] = [];
  const workItems: WorkItemSpec[] = [];
  const open: string[] = [];
  if (rev.event.guestCount > rev.event.venueCapacity) {
    findings.push({ severity: 'risk', needsHumanReview: true, text: `Revised guest count ${rev.event.guestCount} exceeds ${rev.event.venue} capacity on file (${rev.event.venueCapacity}). Venue must confirm in writing.` });
    questions.push({ key: 'venue_capacity', text: `${rev.event.venue} capacity on file is ${rev.event.venueCapacity}, but guests are now ${rev.event.guestCount}. Has the venue confirmed it can host ${rev.event.guestCount}? (answer with what the venue said)`, blocking: false, assigneeRole: 'human_manager' });
    workItems.push({ key: 'coord-venue', title: `Get written venue confirmation for ${rev.event.guestCount} guests`, detail: `Capacity on file ${rev.event.venueCapacity}. Fire-code limits may apply.`, department: 'Event Management', roleKey: 'human_manager', kind: 'decision', artifactKey: 'venue_logistics', due: ctx.change.receivedOn });
    open.push(`Venue capacity (${rev.event.venueCapacity}) vs ${rev.event.guestCount} guests`);
  }
  if (blocking(ctx)) open.push('Vegan meal count unknown');
  for (const r of Object.values(ctx.results)) for (const f of r.findings) if (f.severity === 'risk') open.push(f.text);
  const t = timeline(rev), tb = timeline(base);
  workItems.push({ key: 'coord-beo-review', title: 'Review and approve revised BEO', detail: 'Verify all departments’ drafts agree with the revised BEO before anything is sent.', department: 'Event Management', roleKey: 'human_manager', kind: 'decision', artifactKey: 'beo' });
  workItems.push({ key: 'coord-client', title: 'Approve and send client confirmation', detail: 'Client communication goes out only after the manager approves it.', department: 'Client Services', roleKey: 'human_manager', kind: 'decision', artifactKey: 'client_confirmation' });
  const unans = (k: string) => !ctx.answers[k];
  const beo = [`# Banquet Event Order — REVISED DRAFT${blocking(ctx) ? ' (PROVISIONAL)' : ''}`, '', `**${rev.event.name}** · ${rev.event.client} · ${rev.event.date} · ${rev.event.venue}`, '',
    table(['Field', 'Approved baseline', 'Revised'], [['Guests', base.event.guestCount, `**${rev.event.guestCount}**`], ['Service time', tb.service, `**${t.service}**`], ['Ingredient delivery', tb.delivery, t.delivery], ['Server call', tb.serverCall, t.serverCall], ['Kitchen call', tb.kitchenCall, t.kitchenCall], ['Vegan meals', base.dietary.vegan, rev.dietary.vegan || '**UNKNOWN — pending**'], ['Vegetarian / GF', `${base.dietary.vegetarian} / ${base.dietary.glutenFree}`, `${rev.dietary.vegetarian} / ${rev.dietary.glutenFree} (assumed unchanged)`]]), '',
    '## Menu', ...rev.menu.map((m) => `- ${m.course}: ${m.name}${m.vegan && m.serves === 'vegan' ? ' **(new vegan option)**' : ''} — allergens on file: ${m.allergens.join(', ') || 'none listed'}`), '',
    '## Staffing', `Servers ${staffing(rev).need.servers} · Kitchen ${staffing(rev).need.kitchen} · Bartenders ${staffing(rev).need.bartenders} · Captains ${staffing(rev).need.captains}`, '',
    '## Open items (not resolved by this draft)', ...(open.length ? [...new Set(open)].map((o) => `- ${o}`) : ['- none']), '', `> ${SAFETY}`].join('\n');
  const vegan = rev.dietary.vegan;
  const pending = [unans('venue_capacity') && rev.event.guestCount > rev.event.venueCapacity ? `we are confirming with ${rev.event.venue} that they can host ${rev.event.guestCount} guests` : '', vegan ? 'our chef is reviewing the vegan menu and will confirm allergen handling with you directly' : ''].filter(Boolean);
  const email = [`Subject: ${rev.event.name} — updated plan for ${rev.event.date}`, '', `Hi ${rev.event.clientContact.split(' <')[0]},`, '',
    `Thanks for your update. Here is what we have recorded:`, `- Guests: ${base.event.guestCount} → ${rev.event.guestCount}`, `- Dinner service: ${tb.service} → ${t.service}`, vegan ? `- Vegan meals: ${vegan} added` : '- Vegan meals: we need the number of vegan guests to proceed',
    '', pending.length ? `Still to be confirmed: ${pending.join('; ')}.` : 'All items above are confirmed on our side.', '',
    'We will send the final BEO for your sign-off. Please tell us about any other dietary or allergy requirements for the added guests.', '', 'Kind regards,', 'Event Management Team'].join('\n');
  const actions: ActionSpec[] = blocking(ctx) ? [] : [
    { key: 'publish_beo', type: 'publish_revised_beo', title: 'Publish revised BEO as the new working document', connector: 'document_store', ownerRole: 'human_manager', consequential: true, draftKind: 'revised_beo', approvalRole: 'manager', ackRoles: [], rationale: 'Becomes the document every department works from.', target: 'Document store', effectKey: 'revised-beo' },
    { key: 'send_client', type: 'send_client_communication', title: 'Send confirmation email to client', connector: 'email_outbox', ownerRole: 'human_manager', consequential: true, draftKind: 'client_communication', approvalRole: 'manager', ackRoles: [], rationale: 'External message that sets client expectations.', target: rev.event.clientContact, effectKey: 'client-communication' },
  ];
  return { roleKey: 'coordinator', summary: `Consolidated BEO and client email. ${open.length} open item(s) tracked; ${actions.length} action(s) proposed for approval.`, findings, questions, workItems,
    drafts: [{ kind: 'revised_beo', name: 'Revised BEO (draft)', content: beo, ownerRole: 'coordinator', artifactKey: 'beo' }, { kind: 'client_communication', name: 'Client communication (draft)', content: email, ownerRole: 'coordinator', artifactKey: 'client_confirmation' }],
    actions, analyzer: 'rule-engine/beo-coordinator@1' };
}

export const beoPack: WorkflowPack = {
  tier: 'core', system: 'commerce',
  id: 'beo-rescue', name: 'BEO Rescue', domain: 'Event Operations', version: '1.0.0',
  description: 'Re-plan an approved catering Banquet Event Order when the client changes guests, menu needs or timing.',
  agentLimit: 'Flags allergen risks; strictly forbidden from certifying food safety',
  roles: [
    { key: 'change', name: 'Change Agent', kind: 'agent', responsibility: 'Diffs the request against the approved baseline.' },
    { key: 'kitchen', name: 'Kitchen Agent', kind: 'agent', responsibility: 'Menu, quantities, prep, allergen flags, missing dietary info.', department: 'Kitchen' },
    { key: 'procurement', name: 'Procurement Agent', kind: 'agent', responsibility: 'Purchasing deltas, supplier lead times, procurement update.', department: 'Procurement' },
    { key: 'service', name: 'Service Agent', kind: 'agent', responsibility: 'Staffing ratios, call times, service timeline, curfew.', department: 'Service' },
    { key: 'coordinator', name: 'Event Manager Agent', kind: 'agent', responsibility: 'Consolidates findings, drafts BEO & client message, requests approvals.', department: 'Event Management' },
    { key: 'human_manager', name: 'Event Manager (human)', kind: 'human', responsibility: 'Decision-maker: approves consequential changes.', department: 'Event Management' },
    { key: 'human_chef', name: 'Head Chef', kind: 'human', responsibility: 'Qualified review of recipes and allergen handling.', department: 'Kitchen' },
    { key: 'human_buyer', name: 'Procurement Lead', kind: 'human', responsibility: 'Places supplier orders.', department: 'Procurement' },
    { key: 'human_service', name: 'Service Lead', kind: 'human', responsibility: 'Confirms staffing and call times.', department: 'Service' },
  ],
  roleOrder: ['change', 'kitchen', 'procurement', 'service', 'coordinator'],
  // Data dependencies (the analyzers read the plan and change, not each other's output) except the Event Manager,
  // which consolidates every department's findings. Unchanged inputs => the orchestrator reuses the earlier result.
  roleDeps: { change: [], kitchen: [], procurement: [], service: [], coordinator: ['change', 'kitchen', 'procurement', 'service'] },
  roleInputs(roleKey, ctx) {
    const scrub = (p: any) => { const rest: Record<string, unknown> = { ...(p ?? {}) }; delete rest.menu; delete rest.dietary; delete rest.veganOptions; delete rest.suppliers; return rest; };
    if (roleKey === 'change') return { change: ctx.change, items: ctx.items };
    // Service timing and staffing do not depend on the menu, dietary counts or suppliers.
    if (roleKey === 'service') return { base: scrub(ctx.plan), revised: scrub(ctx.revisedPlan), receivedOn: ctx.change.receivedOn, veganPending: blocking(ctx) };
    return { change: ctx.change, items: ctx.items, answers: ctx.answers, revisedPlan: ctx.revisedPlan };
  },
  planSchema: beoPlanSchema, changeSchema: beoChangeSchema,
  artifacts: [
    { key: 'beo', label: 'Banquet Event Order', department: 'Event Management', ownerRole: 'human_manager', description: 'Master document for the event' },
    { key: 'menu_quantities', label: 'Menu & portion quantities', department: 'Kitchen', ownerRole: 'human_chef', description: 'Portions per menu item' },
    { key: 'dietary_plan', label: 'Dietary & allergen plan', department: 'Kitchen', ownerRole: 'human_chef', description: 'Vegan/vegetarian/GF and allergy handling' },
    { key: 'prep_schedule', label: 'Prep schedule', department: 'Kitchen', ownerRole: 'human_chef', description: 'Kitchen call and prep timings' },
    { key: 'procurement_list', label: 'Procurement list', department: 'Procurement', ownerRole: 'human_buyer', description: 'Ingredient quantities by supplier' },
    { key: 'supplier_orders', label: 'Supplier orders & delivery window', department: 'Procurement', ownerRole: 'human_buyer', description: 'Placed orders and delivery times' },
    { key: 'staffing_roster', label: 'Staffing roster', department: 'Service', ownerRole: 'human_service', description: 'Headcount by role' },
    { key: 'service_timeline', label: 'Service timeline', department: 'Service', ownerRole: 'human_service', description: 'Call times, service, teardown' },
    { key: 'venue_logistics', label: 'Venue confirmation', department: 'Event Management', ownerRole: 'human_manager', description: 'Capacity, curfew' },
    { key: 'client_confirmation', label: 'Client confirmation', department: 'Client Services', ownerRole: 'human_manager', description: 'What the client has been told' },
  ],
  rules: [
    { id: 'guests→menu', trigger: (i) => i.field === 'event.guestCount', to: 'menu_quantities', relation: 'resizes', why: 'Portions scale with guests' },
    { id: 'guests→staff', trigger: (i) => i.field === 'event.guestCount', to: 'staffing_roster', relation: 'resizes', why: 'Staffing ratios are per guest' },
    { id: 'guests→venue', trigger: (i) => i.field === 'event.guestCount', to: 'venue_logistics', relation: 'tests', why: 'Capacity limits' },
    { id: 'time→timeline', trigger: (i) => i.field === 'event.serviceTime', to: 'service_timeline', relation: 'shifts', why: 'Call times derive from service time' },
    { id: 'time→prep', trigger: (i) => i.field === 'event.serviceTime', to: 'prep_schedule', relation: 'shifts', why: 'Prep works back from service' },
    { id: 'time→orders', trigger: (i) => i.field === 'event.serviceTime', to: 'supplier_orders', relation: 'shifts', why: 'Delivery window derives from service time' },
    { id: 'vegan→diet', trigger: (i) => i.field === 'dietary.vegan', to: 'dietary_plan', relation: 'adds', why: 'New dietary category' },
    { id: 'vegan→menu', trigger: (i) => i.field === 'dietary.vegan', to: 'menu_quantities', relation: 'adds', why: 'New menu items needed' },
  ],
  artifactEdges: [
    { from: 'menu_quantities', to: 'procurement_list', relation: 'drives', why: 'Quantities become ingredient needs' },
    { from: 'procurement_list', to: 'supplier_orders', relation: 'drives', why: 'Needs become orders' },
    { from: 'menu_quantities', to: 'prep_schedule', relation: 'drives', why: 'Volume sets prep effort' },
    { from: 'dietary_plan', to: 'prep_schedule', relation: 'drives', why: 'Separate vegan prep & allergen controls' },
    { from: 'service_timeline', to: 'staffing_roster', relation: 'drives', why: 'Call times must be re-confirmed' },
    { from: 'service_timeline', to: 'prep_schedule', relation: 'drives', why: 'Prep works back from service' },
    { from: 'staffing_roster', to: 'beo', relation: 'feeds', why: 'BEO lists staffing' },
    { from: 'menu_quantities', to: 'beo', relation: 'feeds', why: 'BEO lists menu and counts' },
    { from: 'service_timeline', to: 'beo', relation: 'feeds', why: 'BEO lists timings' },
    { from: 'dietary_plan', to: 'beo', relation: 'feeds', why: 'BEO lists dietary needs' },
    { from: 'venue_logistics', to: 'client_confirmation', relation: 'feeds', why: 'Client must hear venue status' },
    { from: 'beo', to: 'client_confirmation', relation: 'feeds', why: 'Client confirmation mirrors the BEO' },
  ],
  decisions: [
    { key: 'approve_beo', label: 'Approve revised BEO', ownerRole: 'human_manager', gates: ['beo'] },
    { key: 'approve_procurement', label: 'Approve supplier communication', ownerRole: 'human_manager', gates: ['supplier_orders'] },
    { key: 'approve_client', label: 'Approve client communication', ownerRole: 'human_manager', gates: ['client_confirmation'] },
  ],
  sample: () => ({ title: 'Meridian Labs Gala — 2026-11-14', plan: samplePlan(), change: sampleChange() }),
  detectChanges, applyChange,
  analyzeRole(roleKey, ctx) {
    switch (roleKey) {
      case 'change': return analyzeChange(ctx);
      case 'kitchen': return analyzeKitchen(ctx);
      case 'procurement': return analyzeProcurement(ctx);
      case 'service': return analyzeService(ctx);
      case 'coordinator': return analyzeCoordinator(ctx);
      default: throw new Error(`BEO pack has no analyzer for role ${roleKey}`);
    }
  },
  parseAnswer(key, text, plan: BeoPlan) {
    const t = text.trim();
    if (key === 'vegan_count') {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 1) return { error: 'Enter a whole number of vegan guests (1 or more).' };
      if (n > plan.event.guestCount + 1000) return { error: 'Number is implausibly large.' };
      return { value: n };
    }
    if (key === 'vegan_dessert') {
      if (/fruit/i.test(t)) return { value: 'fruit_plate' };
      if (/panna|coconut/i.test(t)) return { value: 'panna_cotta' };
      return { error: 'Answer "panna cotta" or "fruit plate".' };
    }
    return t ? { value: t } : { error: 'Answer cannot be empty.' };
  },
  verifyAction(action, observed, revised: BeoPlan) {
    const c = observed.content;
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    const has = (name: string, needle: string) => checks.push({ name, passed: c.includes(needle), detail: `observed content ${c.includes(needle) ? 'contains' : 'is MISSING'} "${needle}"` });
    if (['publish_revised_beo', 'send_client_communication'].includes(action.type)) { has('guest count present', String(revised.event.guestCount)); has('service time present', timeline(revised).service); }
    if (action.type === 'send_staffing_update') has('server headcount present', String(staffing(revised).need.servers));
    if (action.type === 'send_kitchen_instructions') has('kitchen call time present', timeline(revised).kitchenCall);
    if (action.type === 'send_procurement_update') has('delivery time present', timeline(revised).delivery);
    const banned = /\b(certif(y|ied)|guarantee[sd]?|100% safe|allergen[- ]free)\b/i.exec(c);
    checks.push({ name: 'no safety certification claim', passed: !banned, detail: banned ? `contains forbidden claim "${banned[0]}"` : 'no certification/guarantee wording found' });
    return checks;
  },
  completionChecks() { return []; },
};
export { addMin };
