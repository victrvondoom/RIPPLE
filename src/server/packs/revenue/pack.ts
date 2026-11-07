import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';
import { opBlock, parseState, readWarehouse, SANDBOX_LABEL, usd, type Seed, type WarehouseRead } from './lab.js';

/**
 * Revenue Recovery: the flagship cross-capability workflow.
 *   deploy renames an upstream field → revenue pipeline silently under-reports →
 *   Observer reads the (sandbox) warehouse → two investigators form COMPETING hypotheses → Memory Keeper retrieves the
 *   standing decision and the precedent incident → Adversarial Reviewer tests every hypothesis against observed evidence →
 *   the incident commander chooses the remediation (bound to the confirmed root cause) → each operation is approved on its
 *   exact payload → executed in the sandbox → independently re-read and checked against business invariants.
 * A scripted scenario fault (lost response + unreadable status once) is part of the workflow: the engine reads back, records
 * EXECUTION_UNKNOWN instead of guessing, and the recovery read-back verifies the effect without repeating it.
 * Inspired by SchemaCourt / Switch Data Room (dual-version fixtures), Countersign / Notary (independent verification),
 * OnCall Room / OpsRoom (hypotheses and history), CASCADE / Tableline (unknown state is never success). Original implementation.
 */
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const order = z.object({ id: z.string(), day: z.string(), at: z.string(), amount: z.number().int().nonnegative() });
export const planSchema = z.object({
  pipeline: z.object({ name: z.string().min(1), sourceTable: ident, amountField: ident, viewName: ident, producer: z.string().min(1), contractVersion: z.string().min(1) }),
  orders: z.array(order).min(1).max(5000),
  ledger: z.object({ source: z.string().min(1), totalCents: z.number().int().nonnegative() }),
  dependents: z.array(z.object({ key: z.string(), label: z.string(), owner: z.string() })).default([]),
  memory: z.object({
    decisions: z.array(z.object({ id: z.string(), date: z.string(), text: z.string(), owner: z.string(), rationale: z.string(), reopenIf: z.string().default('') })).default([]),
    incidents: z.array(z.object({ id: z.string(), date: z.string(), summary: z.string(), rootCause: z.string(), fix: z.string() })).default([]),
  }).default({ decisions: [], incidents: [] }),
  scenarioFaults: z.array(z.object({ op: z.enum(['apply_mapping', 'recompute', 'rollback', 'backfill']), kind: z.literal('lost_response'), label: z.string() })).default([]),
  financeContact: z.string().default('finance@harborvine.example'),
});
export const changeSchema = z.object({
  alertId: z.string().min(1), receivedOn: z.string(), source: z.string().default('revenue-monitor'), note: z.string().default(''),
  deploy: z.object({ commit: z.string().min(4), baseCommit: z.string().min(4), service: z.string(), deployedAt: z.string(), renamed: z.array(z.object({ from: ident, to: ident })).default([]) }),
});
type Plan = z.infer<typeof planSchema>;
type Change = z.infer<typeof changeSchema>;
interface Hyp { id: string; by: string; claim: string; confidence: number; predicts: string }
type OpName = 'apply_mapping' | 'recompute' | 'rollback' | 'backfill';

export const seedOf = (p: Plan, c: Change): Seed => ({ orders: p.orders, ledgerCents: p.ledger.totalCents, deploy: c.deploy, amountField: p.pipeline.amountField });
const fp = (c: Change, field: string) => createHash('sha256').update(`${c.deploy.commit}|${field}|${c.deploy.renamed.map((r) => `${r.from}>${r.to}`).join(',')}`).digest('hex').slice(0, 10);
const pct = (a: number, b: number) => (b ? `${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a');

/** Tests each hypothesis's predictions against the observed warehouse. Deterministic: the evidence decides, not the confidence. */
export function review(read: WarehouseRead, c: Change, field: string, hyps: Hyp[]) {
  const ren = c.deploy.renamed.find((r) => r.from === field);
  return hyps.map((h) => {
    let verdict: 'confirmed' | 'refuted' | 'inconclusive' = 'inconclusive'; let evidence = '';
    if (h.id === 'H1') {
      const ok = !!ren && read.nullUnderMapping > 0 && !!read.firstNullAt && read.firstNullAt >= c.deploy.deployedAt && (read.storedField[ren.to] ?? 0) === read.nullUnderMapping;
      verdict = ok ? 'confirmed' : 'refuted';
      evidence = ren ? `${read.nullUnderMapping} row(s) unreadable under "${read.mapping}", first at ${read.firstNullAt ?? '—'} (deploy ${c.deploy.deployedAt}); ${read.storedField[ren.to] ?? 0} row(s) carry "${ren.to}".` : 'the deploy renamed no field the pipeline reads.';
    } else if (h.id === 'H2') {
      verdict = read.rows < read.ledgerRows ? 'confirmed' : 'refuted';
      evidence = `warehouse holds ${read.rows} order row(s); the finance ledger lists ${read.ledgerRows}. Late data would show fewer rows.`;
    } else if (h.id === 'H3') {
      const matchDays = read.perDay.filter((d) => d.pipelineCents === d.ledgerCents).length;
      verdict = read.nullUnderMapping > 0 || matchDays === read.perDay.length ? 'refuted' : 'confirmed';
      evidence = `a units bug would give wrong NON-NULL amounts; observed ${read.nullUnderMapping} NULL amount(s) and ${matchDays}/${read.perDay.length} day(s) that still match the ledger exactly.`;
    }
    return { ...h, verdict, evidence };
  });
}

export const revenuePack: WorkflowPack = {
  tier: 'extended', system: 'data',
  id: 'revenue-recovery',
  name: 'Revenue Recovery',
  domain: 'Data Incident & Revenue Integrity',
  version: '1.0.0',
  description: 'Flagship workflow: an upstream deploy renames a field and revenue silently under-reports. Agents observe the warehouse, form competing hypotheses, retrieve the standing decision and precedent, an adversarial reviewer tests every hypothesis against evidence, the incident commander picks the fix, and every sandbox operation is approved, executed, independently re-read and checked against the finance ledger, including recovery from a lost response.',
  labels: { baseline: 'Revenue pipeline contract', change: 'Revenue alert', changeVerb: 'Raise revenue alert', plan: 'Pipeline contract', mission: 'Revenue incident room', blurb: 'Failure → competing hypotheses → evidence → human decision → approved sandbox action → independent verification → recovery → proof.' },
  roles: [
    { key: 'rev_observer', name: 'Observer', kind: 'agent', responsibility: 'Reads the warehouse (sandbox) and the finance ledger; facts only', department: 'Data' },
    { key: 'deploy_investigator', name: 'Deploy Investigator', kind: 'agent', responsibility: 'Correlates the alert with recent deploys and field changes; forms a hypothesis', department: 'Engineering' },
    { key: 'pipeline_investigator', name: 'Pipeline Investigator', kind: 'agent', responsibility: 'Inspects pipeline behaviour (jobs, volumes, units); forms independent hypotheses', department: 'Data' },
    { key: 'memory_keeper', name: 'Memory Keeper', kind: 'agent', responsibility: 'Retrieves standing decisions and precedent incidents; flags decisions the change contradicts', department: 'Governance' },
    { key: 'adversarial_reviewer', name: 'Adversarial Reviewer', kind: 'agent', responsibility: 'Tests every hypothesis against observed evidence; never accepts a claim without it', department: 'Governance' },
    { key: 'remediation_planner', name: 'Remediation Planner', kind: 'agent', responsibility: 'Turns the confirmed root cause and the human choice into exact, approvable operations', department: 'Data' },
    { key: 'incident_commander', name: 'Incident Commander', kind: 'human', responsibility: 'Chooses the remediation and approves each operation', department: 'Operations' },
    { key: 'revenue_controller', name: 'Revenue Controller', kind: 'human', responsibility: 'Owns revenue reporting and the field-rename decision', department: 'Finance' },
  ],
  roleOrder: ['rev_observer', 'deploy_investigator', 'pipeline_investigator', 'memory_keeper', 'adversarial_reviewer', 'remediation_planner'],
  roleDeps: { deploy_investigator: ['rev_observer'], pipeline_investigator: ['rev_observer'], memory_keeper: ['deploy_investigator'], adversarial_reviewer: ['rev_observer', 'deploy_investigator', 'pipeline_investigator'], remediation_planner: ['adversarial_reviewer', 'memory_keeper'] },
  planSchema, changeSchema,
  artifacts: [
    { key: 'observation', label: 'Warehouse observation (facts)', department: 'Data', ownerRole: 'rev_observer', description: 'Pipeline total vs finance ledger, NULL propagation, per-day breakdown' },
    { key: 'hypotheses', label: 'Competing root-cause hypotheses', department: 'Engineering', ownerRole: 'adversarial_reviewer', description: 'Every hypothesis with its prediction and the evidence verdict' },
    { key: 'precedent', label: 'Decision memory & precedent', department: 'Governance', ownerRole: 'memory_keeper', description: 'Standing decisions and similar past incidents' },
    { key: 'remediation', label: 'Approved remediation operations', department: 'Data', ownerRole: 'remediation_planner', description: 'Exact sandbox operations bound to the confirmed root cause' },
    { key: 'postmortem', label: 'Postmortem & learning', department: 'Governance', ownerRole: 'remediation_planner', description: 'Timeline, refuted hypotheses, decision, prevention' },
  ],
  rules: [
    { id: 'rev.deploy', trigger: (i) => i.field === 'deploy.commit', to: 'observation', relation: 'requires_observation', why: 'A deploy near the alert must be checked against real data' },
    { id: 'rev.rename', trigger: (i) => i.field.startsWith('deploy.renamed'), to: 'hypotheses', relation: 'raises_hypothesis', why: 'A renamed field the pipeline reads is a candidate root cause' },
    { id: 'rev.variance', trigger: (i) => i.field === 'revenue.variance', to: 'precedent', relation: 'retrieves_memory', why: 'Revenue variance has precedent and owners' },
  ],
  artifactEdges: [
    { from: 'observation', to: 'hypotheses', relation: 'tests', why: 'Hypotheses are judged only on observed evidence' },
    { from: 'precedent', to: 'remediation', relation: 'informs', why: 'Past fixes and standing decisions shape the plan' },
    { from: 'hypotheses', to: 'remediation', relation: 'motivates', why: 'Only a confirmed root cause is remediated' },
    { from: 'remediation', to: 'postmortem', relation: 'recorded_in', why: 'Every incident leaves a learning record' },
  ],
  decisions: [{ key: 'remediation_choice', label: 'Incident commander chooses the remediation', ownerRole: 'incident_commander', gates: ['remediation'] }],

  sample() {
    const days = ['2026-11-03', '2026-11-04', '2026-11-05'];
    const orders = days.flatMap((day, di) => Array.from({ length: 8 }, (_, i) => ({ id: `ord-${di + 1}${String(i + 1).padStart(2, '0')}`, day, at: `${day}T${String(9 + i).padStart(2, '0')}:15:00Z`, amount: 2500 + ((i * 731 + di * 389) % 9000) })));
    const total = orders.reduce((s, o) => s + o.amount, 0);
    return {
      title: 'REV-2611: revenue_daily under-reports after checkout-api deploy',
      plan: {
        pipeline: { name: 'revenue_daily', sourceTable: 'orders', amountField: 'amount_cents', viewName: 'revenue_daily_mv', producer: 'checkout-api', contractVersion: 'orders.v4' },
        orders, ledger: { source: 'finance-ledger (independent)', totalCents: total },
        dependents: [{ key: 'revenue_daily_mv', label: 'Revenue view', owner: 'Data' }, { key: 'exec_dashboard', label: 'Executive KPI dashboard', owner: 'Finance' }, { key: 'invoice_export', label: 'Month-end invoice export', owner: 'Finance' }],
        memory: {
          decisions: [{ id: 'DEC-2026-014', date: '2026-08-12', text: 'Breaking renames of order fields must keep the old field as an alias for one release.', owner: 'Revenue Controller', rationale: 'Finance pipelines read order amounts directly; a silent rename corrupts revenue.', reopenIf: 'All consumers migrated to the new name' }],
          incidents: [{ id: 'INC-2026-071', date: '2026-07-02', summary: 'discount_cents moved to promo_discount_cents; net revenue overstated', rootCause: 'upstream field move without alias', fix: 'COALESCE mapping in the consumer, then recompute the view' }],
        },
        scenarioFaults: [{ op: 'recompute', kind: 'lost_response', label: 'The warehouse commits the recompute, the response is lost, and the status endpoint is unreadable once' }],
        financeContact: 'finance@harborvine.example',
      },
      change: { alertId: 'REV-2611', receivedOn: '2026-11-05', source: 'revenue-monitor', note: 'Finance reports revenue_daily is lower than the ledger since yesterday.', deploy: { commit: '9f2c1ab7', baseCommit: '4e7d0a21', service: 'checkout-api', deployedAt: '2026-11-04T12:00:00Z', renamed: [{ from: 'amount_cents', to: 'amount_minor' }] } },
    };
  },

  detectChanges(plan: Plan, c: Change): ChangeItem[] {
    const read = readWarehouse(seedOf(plan, c), []);
    return [
      { field: 'deploy.commit', label: `${c.deploy.service} deployed ${c.deploy.commit} (from ${c.deploy.baseCommit})`, before: c.deploy.baseCommit, after: c.deploy.commit, kind: 'modified', severity: 'high' },
      ...c.deploy.renamed.map((r, i): ChangeItem => ({ field: `deploy.renamed.${i}`, label: `Field renamed: ${r.from} → ${r.to}`, before: r.from, after: r.to, kind: 'modified', severity: r.from === plan.pipeline.amountField ? 'high' : 'medium' })),
      { field: 'revenue.variance', label: `${plan.pipeline.name} vs ${plan.ledger.source}`, before: usd(plan.ledger.totalCents), after: usd(read.pipelineCents), kind: 'modified', severity: read.pipelineCents === plan.ledger.totalCents ? 'low' : 'high' },
    ];
  },
  applyChange(plan: Plan): Plan { return structuredClone(plan); },
  parseAnswer(key, text) {
    if (key.startsWith('remediation_')) {
      const t = text.trim().toLowerCase();
      if (/hot ?fix|coalesce|mapping|^a$/.test(t)) return { value: 'hotfix' };
      if (/roll ?back|revert|^b$/.test(t)) return { value: 'rollback' };
      return { error: 'Answer "hotfix" (A) or "rollback" (B).' };
    }
    return { value: text.trim() };
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const plan = ctx.plan as Plan; const c = ctx.change as Change; const P = 'revenue-analyzer';
    const field = plan.pipeline.amountField; const seed = seedOf(plan, c);
    const read = readWarehouse(seed, []);
    const ren = c.deploy.renamed.find((r) => r.from === field);

    if (role === 'rev_observer') {
      const o = new Out(role, `${P}-observer@1`);
      o.info(`Observed in the ${SANDBOX_LABEL}.`);
      if (read.pipelineCents !== read.ledgerCents) o.risk(`OBSERVED: ${plan.pipeline.name} = ${usd(read.pipelineCents)} vs ${plan.ledger.source} = ${usd(read.ledgerCents)} (${pct(read.pipelineCents, read.ledgerCents)}).`);
      else o.info(`OBSERVED: ${plan.pipeline.name} matches the ledger (${usd(read.ledgerCents)}).`);
      if (read.nullUnderMapping) o.risk(`OBSERVED: ${read.nullUnderMapping} of ${read.rows} order row(s) read NULL for "${read.mapping}", first at ${read.firstNullAt}.`);
      o.info(`OBSERVED: ${read.rows} order row(s) in the warehouse, ${read.ledgerRows} in the ledger.`);
      o.data = { read };
      o.draft({ kind: 'observation', name: `Observation: ${c.alertId}`, artifactKey: 'observation', content: `# Warehouse observation (facts only): ${c.alertId}\n\nSource: ${SANDBOX_LABEL}\n\n${table(['Day', plan.pipeline.name, 'Ledger', 'Δ'], read.perDay.map((d) => [d.day, usd(d.pipelineCents), usd(d.ledgerCents), d.pipelineCents === d.ledgerCents ? '0' : usd(d.pipelineCents - d.ledgerCents)]))}\n\nRows unreadable under \`${read.mapping}\`: ${read.nullUnderMapping} (first at ${read.firstNullAt ?? '—'}).` });
      return o.done(read.pipelineCents === read.ledgerCents ? 'Revenue matches the ledger.' : `Revenue under-reported by ${usd(read.ledgerCents - read.pipelineCents)}.`);
    }

    if (role === 'deploy_investigator') {
      const o = new Out(role, `${P}-deploy@1`);
      const hyps: Hyp[] = ren ? [{ id: 'H1', by: 'Deploy Investigator', claim: `${c.deploy.service} ${c.deploy.commit} renamed "${ren.from}" to "${ren.to}"; the pipeline still reads "${ren.from}", so post-deploy rows read NULL.`, confidence: 0.8, predicts: 'NULL amounts only for rows written after the deploy, and those rows carry the new field' }] : [];
      if (ren) o.warn(`HYPOTHESIS H1 (confidence 0.80): ${hyps[0].claim}`);
      else o.info(`The deploy ${c.deploy.commit} renamed no field the pipeline reads (${field}).`);
      o.data = { hypotheses: hyps };
      return o.done(ren ? 'Proposed H1: field rename in the deploy.' : 'No deploy-side hypothesis.');
    }

    if (role === 'pipeline_investigator') {
      const o = new Out(role, `${P}-pipeline@1`);
      const hyps: Hyp[] = [
        { id: 'H2', by: 'Pipeline Investigator', claim: 'Ingestion lag: late-arriving orders after the 12:00 batch are missing from revenue_daily.', confidence: 0.45, predicts: 'fewer order rows in the warehouse than in the ledger' },
        { id: 'H3', by: 'Pipeline Investigator', claim: 'Units bug: amounts are converted with the wrong scale after the release.', confidence: 0.2, predicts: 'wrong but non-NULL amounts' },
      ];
      o.warn(`HYPOTHESIS H2 (confidence 0.45): ${hyps[0].claim} The pipeline job reported success, so I do not attribute this to the schema.`);
      o.info(`HYPOTHESIS H3 (confidence 0.20): ${hyps[1].claim}`);
      o.data = { hypotheses: hyps };
      return o.done('Proposed H2 (ingestion lag) and H3 (units). Disagrees with a schema explanation.');
    }

    if (role === 'memory_keeper') {
      const o = new Out(role, `${P}-memory@1`);
      const words = [field, ...(ren ? [ren.to] : []), 'rename', 'alias', 'moved'].map((w) => w.toLowerCase());
      const decisions = plan.memory.decisions.filter((d) => words.some((w) => d.text.toLowerCase().includes(w)));
      const incidents = plan.memory.incidents.filter((i) => words.some((w) => `${i.summary} ${i.rootCause}`.toLowerCase().includes(w)));
      for (const d of decisions) {
        o.warn(`STANDING DECISION ${d.id} (${d.date}, owner ${d.owner}): "${d.text}" Rationale: ${d.rationale}.`);
        if (ren) o.risk(`CONTRADICTION: ${c.deploy.commit} removed "${ren.from}" without an alias, which ${d.id} forbids. Reopen only if: ${d.reopenIf || 'not stated'}.`);
        o.work({ key: `review-${d.id}`, title: `Confirm whether ${d.id} still stands after ${c.deploy.commit}`, detail: d.text, department: 'Finance', roleKey: 'revenue_controller', kind: 'decision', artifactKey: 'precedent' });
      }
      for (const i of incidents) o.info(`PRECEDENT ${i.id} (${i.date}): ${i.summary}. Root cause: ${i.rootCause}. Fix: ${i.fix}.`);
      if (!decisions.length && !incidents.length) o.info('No standing decision or precedent incident matches this change.');
      o.data = { decisions, incidents };
      o.draft({ kind: 'precedent', name: 'Decision memory & precedent', artifactKey: 'precedent', content: `# Decision memory\n\n${decisions.map((d) => `- **${d.id}** (${d.owner}): ${d.text}\n  - why: ${d.rationale}\n  - reopen if: ${d.reopenIf || '—'}`).join('\n') || '- none'}\n\n# Precedent incidents\n\n${incidents.map((i) => `- **${i.id}**: ${i.summary} → ${i.fix}`).join('\n') || '- none'}` });
      return o.done(`${decisions.length} decision(s), ${incidents.length} precedent(s) retrieved.`);
    }

    const hyps: Hyp[] = [...((ctx.results.deploy_investigator?.data?.hypotheses as Hyp[]) ?? []), ...((ctx.results.pipeline_investigator?.data?.hypotheses as Hyp[]) ?? [])];
    const judged = review(read, c, field, hyps);
    const accepted = judged.filter((h) => h.verdict === 'confirmed');

    if (role === 'adversarial_reviewer') {
      const o = new Out(role, `${P}-reviewer@1`);
      const deployH = judged.filter((h) => h.by === 'Deploy Investigator'); const pipeH = judged.filter((h) => h.by === 'Pipeline Investigator');
      if (deployH.length && pipeH.length) o.warn(`DISAGREEMENT: Deploy Investigator (${deployH.map((h) => h.id).join(', ')}) vs Pipeline Investigator (${pipeH.map((h) => h.id).join(', ')}). Resolved by evidence, not by confidence.`);
      for (const h of judged) {
        const text = `${h.id} ${h.verdict.toUpperCase()} (claimed ${h.confidence.toFixed(2)}): predicts ${h.predicts}. Evidence: ${h.evidence}`;
        if (h.verdict === 'confirmed') o.risk(text); else o.info(text);
      }
      if (accepted.length !== 1) o.ask({ key: `root_cause_${fp(c, field)}`, text: `The evidence ${accepted.length ? 'supports more than one' : 'supports none'} of the hypotheses. Describe the root cause you have verified.`, blocking: true, assigneeRole: 'incident_commander' });
      o.data = { judged, accepted: accepted.map((h) => h.id) };
      o.draft({ kind: 'hypotheses', name: 'Hypotheses & evidence verdicts', artifactKey: 'hypotheses', content: `# Root-cause hypotheses (adversarial review)\n\n${table(['Id', 'By', 'Claim', 'Claimed conf.', 'Verdict', 'Evidence'], judged.map((h) => [h.id, h.by, h.claim, h.confidence.toFixed(2), h.verdict, h.evidence]))}` });
      return o.done(accepted.length === 1 ? `Root cause confirmed by evidence: ${accepted[0].id}; ${judged.length - 1} alternative(s) refuted.` : 'No single hypothesis survived review; escalated.');
    }

    // remediation_planner
    const o = new Out(role, `${P}-planner@1`);
    if (accepted.length !== 1 || accepted[0].id !== 'H1' || !ren) return o.done('Waiting for a confirmed, remediable root cause; nothing proposed.');
    const qKey = `remediation_${fp(c, field)}`;
    const choice = ctx.answers[qKey]?.value as 'hotfix' | 'rollback' | undefined;
    if (!choice) {
      o.ask({ key: qKey, text: `Root cause confirmed (H1: ${ren.from} → ${ren.to} in ${c.deploy.commit}). Choose the remediation: "hotfix" = read ${ren.from} OR ${ren.to} in the pipeline, then recompute ${plan.pipeline.viewName} (recommended; matches precedent ${plan.memory.incidents[0]?.id ?? '—'}); "rollback" = revert to ${c.deploy.baseCommit}, backfill the renamed rows, then recompute.`, blocking: true, assigneeRole: 'incident_commander' });
      return o.done('Root cause confirmed; waiting for the incident commander to choose the remediation.');
    }
    const step = (op: OpName, name: string, explain: string) => {
      const f = plan.scenarioFaults.find((x) => x.op === op);
      o.draft({ kind: `op_${op}`, name, artifactKey: 'remediation', content: `# ${name}\n\n${explain}\n\nTarget: ${SANDBOX_LABEL}.\nBound to root cause H1 (${c.deploy.commit}, ${ren.from} → ${ren.to}) and the commander's choice "${choice}".${f ? `\n\nScripted scenario fault on this step (labelled, part of the demo): ${f.label}.` : ''}\n\n${opBlock({ op, seed, fault: f?.kind })}` });
      o.act({ key: `act-${op}`, type: `warehouse_${op}`, title: name, connector: 'warehouse_sandbox', ownerRole: 'remediation_planner', consequential: true, draftKind: `op_${op}`, approvalRole: 'manager', approver: { role: 'incident_commander' }, ackRoles: [], rationale: explain, target: `${plan.pipeline.sourceTable}/${plan.pipeline.viewName}`, effectKey: `${op}:${c.deploy.commit}` });
    };
    if (choice === 'hotfix') step('apply_mapping', `Pipeline reads COALESCE(${ren.from}, ${ren.to})`, `Make ${plan.pipeline.name} read both the legacy and the renamed field. Verified with dual-version fixtures.`);
    else { step('rollback', `Roll ${c.deploy.service} back to ${c.deploy.baseCommit}`, 'Stops new rows being written with the renamed field.'); step('backfill', `Backfill ${ren.to} → ${ren.from} for rows written during the drift`, 'Rows written between the deploy and the rollback still carry the renamed field.'); }
    step('recompute', `Recompute ${plan.pipeline.viewName}`, `Rebuild the materialised revenue view so dashboards and the invoice export read the corrected total (${usd(plan.ledger.totalCents)} per the ledger).`);
    o.draft({ kind: 'finance_notice', name: 'Revenue restatement notice', artifactKey: 'remediation', content: `Subject: ${c.alertId} revenue_daily restated\n\nRevenue for ${read.perDay.map((d) => d.day).join(', ')} was under-reported by ${usd(read.ledgerCents - read.pipelineCents)} because ${c.deploy.service} ${c.deploy.commit} renamed ${ren.from} to ${ren.to}.\nRemediation chosen by the incident commander: ${choice}. Expected total after the verified recompute: ${usd(plan.ledger.totalCents)} (per ${plan.ledger.source}).\nThis notice describes recorded evidence only; RIPPLE does not sign off financial statements. Affected: ${plan.dependents.map((d) => d.label).join(', ')}.` });
    o.act({ key: 'act-finance-notice', type: 'finance_notice', title: 'Notify finance of the restatement (dry-run email)', connector: 'email_outbox', ownerRole: 'remediation_planner', consequential: true, draftKind: 'finance_notice', approvalRole: 'manager', approver: { role: 'incident_commander' }, ackRoles: [], rationale: 'Finance owns the restated numbers.', target: plan.financeContact, effectKey: `notice:${c.alertId}` });
    o.draft({ kind: 'postmortem', name: `Postmortem: ${c.alertId}`, artifactKey: 'postmortem', content: `# Postmortem ${c.alertId}\n\n## Timeline\n- ${c.deploy.deployedAt}: ${c.deploy.service} ${c.deploy.commit} deployed (${ren.from} → ${ren.to}).\n- ${read.firstNullAt}: first NULL amount in ${plan.pipeline.name}.\n- ${c.receivedOn}: alert from ${c.source}.\n\n## Hypotheses\n${judged.map((h) => `- ${h.id} (${h.by}, ${h.confidence.toFixed(2)}): **${h.verdict}**. ${h.evidence}`).join('\n')}\n\n## Decision\nIncident commander chose **${choice}**.\n\n## Prevention\n- Enforce ${plan.memory.decisions[0]?.id ?? 'the alias rule'} in the producer's CI: breaking renames keep an alias for one release.\n- Keep the dual-version fixtures as a permanent regression test.` });
    o.act({ key: 'act-postmortem', type: 'postmortem', title: `File postmortem ${c.alertId}`, connector: 'document_store', ownerRole: 'remediation_planner', consequential: false, draftKind: 'postmortem', approvalRole: 'manager', ackRoles: [], rationale: 'Learning record for the organisation memory.', target: 'postmortems', effectKey: `postmortem:${c.alertId}` });
    return o.done(`Remediation "${choice}" prepared as ${choice === 'hotfix' ? 2 : 3} sandbox operation(s) + finance notice + postmortem, each awaiting approval.`);
  },

  verifyAction(action, observed, _revised, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (!ctx) return checks;
    const plan = ctx.baselinePlan as Plan; const c = ctx.change as Change;
    if (action.type.startsWith('warehouse_')) {
      const st = parseState(observed.content);
      checks.push({ name: 'independent warehouse read-back parsed', passed: !!st, detail: st ? `${st.sandbox}; ops applied: ${st.ops.join(' → ')}` : 'no observed state in the read-back' });
      if (!st) return checks;
      if (action.type === 'warehouse_apply_mapping') {
        for (const f of st.fixtures) checks.push({ name: `regression fixture: ${f.name}`, passed: f.ok, detail: `mapped ${f.mapped ?? 'NULL'} (want ${f.want}) under ${st.mapping}` });
        checks.push({ name: 'no NULL amounts under the new mapping', passed: st.nullUnderMapping === 0, detail: `${st.nullUnderMapping} unreadable row(s)` });
      }
      if (action.type === 'warehouse_rollback') checks.push({ name: 'deployed commit is the base commit', passed: st.deployedCommit === c.deploy.baseCommit, detail: `deployed ${st.deployedCommit}` });
      if (action.type === 'warehouse_backfill') checks.push({ name: 'no row still carries the renamed field', passed: !c.deploy.renamed.some((r) => (st.storedField[r.to] ?? 0) > 0), detail: JSON.stringify(st.storedField) });
      if (action.type === 'warehouse_recompute') {
        checks.push({ name: 'business invariant: revenue view = finance ledger', passed: st.viewCents === plan.ledger.totalCents, detail: `view ${usd(st.viewCents)} vs ledger ${usd(plan.ledger.totalCents)}` });
        checks.push({ name: 'every day reconciles to the ledger', passed: st.perDay.every((d) => d.pipelineCents === d.ledgerCents), detail: st.perDay.map((d) => `${d.day} ${d.pipelineCents === d.ledgerCents ? 'ok' : `off by ${usd(d.pipelineCents - d.ledgerCents)}`}`).join(', ') });
        checks.push({ name: 'view is fresh (no stale snapshot)', passed: st.viewFresh, detail: st.viewFresh ? 'view equals the live pipeline' : 'view differs from the live pipeline' });
      }
    }
    if (action.type === 'finance_notice') {
      checks.push({ name: 'notice states the ledger total', passed: observed.content.includes(usd(plan.ledger.totalCents)), detail: usd(plan.ledger.totalCents) });
      checks.push({ name: 'notice names the root-cause commit', passed: observed.content.includes(c.deploy.commit), detail: c.deploy.commit });
      checks.push({ name: 'notice makes no certification claim', passed: !/\b(certif(y|ied)|guarantee[sd]?)\b/i.test(observed.content), detail: 'no certification or guarantee wording' });
    }
    return checks;
  },

  completionChecks(ctx) {
    const plan = ctx.baselinePlan as Plan; const c = ctx.change as Change;
    const read = readWarehouse(seedOf(plan, c), []);
    const hyps: Hyp[] = c.deploy.renamed.some((r) => r.from === plan.pipeline.amountField) ? [{ id: 'H1', by: 'Deploy Investigator', claim: '', confidence: 0.8, predicts: '' }] : [];
    const ok = review(read, c, plan.pipeline.amountField, hyps).some((h) => h.verdict === 'confirmed');
    const chosen = Object.keys(ctx.answers).some((k) => k.startsWith('remediation_'));
    return [
      { key: 'root_cause_confirmed', label: 'Root cause confirmed by evidence (not by agent confidence)', passed: ok, detail: ok ? 'H1 confirmed by the adversarial review' : 'no confirmed root cause' },
      { key: 'human_choice', label: 'Remediation chosen by the incident commander', passed: chosen, detail: chosen ? 'recorded' : 'not chosen yet' },
    ];
  },
};
