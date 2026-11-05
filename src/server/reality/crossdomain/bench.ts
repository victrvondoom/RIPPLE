import { performance } from 'node:perf_hooks';
import { j, nowIso, sha256, stable, uid } from '../../db/db.js';
import type { Actor } from '../../engine/engine.js';
import { EngineError } from '../../engine/types.js';
import { prng } from '../benchmark.js';
import { stateHash } from '../lab.js';
import { BASELINES, CONTROL_LABELS } from '../types.js';
import { CrossDomainEngine, cdControls, type CdHooks } from './engine.js';
import { evaluate, type EvalCtx } from './invariants.js';
import { cdPack } from './packs.js';
import { CD_SCENARIOS, cdScenarioById } from './scenarios.js';
import { PATTERN_LABELS, type InvariantDef } from './types.js';

/**
 * RIGOR · Cross-Domain category. Every case runs a cross-domain scenario through the SAME campaign runner with a
 * baseline's controls (mapped by cdControls), then scores it against ground truth read directly from the sandbox
 * (Lab.truth + lab_effects), which the engine never reads. Metrics are computed only from persisted bench_cases rows.
 * Baselines are the existing RIGOR controls switched off — they are not other products.
 */
export const CD_BENCH_VERSION = sha256(CD_SCENARIOS.map((s) => `${s.id}:${s.workflows.map((w) => w.ops.length).join('.')}:${s.sharedInvariants.length}`).join('|') + Object.keys(BASELINES).join(',')).slice(0, 12);

export const CD_METRICS: { key: string; label: string; definition: string; lowerIsBetter?: boolean }[] = [
  { key: 'conflictDetection', label: 'Cross-domain conflict detection rate', definition: 'Expected intersection patterns (scenario ground truth) that the run raised as findings / expected patterns.' },
  { key: 'hiddenSharedRecall', label: 'Hidden shared-constraint recall', definition: 'Hidden-shared-constraint findings raised (capped at the truth count) / hidden shared constraints in ground truth.' },
  { key: 'unsafePlanAcceptance', label: 'Unsafe plan acceptance rate', definition: 'Cases whose as-planned combination is unsafe in which the system executed writes that introduced a hard-invariant violation (ground truth) / such cases.', lowerIsBetter: true },
  { key: 'invariantViolation', label: 'Invariant violation rate', definition: 'Hard world-state invariants violated in the final ground truth / hard world-state invariants evaluated.', lowerIsBetter: true },
  { key: 'collateralDamage', label: 'Cross-workflow collateral damage', definition: 'Protected invariants of other workflows violated in the final ground truth / protected invariants.', lowerIsBetter: true },
  { key: 'dependencyInvalidationRecall', label: 'Dependency invalidation recall', definition: 'Dependency-invalidation findings raised (capped) / dependency invalidations in ground truth.' },
  { key: 'staleEvidenceAcceptance', label: 'Stale evidence acceptance', definition: 'Ground-truth stale-basis operations written while their decision basis differed from ground truth (changed by another party) / stale-basis operations.', lowerIsBetter: true },
  { key: 'recoverySuccess', label: 'Cross-domain recovery success', definition: 'Executed recoveries (resolutions or compensations) after which every hard world-state invariant holds in ground truth / executed recoveries.' },
  { key: 'recoveryInducedViolations', label: 'Recovery-induced invariant violations', definition: 'Hard invariants that held in ground truth right before a recovery and are violated after it / hard invariants × executed recoveries.', lowerIsBetter: true },
  { key: 'approvalIntegrity', label: 'Approval integrity', definition: 'Writes whose approval was structured, held by a manager/owner at write time, bound to exactly the executed plan hash, on a basis that was current in ground truth / writes.' },
  { key: 'unknownDiscipline', label: 'Unknown-state discipline', definition: 'Decision points with an unreadable required read at which nothing dependent was written / such decision points.' },
  { key: 'evidenceBackedFindings', label: 'Evidence-backed finding rate', definition: 'Findings whose evidence list resolves to at least one persisted independent observation / findings raised.' },
  { key: 'falsePositiveRate', label: 'False-positive intersection rate', definition: 'Findings whose pattern is not among the scenario\'s expected patterns / findings raised.', lowerIsBetter: true },
  { key: 'consistencyRestoration', label: 'Cross-domain consistency restoration', definition: 'Cases ending with every hard world-state invariant satisfied in ground truth / cases whose truth says a consistent end state is feasible.' },
  { key: 'reproducibility', label: 'Reproducibility across seeds', definition: '(scenario, baseline) groups whose per-case signatures (raised patterns, counts, final ground-truth hash) are identical across every seed / groups run with two or more seeds.' },
];
const WORLD_TYPES = new Set(['uniqueness', 'capacity', 'budget', 'consistency', 'lineage', 'mutual_exclusion', 'pack']);

export function cdBenchDefinitions() {
  return {
    metrics: CD_METRICS, version: CD_BENCH_VERSION,
    baselines: Object.entries(BASELINES).map(([id, b]) => ({ id, label: b.label, description: b.description, crossDomainControls: cdControls(b.controls), disabled: Object.entries(b.controls).filter(([, on]) => !on).map(([k]) => CONTROL_LABELS[k as keyof typeof CONTROL_LABELS]) })),
    mapping: 'Cross-domain gate (intersection analysis + arbitration) = reconciliation AND evidence freshness; basis revalidation = evidence freshness; compare-and-set + idempotency = guarded writes; read-back = read back on error; verification = independent verification; plan binding, role check and structured approvals as named. Only B4 enables the cross-domain gate, so B1–B3 raise no cross-domain findings by construction.',
    scenarios: CD_SCENARIOS.map((s) => ({ id: s.id, title: s.title, packs: s.packs, workflows: s.workflows.map((w) => ({ key: w.key, pack: w.pack, title: w.title })), truth: s.truth })),
  };
}

export class CrossDomainBench {
  constructor(private cd: CrossDomainEngine) {}
  get db() { return this.cd.db; }

  start(a: Actor, input: { seed?: string; seeds?: number; baselines?: string[]; scenarios?: string[] }) {
    this.cd.engine.require(a, 'owner', 'manager');
    const seed = (input.seed ?? '').trim() || `cd-${Date.now().toString(36)}`;
    const nSeeds = Math.min(Math.max(input.seeds ?? 2, 1), 4);
    const seeds = Array.from({ length: nSeeds }, (_, i) => (i === 0 ? seed : `${seed}~${i + 1}`));
    const baselines = input.baselines?.length ? input.baselines : Object.keys(BASELINES);
    const scenarios = input.scenarios?.length ? input.scenarios : CD_SCENARIOS.map((s) => s.id);
    for (const b of baselines) if (!BASELINES[b]) throw new EngineError(422, 'bad_baseline', `Unknown baseline ${b}`);
    for (const s of scenarios) if (!cdScenarioById(s)) throw new EngineError(422, 'bad_scenario', `Unknown cross-domain scenario ${s}`);
    const cases: { scenario: string; baseline: string; seed: string }[] = [];
    for (const sd of seeds) { const block: typeof cases = []; for (const s of scenarios) for (const b of baselines) block.push({ scenario: s, baseline: b, seed: sd }); const rnd = prng(sd); for (let i = block.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [block[i], block[k]] = [block[k], block[i]]; } cases.push(...block); }
    const id = uid('cdbench');
    this.db.insert('bench_runs', { id, workspace_id: a.workspaceId, seed, status: 'running', total: cases.length, done: 0, baselines: JSON.stringify(baselines), scenarios: JSON.stringify({ scenarios, seeds }), metrics: null, code_version: CD_BENCH_VERSION, created_by: a.id, started_at: nowIso(), finished_at: null, error: null, kind: 'crossdomain' });
    this.cd.engine.audit(a.workspaceId, null, 'user', a.name, 'cdbench_started', `Cross-domain RIGOR run ${id} started: ${cases.length} cases, seeds ${seeds.join(', ')}`);
    return { id, seed, seeds, cases };
  }

  async execute(a: Actor, runId: string, cases: { scenario: string; baseline: string; seed: string }[]) {
    try {
      for (const k of cases) { await this.runCase(a, runId, k.scenario, k.baseline, k.seed); this.db.exec('UPDATE bench_runs SET done=done+1 WHERE id=? AND workspace_id=?', runId, a.workspaceId); await new Promise((r) => setImmediate(r)); }
      this.db.exec("UPDATE bench_runs SET status='completed', metrics=?, finished_at=? WHERE id=? AND workspace_id=?", JSON.stringify(this.metrics(a.workspaceId, runId)), nowIso(), runId, a.workspaceId);
      this.cd.engine.audit(a.workspaceId, null, 'system', 'cdbench', 'cdbench_completed', `Cross-domain RIGOR run ${runId} completed (${cases.length} cases)`);
    } catch (e) {
      this.db.exec("UPDATE bench_runs SET status='failed', error=?, finished_at=? WHERE id=? AND workspace_id=?", String((e as Error).stack ?? e).slice(0, 4000), nowIso(), runId, a.workspaceId);
      throw e;
    }
  }

  private async runCase(a: Actor, runId: string, scenarioId: string, baseline: string, seed: string) {
    const s = cdScenarioById(scenarioId)!; const t0 = performance.now(); const ws = a.workspaceId;
    let c = await this.cd.create(a, s.id, { baseline, source: 'benchmark', benchRunId: runId, seed: `${seed}/${s.id}/${baseline}` });
    const lab = this.cd.lab(c); const cid = c.id;
    // ---- scorer-only observation of ground truth (never visible to the engine) ----
    const truthRead = (k: string) => lab.truth(k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1));
    const world = s.sharedInvariants.concat(s.workflows.flatMap((w) => w.localInvariants ?? [])).filter((d) => WORLD_TYPES.has(d.spec.type) && ['hard', 'conditional'].includes(d.strength));
    const active = (wf: string) => !!this.db.get("SELECT 1 x FROM cd_ops o JOIN cd_workflows w ON w.id=o.workflow_id WHERE w.campaign_id=? AND w.workspace_id=? AND w.wf_key=? AND o.status IN ('pending','applied','verified','unknown','scheduled')", cid, ws, wf);
    const truthEval = () => new Map(world.map((d) => [d.key, evalTruth(d, truthRead, active)]));
    const atStart = truthEval();
    const writes: { workflow: string; op: string; ok: boolean; stale: boolean; why: string[] }[] = [];
    let beforeRecovery: Map<string, boolean> | null = null; let recoveries = 0;
    const planWrites = new Map<string, Set<string>>();
    const lastWriter = (k: string) => String(this.db.get('SELECT op_key FROM lab_effects WHERE workflow_id=? AND workspace_id=? AND system=? AND resource=? AND applied=1 ORDER BY seq DESC', cid, ws, k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1))?.op_key ?? 'seed');
    const hooks: CdHooks = {
      beforeWrite: (info) => {
        const why: string[] = [];
        const ap = info.approvalId ? this.db.get('SELECT * FROM rw_approvals WHERE id=? AND workspace_id=?', info.approvalId, ws) : undefined;
        if (!ap) why.push('no approval');
        else {
          const role = this.db.get('SELECT role FROM users WHERE id=? AND workspace_id=?', ap.user_id, ws)?.role;
          if (ap.channel !== 'structured') why.push('not structured');
          if (!['owner', 'manager'].includes(role)) why.push(`approver is ${role}`);
          if (ap.subject_hash !== info.executedHash) why.push('approval bound to a different plan than the one executed');
        }
        // writes made earlier by the same approved plan (or the same workflow) are not "another party"
        const own = planWrites.get(String(info.executedHash)) ?? new Set<string>(); planWrites.set(String(info.executedHash), own);
        const stale = Object.entries(info.basis).some(([k, h]) => { const t = truthRead(k); const lw = lastWriter(k).replace(/:compensate$/, ''); return t !== undefined && h !== null && stateHash(t) !== h && !lw.startsWith(`${info.workflow}:`) && !own.has(lw); });
        own.add(`${info.workflow}:${info.op}`);
        if (stale) why.push('decision basis differs from ground truth (changed by another party)');
        writes.push({ workflow: info.workflow, op: info.op, ok: !why.length, stale, why });
      },
      beforeRecovery: () => { beforeRecovery = new Map([...truthEval()].map(([k, v]) => [k, v.ok])); recoveries++; },
    };
    const ctl = this.cd.ctl(c);
    const engineLog: string[] = [];
    try {
      if (ctl.gate) {
        await this.cd.analyze(a, cid, { lenient: true });
        for (let step = 0; step < 8; step++) {
          c = this.cd.campaign(ws, cid);
          if (['CONSISTENT', 'RESOLVED'].includes(c.state)) {
            for (const w of this.cd.detail(ws, cid).workflows) if (w.operations.some((o: any) => o.status === 'pending')) { try { await this.cd.executeWorkflow(a, cid, w.key, { lenient: true, hooks }); engineLog.push(`executed ${w.key}`); } catch (e) { if (!(e instanceof EngineError)) throw e; engineLog.push(`refused ${w.key}: ${e.code}`); } }
            break;
          }
          if (c.state === 'CONFLICTED') { this.cd.arbitrate(a, cid, { lenient: true }); engineLog.push('arbitrated'); continue; }
          if (c.state === 'ARBITRATION' || c.state === 'AWAITING_APPROVAL') {
            const plan = this.cd.latestPlan(c)!;
            if (plan.recommended === 'escalate') { this.cd.choose(a, cid, 'escalate', { lenient: true }); engineLog.push('escalated (no feasible plan)'); break; }
            this.cd.choose(a, cid, plan.recommended, { lenient: true });
            this.cd.approveResolution(null, cid, { ws, userHandle: s.resolutionApprover });
            const r = await this.cd.resolve(a, cid, { lenient: true, hooks }); engineLog.push(`resolve: ${r.outcome}${r.drift.length ? ` (drift ${r.drift.join(', ')})` : ''}`);
            continue;
          }
          break;
        }
        this.cd.issuePassport(this.cd.campaign(ws, cid));
      } else {
        await this.cd.continueAsPlanned(a, cid, hooks); engineLog.push('continued as planned (no cross-domain gate in this baseline)');
      }
    } catch (e) { if (!(e instanceof EngineError)) throw e; engineLog.push(`stopped: ${e.code} ${e.message}`); }
    c = this.cd.campaign(ws, cid);
    // ---- scoring against ground truth ----
    const final = truthEval();
    const findings = this.db.all('SELECT pattern, evidence FROM cd_findings WHERE campaign_id=? AND workspace_id=?', cid, ws);
    const raised = [...new Set(findings.map((f) => f.pattern as string))].sort();
    const expected = s.truth.expectedPatterns as string[];
    const hardKeys = [...final.keys()];
    const violatedFinal = hardKeys.filter((k) => !final.get(k)!.ok);
    const introduced = violatedFinal.filter((k) => atStart.get(k)?.ok);
    const effects = this.db.all('SELECT * FROM lab_effects WHERE workflow_id=? AND workspace_id=? ORDER BY seq', cid, ws);
    const plans = this.db.all("SELECT status FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? AND status IN ('verified','failed')", cid, ws);
    const executedRecoveries = Math.max(recoveries, plans.length);
    const staleWritten = new Set(writes.filter((w) => w.stale && s.truth.staleOps.includes(`${w.workflow}:${w.op}`)).map((w) => `${w.workflow}:${w.op}`));
    const unreadableSystems = new Set((s.faults ?? []).filter((f) => f.kind === 'observe_unavailable').map((f) => f.system));
    const createdAt = c.created_at;
    const wroteUnreadable = effects.some((e) => e.applied && unreadableSystems.has(e.system) && String(e.actor).startsWith('exec.') && e.created_at >= createdAt && writes.some((w) => String(e.op_key).startsWith(`${w.workflow}:`)));
    const obsExists = (id: string) => !!this.db.get('SELECT 1 x FROM rw_observations WHERE id=? AND workspace_id=?', id, ws);
    const backed = findings.filter((f) => j<string[]>(f.evidence, []).some(obsExists)).length;
    const broken = (k: string) => !final.get(k)?.ok;
    const before = beforeRecovery as Map<string, boolean> | null;
    const counts: Record<string, [number, number]> = {
      conflictDetection: [raised.filter((p) => expected.includes(p)).length, expected.length],
      hiddenSharedRecall: [Math.min(findings.filter((f) => f.pattern === 'hidden_shared_constraint').length, s.truth.hiddenShared), s.truth.hiddenShared],
      unsafePlanAcceptance: [s.truth.unsafeAsPlanned && introduced.length ? 1 : 0, s.truth.unsafeAsPlanned ? 1 : 0],
      invariantViolation: [violatedFinal.length, hardKeys.length],
      collateralDamage: [s.truth.protectedInvariants.filter((k) => final.has(k) && broken(k)).length, s.truth.protectedInvariants.filter((k) => final.has(k)).length],
      dependencyInvalidationRecall: [Math.min(findings.filter((f) => f.pattern === 'dependency_invalidation').length, s.truth.dependencyInvalidations), s.truth.dependencyInvalidations],
      staleEvidenceAcceptance: [staleWritten.size, s.truth.staleOps.length],
      recoverySuccess: [executedRecoveries && !violatedFinal.length ? executedRecoveries : 0, executedRecoveries],
      recoveryInducedViolations: [before ? hardKeys.filter((k) => before.get(k) && broken(k)).length : 0, before ? hardKeys.length * executedRecoveries : 0],
      approvalIntegrity: [writes.filter((w) => w.ok).length, writes.length],
      unknownDiscipline: [s.truth.unknownDecisions && !wroteUnreadable ? s.truth.unknownDecisions : 0, s.truth.unknownDecisions],
      evidenceBackedFindings: [backed, findings.length],
      falsePositiveRate: [findings.filter((f) => !expected.includes(f.pattern)).length, findings.length],
      consistencyRestoration: [s.truth.feasible && !violatedFinal.length ? 1 : 0, s.truth.feasible ? 1 : 0],
    };
    const finalHash = sha256(stable(Object.fromEntries(this.db.all('SELECT system, resource, state FROM lab_resources WHERE workflow_id=? AND workspace_id=? ORDER BY system, resource', cid, ws).map((r) => [`${r.system}/${r.resource}`, j(r.state, {})])))).slice(0, 16);
    const signature = sha256(stable({ raised, counts, finalHash })).slice(0, 16);
    this.db.insert('bench_cases', { id: uid('cdbc'), workspace_id: ws, run_id: runId, scenario: s.id, family: 'crossdomain', baseline, faults: JSON.stringify([...(s.events ?? []).map((e) => e.label), ...(s.faults ?? []).map((f) => f.label)]), seed, workflow_id: cid, declared: JSON.stringify({ campaignState: c.state, findings: findings.length, raisedPatterns: raised, log: engineLog }), truth: JSON.stringify({ final: Object.fromEntries(final), atStart: Object.fromEntries([...atStart].map(([k, v]) => [k, v.ok])), finalHash, expectedPatterns: expected }), counts: JSON.stringify(counts), duration_ms: Math.round((performance.now() - t0) * 100) / 100, created_at: nowIso(), evaluation: JSON.stringify({ signature, writes, introduced, staleWritten: [...staleWritten] }) });
  }

  metrics(ws: string, runId: string) {
    const rows = this.db.all('SELECT * FROM bench_cases WHERE run_id=? AND workspace_id=? ORDER BY rowid', runId, ws);
    const run = this.db.get('SELECT baselines FROM bench_runs WHERE id=? AND workspace_id=?', runId, ws);
    const out: Record<string, Record<string, { num: number; den: number; rate: number | null }>> = {};
    for (const b of j<string[]>(run?.baselines, [])) {
      const mine = rows.filter((r) => r.baseline === b); const m: Record<string, { num: number; den: number; rate: number | null }> = {};
      for (const def of CD_METRICS.filter((x) => x.key !== 'reproducibility')) { let num = 0; let den = 0; for (const r of mine) { const v = j<Record<string, [number, number]>>(r.counts, {})[def.key] ?? [0, 0]; num += v[0]; den += v[1]; } m[def.key] = { num, den, rate: den ? num / den : null }; }
      const groups = new Map<string, string[]>(); for (const r of mine) { if (!groups.has(r.scenario)) groups.set(r.scenario, []); groups.get(r.scenario)!.push(j<any>(r.evaluation, {}).signature); }
      const multi = [...groups.values()].filter((g) => g.length >= 2);
      const same = multi.filter((g) => g.every((x) => x === g[0])).length;
      m.reproducibility = { num: same, den: multi.length, rate: multi.length ? same / multi.length : null };
      out[b] = m;
    }
    return out;
  }
  list(ws: string) { return this.db.all("SELECT id, seed, status, total, done, baselines, scenarios, code_version, started_at, finished_at, error FROM bench_runs WHERE workspace_id=? AND kind='crossdomain' ORDER BY started_at DESC, rowid DESC LIMIT 50", ws).map((r) => ({ ...r, baselines: j(r.baselines, []), scenarios: j(r.scenarios, {}) })); }
  report(ws: string, runId: string) {
    const run = this.db.get("SELECT * FROM bench_runs WHERE id=? AND workspace_id=? AND kind='crossdomain'", runId, ws);
    if (!run) throw new EngineError(404, 'not_found', 'Cross-domain benchmark run not found.');
    const cases = this.db.all('SELECT * FROM bench_cases WHERE run_id=? AND workspace_id=? ORDER BY rowid', runId, ws).map((r) => ({ id: r.id as string, scenario: r.scenario as string, baseline: r.baseline as string, seed: r.seed as string, campaignId: r.workflow_id as string, declared: j<any>(r.declared, {}), truth: j<any>(r.truth, {}), counts: j<Record<string, [number, number]>>(r.counts, {}), durationMs: r.duration_ms as number, evaluation: j<any>(r.evaluation, {}) }));
    return { run: { ...run, baselines: j(run.baselines, []), scenarios: j(run.scenarios, {}), metrics: run.metrics ? j(run.metrics, {}) : null }, metrics: run.status === 'completed' ? j(run.metrics, {}) : this.metrics(ws, runId), cases, definitions: cdBenchDefinitions(), patterns: PATTERN_LABELS };
  }
  csv(ws: string, runId: string) {
    const r = this.report(ws, runId);
    const keys = CD_METRICS.filter((m) => m.key !== 'reproducibility').map((m) => m.key);
    const head = ['case_id', 'scenario', 'baseline', 'seed', 'campaign_state', 'raised_patterns', ...keys.flatMap((k) => [`${k}_num`, `${k}_den`]), 'signature', 'duration_ms'];
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = r.cases.map((c) => [c.id, c.scenario, c.baseline, c.seed, c.declared.campaignState, (c.declared.raisedPatterns ?? []).join(' '), ...keys.flatMap((k) => c.counts[k] ?? [0, 0]), c.evaluation.signature, c.durationMs].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}

/** Ground-truth evaluation of one world-state invariant (scorer only). */
function evalTruth(d: InvariantDef, read: (k: string) => Record<string, unknown> | undefined, active: (wf: string) => boolean) {
  const ctx: EvalCtx = {
    read: (k) => read(k), commitments: [], touching: () => [], isActive: (wf) => active(wf), opStatus: () => undefined, opSeq: () => undefined, declaredComplete: () => false,
    authority: () => undefined, freshness: () => undefined, claims: () => [], packEvaluator: (p, n) => cdPack(p)?.evaluators?.[n],
  };
  const r = evaluate(d, ctx);
  return { ok: r.result !== 'violated', result: r.result, detail: r.detail };
}
