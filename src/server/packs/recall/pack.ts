import { z } from 'zod';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';

/**
 * Recall desk: a drug batch fails a regulator's quality test; every store that stocks it pulls it, and a person signs off at each step.
 * Domain: pharmacy / retail compliance. Deterministic and offline: the regulator list and each store's stock are supplied in the plan/change.
 *  - Impact: exact batch matches per store. A batch that differs only by a look-alike character (O/0, I/1, S/5, B/8) is NEVER auto-matched:
 *    it becomes a blocking question for the QA Head ("check the strip on the shelf").
 *  - Drafts only: supplier return notes and patient messages (English + Hindi) are drafts; RIPPLE sends nothing.
 *  - Approval: the stop-sale order needs the QA Head (ActionSpec.approver); a store manager or manager cannot approve for them.
 *  - Close: a recall is complete only when every matched (store, batch) has a recorded shelf check whose batch read equals the recalled batch.
 * LIMITS: RIPPLE reads no photos and contacts no store. A shelf check is a batch string the store runner/manager recorded; the stop-sale order is
 * a dry-run record. The patient message is marked ready for a pharmacist, never sent, and makes no medical or safety statement.
 */
export const planSchema = z.object({
  chain: z.string().min(1), qaHeadEmail: z.string().email(),
  stores: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), stock: z.array(z.object({ drug: z.string(), batch: z.string(), qty: z.number().int().min(0) })).default([]) })).min(1),
});
export const changeSchema = z.object({
  recallId: z.string().min(3), source: z.enum(['CDSCO', 'openFDA']), listedAt: z.string(),
  batches: z.array(z.object({ drug: z.string().min(1), batch: z.string().min(1), reason: z.enum(['not-of-standard-quality', 'spurious', 'recall']) })).min(1),
  shelfChecks: z.array(z.object({ storeId: z.string(), batch: z.string(), batchRead: z.string(), readBy: z.string().min(2) })).default([]),
});
type Plan = z.infer<typeof planSchema>; type Change = z.infer<typeof changeSchema>;
const norm = (s: string) => s.trim().toUpperCase().replace(/[\s-]+/g, '');
const CONF: Record<string, string> = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const fold = (s: string) => [...norm(s)].map((c) => CONF[c] ?? c).join('');
export interface Hit { storeId: string; store: string; drug: string; batch: string; qty: number; recalled: string; kind: 'exact' | 'lookalike' }
/** Exact matches are certain; look-alikes need a person. Neither is ever dropped silently. */
export function match(plan: Plan, c: Change): Hit[] {
  const hits: Hit[] = [];
  for (const st of plan.stores) for (const s of st.stock) for (const b of c.batches) {
    if (norm(s.drug) !== norm(b.drug) && !norm(s.drug).includes(norm(b.drug)) && !norm(b.drug).includes(norm(s.drug))) continue;
    if (norm(s.batch) === norm(b.batch)) hits.push({ storeId: st.id, store: st.name, drug: s.drug, batch: s.batch, qty: s.qty, recalled: b.batch, kind: 'exact' });
    else if (fold(s.batch) === fold(b.batch)) hits.push({ storeId: st.id, store: st.name, drug: s.drug, batch: s.batch, qty: s.qty, recalled: b.batch, kind: 'lookalike' });
  }
  return hits;
}
const qKey = (h: Hit) => `lookalike_${h.storeId}_${norm(h.batch)}`.replace(/[^A-Za-z0-9_]/g, '_');
/** Confirmed hits = exact + look-alikes the QA Head answered "yes, same batch". */
export function confirmedHits(plan: Plan, c: Change, a: AnalysisContext['answers']) { return match(plan, c).filter((h) => h.kind === 'exact' || a[qKey(h)]?.value === 'yes'); }
export const outstandingChecks = (hits: Hit[], c: Change) => hits.filter((h) => !c.shelfChecks.some((k) => k.storeId === h.storeId && norm(k.batchRead) === norm(h.recalled)));

export const recallPack: WorkflowPack = {
  tier: 'extended', system: 'commerce',
  id: 'recall-desk', name: 'Recall Desk', domain: 'Pharmacy Compliance', version: '1.0.0',
  description: 'A drug-batch recall desk: match a regulator\'s failed batches to each store\'s stock, treat look-alike batch numbers as questions for a person, draft supplier and patient notices (never sent), and close only when every store has a recorded shelf check. Only the QA Head approves the stop-sale order.',
  labels: { baseline: 'Chain & Store Stock', change: 'Regulator List', changeVerb: 'Open recall', plan: 'Stock Baseline', mission: 'Recall', blurb: 'Matches failed batches to store stock. A letter-O versus zero look-alike is never auto-matched: the QA Head decides. Nothing is sent; completion needs a shelf check per store.' },
  roles: [
    { key: 'rc_sentinel', name: 'Recall Sentinel', kind: 'agent', responsibility: 'Reads the regulator list, opens the recall, orders stop-sale after approval, closes only on evidence', department: 'Compliance' },
    { key: 'rc_matcher', name: 'Impact Matcher', kind: 'agent', responsibility: 'Matches batches to stock; flags look-alike batch numbers for a person', department: 'Compliance', scope: 'read' },
    { key: 'rc_comms', name: 'Notice Writer', kind: 'agent', responsibility: 'Drafts supplier return notes and patient messages (English, Hindi); sends nothing', department: 'Compliance', scope: 'read' },
    { key: 'rc_runner', name: 'Store Runner', kind: 'agent', responsibility: 'Checks recorded shelf reads against the recalled batch numbers', department: 'Stores', scope: 'read' },
    { key: 'rc_qa_head', name: 'QA Head', kind: 'human', responsibility: 'Answers look-alike questions and is the only person who approves the stop-sale order', department: 'HQ' },
    { key: 'rc_store_manager', name: 'Store Manager', kind: 'human', responsibility: 'Pulls the stock and records the shelf check', department: 'Stores' },
  ],
  roleOrder: ['rc_matcher', 'rc_comms', 'rc_sentinel', 'rc_runner', 'rc_qa_head', 'rc_store_manager'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'impact_table', label: 'Impact table', department: 'Compliance', ownerRole: 'rc_matcher', description: 'Per store: exact matches and look-alikes needing review' },
    { key: 'notices', label: 'Draft notices', department: 'Compliance', ownerRole: 'rc_comms', description: 'Supplier return notes and patient messages; drafts only' },
    { key: 'stop_sale', label: 'Stop-sale order (dry-run)', department: 'Compliance', ownerRole: 'rc_sentinel', description: 'Order per store and batch; no store is contacted' },
    { key: 'recall_log', label: 'Recall log', department: 'Compliance', ownerRole: 'rc_sentinel', description: 'Audit record: who approved, which checks are recorded' },
  ],
  rules: [],
  artifactEdges: [{ from: 'impact_table', to: 'notices', relation: 'informs', why: 'Notices cover only confirmed matches' }, { from: 'impact_table', to: 'stop_sale', relation: 'scopes', why: 'The order lists exactly the confirmed matches' }, { from: 'stop_sale', to: 'recall_log', relation: 'recorded_in', why: 'The log records the approved order' }],
  decisions: [{ key: 'approve_stop_sale', label: 'The QA Head alone approves the stop-sale order', ownerRole: 'rc_qa_head', gates: ['stop_sale'] }],

  sample() {
    return {
      title: 'Recall R-20261104-1: three failed batches (CDSCO sample list)',
      plan: { chain: 'Harborvine Pharmacy', qaHeadEmail: 'sam@harborvine.example', stores: [
        { id: 'pune', name: 'Pune store', stock: [{ drug: 'Paracetamol 500mg', batch: 'PCM-2501', qty: 120 }, { drug: 'Montelukast 10mg', batch: 'APRCT-25O1', qty: 40 }] },
        { id: 'mumbai', name: 'Mumbai store', stock: [{ drug: 'Paracetamol 500mg', batch: 'PCM-2499', qty: 80 }, { drug: 'Telmisartan 40mg', batch: 'TLM-7781', qty: 60 }] },
      ] },
      change: { recallId: 'R-20261104-1', source: 'CDSCO', listedAt: '2026-11-04', batches: [
        { drug: 'Paracetamol 500mg', batch: 'PCM-2501', reason: 'not-of-standard-quality' }, { drug: 'Montelukast 10mg', batch: 'APRCT-2501', reason: 'spurious' }, { drug: 'Telmisartan 40mg', batch: 'TLM-9999', reason: 'not-of-standard-quality' }], shelfChecks: [] },
    };
  },
  detectChanges(plan: Plan, c: Change): ChangeItem[] {
    const h = match(plan, c);
    return [{ field: 'recall', label: `${c.recallId}: ${c.batches.length} batches from ${c.source}`, before: 'none', after: `${h.filter((x) => x.kind === 'exact').length} exact, ${h.filter((x) => x.kind === 'lookalike').length} look-alike matches`, kind: 'added', severity: h.length ? 'high' : 'low' }];
  },
  applyChange(plan: Plan) { return structuredClone(plan); },
  parseAnswer(key, text) { const t = text.trim().toLowerCase(); if (key.startsWith('lookalike_')) return t === 'yes' || t === 'no' ? { value: t } : { error: 'Answer yes (same batch) or no (different batch) after checking the strip.' }; return { value: text.trim() }; },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const A = 'recall-deterministic'; const plan = ctx.plan as Plan; const c = ctx.change as Change; const hits = match(plan, c); const conf = confirmedHits(plan, c, ctx.answers);
    const look = hits.filter((h) => h.kind === 'lookalike'); const open = look.filter((h) => !ctx.answers[qKey(h)]);
    if (role === 'rc_matcher') {
      const o = new Out(role, `${A}-matcher@1`);
      o.draft({ kind: 'impact_table', name: `Impact ${c.recallId}`, artifactKey: 'impact_table', content: `# Impact: ${c.recallId} (${c.source}, listed ${c.listedAt})\n\n${hits.length ? table(['Store', 'Drug', 'On shelf', 'Recalled', 'Qty', 'Match'], hits.map((h) => [h.store, h.drug, h.batch, h.recalled, h.qty, h.kind === 'exact' ? 'exact' : 'LOOK-ALIKE: needs a person'])) : 'No store stocks a listed batch.'}\n\n_Matching is by batch string only; no strip was seen by RIPPLE._` });
      for (const h of look) { o.risk(`${h.store}: stock batch ${h.batch} differs from recalled ${h.recalled} only by look-alike characters. Check the strip on the shelf; not auto-matched.`); if (!ctx.answers[qKey(h)]) o.ask({ key: qKey(h), text: `${h.store}: shelf batch "${h.batch}" vs recalled "${h.recalled}". After checking the strip, is it the same batch? (yes/no)`, blocking: true, assigneeRole: 'rc_qa_head', assigneeOnly: true }); }
      if (!hits.length) o.info('No listed batch is in stock anywhere.');
      return o.done(`${hits.filter((h) => h.kind === 'exact').length} exact and ${look.length} look-alike matches.`);
    }
    if (role === 'rc_comms') {
      const o = new Out(role, `${A}-comms@1`); if (!conf.length) return o.done('No confirmed matches: no notices drafted.');
      const sup = conf.map((h) => `- ${h.drug}, batch ${h.recalled}: ${h.qty} units at ${h.store}`).join('\n');
      o.draft({ kind: 'notices', name: `Draft notices ${c.recallId}`, artifactKey: 'notices', content: `# Draft notices (${c.recallId})\n\n## Supplier return note (English)\nPlease arrange collection of the following batches listed by ${c.source}:\n${sup}\n\n## Patient message (English)\nA batch of a medicine you bought from us has been listed by the regulator. Please bring the strip to your pharmacist.\n\n## रोगी संदेश (हिन्दी)\nआपने हमसे जो दवा खरीदी थी, उसका एक बैच नियामक की सूची में आया है। कृपया पट्टी अपने फार्मासिस्ट के पास लाएँ।\n\n_DRAFTS ONLY: RIPPLE sends nothing. A pharmacist must review before any patient is contacted. No safety or medical claim is made._` });
      return o.done('Drafted supplier and patient notices (English and Hindi); nothing sent.');
    }
    if (role === 'rc_sentinel') {
      const o = new Out(role, `${A}-sentinel@1`); if (open.length) return o.done('Waiting for the QA Head on look-alike batches; no order proposed.'); if (!conf.length) return o.done('Nothing to stop.');
      const lines = conf.map((h) => `- ${h.store}: ${h.drug} batch ${h.batch} (${h.qty} units): REMOVE FROM SALE`).join('\n');
      o.draft({ kind: 'stop_sale', name: `Stop-sale ${c.recallId}`, artifactKey: 'stop_sale', content: `# Stop-sale order ${c.recallId}\n\n${lines}\n\nApproval: the QA Head (${plan.qaHeadEmail}) must approve.\n\n**DRY-RUN: no store was contacted.** RIPPLE sends no order to any store or chat.` });
      o.act({ key: 'act-stop-sale', type: 'stop_sale_order', title: `Stop-sale order for ${conf.length} batch(es) (dry-run)`, connector: 'internal_notify', ownerRole: 'rc_sentinel', consequential: true, draftKind: 'stop_sale', approvalRole: 'manager', ackRoles: ['rc_store_manager'], rationale: 'Only the QA Head may approve. Approving records the order; it contacts no store.', target: `recall/${c.recallId}`, effectKey: `recall-${c.recallId}-${conf.map((h) => h.storeId + norm(h.batch)).sort().join('')}`, approver: { email: plan.qaHeadEmail } });
      return o.done(`Stop-sale order proposed for ${conf.length} confirmed match(es).`);
    }
    if (role === 'rc_runner') { const o = new Out(role, `${A}-runner@1`); const out = outstandingChecks(conf, c); if (conf.length) { if (out.length) o.warn(`${out.length} store check(s) outstanding: ${out.map((h) => `${h.store} ${h.recalled}`).join(', ')}.`, true); else o.info('Every confirmed batch has a recorded shelf read equal to the recalled batch.'); } return o.done(conf.length ? `${conf.length - out.length}/${conf.length} shelf checks recorded.` : 'No checks needed.'); }
    return new Out(role, `${A}-human@1`).done('Human role.');
  },
  verifyAction(action, observed, _r, ctx) {
    const out: { name: string; passed: boolean; detail: string }[] = []; if (action.type !== 'stop_sale_order') return out; const t = observed.content;
    out.push({ name: 'labelled dry-run, no store contacted', passed: t.includes('DRY-RUN: no store was contacted'), detail: 'scope statement present' });
    out.push({ name: 'contains no patient message text', passed: !/patient message|रोगी/i.test(t), detail: 'order and patient notice stay separate' });
    if (ctx) { const hits = confirmedHits(ctx.baselinePlan as Plan, ctx.change as Change, ctx.answers); const missing = hits.filter((h) => !t.includes(`${h.store}: ${h.drug} batch ${h.batch}`)); out.push({ name: 'order lists exactly the confirmed matches (re-computed)', passed: missing.length === 0 && (t.match(/REMOVE FROM SALE/g)?.length ?? 0) === hits.length, detail: missing.length ? `missing: ${missing.map((h) => h.batch).join(', ')}` : `${hits.length} line(s) match` }); }
    return out;
  },
  completionChecks(ctx) {
    const plan = ctx.baselinePlan as Plan; const c = ctx.change as Change; const hits = match(plan, c); const unanswered = hits.filter((h) => h.kind === 'lookalike' && !ctx.answers[qKey(h)]); const conf = confirmedHits(plan, c, ctx.answers); const out = outstandingChecks(conf, c);
    return [{ key: 'lookalikes_decided', label: 'Every look-alike batch was decided by the QA Head', passed: unanswered.length === 0, detail: unanswered.length ? `${unanswered.length} undecided` : 'all decided' },
      { key: 'shelf_checks', label: 'Every confirmed store batch has a recorded shelf read equal to the recalled batch', passed: out.length === 0, detail: out.length ? `outstanding: ${out.map((h) => `${h.store} ${h.recalled}`).join(', ')}` : `${conf.length} checked` }];
  },
};
