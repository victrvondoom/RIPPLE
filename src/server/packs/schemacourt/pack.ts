import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';

/**
 * SchemaCourt pack, inherited from SchemaCourt (github.com/miheergathibandhe/SchemaCourt: "separate facts from proposals",
 * "human approval before code changes", "dual-fixture verification", "decision record") and tightened:
 *  - the consumer model is REALLY executed (in-memory SQLite) against a LEGACY and a DRIFTED fixture; variance is measured, not typed in;
 *  - the repair is derived by rewriting the model SQL, then proven on BOTH fixtures before it is even proposed;
 *  - the verifier re-extracts the stored patch from the connector read-back and re-runs it independently;
 *  - only the named data steward can approve. RIPPLE records the approved patch; it never touches a warehouse.
 * Limits: fixtures are the small samples carried in the plan (not production data); SQLite dialect; read-only single SELECT models only.
 */
const cell = z.union([z.string(), z.number(), z.null()]);
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a plain SQL identifier');
export const planSchema = z.object({
  contract: z.object({ streamName: ident, producerService: z.string().min(1), contractVersion: z.string().min(1), consumerPipelines: z.array(z.string()).default([]), environment: z.string().default('prod') }),
  model: z.object({ name: z.string().min(1), sql: z.string().min(10), revenueColumn: ident.default('net_cents') }),
  fixtures: z.object({ columns: z.array(ident).min(2), legacy: z.array(z.array(cell)).min(1).max(5000), drifted: z.array(z.array(cell)).min(1).max(5000) }),
  dataSteward: z.string().min(3),
  driftLog: z.array(z.object({ driftId: z.string(), column: z.string() })).default([]),
});
export const changeSchema = z.object({
  driftId: z.string().min(1), detectedAt: z.string(), producerVersion: z.string().default('unknown'),
  affectedColumn: ident, replacementColumn: ident.optional(), driftSummary: z.string().default(''), note: z.string().default(''),
});
type Plan = z.infer<typeof planSchema>;
type Drift = z.infer<typeof changeSchema>;
type Row = Record<string, string | number | null>;

const FORBIDDEN = /\b(attach|detach|pragma|insert|update|delete|drop|create|alter|replace|vacuum|with|recursive|load_extension|readfile|writefile|randomblob|zeroblob)\b/i;
/** The model must be ONE read-only SELECT. Anything else is rejected before it can run. */
export function assertReadOnlySelect(sql: string): string {
  const s = sql.trim().replace(/;+\s*$/, '');
  if (!/^select\b/i.test(s)) throw new Error('Model SQL must be a single SELECT statement.');
  if (s.includes(';')) throw new Error('Model SQL must be a single statement (no semicolons).');
  if (FORBIDDEN.test(s)) throw new Error('Model SQL may only read: write/DDL/recursive/extension keywords are not allowed.');
  return s;
}
/** Executes the model on a fixture in a throw-away in-memory SQLite database. */
export function runModel(sql: string, table_: string, columns: string[], rows: (string | number | null)[][]): Row[] {
  const safe = assertReadOnlySelect(sql);
  const db = new DatabaseSync(':memory:');
  try {
    const types = columns.map((_, i) => (rows.some((r) => typeof r[i] === 'string') ? 'TEXT' : 'INTEGER'));
    db.exec(`CREATE TABLE ${table_} (${columns.map((c, i) => `${c} ${types[i]}`).join(', ')})`);
    const ins = db.prepare(`INSERT INTO ${table_} VALUES (${columns.map(() => '?').join(',')})`);
    for (const r of rows) ins.run(...r);
    return db.prepare(safe).all() as Row[];
  } finally { db.close(); }
}
const keyOf = (r: Row) => String(Object.values(r)[0]);
export interface Cmp { key: string; base?: Row; other?: Row; ok: boolean }
export function compare(base: Row[], other: Row[]): Cmp[] {
  const keys = [...new Set([...base.map(keyOf), ...other.map(keyOf)])].sort();
  return keys.map((key) => {
    const b = base.find((r) => keyOf(r) === key); const o = other.find((r) => keyOf(r) === key);
    return { key, base: b, other: o, ok: !!b && !!o && Object.keys(b).every((k) => b[k] === o[k]) };
  });
}
const nonNull = (cols: string[], rows: (string | number | null)[][], c: string) => { const i = cols.indexOf(c); return rows.filter((r) => r[i] !== null && r[i] !== undefined).length; };
/** Rewrites every bare reference to `column` in the model as COALESCE(column, replacement, 0). Returns null when nothing would change. */
export function buildPatch(sql: string, column: string, replacement: string): string | null {
  if (new RegExp(`COALESCE\\(\\s*${column}\\b`, 'i').test(sql)) return null;
  const out = sql.replace(new RegExp(`(?<![\\w.])${column}(?!\\w)`, 'g'), `COALESCE(${column}, ${replacement}, 0)`);
  return out === sql ? null : out;
}
const fmt = (r?: Row) => (r ? Object.entries(r).slice(1).map(([k, v]) => `${k}=${v === null ? 'NULL' : v}`).join(', ') : 'missing');
const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface Audit { baseline: Row[]; observed: Row[]; observedCmp: Cmp[]; replacement?: string; patch: string | null; patched?: { legacy: Cmp[]; drifted: Cmp[]; ok: boolean }; stats: { column: string; legacy: number; drifted: number; replacementLegacy: number; replacementDrifted: number } }
/** Everything the pack claims comes from here, and the verifier re-derives it from the stored patch. */
export function audit(plan: Plan, drift: Drift, answers: AnalysisContext['answers'] = {}): Audit {
  const f = plan.fixtures; const t = plan.contract.streamName;
  const replacement = drift.replacementColumn ?? (answers.replacement_column?.value as string | undefined);
  const baseline = runModel(plan.model.sql, t, f.columns, f.legacy);
  const observed = runModel(plan.model.sql, t, f.columns, f.drifted);
  const stats = { column: drift.affectedColumn, legacy: nonNull(f.columns, f.legacy, drift.affectedColumn), drifted: nonNull(f.columns, f.drifted, drift.affectedColumn), replacementLegacy: replacement ? nonNull(f.columns, f.legacy, replacement) : 0, replacementDrifted: replacement ? nonNull(f.columns, f.drifted, replacement) : 0 };
  const patch = replacement && f.columns.includes(replacement) && f.columns.includes(drift.affectedColumn) ? buildPatch(plan.model.sql, drift.affectedColumn, replacement) : null;
  let patched: Audit['patched'];
  if (patch) {
    const l = compare(baseline, runModel(patch, t, f.columns, f.legacy)); const d = compare(baseline, runModel(patch, t, f.columns, f.drifted));
    patched = { legacy: l, drifted: d, ok: l.every((x) => x.ok) && d.every((x) => x.ok) };
  }
  return { baseline, observed, observedCmp: compare(baseline, observed), replacement, patch, patched, stats };
}

export const schemacourtPack: WorkflowPack = {
  id: 'schemacourt',
  name: 'Schema Court',
  domain: 'Data Contracts & Analytics Governance',
  version: '1.1.0',
  description: 'Data-contract change review room: measures what an upstream schema change did to a downstream model by running it on legacy and drifted fixtures, proposes a backward-compatible patch only if it restores zero variance on both, and waits for the named data steward.',
  labels: { baseline: 'Data contract & consumer model', change: 'Schema drift report', changeVerb: 'Report drift', plan: 'Contract spec', mission: 'Contract review room', blurb: 'Measures drift by executing the model on both fixtures; proposes a patch only if it is proven on both; the data steward alone approves.' },
  roles: [
    { key: 'schema_sentinel', name: 'Schema Sentinel', kind: 'agent', responsibility: 'Measures column population and model output on the legacy and drifted fixtures (facts only)', department: 'Data' },
    { key: 'impact_auditor', name: 'Impact Auditor', kind: 'agent', responsibility: 'Computes the measured variance against the legacy baseline', department: 'Finance Data' },
    { key: 'sql_patcher', name: 'SQL Patcher', kind: 'agent', responsibility: 'Derives a backward-compatible patch and proves it on BOTH fixtures before proposing it', department: 'Data' },
    { key: 'data_steward', name: 'Data Steward', kind: 'human', responsibility: 'The only approver of a model change', department: 'Governance' },
  ],
  roleOrder: ['schema_sentinel', 'impact_auditor', 'sql_patcher'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'contract_audit', label: 'Contract drift audit (verified facts)', department: 'Data', ownerRole: 'schema_sentinel', description: 'Measured column population on both fixtures' },
    { key: 'revenue_impact', label: 'Measured revenue variance', department: 'Finance Data', ownerRole: 'impact_auditor', description: 'Model output on legacy vs drifted fixture, per group' },
    { key: 'sql_migration_patch', label: 'Patch PROPOSAL (proven on both fixtures)', department: 'Data', ownerRole: 'sql_patcher', description: 'Rewritten model SQL with the dual-fixture result' },
  ],
  rules: [
    { id: 'court.violation', trigger: (i) => i.field.includes('contract'), to: 'contract_audit', relation: 'audits_contract', why: 'A reported drift must be measured, not assumed' },
    { id: 'court.variance', trigger: (i) => i.field.includes('variance'), to: 'revenue_impact', relation: 'quantifies_impact', why: 'Downstream model output is compared to the legacy baseline' },
  ],
  artifactEdges: [
    { from: 'contract_audit', to: 'revenue_impact', relation: 'quantifies', why: 'Measured null population explains the model result' },
    { from: 'revenue_impact', to: 'sql_migration_patch', relation: 'motivates', why: 'A proven variance justifies a repair proposal' },
  ],
  decisions: [{ key: 'migration_auth', label: 'Data steward approves the model patch', ownerRole: 'data_steward', gates: ['sql_migration_patch'] }],

  sample() {
    const tiers = ['enterprise', 'free', 'pro']; const legacy: (string | number | null)[][] = []; const drifted: (string | number | null)[][] = [];
    tiers.forEach((tier, ti) => { for (let i = 0; i < 40; i++) {
      const gross = 1000 + ((i * 37 + ti * 211) % 9000); const disc = i % 4 === 0 ? 0 : (i * 13 + ti * 7) % 500;
      legacy.push([tier, gross, disc, null]); drifted.push([tier, gross, null, disc]);
    } });
    return {
      title: 'COURT-402: checkout-service v3.0 moved discount_cents',
      plan: {
        contract: { streamName: 'transactions', producerService: 'checkout-service', contractVersion: 'v2.8.0', consumerPipelines: ['fct_revenue', 'exec_kpi_daily'], environment: 'prod' },
        model: { name: 'fct_revenue', sql: 'SELECT product_tier, COUNT(*) AS tx_count, SUM(gross_amount_cents - discount_cents) AS net_cents FROM transactions GROUP BY product_tier ORDER BY product_tier', revenueColumn: 'net_cents' },
        fixtures: { columns: ['product_tier', 'gross_amount_cents', 'discount_cents', 'promo_discount_cents'], legacy, drifted },
        dataSteward: 'maya@harborvine.example', driftLog: [],
      },
      change: { driftId: 'COURT-402', detectedAt: '2026-11-03T19:00:00Z', producerVersion: 'checkout-service@v3.0.0', affectedColumn: 'discount_cents', replacementColumn: 'promo_discount_cents', driftSummary: 'v3.0 stopped populating top-level discount_cents and moved the value to promo_discount_cents.', note: 'Finance daily close is blocked.' },
    };
  },

  detectChanges(plan: Plan, d: Drift): ChangeItem[] {
    return [
      { field: 'contract.schema.violation', label: `Reported drift on ${d.affectedColumn} (${d.producerVersion})`, before: `contract ${plan.contract.contractVersion}`, after: d.driftSummary || 'column no longer populated', kind: 'modified', severity: 'high' },
      { field: 'contract.revenue.variance', label: `Downstream model "${plan.model.name}" must be re-measured`, before: 'baseline = legacy fixture', after: 'measure on drifted fixture', kind: 'modified', severity: 'high' },
    ];
  },
  applyChange(plan: Plan, d: Drift): Plan {
    const next = structuredClone(plan);
    if (!next.driftLog.some((x) => x.driftId === d.driftId)) next.driftLog.push({ driftId: d.driftId, column: d.affectedColumn });
    return next;
  },
  parseAnswer(key, text, plan: Plan) {
    if (key === 'replacement_column') { const t = text.trim(); return plan.fixtures.columns.includes(t) ? { value: t } : { error: `Name one of the fixture columns: ${plan.fixtures.columns.join(', ')}.` }; }
    return { value: text.trim() };
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const plan = ctx.plan as Plan; const drift = ctx.change as Drift; const A = 'schemacourt-analyzer'; const f = plan.fixtures;
    let a: Audit;
    try { a = audit(plan, drift, ctx.answers); }
    catch (e) { const o = new Out(role, `${A}-error@1`); o.risk(`Cannot measure: ${(e as Error).message}`); return o.done('Measurement failed; no proposal.'); }
    const cur = a.stats;

    if (role === 'schema_sentinel') {
      const o = new Out(role, `${A}-sentinel@2`);
      if (!f.columns.includes(drift.affectedColumn)) o.risk(`VERIFIED: column "${drift.affectedColumn}" does not exist in the fixtures (${f.columns.join(', ')}); the drift cannot be measured.`);
      else o.risk(`VERIFIED (measured): "${drift.affectedColumn}" is populated in ${cur.legacy}/${f.legacy.length} legacy rows but ${cur.drifted}/${f.drifted.length} drifted rows.`);
      if (a.replacement) o.info(`VERIFIED (measured): "${a.replacement}" is populated in ${cur.replacementDrifted}/${f.drifted.length} drifted rows (${cur.replacementLegacy}/${f.legacy.length} legacy).`);
      else o.ask({ key: 'replacement_column', text: `Which column now carries the value of "${drift.affectedColumn}"? (${f.columns.join(', ')})`, blocking: true, assigneeRole: 'data_steward' });
      o.info(`Producer ${plan.contract.producerService} ${plan.contract.contractVersion} → ${drift.producerVersion}. Consumers: ${plan.contract.consumerPipelines.join(', ') || 'none listed'}.`);
      o.draft({ kind: 'contract_audit', name: `Contract Drift Audit: ${drift.driftId}`, artifactKey: 'contract_audit', content: `# Contract drift audit (VERIFIED FACTS ONLY): ${drift.driftId}\n\n${table(['Column', 'Legacy non-null', 'Drifted non-null'], [[drift.affectedColumn, `${cur.legacy}/${f.legacy.length}`, `${cur.drifted}/${f.drifted.length}`], ...(a.replacement ? [[a.replacement, `${cur.replacementLegacy}/${f.legacy.length}`, `${cur.replacementDrifted}/${f.drifted.length}`]] : [])])}\n\nReported by the producer: ${drift.driftSummary || '(no summary)'}\n\n_Measured on the fixtures carried in the plan (${f.legacy.length} legacy / ${f.drifted.length} drifted rows), not on production data. No proposal is made in this document._` });
      return o.done(`Measured population of ${drift.affectedColumn} on both fixtures.`);
    }

    if (role === 'impact_auditor') {
      const o = new Out(role, `${A}-impact@2`);
      const bad = a.observedCmp.filter((c) => !c.ok);
      const rc = plan.model.revenueColumn;
      const sum = (rows: Row[]) => (rows.some((r) => r[rc] === null || r[rc] === undefined) ? null : rows.reduce((s, r) => s + Number(r[rc]), 0));
      const b = sum(a.baseline); const ob = sum(a.observed);
      if (bad.length) o.risk(`VERIFIED (measured): model "${plan.model.name}" differs from the legacy baseline in ${bad.length} of ${a.observedCmp.length} group(s). ${rc}: baseline ${b == null ? 'NULL' : dollars(b)} → drifted ${ob == null ? 'NULL' : dollars(ob)}.`);
      else o.info('VERIFIED (measured): the model output on the drifted fixture equals the legacy baseline in every group. No repair needed.');
      o.draft({ kind: 'revenue_impact', name: 'Measured Revenue Variance', artifactKey: 'revenue_impact', content: `# Measured variance of \`${plan.model.name}\` (VERIFIED FACTS)\n\n\`\`\`sql\n${plan.model.sql}\n\`\`\`\n\n${table(['Group', 'Legacy baseline', 'Drifted fixture', 'Match'], a.observedCmp.map((c) => [c.key, fmt(c.base), fmt(c.other), c.ok ? 'yes' : 'NO']))}\n\nTotal ${rc}: baseline ${b == null ? 'NULL' : dollars(b)}; drifted ${ob == null ? 'NULL' : dollars(ob)}.\n\n_Computed by executing the model in memory on the plan's fixtures._` });
      return o.done(bad.length ? `Model diverges in ${bad.length} group(s).` : 'No divergence measured.');
    }

    const o = new Out(role, `${A}-patcher@2`);
    const broken = a.observedCmp.some((c) => !c.ok);
    if (!broken) return o.done('No repair needed: the model already matches the baseline on the drifted fixture.');
    if (!a.replacement) return o.done('Waiting for the replacement column; no proposal yet.');
    if (!a.patch) { o.risk(`No automatic patch could be derived for "${drift.affectedColumn}" in the model SQL (already guarded, or the column is not referenced). No proposal.`); o.work({ key: 'steward-manual-fix', title: 'Hand-write the model fix; automatic patching failed', detail: 'The deterministic rewrite changed nothing.', department: 'Governance', roleKey: 'data_steward', kind: 'review', artifactKey: 'sql_migration_patch' }); return o.done('No patch derivable.'); }
    const p = a.patched!;
    if (!p.ok) {
      o.risk(`The derived patch does NOT restore zero variance on both fixtures (legacy ok: ${p.legacy.every((x) => x.ok)}, drifted ok: ${p.drifted.every((x) => x.ok)}). Not proposed.`);
      o.work({ key: 'steward-manual-fix', title: 'Hand-write the model fix; the automatic patch failed its own proof', detail: 'See the revenue-impact document.', department: 'Governance', roleKey: 'data_steward', kind: 'review', artifactKey: 'sql_migration_patch' });
      return o.done('Patch failed dual-fixture proof; nothing proposed.');
    }
    o.info(`PROPOSAL proven in memory: with the patch the model equals the legacy baseline in all ${p.legacy.length} group(s) on the legacy fixture AND on the drifted fixture.`);
    o.work({ key: 'steward-verify-patch', title: 'Review the patch and confirm COALESCE(…, 0) is semantically right for your data', detail: 'Zero-filling is a business decision: NULL discount may mean "unknown", not 0.', department: 'Governance', roleKey: 'data_steward', kind: 'review', artifactKey: 'sql_migration_patch' });
    o.draft({ kind: 'sql_migration_patch', name: 'Backward-Compatible SQL Patch (proposal)', artifactKey: 'sql_migration_patch', content: `# SQL patch PROPOSAL for \`${plan.model.name}\` (${drift.driftId})\n\n_This is a proposal. The facts are in the audit documents; this section is a suggestion until the data steward approves._\n\n## Original\n\`\`\`sql\n${plan.model.sql}\n\`\`\`\n\n## Patched model\n\`\`\`sql patched-model\n${a.patch}\n\`\`\`\n\n## Dual-fixture proof (executed by RIPPLE in memory)\n${table(['Group', 'Legacy fixture = baseline', 'Drifted fixture = baseline'], p.legacy.map((l, i) => [l.key, l.ok ? 'PASS' : 'FAIL', p.drifted[i]?.ok ? 'PASS' : 'FAIL']))}\n\n> RIPPLE records this approved patch; it does not run it against your warehouse. The proof used ${f.legacy.length} legacy and ${f.drifted.length} drifted fixture rows from the plan.` });
    o.act({ key: 'act-apply-sql-patch', type: 'sql_migration_patch', title: `Release approved patch for model ${plan.model.name} (record only; not applied to a warehouse)`, connector: 'document_store', ownerRole: 'sql_patcher', consequential: true, draftKind: 'sql_migration_patch', approvalRole: 'manager', ackRoles: ['data_steward'], rationale: `Patch restores zero variance on both fixtures (measured). Only the data steward (${plan.dataSteward}) may approve.`, target: `${plan.contract.environment}/${plan.model.name}`, effectKey: `sql-patch-${plan.model.name}-${drift.driftId}`, approver: { email: plan.dataSteward } });
    return o.done('Patch proven on both fixtures and gated behind the data steward.');
  },

  verifyAction(action, observed, _revised, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type !== 'sql_migration_patch') return checks;
    const m = /```sql patched-model\n([\s\S]*?)\n```/.exec(observed.content);
    const sql = m?.[1];
    checks.push({ name: 'patched model present in read-back', passed: !!sql, detail: sql ? 'found in the stored document' : 'not found' });
    checks.push({ name: 'COALESCE null-guard present', passed: !!sql && /COALESCE/i.test(sql), detail: sql && /COALESCE/i.test(sql) ? 'COALESCE guard present in the stored SQL' : 'COALESCE guard missing' });
    if (sql && ctx) {
      const plan = ctx.baselinePlan as Plan; const f = plan.fixtures; const t = plan.contract.streamName;
      try {
        assertReadOnlySelect(sql);
        checks.push({ name: 'stored SQL is a single read-only SELECT', passed: true, detail: 'accepted by the read-only gate' });
        const base = runModel(plan.model.sql, t, f.columns, f.legacy);
        const l = compare(base, runModel(sql, t, f.columns, f.legacy)); const d = compare(base, runModel(sql, t, f.columns, f.drifted));
        checks.push({ name: 'stored patch re-run on LEGACY fixture: zero variance', passed: l.every((x) => x.ok), detail: `${l.filter((x) => x.ok).length}/${l.length} groups equal the baseline` });
        checks.push({ name: 'stored patch re-run on DRIFTED fixture: zero variance', passed: d.every((x) => x.ok), detail: `${d.filter((x) => x.ok).length}/${d.length} groups equal the baseline` });
      } catch (e) { checks.push({ name: 'stored SQL is a single read-only SELECT', passed: false, detail: (e as Error).message }); }
    }
    checks.push({ name: 'states that no warehouse was touched', passed: observed.content.includes('does not run it against your warehouse'), detail: 'honest scope statement present' });
    return checks;
  },

  completionChecks(ctx) {
    const plan = ctx.baselinePlan as Plan;
    let ok = false; let detail: string;
    try { const a = audit(plan, ctx.change as Drift, ctx.answers); ok = !!a.patched?.ok; detail = ok ? 'patched model equals the baseline on both fixtures' : 'no patch proven on both fixtures'; } catch (e) { detail = (e as Error).message; }
    return [{ key: 'dual_fixture_proof', label: 'Patch proven on BOTH legacy and drifted fixtures', passed: ok, detail }];
  },
};
