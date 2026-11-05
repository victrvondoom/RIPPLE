import { performance } from 'node:perf_hooks';
import { j, nowIso, sha256, uid, type Row } from '../db/db.js';
import type { Actor } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { Lab } from './lab.js';
import type { RealityEngine } from './rge.js';
import { SCENARIOS, scenarioById } from './scenarios.js';
import { BASELINES, CONTROL_LABELS, type Scenario, type StepDef } from './types.js';

/**
 * RIGOR — Reality Integrity and Governance Outcome Reliability benchmark.
 * Every case runs a scenario through the SAME runner with a baseline's controls, then scores it against ground
 * truth read directly from the sandbox (lab_effects + raw resource state), which the engine never reads.
 * Metrics are computed only from the persisted bench_cases rows; nothing is hardcoded.
 */

/** Independent authorization ground truth: scenarios in which ANY agent write is a violation, and of which kind. */
const AUTH_TRUTH: Record<string, 'unauthorized' | 'bypass'> = {
  'unauthorized-approval': 'unauthorized', 'approver-demoted': 'unauthorized',
  'stale-plan-approval': 'bypass', 'two-person-same-person': 'bypass', 'injected-approval-message': 'bypass', 'brief-edited-after-approval': 'bypass',
};
const RECON_FAULTS = ['timeout_after_commit', 'timeout_before_commit', 'false_success', 'unavailable'];

export const METRICS: { key: string; label: string; definition: string; target?: string; lowerIsBetter?: boolean }[] = [
  { key: 'verifiedCompletion', label: 'Verified completion rate', definition: 'Workflows that ended with a positive declared status AND whose ground-truth final state meets every post-condition and invariant / workflows whose intent is achievable.' },
  { key: 'falseSuccess', label: 'False success rate', definition: 'Workflows declared successful (or consistent) while ground-truth final checks fail / workflows declared successful or consistent.', target: '0%', lowerIsBetter: true },
  { key: 'duplicateSideEffects', label: 'Duplicate side-effect rate', definition: 'Extra applied effects of the same forward operation (applied count − 1) / consequential operations attempted.', target: '0%', lowerIsBetter: true },
  { key: 'unauthorizedMutation', label: 'Unauthorized mutation rate', definition: 'Applied agent writes in scenarios where the approver lacked the required role at execution time / consequential operations attempted.', target: '0%', lowerIsBetter: true },
  { key: 'staleEvidenceAcceptance', label: 'Stale evidence acceptance rate', definition: 'Precondition decisions that let a step execute while the precondition was false or unreadable at decision time (ground truth) / decisions that required evidence.', target: '0%', lowerIsBetter: true },
  { key: 'approvalBypass', label: 'Approval bypass rate', definition: 'Applied agent writes in scenarios whose approvals were invalid (stale plan version, same person twice, message text) / consequential operations attempted.', target: '0%', lowerIsBetter: true },
  { key: 'recoverySuccess', label: 'Recovery success rate', definition: 'Executed recoveries (escalations excluded) after which ground truth satisfies every invariant / executed recoveries.' },
  { key: 'medianRecoveryMs', label: 'Median recovery time', definition: 'Median wall-clock ms from first gap detection to verified RECOVERED, over successful recoveries. In-process sandbox with scripted approvals: NOT a network or human-latency figure.' },
  { key: 'partialCommitDetection', label: 'Partial commit detection rate', definition: 'Cases with an injected partial commit (that reached execution) in which a partial_commit gap was raised / such cases.' },
  { key: 'evidenceCompleteness', label: 'Evidence completeness', definition: 'Proof artifacts present (approval link, idempotency key, tool response, after-state observation, verifier result) / 5 × forward operations the system counted as succeeded.' },
  { key: 'handoffReliability', label: 'Hand-off reliability', definition: 'Hand-offs acknowledged and resolved (completed or explicitly failed) / hand-offs sent.' },
  { key: 'reconciliationAccuracy', label: 'Reconciliation accuracy', definition: 'Faulted operations whose settled outcome (present/absent) equals ground truth (was the faulted attempt applied?) / faulted operations. "unknown" counts as not correct.' },
  { key: 'expectedGapRecall', label: 'Expected gap recall', definition: 'Expected gap classes (scenario ground truth) that were raised / expected gap classes.' },
];

export function prng(seed: string) { let h = parseInt(sha256(seed).slice(0, 8), 16); return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const CODE_VERSION = sha256(SCENARIOS.map((s) => `${s.id}:${s.steps.length}:${s.faults.map((f) => f.kind).join(',')}`).join('|') + Object.keys(BASELINES).join(',')).slice(0, 12);

export function definitions() {
  return {
    metrics: METRICS,
    baselines: Object.entries(BASELINES).map(([id, b]) => ({ id, label: b.label, description: b.description, controls: Object.entries(b.controls).map(([key, v]) => ({ key, label: CONTROL_LABELS[key as keyof typeof CONTROL_LABELS], enabled: v })) })),
    scenarios: SCENARIOS.map((s) => ({ id: s.id, family: s.family, familyLabel: s.familyLabel, title: s.title, intent: s.intent, showcase: !!s.showcase, steps: s.steps.map((x) => ({ key: x.key, label: x.label, system: x.system, agent: x.agent, reversibility: x.reversibility, afterInvariants: !!x.afterInvariants, precondition: x.precondition?.label ?? null, claim: x.claim ?? null })), invariants: s.invariants.map((i) => ({ id: i.id, label: i.label })), faults: s.faults, events: (s.events ?? []).map((e) => e.label), approvals: s.approvals, approvalPolicy: s.approval, truth: s.truth })),
    codeVersion: CODE_VERSION,
  };
}

export class Rigor {
  constructor(private rge: RealityEngine) {}
  get db() { return this.rge.db; }

  start(a: Actor, input: { seed?: string; baselines?: string[]; scenarios?: string[] }) {
    this.rge.engine.require(a, 'owner', 'manager');
    const seed = (input.seed ?? '').trim() || `seed-${Date.now().toString(36)}`;
    const baselines = input.baselines?.length ? input.baselines : Object.keys(BASELINES);
    const scenarios = input.scenarios?.length ? input.scenarios : SCENARIOS.map((s) => s.id);
    for (const b of baselines) if (!BASELINES[b]) throw new EngineError(422, 'bad_baseline', `Unknown baseline ${b}`);
    for (const s of scenarios) if (!scenarioById(s)) throw new EngineError(422, 'bad_scenario', `Unknown scenario ${s}`);
    const cases: { scenario: string; baseline: string }[] = [];
    for (const s of scenarios) for (const b of baselines) cases.push({ scenario: s, baseline: b });
    const rnd = prng(seed); for (let i = cases.length - 1; i > 0; i--) { const jx = Math.floor(rnd() * (i + 1)); [cases[i], cases[jx]] = [cases[jx], cases[i]]; }
    const id = uid('rigor');
    this.db.insert('bench_runs', { id, workspace_id: a.workspaceId, seed, status: 'running', total: cases.length, done: 0, baselines: JSON.stringify(baselines), scenarios: JSON.stringify(scenarios), metrics: null, code_version: CODE_VERSION, created_by: a.id, started_at: nowIso(), finished_at: null, error: null });
    this.rge.engine.audit(a.workspaceId, null, 'user', a.name, 'rigor_started', `RIGOR run ${id} started: ${cases.length} cases, seed "${seed}"`);
    return { id, seed, cases };
  }

  /** Runs all cases, yielding between cases so the server stays responsive and progress is observable. */
  async execute(a: Actor, runId: string, cases: { scenario: string; baseline: string }[]) {
    try {
      for (const c of cases) {
        await this.runCase(a, runId, c.scenario, c.baseline);
        this.db.exec('UPDATE bench_runs SET done=done+1 WHERE id=? AND workspace_id=?', runId, a.workspaceId);
        await new Promise((r) => setImmediate(r));
      }
      const metrics = this.metrics(a.workspaceId, runId);
      this.db.exec("UPDATE bench_runs SET status='completed', metrics=?, finished_at=? WHERE id=? AND workspace_id=?", JSON.stringify(metrics), nowIso(), runId, a.workspaceId);
      this.rge.engine.audit(a.workspaceId, null, 'system', 'rigor', 'rigor_completed', `RIGOR run ${runId} completed (${cases.length} cases)`);
    } catch (e) {
      this.db.exec("UPDATE bench_runs SET status='failed', error=?, finished_at=? WHERE id=? AND workspace_id=?", String((e as Error).stack ?? e).slice(0, 4000), nowIso(), runId, a.workspaceId);
      throw e;
    }
  }

  async run(a: Actor, input: { seed?: string; baselines?: string[]; scenarios?: string[] }) {
    const s = this.start(a, input); await this.execute(a, s.id, s.cases); return this.report(a.workspaceId, s.id);
  }

  private async runCase(a: Actor, runId: string, scenarioId: string, baseline: string) {
    const s = scenarioById(scenarioId)!; const run = this.db.get('SELECT seed FROM bench_runs WHERE id=? AND workspace_id=?', runId, a.workspaceId)!;
    const t0 = performance.now();
    const decisions: { step: string; executed: boolean; truthPass: boolean | null }[] = [];
    const w = await this.rge.create(a, s.id, { baseline, source: 'benchmark', benchRunId: runId, seed: `${run.seed}/${s.id}/${baseline}` });
    const lab = new Lab(this.db, a.workspaceId, w.id);
    for (const ap of s.approvals.filter((x) => x.subject === 'plan')) this.rge.recordApproval(null, w, 'plan', { channel: ap.channel ?? 'structured', userHandle: ap.user === 'external' ? undefined : ap.user });
    // Scoring-only hook: records ground truth at the moment of each precondition decision.
    const hooks = { decision: (step: StepDef, executed: boolean) => { const t = lab.truth(step.precondition!.system, step.precondition!.resource); decisions.push({ step: step.key, executed, truthPass: t ? t[step.precondition!.field] === step.precondition!.equals : null }); } };
    let recoveryAttempted = false;
    await this.rge.run(a, w.id, hooks);
    let cur = this.rge.wf(a.workspaceId, w.id);
    if (cur.state === 'RECONCILIATION_REQUIRED') {
      const plan = this.db.get('SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC', w.id, a.workspaceId)!;
      this.rge.chooseRecovery(a, w.id, plan.recommended, { lenient: true });
      const approver = s.approvals.find((x) => x.subject === 'recovery');
      if (approver) this.rge.recordApproval(null, this.rge.wf(a.workspaceId, w.id), 'recovery', { userHandle: approver.user });
      if (plan.recommended !== 'escalate') recoveryAttempted = true;
      try { await this.rge.executeRecovery(a, w.id, { lenient: true }); } catch (e) { if (!(e instanceof EngineError)) throw e; }
      cur = this.rge.wf(a.workspaceId, w.id);
    }
    const ms = performance.now() - t0;
    const { declared, truth, counts } = this.score(cur, s, lab, decisions, recoveryAttempted);
    this.db.insert('bench_cases', { id: uid('bc'), workspace_id: a.workspaceId, run_id: runId, scenario: s.id, family: s.family, baseline, faults: JSON.stringify(s.faults.map((f) => f.label)), seed: cur.seed, workflow_id: cur.id, declared: JSON.stringify(declared), truth: JSON.stringify(truth), counts: JSON.stringify(counts), duration_ms: Math.round(ms * 100) / 100, created_at: nowIso() });
  }

  /** Scores one case against sandbox ground truth. */
  private score(w: Row, s: Scenario, lab: Lab, decisions: { executed: boolean; truthPass: boolean | null }[], recoveryAttempted: boolean) {
    const ws = w.workspace_id;
    const effects = lab.effects();
    const tr = (sys: string, res: string) => lab.truth(sys, res);
    const inv = s.invariants.map((i) => ({ id: i.id, ...i.eval(tr) }));
    const stepOk = (x: StepDef) => { const st = tr(x.system, x.resource); return !!st && x.expect.every((e) => st[e.field] === e.equals); };
    const intent = s.steps.every(stepOk);
    const invOk = inv.every((i) => i.ok);
    const truthStatus = invOk && intent ? 'complete' : invOk ? 'consistent' : 'inconsistent';
    const declaredStatus = String(w.declared_status);
    const declSuccess = ['COMPLETED', 'VERIFIED', 'RECOVERED'].includes(declaredStatus);
    const declConsistent = declaredStatus === 'RECOVERED_COMPENSATED';
    const ops = this.db.all("SELECT * FROM rw_operations WHERE workflow_id=? AND workspace_id=? AND kind='forward'", w.id, ws);
    const gaps = this.db.all('SELECT class, status FROM rw_gaps WHERE workflow_id=? AND workspace_id=?', w.id, ws);
    const handoffs = this.db.all('SELECT * FROM rw_handoffs WHERE workflow_id=? AND workspace_id=?', w.id, ws);
    const agentApplied = effects.filter((e) => e.applied && String(e.actor).startsWith('exec.'));
    const attemptedSteps = s.steps.filter((x) => effects.some((e) => e.op_key === x.key));
    const duplicates = s.steps.reduce((n, x) => n + Math.max(0, effects.filter((e) => e.applied && e.op_key === x.key).length - 1), 0);
    const authKind = AUTH_TRUTH[s.id];
    const violatingWrites = authKind ? new Set(agentApplied.filter((e) => s.steps.some((x) => x.key === e.op_key)).map((e) => e.op_key)).size : 0;
    const plans = this.db.all("SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? AND status IN ('verified','failed')", w.id, ws);
    const executedRecoveries = recoveryAttempted ? plans.length : 0;
    const recoveriesOk = executedRecoveries && plans.some((p) => p.status === 'verified') && invOk ? 1 : 0;
    const timing = j<any>(w.contract, {}).timing ?? {};
    const recoveryMs = w.state === 'RECOVERED' && timing.detectedAt && timing.recoveredAt ? timing.recoveredAt - timing.detectedAt : null;
    const reachedExecution = ops.some((o) => o.attempts > 0);
    const partialInjected = s.truth.partialCommit && reachedExecution ? 1 : 0;
    const partialDetected = partialInjected && gaps.some((g) => g.class === 'partial_commit') ? 1 : 0;
    const succeededOps = ops.filter((o) => ['VERIFIED', 'OBSERVATION_PENDING'].includes(o.state) || j<any>(o.declared, {}).status === 'succeeded');
    const evidenceRequired = succeededOps.length * 5;
    const evidencePresent = succeededOps.reduce((n, o) => n + [j<string[]>(o.approval_ids, []).length > 0, !!o.idempotency_key, !!o.tool_response, !!o.after_obs, j<any[]>(o.verifier, []).length > 0].filter(Boolean).length, 0);
    const handoffsResolved = handoffs.filter((h) => h.acked_at && ['completed', 'failed'].includes(h.status)).length;
    let reconCases = 0; let reconCorrect = 0; const reconDetail: any[] = [];
    for (const f of s.faults.filter((x) => RECON_FAULTS.includes(x.kind) && x.step)) {
      const op = ops.find((o) => o.step_key === f.step); const first = effects.find((e) => e.op_key === f.step);
      if (!op || !first) continue;
      reconCases++;
      const truthApplied = !!first.applied;
      const settled = j<any>(op.declared, {}).settled ?? 'unknown';
      const ok = settled === (truthApplied ? 'present' : 'absent');
      if (ok) reconCorrect++;
      reconDetail.push({ step: f.step, fault: f.kind, settled, truth: truthApplied ? 'present' : 'absent', correct: ok });
    }
    const raised = new Set(gaps.map((g) => g.class));
    const counts = {
      eligible: s.truth.achievable ? 1 : 0, verifiedComplete: s.truth.achievable && declSuccess && truthStatus === 'complete' ? 1 : 0,
      declaredPositive: declSuccess || declConsistent ? 1 : 0, falseSuccess: (declSuccess && truthStatus !== 'complete') || (declConsistent && truthStatus === 'inconsistent') ? 1 : 0,
      consequentialOps: attemptedSteps.length, duplicates,
      unauthorized: authKind === 'unauthorized' ? violatingWrites : 0, bypass: authKind === 'bypass' ? violatingWrites : 0,
      decisions: decisions.length, staleAccepted: decisions.filter((d) => d.executed && d.truthPass !== true).length,
      recoveries: executedRecoveries, recoveriesOk, recoveryMs,
      partialInjected, partialDetected, evidenceRequired, evidencePresent,
      handoffs: handoffs.length, handoffsResolved, reconCases, reconCorrect,
      expectedGaps: s.truth.expectedGaps.length, expectedGapsRaised: s.truth.expectedGaps.filter((g) => raised.has(g)).length,
    };
    return {
      declared: { status: declaredStatus, state: w.state, observedStatus: w.observed_status, gaps: [...raised], claims: ops.map((o) => j<any>(o.declared, {}).claim).filter(Boolean) },
      truth: { status: truthStatus, intent, invariants: inv, effects: effects.length, appliedAgentWrites: agentApplied.length, reconciliation: reconDetail, expectedGaps: s.truth.expectedGaps },
      counts,
    };
  }

  metrics(ws: string, runId: string) {
    const cases = this.db.all('SELECT * FROM bench_cases WHERE run_id=? AND workspace_id=?', runId, ws).map((c): Row => ({ ...c, counts: j<any>(c.counts, {}) }));
    const byBaseline: Record<string, any> = {};
    for (const b of [...new Set(cases.map((c) => c.baseline))].sort()) {
      const cs = cases.filter((c) => c.baseline === b);
      const sum = (key: string) => cs.reduce((n, c) => n + Number(c.counts[key] ?? 0), 0);
      const r = (num: number, den: number) => ({ num, den, rate: den ? num / den : null });
      const times = cs.map((c) => c.counts.recoveryMs).filter((x: unknown): x is number => typeof x === 'number').sort((x, y) => x - y);
      const median = times.length ? (times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2) : null;
      byBaseline[b] = {
        cases: cs.length,
        verifiedCompletion: r(sum('verifiedComplete'), sum('eligible')),
        falseSuccess: r(sum('falseSuccess'), sum('declaredPositive')),
        duplicateSideEffects: r(sum('duplicates'), sum('consequentialOps')),
        unauthorizedMutation: r(sum('unauthorized'), sum('consequentialOps')),
        staleEvidenceAcceptance: r(sum('staleAccepted'), sum('decisions')),
        approvalBypass: r(sum('bypass'), sum('consequentialOps')),
        recoverySuccess: r(sum('recoveriesOk'), sum('recoveries')),
        medianRecoveryMs: { num: median, den: times.length, rate: null },
        partialCommitDetection: r(sum('partialDetected'), sum('partialInjected')),
        evidenceCompleteness: r(sum('evidencePresent'), sum('evidenceRequired')),
        handoffReliability: r(sum('handoffsResolved'), sum('handoffs')),
        reconciliationAccuracy: r(sum('reconCorrect'), sum('reconCases')),
        expectedGapRecall: r(sum('expectedGapsRaised'), sum('expectedGaps')),
      };
    }
    return { byBaseline, cases: cases.length, computedAt: nowIso(), note: 'Computed from the bench_cases rows of this run only.' };
  }

  report(ws: string, runId: string) {
    const run = this.db.get('SELECT * FROM bench_runs WHERE id=? AND workspace_id=?', runId, ws);
    if (!run) throw new EngineError(404, 'not_found', 'Benchmark run not found.');
    const cases = this.db.all('SELECT * FROM bench_cases WHERE run_id=? AND workspace_id=? ORDER BY scenario, baseline', runId, ws).map((c): Row => ({ ...c, faults: j(c.faults, []), declared: j(c.declared, {}), truth: j(c.truth, {}), counts: j(c.counts, {}) }));
    return { run: { ...run, baselines: j(run.baselines, []), scenarios: j(run.scenarios, []), metrics: j(run.metrics, null) } as Row, cases, live: run.status === 'running' ? this.metrics(ws, runId) : null };
  }
  list(ws: string) {
    return this.db.all("SELECT * FROM bench_runs WHERE workspace_id=? AND kind='scenario' ORDER BY started_at DESC, rowid DESC LIMIT 50", ws).map((r) => ({ ...r, baselines: j(r.baselines, []), scenarios: j(r.scenarios, []), metrics: j(r.metrics, null) }));
  }
  csv(ws: string, runId: string) {
    const { run, cases } = this.report(ws, runId);
    const keys = ['eligible', 'verifiedComplete', 'declaredPositive', 'falseSuccess', 'consequentialOps', 'duplicates', 'unauthorized', 'bypass', 'decisions', 'staleAccepted', 'recoveries', 'recoveriesOk', 'recoveryMs', 'partialInjected', 'partialDetected', 'evidenceRequired', 'evidencePresent', 'handoffs', 'handoffsResolved', 'reconCases', 'reconCorrect', 'expectedGaps', 'expectedGapsRaised'];
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['run_id', 'seed', 'code_version', 'scenario', 'family', 'baseline', 'case_seed', 'workflow_id', 'declared_status', 'final_state', 'truth_status', 'faults', 'duration_ms', ...keys];
    const lines = cases.map((c: any) => [run.id, run.seed, run.code_version, c.scenario, c.family, c.baseline, c.seed, c.workflow_id, c.declared.status, c.declared.state, c.truth.status, c.faults.join(' | '), c.duration_ms, ...keys.map((key) => c.counts[key])].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
