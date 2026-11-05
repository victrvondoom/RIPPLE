import { j, nowIso, sha256, stable, uid, type Row } from '../../db/db.js';
import type { Actor, Engine } from '../../engine/engine.js';
import { EngineError } from '../../engine/types.js';
import { recordCausalEvent, type CauseType, type CausalLifecycleState } from '../../engine/causal.js';
import { canMove, R_STATES, type RState } from '../states.js';
import { agentById, applyPatch, Lab, LabError, LAB_LABEL, stateHash } from '../lab.js';
import { compensationChecks } from '../rge.js';
import { BASELINES, type Controls, type Patch, type ResourceState } from '../types.js';
import { evaluateAll, isBlockingStrength, type EvalCtx } from './invariants.js';
import { CD_PACKS, cdPack, effective } from './packs.js';
import { cdScenarioById } from './scenarios.js';
import {
  PATTERN_LABELS, refKey, type AltContext, type Alternative, type ApprovalLevel, type CdScenario, type Commitment, type EvalResult,
  type Evaluation, type InvariantDef, type OpDef, type Pattern, type PlanAction,
} from './types.js';

/**
 * CROSS-DOMAIN INTERSECTION ENGINE.
 * Evaluates every workflow of a campaign (one shared sandbox world) against its own contract, the shared invariant set,
 * the other active workflows, their pending approvals, fresh evidence and time — and finds what no single workflow can
 * see: collisions, shared constraints, invalidated dependencies, contradictory declarations and recoveries that would
 * break someone else. Conflicts go through constrained arbitration (simulated candidate plans; hard constraints cannot
 * be overridden by anyone), a hash-bound human approval, basis revalidation, guarded execution and independent
 * verification of every affected invariant. Nothing here trusts an agent's claim or a tool response as proof.
 */

const RESOLUTION_TTL_MS = 15 * 60_000;
const PLAN_APPROVAL_TTL_MS = 24 * 60 * 60_000;
const MAX_READS = 3;
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const hashOf = (s: ResourceState | undefined) => (s === undefined ? null : stateHash(s));
const eq = (a: unknown, b: unknown) => stable(a ?? null) === stable(b ?? null);

export type CampaignState = 'OPEN' | 'CONSISTENT' | 'CONFLICTED' | 'ARBITRATION' | 'AWAITING_APPROVAL' | 'EXECUTING' | 'RESOLVED' | 'REQUIRES_HUMAN';
const CT: Record<CampaignState, CampaignState[]> = {
  OPEN: ['CONSISTENT', 'CONFLICTED', 'REQUIRES_HUMAN'],
  CONSISTENT: ['CONFLICTED', 'EXECUTING', 'RESOLVED', 'REQUIRES_HUMAN'],
  CONFLICTED: ['ARBITRATION', 'CONSISTENT', 'REQUIRES_HUMAN', 'EXECUTING'],
  ARBITRATION: ['AWAITING_APPROVAL', 'REQUIRES_HUMAN', 'CONFLICTED', 'CONSISTENT'],
  AWAITING_APPROVAL: ['EXECUTING', 'ARBITRATION', 'REQUIRES_HUMAN', 'CONFLICTED'],
  EXECUTING: ['RESOLVED', 'REQUIRES_HUMAN', 'ARBITRATION', 'CONSISTENT', 'CONFLICTED'],
  RESOLVED: ['CONFLICTED', 'CONSISTENT', 'EXECUTING'],
  REQUIRES_HUMAN: ['ARBITRATION', 'CONFLICTED', 'CONSISTENT', 'EXECUTING'],
};
export const CAMPAIGN_STATES = Object.keys(CT) as CampaignState[];

/** Baseline controls mapped onto the cross-domain runner (same switches RIGOR uses; see docs). */
export function cdControls(c: Controls) {
  return { gate: c.reconciliation && c.evidenceFreshness, revalidate: c.evidenceFreshness, cas: c.guardedWrites, readBack: c.readBackOnError, verify: c.independentVerification, binding: c.approvalPlanBinding, roleCheck: c.roleCheck, structured: c.structuredApprovalsOnly, approvalGate: c.approvalGate };
}
export type CdCtl = ReturnType<typeof cdControls>;

/** Scoring-only hooks (cross-domain benchmark). They observe; they cannot influence a run. */
export interface CdHooks {
  beforeWrite?(info: { workflow: string; op: string; kind: string; system: string; resource: string; approvalId: string | null; boundHash: string | null; executedHash: string | null; basis: Record<string, string | null> }): void;
  beforeRecovery?(): void;
}

interface Snap { [ref: string]: { available: boolean; state: ResourceState; hash: string | null; obsId: string; at: string } }
interface Sim {
  read(k: string): ResourceState | undefined; status: Map<string, string>; seq: Map<string, number>; claims: Commitment[];
  rejected: { workflow: string; op: string; reason: string }[]; unknownActions: { workflow: string; op: string; reason: string }[];
  effects: { ref: string; before: unknown; after: unknown; action: string }[];
}
export interface OptionOut {
  id: string; kind: 'proceed' | 'repair' | 'withdraw' | 'recovery' | 'escalate'; label: string; rationale: string; actions: PlanAction[]; hash: string;
  status: 'feasible' | 'rejected' | 'escalation'; preserved: string[]; violated: { key: string; name: string; strength: string; detail: string }[];
  unknown: { key: string; detail: string }[]; softViolations: { key: string; detail: string }[]; newlyBroken: string[];
  rejectedActions: { workflow: string; op: string; reason: string }[]; expectedEffects: Sim['effects']; affectedWorkflows: string[];
  reversibility: 'reversible' | 'compensable' | 'irreversible'; evidenceStrength: { readable: number; total: number; fresh: number; score: number };
  uncertainty: string[]; approvalLevel: ApprovalLevel; why: string; cost: number; alternativesApplied: string[]; isRecovery: boolean;
}

export class CrossDomainEngine {
  constructor(public engine: Engine) {}
  get db() { return this.engine.db; }

  // ================================================================== basics
  campaign(ws: string, id: string): Row {
    const c = this.db.get('SELECT * FROM cd_campaigns WHERE id=? AND workspace_id=?', id, ws);
    if (!c) throw new EngineError(404, 'not_found', 'Cross-domain campaign not found.');
    return c;
  }
  scenario(c: Row): CdScenario { const s = cdScenarioById(c.scenario); if (!s) throw new EngineError(500, 'no_scenario', `Scenario ${c.scenario} is not installed.`); return s; }
  ctl(c: Row): CdCtl { return cdControls(j<Controls>(c.controls, BASELINES['B4-resolve-full'].controls)); }
  lab(c: Row) { return new Lab(this.db, c.workspace_id, c.id, 'cd_campaigns'); }
  private wfs(c: Row): Row[] { return this.db.all('SELECT * FROM cd_workflows WHERE campaign_id=? AND workspace_id=? ORDER BY rowid', c.id, c.workspace_id).map((w) => ({ ...w, plan: j(w.plan, {}), basis: j(w.basis, {}), declared_links: j(w.declared_links, []), declared: j(w.declared, []) })); }
  private ops(c: Row): Row[] { return this.db.all('SELECT rowid AS rowid, * FROM cd_ops WHERE campaign_id=? AND workspace_id=? ORDER BY rowid', c.id, c.workspace_id).map((o) => ({ ...o, spec: j<OpDef>(o.spec, {}), verifier: j(o.verifier, []), tool_response: j(o.tool_response, null) })); }
  private invariants(c: Row): InvariantDef[] {
    return this.db.all('SELECT * FROM cd_invariants WHERE campaign_id=? AND workspace_id=? ORDER BY rowid', c.id, c.workspace_id).map((r) => ({
      key: r.inv_key, version: r.version, name: r.name, explanation: r.explanation, scope: r.scope, owner: r.owner_workflow ?? undefined, spec: j(r.spec, {}),
      requiredEvidence: j(r.required_evidence, []), preconditions: j(r.preconditions, []), severity: r.severity, impact: r.impact, validFrom: r.valid_from ?? undefined, validUntil: r.valid_until ?? undefined,
      resolutionPolicy: r.resolution_policy, approvalLevel: r.approval_level, strength: r.strength, conditionWorkflow: j<any>(r.spec, {}).__condition ?? undefined, autoRestorable: !!r.auto_restorable,
      provenance: j(r.provenance, {}), confidence: r.confidence, uncertainty: r.uncertainty, dependsOn: j(r.depends_on, []),
    }));
  }
  private audit(c: Row, actor: string, type: string, summary: string, data: unknown = {}) { this.engine.audit(c.workspace_id, c.id, agentById(actor) || ['ripple-cdii', 'world'].includes(actor) ? 'agent' : 'user', actor, `cdii_${type}`, summary, data); }
  private causal(c: Row, cause: CauseType, state: CausalLifecycleState, summary: string, actor: string, observed: Record<string, unknown> = {}, parent?: string | null) {
    return recordCausalEvent(this.db, { workspaceId: c.workspace_id, missionId: c.id, parentEventId: parent === undefined ? c.causal_root ?? null : parent, causeType: cause, lifecycleState: state, summary, actor, observedState: observed }).id;
  }
  private moveCampaign(c: Row, to: CampaignState, reason: string, actor = 'ripple-cdii') {
    const from = c.state as CampaignState;
    if (from !== to && !CT[from]?.includes(to)) throw new EngineError(409, 'invalid_transition', `Invalid campaign transition ${from} -> ${to}.`);
    this.db.exec('UPDATE cd_campaigns SET state=?, state_reason=?, updated_at=? WHERE id=? AND workspace_id=?', to, reason, nowIso(), c.id, c.workspace_id);
    if (from !== to) this.audit(c, actor, 'state', `${from} → ${to}: ${reason}`, { from, to });
    c.state = to; c.state_reason = reason;
  }
  /** Moves a workflow through the reality state machine (states.ts), hop by hop along the shortest legal path; every hop audited. */
  private walk(c: Row, w: Row, to: RState, reason: string) {
    const from = w.state as RState; if (from === to) return;
    const prev = new Map<RState, RState>(); const q: RState[] = [from]; const seen = new Set<RState>([from]);
    while (q.length) { const cur = q.shift()!; if (cur === to) break; for (const n of R_STATES) if (!seen.has(n) && n !== cur && canMove(cur, n)) { seen.add(n); prev.set(n, cur); q.push(n); } }
    if (!seen.has(to)) throw new EngineError(409, 'invalid_transition', `No legal path ${from} -> ${to}.`);
    const path: RState[] = []; for (let s: RState | undefined = to; s && s !== from; s = prev.get(s)) path.unshift(s);
    for (const s of path) this.audit(c, 'ripple-cdii', 'workflow_state', `${w.wf_key}: → ${s}${s === to ? `: ${reason}` : ''}`, { workflow: w.wf_key });
    this.db.exec('UPDATE cd_workflows SET state=?, state_reason=?, updated_at=? WHERE id=? AND workspace_id=?', to, reason, nowIso(), w.id, c.workspace_id);
    w.state = to; w.state_reason = reason;
  }
  userByHandle(ws: string, handle: string): Row | undefined { return this.db.get('SELECT * FROM users WHERE workspace_id=? AND lower(email) LIKE ?', ws, `${handle.toLowerCase()}@%`); }

  // ================================================================== graph (typed, provenance on every edge)
  private graphBatch(c: Row, summary: string, source: string, nodes: { id: string; type: string; label: string; ref?: string | null; domain?: string | null; data?: unknown }[], edges: { from: string; to: string; rel: string; evidence?: string | null; why?: string }[]) {
    if (!nodes.length && !edges.length) return;
    const cau = this.causal(c, 'agent_inference', 'OBSERVED', `Cross-domain graph: ${summary} (${nodes.length} nodes, ${edges.length} edges)`, 'intersection', { source });
    for (const n of nodes) this.db.exec('INSERT OR IGNORE INTO cd_nodes (id, workspace_id, campaign_id, type, ref_id, label, domain, data, created_at) VALUES (?,?,?,?,?,?,?,?,?)', n.id, c.workspace_id, c.id, n.type, n.ref ?? null, n.label, n.domain ?? null, JSON.stringify(n.data ?? {}), nowIso());
    for (const e of edges) this.db.exec('INSERT OR IGNORE INTO cd_edges (id, workspace_id, campaign_id, from_node, to_node, rel, provenance, evidence_id, causal_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', uid('cde'), c.workspace_id, c.id, e.from, e.to, e.rel, JSON.stringify({ source, why: e.why ?? summary }), e.evidence ?? null, cau, nowIso());
  }
  private edges(c: Row): Row[] { return this.db.all('SELECT * FROM cd_edges WHERE campaign_id=? AND workspace_id=? ORDER BY rowid', c.id, c.workspace_id); }

  // ================================================================== evidence
  private observe(c: Row, lab: Lab, observer: string, ref: string, purpose: string, ownerId: string, opId: string | null = null) {
    const [system, resource] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
    const id = uid('ob');
    try {
      const r = lab.observe(observer, system, resource); const at = nowIso();
      this.db.insert('rw_observations', { id, workspace_id: c.workspace_id, workflow_id: ownerId, operation_id: opId, purpose, system, resource, observer, available: 1, state: JSON.stringify(r.state), state_hash: stateHash(r.state), updated_by: r.updated_by, policy: 'mutable', observed_at: at, valid_until: null, invalidated_at: null, invalidated_reason: null });
      return { id, available: true, state: r.state, hash: stateHash(r.state) as string | null, at };
    } catch (e) {
      const at = nowIso();
      this.db.insert('rw_observations', { id, workspace_id: c.workspace_id, workflow_id: ownerId, operation_id: opId, purpose, system, resource, observer, available: 0, state: null, state_hash: null, updated_by: null, policy: 'mutable', observed_at: at, valid_until: at, invalidated_at: null, invalidated_reason: `unreadable: ${String((e as Error).message)}` });
      return { id, available: false, state: {} as ResourceState, hash: null as string | null, at };
    }
  }
  private worldRefs(c: Row): string[] { return this.db.all('SELECT system, resource FROM lab_resources WHERE workflow_id=? AND workspace_id=? ORDER BY system, resource', c.id, c.workspace_id).map((r) => `${r.system}/${r.resource}`); }
  private snapshot(c: Row, purpose: string): Snap {
    const lab = this.lab(c); const snap: Snap = {};
    for (const k of this.worldRefs(c)) {
      let o = this.observe(c, lab, 'intersection', k, purpose, c.id);
      for (let i = 1; i < MAX_READS && !o.available; i++) o = this.observe(c, lab, 'intersection', k, purpose, c.id);
      snap[k] = { available: o.available, state: o.state, hash: o.hash, obsId: o.id, at: o.at };
    }
    return snap;
  }
  private obsRow(ws: string, id: string | null | undefined) { return id ? this.db.get('SELECT * FROM rw_observations WHERE id=? AND workspace_id=?', id, ws) : undefined; }

  // ================================================================== creation
  async create(a: Actor, scenarioId: string, opts: { baseline?: string; source?: 'live' | 'benchmark'; benchRunId?: string; seed?: string } = {}) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot start campaigns.');
    const source = opts.source ?? 'live';
    if (source === 'live') this.engine.require(a, 'owner', 'manager');
    const s = cdScenarioById(scenarioId); if (!s) throw new EngineError(404, 'not_found', `Unknown cross-domain scenario "${scenarioId}".`);
    const baseline = opts.baseline ?? 'B4-resolve-full'; const b = BASELINES[baseline]; if (!b) throw new EngineError(422, 'bad_baseline', `Unknown baseline "${baseline}".`);
    const id = uid('cdc');
    const c: Row = { id, workspace_id: a.workspaceId, scenario: s.id, title: s.title, story: s.story, state: 'OPEN', state_reason: 'Campaign world seeded; workflows planned.', baseline, controls: JSON.stringify(b.controls), source, bench_run_id: opts.benchRunId ?? null, seed: opts.seed ?? 'live', fault_state: '{"faults":[],"blocked":{}}', events_done: '[]', round: 0, causal_root: null, created_by: a.id, created_at: nowIso(), updated_at: nowIso() };
    this.db.insert('cd_campaigns', c);
    Lab.seed(this.db, a.workspaceId, id, s.initial, [], 'cd_campaigns');
    c.causal_root = this.causal(c, 'agent_inference', 'PLANNED', `Cross-domain campaign "${s.title}": ${s.workflows.length} workflows from ${s.packs.length} domain packs in one shared sandbox world (${s.initial.length} resources)`, 'planner', { baseline, packs: s.packs }, null);
    this.db.exec('UPDATE cd_campaigns SET causal_root=? WHERE id=?', c.causal_root, id);
    const lab = this.lab(c);
    const W: Record<string, Row> = {};
    for (const wd of s.workflows) {
      const w: Row = { id: uid('cdw'), workspace_id: a.workspaceId, campaign_id: id, wf_key: wd.key, pack: wd.pack, domain: cdPack(wd.pack)?.domain ?? wd.pack, title: wd.title, intent: wd.intent, owner: wd.owner, plan: JSON.stringify({ ops: wd.ops, localInvariants: wd.localInvariants ?? [] }), plan_hash: '', basis: '{}', declared_links: JSON.stringify(wd.declaredLinks ?? []), state: 'PLANNED', state_reason: 'Planned by its own planner.', local_status: null, global_status: null, declared: '[]', created_at: nowIso(), updated_at: nowIso() };
      this.db.insert('cd_workflows', w); W[wd.key] = { ...w, plan: { ops: wd.ops }, basis: {} };
      for (const op of wd.ops) this.db.insert('cd_ops', { id: uid('cdo'), workspace_id: a.workspaceId, campaign_id: id, workflow_id: w.id, op_key: op.key, kind: op.isCompensation ? 'compensation' : 'forward', label: op.label, system: op.system, resource: op.resource, agent: `exec.${op.system}`, spec: JSON.stringify(op), status: op.scheduled ? 'scheduled' : 'pending', origin: op.scheduled ? 'scheduled' : 'plan', created_at: nowIso(), updated_at: nowIso() });
    }
    const refsOf = (key: string) => { const wd = s.workflows.find((x) => x.key === key)!; return [...new Set([...wd.ops.map((o) => `${o.system}/${o.resource}`), ...(wd.localInvariants ?? []).flatMap((i) => specReads(i))])]; };
    const historyWfs = new Set((s.history ?? []).map((h) => h.workflow));
    const plan = (key: string, refs: string[], stale = false) => {
      const w = W[key]; const basis = j<Record<string, any>>(this.db.get('SELECT basis FROM cd_workflows WHERE id=?', w.id)?.basis, {});
      for (const r of refs) { if (basis[r]) continue; const o = this.observe(c, lab, 'planner', r, stale ? 'cd-planning (taken before the world changed)' : 'cd-planning', w.id); basis[r] = { obsId: o.id, hash: o.hash, at: o.at, available: o.available, planObs: o.id, planHash: o.hash }; }
      this.db.exec('UPDATE cd_workflows SET basis=? WHERE id=?', JSON.stringify(basis), w.id); w.basis = basis;
    };
    const seal = (key: string) => {
      const wd = s.workflows.find((x) => x.key === key)!; const w = W[key];
      const ph = sha256(stable({ ops: wd.ops, basis: Object.fromEntries(Object.entries(w.basis as Record<string, any>).map(([r, v]) => [r, v.planHash ?? v.hash])) }));
      this.db.exec('UPDATE cd_workflows SET plan_hash=? WHERE id=?', ph, w.id); w.plan_hash = ph;
      if (wd.approvedBy) this.recordPlanApproval(c, w, null, wd.approvedBy);
    };
    // Phase A — planning of workflows that act in the history, plus stale evidence taken BEFORE the world changed.
    for (const key of historyWfs) { plan(key, refsOf(key)); seal(key); }
    for (const wd of s.workflows) if (wd.stalePlanningEvidence?.length) plan(wd.key, wd.stalePlanningEvidence.map(refKey), true);
    // Phase B — the world's history (through the same guarded executor).
    for (const h of s.history ?? []) {
      const w = W[h.workflow]; const op = this.db.get('SELECT * FROM cd_ops WHERE workflow_id=? AND op_key=? AND workspace_id=?', w.id, h.op, a.workspaceId)!;
      if (h.fail) this.db.exec('UPDATE cd_campaigns SET fault_state=? WHERE id=?', JSON.stringify({ faults: [{ kind: 'unavailable', step: `${h.workflow}:${h.op}`, reads: 0, remaining: 1, label: `${op.system} unavailable during history step ${h.op}` }], blocked: {} }), id);
      const ap = this.validPlanApprovals(c, w, FULL_CTL)[0];
      this.executeOp(c, lab, w, { ...op, spec: j(op.spec, {}) }, j<OpDef>(op.spec, {}), 'execute', FULL_CTL, { approvalId: ap?.id ?? null, boundHash: ap?.subject_hash ?? null, executedHash: w.plan_hash, idemScope: `hist:${String(w.plan_hash).slice(0, 12)}`, basis: {} }, {});
    }
    this.db.exec('UPDATE cd_campaigns SET fault_state=? WHERE id=?', '{"faults":[],"blocked":{}}', id);
    // Phase C — planning of every other workflow on the current world.
    for (const wd of s.workflows) if (!historyWfs.has(wd.key)) { plan(wd.key, refsOf(wd.key)); seal(wd.key); }
    // Invariants: policy + pack/local + inferred (freshness of every decision basis, completeness, provenance, authorization).
    const defs: InvariantDef[] = [...s.sharedInvariants, ...s.workflows.flatMap((wd) => wd.localInvariants ?? [])];
    for (const wd of s.workflows) {
      const w = W[wd.key]; const core = wd.ops.filter((o) => !o.isCompensation && !o.scheduled).map((o) => o.key);
      if (wd.ops.some((o) => !o.scheduled)) for (const r of Object.keys(w.basis)) defs.push(inferred(`fresh:${wd.key}:${r}`, `${wd.title}: decision evidence for ${r} is still current`, `${wd.key} decided on a read of ${r}. If that resource changed since, the decision basis is stale.`, { type: 'freshness', workflow: wd.key, ref: { system: r.slice(0, r.indexOf('/')), resource: r.slice(r.indexOf('/') + 1) } }, wd.key, 'high'));
      if (core.length) defs.push(inferred(`complete:${wd.key}`, `${wd.title}: every required operation verified`, `${wd.key} is complete only when ${core.join(', ')} are independently verified.`, { type: 'completeness', workflow: wd.key, ops: core }, wd.key, 'high'));
      defs.push(inferred(`provenance:${wd.key}`, `${wd.title}: claims backed by evidence`, `Every consequential claim made by ${wd.key}'s agents must be backed by an attributable independent observation.`, { type: 'provenance', workflow: wd.key }, wd.key, 'medium'));
      if (wd.approvedBy) defs.push(inferred(`authority:${wd.key}`, `${wd.title}: valid authority`, `${wd.key} needs a structured, unexpired, plan-bound approval from a manager or owner at execution time.`, { type: 'authorization', workflow: wd.key, role: 'manager' }, wd.key, 'high'));
    }
    for (const d of defs) this.saveInvariant(c, d);
    // Fault injection activated after planning (labelled; sandbox only).
    if (s.faults?.length) {
      this.db.exec('UPDATE cd_campaigns SET fault_state=? WHERE id=?', JSON.stringify({ faults: s.faults.map((f) => ({ ...f, remaining: f.times ?? 1 })), blocked: {} }), id);
      for (const f of s.faults) this.causal(c, 'fault_injection', 'FAULT_INJECTED', `Fault armed (sandbox): ${f.label}`, 'reality-lab', { kind: f.kind, system: f.system });
    }
    for (const w of this.wfs(c)) this.settleWorkflowState(c, w);
    this.buildDeclaredGraph(c);
    this.localValidity(c);
    this.audit(c, a.name, 'created', `Cross-domain campaign "${s.title}" created (${baseline}, ${source}).`);
    return this.campaign(a.workspaceId, id);
  }

  private saveInvariant(c: Row, d: InvariantDef) {
    const spec = d.conditionWorkflow ? { ...d.spec, __condition: d.conditionWorkflow } : d.spec;
    this.db.insert('cd_invariants', { id: uid('cdi'), workspace_id: c.workspace_id, campaign_id: c.id, inv_key: d.key, version: d.version ?? 1, type: d.spec.type, name: d.name, explanation: d.explanation, scope: d.scope, owner_workflow: d.owner ?? null, systems: JSON.stringify([...new Set(specReads(d).map((r) => r.slice(0, r.indexOf('/'))))]), resources: JSON.stringify(specReads(d)), required_evidence: JSON.stringify(d.requiredEvidence ?? specReads(d).map((r) => `independent read of ${r}`)), preconditions: JSON.stringify(d.preconditions ?? []), spec: JSON.stringify(spec), severity: d.severity, impact: d.impact, valid_from: d.validFrom ?? null, valid_until: d.validUntil ?? null, resolution_policy: d.resolutionPolicy, approval_level: d.approvalLevel, strength: d.strength, auto_restorable: d.autoRestorable ? 1 : 0, provenance: JSON.stringify(d.provenance), confidence: d.confidence ?? 1, uncertainty: d.uncertainty ?? 'Evaluated from independent sandbox reads.', depends_on: JSON.stringify(d.dependsOn ?? []), last_result: null, last_eval: null, created_at: nowIso(), updated_at: nowIso() });
  }

  private recordPlanApproval(c: Row, w: Row, a: Actor | null, handle?: string) {
    const user = a ? this.db.get('SELECT * FROM users WHERE id=? AND workspace_id=?', a.id, c.workspace_id) : handle ? this.userByHandle(c.workspace_id, handle) : undefined;
    if (!user) throw new EngineError(403, 'forbidden', 'Approvals must come from an authenticated user.');
    if (!['owner', 'manager'].includes(user.role)) throw new EngineError(403, 'forbidden', 'Only a manager or owner can approve a workflow plan.');
    const id = uid('rap');
    this.db.insert('rw_approvals', { id, workspace_id: c.workspace_id, workflow_id: w.id, subject: 'plan', subject_hash: w.plan_hash, plan_version: 1, user_id: user.id, user_name: user.name, role_at_decision: user.role, channel: 'structured', status: 'recorded', invalid_reason: null, created_at: nowIso(), expires_at: new Date(Date.now() + PLAN_APPROVAL_TTL_MS).toISOString() });
    this.causal(c, 'governance', 'AUTHORIZED', `${user.name} approved ${w.wf_key}'s plan (bound to ${String(w.plan_hash).slice(0, 10)})`, user.name, { approvalId: id, workflow: w.wf_key });
    this.graphBatch(c, `approval of ${w.wf_key}`, 'approval', [{ id: `ap:${id}`, type: 'approval', label: `${user.name} approved ${w.wf_key} plan`, ref: id }], [{ from: `wf:${w.wf_key}`, to: `ap:${id}`, rel: 'governed_by', why: 'plan approval bound to the plan hash' }]);
    return id;
  }
  approveWorkflow(a: Actor, cid: string, wfKey: string) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot approve.');
    this.engine.require(a, 'owner', 'manager');
    const c = this.campaign(a.workspaceId, cid); const w = this.wfs(c).find((x) => x.wf_key === wfKey);
    if (!w) throw new EngineError(404, 'not_found', 'Workflow not in this campaign.');
    this.recordPlanApproval(c, w, a);
    if (w.state === 'AUTHORIZATION_PENDING') this.walk(c, w, 'AUTHORIZED', `Plan approved by ${a.name}.`);
    return this.detail(a.workspaceId, cid);
  }
  /** Valid plan approvals for a workflow under the given controls (structured, role now, bound to the current plan hash, unexpired). */
  private validPlanApprovals(c: Row, w: Row, ctl: CdCtl): Row[] {
    return this.db.all("SELECT * FROM rw_approvals WHERE workflow_id=? AND workspace_id=? AND subject='plan' AND status='recorded' ORDER BY created_at, rowid", w.id, c.workspace_id).filter((r) => {
      if (ctl.structured && r.channel !== 'structured') return false;
      if (ctl.roleCheck) { const role = this.db.get('SELECT role FROM users WHERE id=? AND workspace_id=?', r.user_id, c.workspace_id)?.role; if (!['owner', 'manager'].includes(role)) return false; }
      if (ctl.binding && (r.subject_hash !== w.plan_hash || r.expires_at < nowIso())) return false;
      return true;
    });
  }

  private settleWorkflowState(c: Row, w: Row) {
    const ops = this.db.all("SELECT status FROM cd_ops WHERE workflow_id=? AND workspace_id=? AND status!='scheduled'", w.id, c.workspace_id);
    const approved = this.validPlanApprovals(c, w, FULL_CTL).length > 0;
    const done = ops.filter((o) => o.status === 'verified').length; const failed = ops.some((o) => ['failed', 'unknown', 'rejected'].includes(o.status));
    if (!ops.length) { this.walk(c, w, approved ? 'AUTHORIZED' : 'AUTHORIZATION_PENDING', 'Concurrent workflow: its steps run on its own schedule, outside this campaign\'s arbitration.'); return; }
    if (failed) this.walk(c, w, 'PARTIALLY_COMPLETED', `${done} operation(s) committed; a later operation failed.`);
    else if (done === ops.length) this.walk(c, w, 'VERIFIED', 'Every operation independently verified.');
    else if (done > 0) this.walk(c, w, 'EXECUTING', `${done}/${ops.length} operations verified; the rest are pending.`);
    else this.walk(c, w, approved ? 'AUTHORIZED' : 'AUTHORIZATION_PENDING', approved ? 'Plan approved (bound to its plan hash).' : 'Waiting for a plan approval.');
  }

  private buildDeclaredGraph(c: Row) {
    const wfs = this.wfs(c); const ops = this.ops(c); const defs = this.invariants(c);
    const nodes: any[] = []; const edges: any[] = [];
    for (const w of wfs) {
      nodes.push({ id: `dom:${w.pack}`, type: 'domain', label: `${cdPack(w.pack)?.domain ?? w.pack} (${cdPack(w.pack)?.label ?? w.pack})`, domain: w.pack });
      nodes.push({ id: `wf:${w.wf_key}`, type: 'workflow', label: w.title, ref: w.id, domain: w.pack });
      edges.push({ from: `wf:${w.wf_key}`, to: `dom:${w.pack}`, rel: 'belongs_to' });
      for (const l of w.declared_links) edges.push({ from: `wf:${w.wf_key}`, to: `wf:${l}`, rel: 'depends_on', why: 'declared dependency in the plan' });
      const mine = ops.filter((o) => o.workflow_id === w.id);
      mine.forEach((o, i) => {
        const ref = `${o.system}/${o.resource}`; const k = o.spec.effect?.kind;
        nodes.push({ id: `op:${w.wf_key}:${o.op_key}`, type: 'operation', label: o.label, ref: o.id, domain: w.pack }, { id: `res:${ref}`, type: 'resource', label: ref }, { id: `agent:${o.agent}`, type: 'agent', label: agentById(o.agent)?.name ?? o.agent });
        edges.push({ from: `wf:${w.wf_key}`, to: `op:${w.wf_key}:${o.op_key}`, rel: 'requires' }, { from: `agent:${o.agent}`, to: `op:${w.wf_key}:${o.op_key}`, rel: 'executes' });
        edges.push({ from: `op:${w.wf_key}:${o.op_key}`, to: `res:${ref}`, rel: ['reserve', 'schedule'].includes(k) ? 'reserves' : ['consume', 'spend'].includes(k) ? 'consumes' : k === 'release' ? 'releases' : 'modifies' });
        if (o.spec.isCompensation) { const tgt = mine.find((x) => `${x.system}/${x.resource}` === ref && !x.spec.isCompensation); if (tgt) edges.push({ from: `op:${w.wf_key}:${o.op_key}`, to: `op:${w.wf_key}:${tgt.op_key}`, rel: 'compensates_for' }); }
        if (i > 0) edges.push({ from: `op:${w.wf_key}:${mine[i - 1].op_key}`, to: `op:${w.wf_key}:${o.op_key}`, rel: 'temporally_precedes' });
      });
      for (const [r, b] of Object.entries(w.basis as Record<string, any>)) { nodes.push({ id: `obs:${b.obsId}`, type: 'evidence', label: `${w.wf_key} planning read of ${r}`, ref: b.obsId }, { id: `res:${r}`, type: 'resource', label: r }); edges.push({ from: `wf:${w.wf_key}`, to: `obs:${b.obsId}`, rel: 'requires', evidence: b.obsId, why: 'decision basis' }, { from: `obs:${b.obsId}`, to: `res:${r}`, rel: 'derived_from', evidence: b.obsId }); }
    }
    for (const d of defs) {
      nodes.push({ id: `inv:${d.key}`, type: d.provenance.source === 'policy' ? 'policy' : 'invariant', label: d.name, domain: null, data: { type: d.spec.type, strength: d.strength } });
      for (const r of specReads(d)) { nodes.push({ id: `res:${r}`, type: 'resource', label: r }); edges.push({ from: `res:${r}`, to: `inv:${d.key}`, rel: 'governed_by' }); }
      const owner = d.owner ?? (d.spec as any).workflow; if (owner) edges.push({ from: `wf:${owner}`, to: `inv:${d.key}`, rel: 'governed_by', why: 'invariant scoped to this workflow' });
      if (d.spec.type === 'temporal_order') edges.push({ from: `op:${d.spec.before.workflow}:${d.spec.before.op}`, to: `op:${d.spec.after.workflow}:${d.spec.after.op}`, rel: 'temporally_precedes', why: d.name });
    }
    this.graphBatch(c, 'derived from plan declarations, planning evidence and the invariant set', 'plan-declaration', dedupeNodes(nodes), edges);
  }

  // ================================================================== evaluation contexts
  private statusMap(c: Row) { const m = new Map<string, string>(); const seq = new Map<string, number>(); const wfs = this.wfs(c); for (const o of this.ops(c)) { const w = wfs.find((x) => x.id === o.workflow_id); if (w) { m.set(`${w.wf_key}:${o.op_key}`, o.status); if (o.attempts) seq.set(`${w.wf_key}:${o.op_key}`, Number(o.rowid ?? 0)); } } return { m, seq }; }
  private isActiveIn(status: Map<string, string>, wf: Row): boolean {
    const mine = (wf.plan.ops as OpDef[]).filter((o) => !o.scheduled);
    if (mine.some((o) => o.isCompensation && status.get(`${wf.wf_key}:${o.key}`) === 'verified')) return false; // compensated itself
    if (!mine.length) return true;
    // active while something is still pending, applied, verified or unknown; withdrawn once only cancelled/compensated/failed steps remain
    return mine.some((o) => ['pending', 'applied', 'verified', 'unknown'].includes(String(status.get(`${wf.wf_key}:${o.key}`))));
  }
  private touchingFn(c: Row, extra: { wf: string; ref: string }[] = []) {
    const wfs = this.wfs(c); const ops = this.ops(c);
    const idx = new Map<string, Set<string>>();
    const add = (ref: string, wf: string) => { if (!idx.has(ref)) idx.set(ref, new Set()); idx.get(ref)!.add(wf); };
    for (const o of ops) { const w = wfs.find((x) => x.id === o.workflow_id); if (w) add(`${o.system}/${o.resource}`, w.wf_key); }
    for (const x of extra) add(x.ref, x.wf);
    return (ref: string) => [...(idx.get(ref) ?? [])].sort();
  }
  private authorityFn(c: Row) {
    const wfs = this.wfs(c);
    return (wf: string, role: 'manager' | 'owner') => {
      const w = wfs.find((x) => x.wf_key === wf); if (!w) return undefined;
      const rows = this.db.all("SELECT * FROM rw_approvals WHERE workflow_id=? AND workspace_id=? AND subject='plan' AND status='recorded' ORDER BY created_at DESC, rowid DESC", w.id, c.workspace_id);
      if (!rows.length) return { ok: false, detail: `${wf} has no recorded approval` };
      for (const r of rows) {
        const now = this.db.get('SELECT role FROM users WHERE id=? AND workspace_id=?', r.user_id, c.workspace_id)?.role ?? 'none';
        const roleOk = role === 'owner' ? now === 'owner' : ['owner', 'manager'].includes(now);
        const why = [!roleOk && `${r.user_name} is "${now}" now`, r.channel !== 'structured' && `${r.channel} channel`, r.subject_hash !== w.plan_hash && 'bound to a different plan hash', r.expires_at < nowIso() && 'expired'].filter(Boolean);
        if (!why.length) return { ok: true, detail: `${r.user_name} (${now}) approved plan ${String(w.plan_hash).slice(0, 10)}; valid until ${String(r.expires_at).slice(0, 16)}` };
      }
      return { ok: false, detail: `no valid approval for ${wf}'s current plan` };
    };
  }
  private claimsFn(c: Row) {
    const wfs = this.wfs(c);
    return (wf: string) => {
      const w = wfs.find((x) => x.wf_key === wf); if (!w) return [];
      return this.db.all("SELECT * FROM cd_ops WHERE workflow_id=? AND workspace_id=? AND status IN ('applied','verified')", w.id, c.workspace_id).map((o) => { const ob = this.obsRow(c.workspace_id, o.after_obs); return { op: o.op_key as string, evidence: ob && ob.available && ob.observer !== `exec.${o.system}` ? (ob.id as string) : null }; });
    };
  }
  private packEval = (pack: string, name: string) => cdPack(pack)?.evaluators?.[name];

  /** Current evaluation: the observed world, recorded op statuses, no commitments. */
  private evalCurrent(c: Row, snap: Snap, defs: InvariantDef[]) {
    const wfs = this.wfs(c); const { m, seq } = this.statusMap(c);
    const ctx: EvalCtx = {
      read: (k) => (snap[k]?.available ? snap[k].state : undefined), commitments: [], touching: this.touchingFn(c),
      isActive: (wf) => { const w = wfs.find((x) => x.wf_key === wf); return w ? this.isActiveIn(m, w) : false; },
      opStatus: (wf, op) => m.get(`${wf}:${op}`), opSeq: (wf, op) => seq.get(`${wf}:${op}`),
      declaredComplete: (wf) => ['VERIFIED', 'RECOVERED'].includes(wfs.find((x) => x.wf_key === wf)?.state),
      authority: this.authorityFn(c),
      freshness: (wf, ref) => { if (![...m].some(([k, v]) => k.startsWith(`${wf}:`) && v === 'pending')) return undefined; const w = wfs.find((x) => x.wf_key === wf); const b = w?.basis?.[ref]; if (!b) return undefined; const cur = snap[ref]; return { basisHash: b.hash, currentHash: cur?.hash ?? null, readable: !!cur?.available }; },
      claims: this.claimsFn(c), packEvaluator: this.packEval,
    };
    return evaluateAll(defs, ctx);
  }

  /** Simulates a plan (ordered actions) on the observed snapshot with compare-and-set semantics, as the guarded executor would run it. */
  simulate(c: Row, snap: Snap, actions: PlanAction[], opts: { cas?: boolean } = {}): Sim { return this.simulateFrom(c, snap, actions, this.statusMap(c).m, opts); }
  private simulateFrom(c: Row, snap: Snap, actions: PlanAction[], m: Map<string, string>, opts: { cas?: boolean } = {}): Sim {
    const cas = opts.cas ?? true;
    const wfs = this.wfs(c);
    const state = new Map<string, ResourceState | undefined>(); for (const [k, v] of Object.entries(snap)) state.set(k, v.available ? structuredClone(v.state) : undefined);
    const side = new Map<string, ResourceState>();
    const status = new Map(m); const seq = new Map<string, number>(); let n = 100000;
    const sim: Sim = { read: (k) => (k.includes('#before:') ? side.get(k) : state.get(k)), status, seq, claims: [], rejected: [], unknownActions: [], effects: [] };
    const ctxW = { workflows: wfs.map((w) => ({ key: w.wf_key, pack: w.pack, ops: w.plan.ops as OpDef[], status: {} })), actions };
    for (const act of actions) {
      const key = `${act.workflow}:${act.op}`;
      if (act.kind === 'cancel') { status.set(key, 'cancelled'); continue; }
      const op = effective(ctxW, act.workflow, act.op); if (!op) { sim.rejected.push({ workflow: act.workflow, op: act.op, reason: 'unknown operation' }); continue; }
      const ref = refKey(op); const cur = state.get(ref);
      if (!state.has(ref) || cur === undefined) { status.set(key, 'unknown'); sim.unknownActions.push({ workflow: act.workflow, op: act.op, reason: `${ref} is unreadable — its effect cannot be simulated` }); continue; }
      let patch: Patch;
      if (act.kind === 'compensate') { if (!op.compensate) { sim.rejected.push({ workflow: act.workflow, op: act.op, reason: 'not compensable' }); continue; } patch = op.compensate.patch; }
      else patch = materialize(op, cur, cas);
      if (op.effect.kind === 'release' || act.kind === 'compensate') side.set(`${ref}#before:${act.workflow}:${act.op}`, structuredClone(cur));
      const exp = cas ? patch.expect : undefined;
      if (exp && Object.entries(exp).some(([f, v]) => !eq(cur[f], v))) {
        status.set(key, 'rejected');
        sim.rejected.push({ workflow: act.workflow, op: act.op, reason: `compare-and-set would reject: ${Object.entries(exp).filter(([f, v]) => !eq(cur[f], v)).map(([f]) => `${ref}.${f} is ${JSON.stringify(cur[f] ?? null)}`).join(', ')}` });
        if (['reserve', 'consume'].includes(op.effect.kind)) sim.claims.push({ workflow: act.workflow, op: act.op, ref, kind: op.effect.kind, amount: op.effect.amount ?? 1, holder: op.effect.holder });
        continue;
      }
      const next = applyPatch(cur, patch);
      state.set(ref, next); sim.effects.push({ ref, before: cur, after: next, action: `${act.kind} ${key}` });
      status.set(key, act.kind === 'compensate' ? 'compensated' : 'verified'); seq.set(key, n++);
    }
    return sim;
  }

  private evalSim(c: Row, snap: Snap, sim: Sim, defs: InvariantDef[], scope: Set<string>, actions: PlanAction[], before?: Map<string, EvalResult>) {
    const wfs = this.wfs(c);
    const ctxW = { workflows: wfs.map((w) => ({ key: w.wf_key, pack: w.pack, ops: w.plan.ops, status: {} })), actions };
    const extra = actions.map((a) => { const op = effective(ctxW, a.workflow, a.op); return op ? { wf: a.workflow, ref: refKey(op) } : null; }).filter(Boolean) as { wf: string; ref: string }[];
    const auth = this.authorityFn(c); const claims = this.claimsFn(c); const { seq } = this.statusMap(c);
    const ctx: EvalCtx = {
      read: (k) => sim.read(k), commitments: sim.claims, touching: this.touchingFn(c, extra),
      isActive: (wf) => { const w = wfs.find((x) => x.wf_key === wf); return w ? this.isActiveIn(sim.status, w) : false; },
      opStatus: (wf, op) => sim.status.get(`${wf}:${op}`), opSeq: (wf, op) => sim.seq.get(`${wf}:${op}`) ?? seq.get(`${wf}:${op}`),
      declaredComplete: () => false,
      authority: (wf, role) => (scope.has(wf) ? { ok: true, detail: 'authorized by the resolution approval bound to this plan hash (required before execution)' } : auth(wf, role)),
      freshness: (wf, ref) => {
        if (!scope.has(wf) && ![...sim.status].some(([k, v]) => k.startsWith(`${wf}:`) && v === 'pending')) return undefined; // no pending decision depends on it
        const w = wfs.find((x) => x.wf_key === wf); const b = w?.basis?.[ref]; if (!b) return undefined;
        if (scope.has(wf)) { const cur = sim.read(ref); const h = hashOf(cur); return { basisHash: h ?? b.hash, currentHash: h, readable: cur !== undefined }; } // acts on the plan's revalidated basis
        return { basisHash: b.hash, currentHash: snap[ref]?.hash ?? null, readable: !!snap[ref]?.available };
      },
      claims: (wf) => (scope.has(wf) ? [] : claims(wf)), packEvaluator: this.packEval, before,
    };
    return evaluateAll(defs, ctx);
  }

  // ================================================================== analysis (the Intersection Engine)
  /** Pending, arbitration-eligible actions of workflows, in campaign order. */
  private pendingActions(c: Row, only?: Set<string>): PlanAction[] {
    const wfs = this.wfs(c); const ops = this.ops(c); const out: PlanAction[] = [];
    for (const w of wfs) { if (only && !only.has(w.wf_key)) continue; for (const o of ops.filter((x) => x.workflow_id === w.id && x.status === 'pending')) out.push({ workflow: w.wf_key, op: o.op_key, kind: 'execute' }); }
    return out;
  }

  async analyze(a: Actor, cid: string, opts: { lenient?: boolean } = {}) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot run analysis.');
    const c = this.campaign(a.workspaceId, cid);
    if (c.source === 'live' && !opts.lenient) this.engine.require(a, 'owner', 'manager');
    this.runAnalysis(c);
    return this.detail(a.workspaceId, cid);
  }

  /** One analysis round. Returns the blocking findings. */
  private runAnalysis(c: Row) {
    const round = Number(c.round) + 1; this.db.exec('UPDATE cd_campaigns SET round=? WHERE id=?', round, c.id); c.round = round;
    const snap = this.snapshot(c, 'cd-analysis');
    const defs = this.invariants(c); const wfs = this.wfs(c);
    const current = this.evalCurrent(c, snap, defs);
    const all = this.pendingActions(c);
    const projected = this.evalSim(c, snap, this.simulate(c, snap, all), defs, new Set(), all);
    // each workflow alone (for constraint collisions: individually valid, collectively not)
    const alone = new Map<string, Map<string, Evaluation>>();
    for (const w of wfs) { const acts = this.pendingActions(c, new Set([w.wf_key])); alone.set(w.wf_key, this.evalSim(c, snap, this.simulate(c, snap, acts), defs, new Set(), acts)); }
    const wfKeys = new Set(wfs.map((w) => w.wf_key));
    const found: FindingIn[] = [];
    const evidenceFor = (ev: Evaluation) => ev.reads.map((r) => snap[r]?.obsId).filter(Boolean) as string[];
    const ops = this.ops(c);
    const applied = ops.filter((o) => ['applied', 'verified'].includes(o.status));

    for (const d of defs) {
      if (d.strength === 'advisory' || d.spec.type === 'recovery_safety' || d.spec.type === 'authorization') continue;
      const p = projected.get(d.key)!; const cur = current.get(d.key)!;
      const ev = cur.result === 'violated' || cur.result === 'unknown' ? cur : p;
      if (!['violated', 'unknown'].includes(ev.result)) continue;
      const parts = [...new Set([...p.participants, ...cur.participants])].filter((x) => wfKeys.has(x));
      if (d.scope === 'workflow' && d.spec.type !== 'freshness' && d.spec.type !== 'completeness' && parts.length <= 1 && ev.result !== 'unknown') continue; // purely local
      if (d.spec.type === 'provenance' && parts.length <= 1) continue;
      const blocks = isBlockingStrength(d);
      const extraEvidence = d.spec.type === 'completeness' ? this.db.all(`SELECT id FROM rw_observations WHERE workspace_id=? AND operation_id IN (SELECT id FROM cd_ops WHERE workflow_id=(SELECT id FROM cd_workflows WHERE campaign_id=? AND wf_key=?)) ORDER BY rowid`, c.workspace_id, c.id, d.spec.workflow).map((r) => r.id as string) : [];
      if (ev.result === 'unknown') { found.push(this.finding(c, 'unknown_state', d, ev, parts, evidenceFor(ev), { blocks: true, status: 'unknown', confidence: 0.5, uncertainty: `Required reads unavailable: ${ev.unreadable.join(', ')}. Unknown is never treated as satisfied; execution that depends on it is blocked.`, recommendation: 'Restore the read path or obtain the record from the system owner; do not execute dependent operations until it can be evaluated.' })); continue; }
      let pattern: Pattern; let extra = '';
      switch (d.spec.type) {
        case 'uniqueness': pattern = 'resource_collision'; break;
        case 'capacity': case 'budget': {
          pattern = 'constraint_collision';
          const ok = parts.filter((w) => alone.get(w)?.get(d.key)?.result === 'satisfied');
          extra = ok.length === parts.length && parts.length > 1 ? ` Each of ${parts.join(', ')} is within the limit on its own; only their combination is not.` : ` Individually within the limit: ${ok.join(', ') || 'none'}.`;
          break;
        }
        case 'mutual_exclusion': case 'temporal_order': pattern = 'temporal_collision'; break;
        case 'lineage': pattern = 'dependency_invalidation'; break;
        case 'freshness': pattern = 'temporal_evidence_invalidation'; break;
        case 'provenance': pattern = 'contradictory_declarations'; break;
        case 'completeness': {
          const target = d.spec.workflow; const w = wfs.find((x) => x.wf_key === target);
          const mine = applied.filter((o) => o.workflow_id === w?.id); const bad = ops.filter((o) => o.workflow_id === w?.id && ['failed', 'unknown', 'rejected'].includes(o.status));
          if (!(mine.length && bad.some((b) => !mine.some((x) => x.system === b.system)))) continue; // not a cross-domain partial commit
          pattern = 'cross_domain_partial_commit'; extra = ` Committed in ${[...new Set(mine.map((o) => o.system))].join(', ')}; failed in ${[...new Set(bad.map((o) => o.system))].join(', ')}.`;
          break;
        }
        default: pattern = 'cross_domain_partial_commit';
      }
      found.push(this.finding(c, pattern, d, ev, parts, [...evidenceFor(ev), ...extraEvidence], { blocks, extra }));
      if (d.spec.type === 'lineage') {
        // the downstream consumer's own evidence about its upstream is no longer valid
        const down = refKey(d.spec.downstream); const up = refKey(d.spec.upstream);
        for (const w of wfs) for (const r of [down, up]) { const b = w.basis?.[r]; if (b && parts.includes(w.wf_key)) this.db.exec('UPDATE rw_observations SET invalidated_at=coalesce(invalidated_at, ?), invalidated_reason=coalesce(invalidated_reason, ?) WHERE id=? AND workspace_id=?', nowIso(), `dependency invalidated: ${up} would no longer honour ${down} (${d.key})`, b.obsId, c.workspace_id); }
      }
    }
    // F · split authority: individually valid approvals, collectively violating a hard invariant.
    const auth = this.authorityFn(c);
    for (const f of [...found].filter((x) => x.blocks && x.status !== 'unknown' && ['resource_collision', 'constraint_collision', 'temporal_collision', 'dependency_invalidation'].includes(x.pattern))) {
      const approved = f.workflows.filter((w) => auth(w, 'manager')?.ok && ops.some((o) => o.status === 'pending' && wfs.find((x) => x.id === o.workflow_id)?.wf_key === w));
      if (approved.length < 2) continue;
      const d = defs.find((x) => x.key === f.invariantKey)!;
      found.push(this.finding(c, 'split_authority', d, { key: d.key, result: 'violated', detail: `${approved.join(' and ')} each hold a valid plan approval, given separately; together the approved plans violate "${d.name}"`, reads: f.resources, participants: approved, unreadable: [] }, approved, f.evidence, { blocks: true, keySuffix: d.key, recommendation: 'Treat the separate approvals as insufficient: one arbitrated plan covering all of these workflows needs one approval bound to its hash.' }));
    }
    // I · contradictory declarations: agents of different workflows declared world facts that cannot all be true; reads decide.
    const decl = new Map<string, { wf: string; op: string; value: unknown; obs: string | null }[]>();
    for (const o of applied) {
      const w = wfs.find((x) => x.id === o.workflow_id)!;
      // a declaration is withdrawn once a later verified op of the same workflow rewrote the record that carried it
      const superseded = ops.some((x) => x.workflow_id === o.workflow_id && x.system === o.system && x.resource === o.resource && x.status === 'verified' && Number(x.rowid) !== Number(o.rowid) && String(x.updated_at) > String(o.updated_at));
      if (superseded && (o.spec.asserts ?? []).length) continue;
      if (!this.isActiveIn(this.statusMap(c).m, w)) continue; // a withdrawn or compensated workflow's claims are withdrawn with it
      const facts = [...(o.spec.asserts ?? []).map((x: any) => ({ ref: x.ref, field: x.field, equals: x.equals })), ...(o.spec.expect ?? []).map((e: any) => ({ ref: `${o.system}/${o.resource}`, field: e.field, equals: e.equals }))];
      for (const f of facts) { const k = `${f.ref}.${f.field}`; if (!decl.has(k)) decl.set(k, []); decl.get(k)!.push({ wf: w.wf_key, op: o.op_key, value: f.equals, obs: o.after_obs }); }
    }
    for (const [k, list] of decl) {
      const ref = k.slice(0, k.lastIndexOf('.')); const field = k.slice(k.lastIndexOf('.') + 1);
      const obs = snap[ref]; if (!obs?.available) continue;
      const parts = [...new Set(list.map((x) => x.wf))]; if (parts.length < 2) continue;
      const values = new Set(list.map((x) => stable(x.value))); const contradicted = list.filter((x) => !eq(obs.state[field], x.value));
      if (values.size < 2 && !contradicted.length) continue;
      const pseudo: InvariantDef = { key: `decl:${k}`, name: `Declarations about ${k} agree with reality`, explanation: 'Agents of different workflows declared outcomes about the same record; at most one can be true.', scope: 'cross-domain', spec: { type: 'provenance', workflow: parts[0] }, severity: 'high', impact: 'Two parties believe they hold the same thing', resolutionPolicy: 'Independent reads decide; contradicted claims are withdrawn.', approvalLevel: 'manager', strength: 'hard', autoRestorable: false, provenance: { source: 'inferred', by: 'intersection analyst' } };
      found.push(this.finding(c, 'contradictory_declarations', pseudo, { key: pseudo.key, result: 'violated', detail: `${list.map((x) => `${x.wf}:${x.op} declared ${field}=${JSON.stringify(x.value)}`).join('; ')} — independently observed ${field}=${JSON.stringify(obs.state[field] ?? null)}; contradicted: ${contradicted.map((x) => `${x.wf}:${x.op}`).join(', ') || 'none'}`, reads: [ref], participants: parts, unreadable: [] }, parts, [obs.obsId, ...list.map((x) => x.obs).filter(Boolean) as string[]], { blocks: true, keySuffix: k, recommendation: 'Withdraw the contradicted claim, then arbitrate which party keeps the record.' }));
    }
    // H · hidden shared constraints, from the graph: two workflows governed by the same constraint, no declared dependency.
    const blockingInv = new Set(found.filter((f) => f.blocks).map((f) => f.invariantKey).filter(Boolean));
    const shareMap = this.sharedConstraints(c, defs, current, projected);
    const edgesNow = this.edges(c);
    for (const [pair, shared] of shareMap) {
      const [x, y] = pair.split('|');
      const declared = edgesNow.some((e) => e.rel === 'depends_on' && ((e.from_node === `wf:${x}` && e.to_node === `wf:${y}`) || (e.from_node === `wf:${y}` && e.to_node === `wf:${x}`)));
      if (declared) continue;
      const hot = shared.invariants.filter((k) => blockingInv.has(k));
      const pseudo: InvariantDef = { key: `hidden:${pair}`, name: `Hidden shared constraint: ${x} × ${y}`, explanation: 'Two workflows that never reference each other depend on the same resource, budget, policy or evidence.', scope: 'cross-domain', spec: { type: 'provenance', workflow: x }, severity: hot.length ? 'high' : 'low', impact: hot.length ? 'The shared constraint is currently violated or unknown' : 'Currently holds; any change by one affects the other', resolutionPolicy: 'Make the dependency explicit; arbitrate jointly when it is violated.', approvalLevel: 'none', strength: hot.length ? 'hard' : 'advisory', autoRestorable: false, provenance: { source: 'inferred', by: 'graph traversal (shares_constraint_with)' } };
      found.push(this.finding(c, 'hidden_shared_constraint', pseudo, { key: pseudo.key, result: hot.length ? 'violated' : 'satisfied', detail: `${x} and ${y} declare no dependency on each other, yet both are governed by ${shared.invariants.map((k) => `"${defs.find((d) => d.key === k)?.name ?? k}"`).join(', ')} through ${shared.resources.join(', ')}.${hot.length ? ` Currently violated or unknown: ${hot.join(', ')}.` : ' It currently holds'}`, reads: shared.resources, participants: [x, y], unreadable: [] }, [x, y], shared.resources.map((r) => snap[r]?.obsId).filter(Boolean) as string[], { blocks: false, status: hot.length ? 'unresolved' : 'resolved', keySuffix: pair, recommendation: hot.length ? 'Arbitrate these workflows together; record the dependency so future plans see it.' : 'Record the dependency so that a future change by either workflow is evaluated against the other.' }));
    }
    // Persist: upsert raised findings; anything not raised again (except arbitration/execution-time findings) is resolved.
    const raisedKeys = new Set<string>();
    for (const f of found) raisedKeys.add(this.upsertFinding(c, f, round));
    for (const old of this.db.all("SELECT * FROM cd_findings WHERE campaign_id=? AND workspace_id=? AND status IN ('unresolved','unknown')", c.id, c.workspace_id)) {
      if (raisedKeys.has(old.finding_key) || old.pattern === 'recovery_collateral' || String(old.finding_key).startsWith('temporal_evidence_invalidation:basis:')) continue;
      this.db.exec("UPDATE cd_findings SET status='resolved', resolved_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), old.id);
      this.causal(c, 'verification_probe', 'VERIFIED', `Finding resolved by fresh evaluation: ${old.title}`, 'intersection', { findingId: old.id });
    }
    for (const d of defs) {
      const p = projected.get(d.key)!; const cur = current.get(d.key)!;
      const shown = cur.result === 'violated' || cur.result === 'unknown' ? cur : p;
      this.db.exec('UPDATE cd_invariants SET last_result=?, last_eval=?, updated_at=? WHERE campaign_id=? AND inv_key=? AND workspace_id=?', shown.result, JSON.stringify({ round, current: cur, projected: p, evidence: evidenceFor(shown), at: nowIso() }), nowIso(), c.id, d.key, c.workspace_id);
    }
    // Graph: shares_constraint_with / conflicts_with / invalidates edges and evidence-backed finding nodes.
    const nodes: any[] = []; const edges: any[] = [];
    for (const [pair, shared] of shareMap) { const [x, y] = pair.split('|'); edges.push({ from: `wf:${x}`, to: `wf:${y}`, rel: 'shares_constraint_with', why: shared.invariants.join(', '), evidence: snap[shared.resources[0]]?.obsId ?? null }); }
    for (const f of this.db.all('SELECT * FROM cd_findings WHERE campaign_id=? AND workspace_id=? AND round=?', c.id, c.workspace_id, round)) {
      nodes.push({ id: `find:${f.id}`, type: 'finding', label: `${PATTERN_LABELS[f.pattern as Pattern]}: ${f.title}`, ref: f.id, data: { pattern: f.pattern } });
      const ws = j<string[]>(f.workflows, []);
      for (const w of ws) edges.push({ from: `find:${f.id}`, to: `wf:${w}`, rel: 'conflicts_with', why: f.pattern });
      if (f.blocks) for (let i = 0; i < ws.length; i++) for (let k = i + 1; k < ws.length; k++) edges.push({ from: `wf:${ws[i]}`, to: `wf:${ws[k]}`, rel: 'conflicts_with', why: f.title });
      if (f.invariant_key && this.db.get('SELECT 1 x FROM cd_nodes WHERE campaign_id=? AND id=?', c.id, `inv:${f.invariant_key}`)) edges.push({ from: `find:${f.id}`, to: `inv:${f.invariant_key}`, rel: 'derived_from' });
      for (const e of j<string[]>(f.evidence, [])) { const o = this.obsRow(c.workspace_id, e); nodes.push({ id: `obs:${e}`, type: 'evidence', label: `${o?.purpose ?? 'read'} of ${o?.system}/${o?.resource}`, ref: e }); edges.push({ from: `find:${f.id}`, to: `obs:${e}`, rel: 'derived_from', evidence: e }); }
    }
    for (const w of wfs) for (const [r, b] of Object.entries(w.basis as Record<string, any>)) if (snap[r] && b.hash && snap[r].hash && b.hash !== snap[r].hash) {
      nodes.push({ id: `obs:${snap[r].obsId}`, type: 'evidence', label: `analysis read of ${r}`, ref: snap[r].obsId }, { id: `obs:${b.obsId}`, type: 'evidence', label: `${w.wf_key} planning read of ${r}`, ref: b.obsId });
      edges.push({ from: `obs:${snap[r].obsId}`, to: `obs:${b.obsId}`, rel: 'invalidates', evidence: snap[r].obsId, why: `${r} changed since ${w.wf_key} planned` });
      this.db.exec('UPDATE rw_observations SET invalidated_at=coalesce(invalidated_at, ?), invalidated_reason=coalesce(invalidated_reason, ?) WHERE id=? AND workspace_id=?', nowIso(), `superseded: ${r} changed (read ${snap[r].obsId})`, b.obsId, c.workspace_id);
    }
    this.graphBatch(c, `analysis round ${round}`, 'analysis', dedupeNodes(nodes), edges);
    const blocking = this.db.all("SELECT * FROM cd_findings WHERE campaign_id=? AND workspace_id=? AND blocks=1 AND status IN ('unresolved','unknown')", c.id, c.workspace_id);
    for (const w of this.wfs(c)) {
      const mine = blocking.filter((f) => j<string[]>(f.workflows, []).includes(w.wf_key));
      this.db.exec('UPDATE cd_workflows SET global_status=? WHERE id=?', mine.length ? `blocked by ${mine.length} finding(s)` : 'clear', w.id);
      const hasPending = this.ops(c).some((o) => o.workflow_id === w.id && o.status === 'pending');
      if (mine.length && hasPending && !['CANCELLED', 'RECOVERED', 'REQUIRES_HUMAN', 'RECOVERING'].includes(w.state)) this.walk(c, w, 'REQUIRES_HUMAN', `Locally valid, globally blocked: ${[...new Set(mine.map((f) => PATTERN_LABELS[f.pattern as Pattern]))].join(', ')}.`);
    }
    this.causal(c, 'agent_inference', blocking.length ? 'REQUIRES_HUMAN' : 'VERIFIED', `Intersection analysis round ${round}: ${found.length} finding(s), ${blocking.length} blocking`, 'intersection', { round, patterns: [...new Set(found.map((f) => f.pattern))] });
    if (!['ARBITRATION', 'AWAITING_APPROVAL', 'EXECUTING'].includes(c.state)) {
      if (blocking.length) this.moveCampaign(c, 'CONFLICTED', `${blocking.length} blocking cross-domain finding(s): ${[...new Set(blocking.map((f) => PATTERN_LABELS[f.pattern as Pattern]))].join(', ')}.`, 'intersection');
      else if (c.state !== 'RESOLVED') this.moveCampaign(c, 'CONSISTENT', 'No blocking cross-domain finding: every shared invariant holds on current reads and on the projected plans.', 'intersection');
    }
    return blocking;
  }

  /** Pairs of workflows governed by the same constraint (through resources each touches), derived from graph edges. */
  private sharedConstraints(c: Row, defs: InvariantDef[], current: Map<string, Evaluation>, projected: Map<string, Evaluation>) {
    const touches = new Map<string, Set<string>>();
    for (const e of this.edges(c).filter((x) => ['reserves', 'consumes', 'modifies', 'releases'].includes(x.rel) && x.from_node.startsWith('op:'))) { const wf = e.from_node.split(':')[1]; const r = e.to_node.slice(4); if (!touches.has(wf)) touches.set(wf, new Set()); touches.get(wf)!.add(r); }
    const out = new Map<string, { invariants: string[]; resources: string[] }>();
    for (const d of defs) {
      if (['recovery_safety', 'completeness', 'provenance', 'authorization'].includes(d.spec.type)) continue;
      const reads = [...new Set([...specReads(d), ...(current.get(d.key)?.reads ?? []), ...(projected.get(d.key)?.reads ?? [])])];
      const gov = [...touches.entries()].filter(([, rs]) => reads.some((r) => rs.has(r))).map(([wf]) => wf);
      if (d.spec.type === 'freshness') gov.push(d.spec.workflow);
      const ws = [...new Set(gov)].sort();
      for (let i = 0; i < ws.length; i++) for (let k = i + 1; k < ws.length; k++) {
        const key = `${ws[i]}|${ws[k]}`; if (!out.has(key)) out.set(key, { invariants: [], resources: [] });
        const o = out.get(key)!; if (!o.invariants.includes(d.key)) o.invariants.push(d.key);
        for (const r of reads) if ((touches.get(ws[i])?.has(r) || touches.get(ws[k])?.has(r)) && !o.resources.includes(r)) o.resources.push(r);
      }
    }
    return out;
  }

  private finding(c: Row, pattern: Pattern, d: InvariantDef, ev: Evaluation, parts: string[], evidence: string[], o: { blocks?: boolean; status?: string; confidence?: number; uncertainty?: string; recommendation?: string; extra?: string; keySuffix?: string } = {}): FindingIn {
    const wfs = this.wfs(c); const ops = this.ops(c);
    const mine = wfs.filter((w) => parts.includes(w.wf_key));
    const keyOf = (op: Row) => `${wfs.find((w) => w.id === op.workflow_id)?.wf_key}:${op.op_key}`;
    const touched = ops.filter((op) => mine.some((w) => w.id === op.workflow_id) && (ev.reads.includes(`${op.system}/${op.resource}`) || (d.spec.type === 'completeness' && d.spec.workflow === wfs.find((w) => w.id === op.workflow_id)?.wf_key)));
    const rec: Record<Pattern, string> = {
      resource_collision: 'Block the later claim; arbitrate which workflow keeps the unit or substitute an equivalent free unit.',
      constraint_collision: 'Block the commitments that exceed the shared limit; arbitrate which to defer, move or shrink, with the approval level the constraint requires.',
      temporal_collision: 'Block the overlapping commitments; reschedule one of them to a declared alternative window.',
      dependency_invalidation: 'Block the upstream change as planned; prefer a backward-compatible (expand/contract) change and re-verify every downstream consumer.',
      recovery_collateral: 'Reject this recovery; choose an option that preserves every protected invariant.',
      split_authority: 'One arbitrated plan, one approval bound to its hash.',
      cross_domain_partial_commit: 'Reconcile across domains: resume the missing side or compensate the committed side — decided by simulation, approved by a human.',
      hidden_shared_constraint: 'Record the dependency; evaluate the workflows jointly.',
      contradictory_declarations: 'Withdraw the contradicted claim; independent reads decide.',
      temporal_evidence_invalidation: 'Re-plan on fresh evidence; approvals bound to the old basis no longer authorize execution.',
      unknown_state: 'Do not execute dependent operations; restore the read or escalate.',
    };
    return {
      key: `${pattern}:${o.keySuffix ?? d.key}`, pattern, invariantKey: d.key, title: `${d.name}${ev.result === 'unknown' ? ' — UNKNOWN' : ''}`,
      workflows: [...parts].sort(), operations: touched.map(keyOf), domains: [...new Set(mine.map((w) => w.domain))], resources: ev.reads,
      intended: { invariant: d.explanation, operations: touched.map((op) => ({ op: keyOf(op), label: op.label, status: op.status })) },
      declared: touched.filter((op) => ['applied', 'verified'].includes(op.status)).map((op) => ({ op: keyOf(op), claim: op.spec.claim ?? 'tool reported success', asserts: op.spec.asserts ?? [] })),
      observed: { evaluation: ev.detail, result: ev.result, unreadable: ev.unreadable },
      evidence: [...new Set(evidence)], predecessors: [], severity: d.severity, blast: this.blastRadius(c, ev.reads),
      confidence: o.confidence ?? (ev.result === 'unknown' ? 0.5 : 1), uncertainty: o.uncertainty ?? (ev.unreadable.length ? `Unreadable: ${ev.unreadable.join(', ')}` : 'Derived from independent reads and recorded operation states.'),
      explanation: `${d.impact}. ${ev.detail}.${o.extra ?? ''}`, recommendation: o.recommendation ?? rec[pattern], blocks: o.blocks ?? isBlockingStrength(d), approvalRequired: d.approvalLevel, status: o.status ?? (ev.result === 'unknown' ? 'unknown' : 'unresolved'),
    };
  }
  private blastRadius(c: Row, refs: string[]) {
    const edges = this.edges(c); const seen = new Set<string>(); const wfs = new Set<string>(); const invs = new Set<string>();
    const q = refs.map((r) => `res:${r}`);
    while (q.length) {
      const n = q.shift()!; if (seen.has(n) || seen.size > 300) continue; seen.add(n);
      for (const e of edges) {
        const nx = e.from_node === n ? e.to_node : e.to_node === n ? e.from_node : null; if (!nx || seen.has(nx)) continue;
        if (nx.startsWith('inv:') && n.startsWith('res:')) { invs.add(nx.slice(4)); q.push(nx); }
        else if (nx.startsWith('res:') && n.startsWith('inv:')) q.push(nx);
        else if (nx.startsWith('op:') && n.startsWith('res:')) wfs.add(nx.split(':')[1]);
      }
    }
    return { workflows: [...wfs].sort(), invariants: [...invs].sort(), resources: refs };
  }
  private upsertFinding(c: Row, f: FindingIn, round: number): string {
    const ex = this.db.get('SELECT * FROM cd_findings WHERE campaign_id=? AND workspace_id=? AND finding_key=?', c.id, c.workspace_id, f.key);
    if (ex) {
      const reopened = ex.status === 'resolved' && f.status !== 'resolved';
      this.db.exec('UPDATE cd_findings SET observed=?, evidence=?, workflows=?, operations=?, resources=?, explanation=?, status=?, blocks=?, severity=?, round=?, blast_radius=?, updated_at=?, resolved_at=? WHERE id=?', JSON.stringify(f.observed), JSON.stringify(f.evidence), JSON.stringify(f.workflows), JSON.stringify(f.operations), JSON.stringify(f.resources), f.explanation, f.status, f.blocks ? 1 : 0, f.severity, round, JSON.stringify(f.blast), nowIso(), f.status === 'resolved' ? ex.resolved_at ?? nowIso() : null, ex.id);
      if (reopened) this.causal(c, 'reality_gap', 'RECONCILIATION_REQUIRED', `Finding re-opened: ${f.title}`, 'intersection', { findingId: ex.id });
      return f.key;
    }
    const id = uid('cdf');
    const causalId = this.causal(c, 'reality_gap', f.blocks ? 'REQUIRES_HUMAN' : 'OBSERVED', `${PATTERN_LABELS[f.pattern]}: ${f.title} [${f.workflows.join(' × ')}]`, 'intersection', { pattern: f.pattern, invariant: f.invariantKey, evidence: f.evidence });
    this.db.insert('cd_findings', { id, workspace_id: c.workspace_id, campaign_id: c.id, finding_key: f.key, pattern: f.pattern, title: f.title, workflows: JSON.stringify(f.workflows), operations: JSON.stringify(f.operations), domains: JSON.stringify(f.domains), resources: JSON.stringify(f.resources), invariant_key: f.invariantKey ?? null, intended: JSON.stringify(f.intended), declared: JSON.stringify(f.declared), observed: JSON.stringify(f.observed), evidence: JSON.stringify(f.evidence), predecessors: JSON.stringify([c.causal_root].filter(Boolean)), severity: f.severity, blast_radius: JSON.stringify(f.blast), confidence: f.confidence, uncertainty: f.uncertainty, explanation: f.explanation, recommendation: f.recommendation, blocks: f.blocks ? 1 : 0, approval_required: f.approvalRequired, hypothesis: f.evidence.length ? 0 : 1, status: f.status, round, causal_id: causalId, detected_at: nowIso(), updated_at: nowIso(), resolved_at: f.status === 'resolved' ? nowIso() : null });
    this.audit(c, 'intersection', 'finding', `${PATTERN_LABELS[f.pattern]}: ${f.title}`, { findingId: id, blocks: f.blocks });
    return f.key;
  }

  /** Each workflow on its own evidence (its planning reads) with only its own commitments: is it locally valid? */
  private localValidity(c: Row) {
    const defs = this.invariants(c); const wfs = this.wfs(c);
    for (const w of wfs) {
      const snap: Snap = {};
      for (const k of this.worldRefs(c)) {
        const b = w.basis?.[k];
        const ob = b ? this.obsRow(c.workspace_id, b.planObs ?? b.obsId) : this.db.get('SELECT * FROM rw_observations WHERE workflow_id=? AND workspace_id=? AND system=? AND resource=? ORDER BY rowid DESC', w.id, c.workspace_id, k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)) ?? this.db.get("SELECT * FROM rw_observations WHERE workflow_id IN (SELECT id FROM cd_workflows WHERE campaign_id=?) AND workspace_id=? AND system=? AND resource=? AND purpose LIKE 'cd-planning%' ORDER BY rowid DESC", c.id, c.workspace_id, k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1));
        snap[k] = { available: !!ob?.available, state: j(ob?.state, {}), hash: ob?.state_hash ?? null, obsId: ob?.id ?? '', at: ob?.observed_at ?? '' };
      }
      // its own plan, plus the plans it explicitly declared a dependency on — nothing else
      const mineAndDeclared = [...wfs.filter((x) => (w.declared_links as string[]).includes(x.wf_key)), w];
      const acts: PlanAction[] = mineAndDeclared.flatMap((x) => (x.plan.ops as OpDef[]).filter((o) => !o.isCompensation).map((o) => ({ workflow: x.wf_key, op: o.key, kind: 'execute' as const })));
      const ownRefs = new Set(mineAndDeclared.flatMap((x) => (x.plan.ops as OpDef[]).map((o) => `${o.system}/${o.resource}`)));
      const sim = this.simulateFrom(c, snap, acts, new Map());
      const res = this.evalSim(c, snap, sim, defs, new Set([w.wf_key]), acts);
      // its own contract: invariants it owns, and invariants whose every resource it (or a declared dependency) touches itself
      const relevant = defs.filter((d) => isBlockingStrength(d) && !['recovery_safety', 'authorization', 'completeness', 'provenance', 'freshness'].includes(d.spec.type) && (d.owner === w.wf_key || (specReads(d).length > 0 && specReads(d).every((r) => ownRefs.has(r)))));
      const bad = relevant.filter((d) => ['violated', 'unknown'].includes(res.get(d.key)!.result));
      this.db.exec('UPDATE cd_workflows SET local_status=? WHERE id=?', JSON.stringify({ valid: !bad.length && !sim.rejected.length, checked: relevant.length, failing: bad.map((d) => ({ key: d.key, detail: res.get(d.key)!.detail })), rejected: sim.rejected, basisReadAt: Object.values(w.basis as Record<string, any>).map((b) => b.at).sort()[0] ?? null, note: 'Its own plan (plus plans it declared a dependency on), simulated on its own planning evidence, checked against the invariants it can see: those it owns or whose every resource it touches.' }), w.id);
    }
  }

  // ================================================================== arbitration
  arbitrate(a: Actor, cid: string, opts: { lenient?: boolean } = {}) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot arbitrate.');
    const c = this.campaign(a.workspaceId, cid);
    if (c.source === 'live' && !opts.lenient) this.engine.require(a, 'owner', 'manager');
    if (!['CONFLICTED', 'ARBITRATION', 'REQUIRES_HUMAN', 'AWAITING_APPROVAL'].includes(c.state)) throw new EngineError(409, 'bad_state', `Arbitration starts from CONFLICTED (campaign is ${c.state}). Run the intersection analysis first.`);
    const blocking = this.db.all("SELECT * FROM cd_findings WHERE campaign_id=? AND workspace_id=? AND blocks=1 AND status IN ('unresolved','unknown')", c.id, c.workspace_id);
    if (!blocking.length) throw new EngineError(409, 'nothing_to_arbitrate', 'There are no blocking findings to arbitrate.');
    this.buildArbitration(c, blocking);
    return this.detail(a.workspaceId, cid);
  }

  private buildArbitration(c: Row, blocking: Row[]) {
    this.db.exec("UPDATE rw_recovery_plans SET status='superseded' WHERE workflow_id=? AND workspace_id=? AND status IN ('proposed','awaiting_approval')", c.id, c.workspace_id);
    this.db.exec("UPDATE rw_approvals SET status='superseded', invalid_reason='superseded: a new arbitration replaced the plan' WHERE workflow_id=? AND workspace_id=? AND subject='resolution' AND status='recorded'", c.id, c.workspace_id);
    const snap = this.snapshot(c, 'cd-arbitration');
    const defs = this.invariants(c); const wfs = this.wfs(c);
    const before = new Map([...this.evalCurrent(c, snap, defs)].map(([k, v]) => [k, v.result]));
    // Scope: every workflow named by a blocking finding, plus declared dependants (graph depends_on edges).
    const scope = new Set<string>(blocking.flatMap((f) => j<string[]>(f.workflows, [])));
    for (const e of this.edges(c).filter((x) => x.rel === 'depends_on')) { const [f, t] = [e.from_node.slice(3), e.to_node.slice(3)]; if (scope.has(t)) scope.add(f); if (scope.has(f)) scope.add(t); }
    const base = this.pendingActions(c, scope);
    const statusOf = this.statusMap(c).m;
    const ctxWfs = wfs.map((w) => ({ key: w.wf_key, pack: w.pack, ops: (w.plan.ops as OpDef[]).filter((o) => !o.scheduled), status: Object.fromEntries((w.plan.ops as OpDef[]).map((o) => [o.key, statusOf.get(`${w.wf_key}:${o.key}`) ?? 'pending'])) }));
    const evalPlan = (actions: PlanAction[]) => { const sim = this.simulate(c, snap, actions); return { sim, res: this.evalSim(c, snap, sim, defs, scope, actions, before) }; };
    const blockingViolations = (res: Map<string, Evaluation>) => defs.filter((d) => isBlockingStrength(d) && ['violated', 'unknown'].includes(res.get(d.key)?.result ?? '')).sort((x, y) => (SEV_RANK[x.severity] - SEV_RANK[y.severity]) || x.key.localeCompare(y.key));
    const altsFor = (d: InvariantDef, ev: Evaluation, actions: PlanAction[], sim: Sim): Alternative[] => {
      const ctx: AltContext = { invariant: d, evaluation: ev, read: (k) => sim.read(k), world: Object.keys(snap), workflows: ctxWfs, actions };
      const out: Alternative[] = [];
      for (const p of CD_PACKS) for (const alt of p.alternatives?.(ctx) ?? []) if (alt.actions.every((x) => wfs.find((w) => w.wf_key === x.workflow)?.pack === p.id)) out.push(alt); // a pack acts only on its own workflows
      return out;
    };
    const candidates: { kind: OptionOut['kind']; label: string; rationale: string; actions: PlanAction[]; alts: string[] }[] = [];
    candidates.push({ kind: 'proceed', label: 'Proceed as planned (every workflow executes its own plan)', rationale: 'What the locally-correct workflows would do without cross-domain arbitration.', actions: base, alts: [] });
    // Repair search: branch on the first violated hard invariant that has alternatives, then greedily repair the rest.
    const p0 = evalPlan(base);
    const firsts = blockingViolations(p0.res).map((d) => altsFor(d, p0.res.get(d.key)!, base, p0.sim)).filter((x) => x.length).slice(0, 4).flatMap((alts) => alts.slice(0, 2));
    for (const first of firsts.filter((x, i) => firsts.findIndex((y) => y.id === x.id) === i)) {
      let plan = applyAlt(base, first); const applied: Alternative[] = [first];
      for (let i = 0; i < 8; i++) {
        const { sim, res } = evalPlan(plan); let progressed = false;
        for (const d of blockingViolations(res)) { const alt = altsFor(d, res.get(d.key)!, plan, sim).find((x) => !applied.some((y) => y.id === x.id)); if (alt) { plan = applyAlt(plan, alt); applied.push(alt); progressed = true; break; } }
        if (!progressed) break;
      }
      candidates.push({ kind: 'repair', label: `Repair: ${applied.map((x) => x.label).join('; ')}`, rationale: applied.map((x) => x.rationale).join(' '), actions: plan, alts: applied.map((x) => x.id) });
    }
    // Withdraw options: one workflow (and its declared dependants) steps back entirely.
    for (const w of [...scope].sort()) {
      const deps = new Set([w]); for (const e of this.edges(c).filter((x) => x.rel === 'depends_on' && x.to_node === `wf:${w}`)) deps.add(e.from_node.slice(3));
      const acts: PlanAction[] = [];
      for (const k of deps) {
        const ww = wfs.find((x) => x.wf_key === k); if (!ww) continue;
        for (const o of (ww.plan.ops as OpDef[]).filter((x) => !x.scheduled)) { const st = statusOf.get(`${k}:${o.key}`); if (st === 'pending') acts.push({ workflow: k, op: o.key, kind: 'cancel', note: 'withdrawn' }); else if (['verified', 'applied'].includes(String(st)) && o.compensate && !o.isCompensation) acts.push({ workflow: k, op: o.key, kind: 'compensate', note: o.compensate.label }); }
      }
      const rest = base.filter((x) => !deps.has(x.workflow));
      candidates.push({ kind: 'withdraw', label: `Withdraw ${[...deps].join(' + ')} (cancel pending steps, compensate committed ones)`, rationale: `${w} steps back so the others can proceed.${deps.size > 1 ? ` ${[...deps].filter((x) => x !== w).join(', ')} declared a dependency on ${w} and is withdrawn with it.` : ''}`, actions: [...acts, ...rest], alts: [] });
    }
    // Pack-contributed recoveries (e.g. roll back) — simulated, never assumed safe.
    for (const p of CD_PACKS) for (const r of p.recoveries?.({ workflows: ctxWfs, read: (k) => (snap[k]?.available ? snap[k].state : undefined) }) ?? []) {
      if (!r.actions.every((x) => wfs.find((w) => w.wf_key === x.workflow)?.pack === p.id)) continue;
      const touched = new Set(r.actions.map((x) => `${x.workflow}:${x.op}`));
      candidates.push({ kind: 'recovery', label: r.label, rationale: r.rationale, actions: [...r.actions, ...base.filter((x) => !touched.has(`${x.workflow}:${x.op}`))], alts: [r.id] });
    }
    const basis = Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, { hash: v.hash, obsId: v.obsId, available: v.available }]));
    const basisHashes = Object.fromEntries(Object.entries(basis).map(([k, v]) => [k, v.hash]));
    const seen = new Set<string>(); const options: OptionOut[] = [];
    for (const cand of candidates) {
      const sig = stable([...cand.actions].map((x) => stable(x)).sort()); if (seen.has(sig)) continue; seen.add(sig);
      options.push(this.scoreOption(c, cand, evalPlan(cand.actions), defs, before, basis, basisHashes, options.length));
    }
    options.push({ id: 'escalate', kind: 'escalate', label: 'Escalate: no automatic action', rationale: 'Leave the world as observed and hand the decision to a human owner.', actions: [], hash: sha256(stable({ actions: [], basis: basisHashes })), status: 'escalation', preserved: [], violated: [], unknown: [], softViolations: [], newlyBroken: [], rejectedActions: [], expectedEffects: [], affectedWorkflows: [], reversibility: 'reversible', evidenceStrength: strength(basis), uncertainty: ['Current violations remain in place.'], approvalLevel: 'manager', why: 'Always available. Chosen automatically only when no feasible plan exists.', cost: 1000, alternativesApplied: [], isRecovery: false });
    const feasible = options.filter((o) => o.status === 'feasible').sort((x, y) => x.cost - y.cost || x.id.localeCompare(y.id));
    const recommended = feasible[0]?.id ?? 'escalate';
    for (const o of options) if (o.status !== 'escalation') o.why = o.status === 'rejected' ? `Rejected: ${[...o.violated.map((v) => `violates hard invariant "${v.name}"`), ...o.unknown.map((u) => `cannot evaluate ${u.key}`), ...o.rejectedActions.map((r) => `${r.workflow}:${r.op} — ${r.reason}`)].slice(0, 4).join('; ')}. A human approval cannot override a hard constraint.` : o.id === recommended ? `Recommended: preserves every hard invariant at the lowest disruption cost (${o.cost}).` : `Feasible, but a higher disruption cost (${o.cost}) than the recommendation.`;
    // Adversarial review: objections are preserved, not voted away.
    const objections = options.filter((o) => o.status === 'feasible').flatMap((o) => [
      ...o.actions.filter((x) => x.kind === 'compensate').map((x) => ({ option: o.id, by: 'adversary', text: `${x.workflow}:${x.op} is compensated, not undone — the reversal itself is visible to the affected party.` })),
      ...o.actions.filter((x) => x.kind === 'cancel' && !String(x.note ?? '').includes('moot')).map((x) => ({ option: o.id, by: 'adversary', text: `${x.workflow}:${x.op} will not happen; its owner (${wfs.find((w) => w.wf_key === x.workflow)?.owner}) must be told.` })),
      ...(o.softViolations.length ? [{ option: o.id, by: 'adversary', text: `Accepts soft trade-offs: ${o.softViolations.map((s) => s.key).join(', ')}.` }] : []),
      ...(o.evidenceStrength.score < 1 ? [{ option: o.id, by: 'adversary', text: `Evidence strength ${(o.evidenceStrength.score * 100).toFixed(0)}%: some basis reads were unreadable.` }] : []),
      { option: o.id, by: 'adversary', text: 'The simulation assumes each sandbox write applies as modelled; the executor re-reads every basis resource before writing and re-plans if anything moved.' },
    ]);
    const planId = uid('cdp');
    const causalId = this.causal(c, 'agent_inference', 'PLANNED', `Arbiter: ${options.length} candidate plan(s), ${feasible.length} feasible; recommended "${options.find((o) => o.id === recommended)?.label}"`, 'arbiter', { planId, recommended });
    this.db.insert('rw_recovery_plans', { id: planId, workspace_id: c.workspace_id, workflow_id: c.id, gap_ids: JSON.stringify(blocking.map((f) => f.id)), options: JSON.stringify(options), recommended, chosen: null, objections: JSON.stringify(objections), plan_hash: sha256(stable(options.map((o) => o.hash))), basis: JSON.stringify({ refs: basis, scope: [...scope], round: c.round }), status: 'proposed', result: null, causal_id: causalId, created_at: nowIso(), decided_at: null, finished_at: null });
    // E · recovery collateral damage: a recovery that fixes its target but breaks another workflow's invariant.
    // Counterfactual: the same plan with and without its recovery actions. Only what the recovery itself breaks counts.
    const isRecAction = (x: PlanAction) => x.kind === 'compensate' || (x.kind === 'execute' && !!(wfs.find((w) => w.wf_key === x.workflow)?.plan.ops as OpDef[]).find((p) => p.key === x.op)?.isCompensation);
    for (const o of options.filter((x) => x.isRecovery)) {
      const res = evalPlan(o.actions).res; const without = evalPlan(o.actions.filter((x) => !isRecAction(x))).res;
      const comp = new Set(o.actions.filter(isRecAction).map((x) => x.workflow));
      const caused = defs.filter((d) => d.spec.type !== 'recovery_safety' && without.get(d.key)?.result === 'satisfied' && res.get(d.key)?.result === 'violated').map((d) => d.key);
      for (const key of caused) {
        const d = defs.find((x) => x.key === key)!;
        const ev = res.get(key)!; const victims = ev.participants.filter((p) => !comp.has(p) && wfs.some((w) => w.wf_key === p));
        if (!victims.length) continue;
        this.upsertFinding(c, { ...this.finding(c, 'recovery_collateral', d, ev, [...new Set([...comp, ...victims])], ev.reads.map((r) => snap[r]?.obsId).filter(Boolean) as string[], { blocks: false, keySuffix: `${o.label}:${key}`, recommendation: `Rejected option "${o.label}" would break "${d.name}" for ${victims.join(', ')}. It cannot be chosen; it was never executed.` }), title: `Recovery "${o.label}" would break "${d.name}" for ${victims.join(', ')}`, status: 'unresolved' }, c.round);
      }
    }
    const nodes: any[] = [{ id: `plan:${planId}`, type: 'plan', label: `Arbitration (round ${c.round}): ${options.length} candidates, ${feasible.length} feasible`, ref: planId }];
    const edges: any[] = blocking.map((f) => ({ from: `plan:${planId}`, to: `find:${f.id}`, rel: 'resolves', why: 'arbitration covers this finding' }));
    const rec = options.find((o) => o.id === recommended)!;
    for (const x of rec.actions) edges.push({ from: `plan:${planId}`, to: `op:${x.workflow}:${x.op}`, rel: x.kind === 'compensate' ? 'compensates_for' : x.kind === 'cancel' ? 'invalidates' : 'requires', why: `recommended option ${rec.id}: ${x.kind}` });
    for (const [k, v] of Object.entries(basis)) { nodes.push({ id: `obs:${v.obsId}`, type: 'evidence', label: `arbitration basis read of ${k}`, ref: v.obsId }); edges.push({ from: `plan:${planId}`, to: `obs:${v.obsId}`, rel: 'derived_from', evidence: v.obsId }); }
    this.graphBatch(c, `arbitration round ${c.round}`, 'arbitration', nodes, edges);
    if (c.state !== 'ARBITRATION') this.moveCampaign(c, 'ARBITRATION', `${feasible.length} feasible plan(s) of ${options.length}; a human chooses.`, 'arbiter');
    this.audit(c, 'arbiter', 'arbitration', `Arbitration: ${options.map((o) => `${o.id}=${o.status}`).join(', ')}; recommended ${recommended}`, { planId });
    return planId;
  }

  private scoreOption(c: Row, cand: { kind: OptionOut['kind']; label: string; rationale: string; actions: PlanAction[]; alts: string[] }, ev: { sim: Sim; res: Map<string, Evaluation> }, defs: InvariantDef[], before: Map<string, EvalResult>, basis: Record<string, { hash: string | null; obsId: string; available: boolean }>, basisHashes: Record<string, string | null>, idx: number): OptionOut {
    const wfs = this.wfs(c);
    const hard = defs.filter((d) => isBlockingStrength(d)); const soft = defs.filter((d) => d.strength === 'soft');
    const violated = hard.filter((d) => ev.res.get(d.key)?.result === 'violated').map((d) => ({ key: d.key, name: d.name, strength: d.strength, detail: ev.res.get(d.key)!.detail }));
    const unknown = defs.filter((d) => d.strength !== 'advisory' && ev.res.get(d.key)?.result === 'unknown').map((d) => ({ key: d.key, detail: ev.res.get(d.key)!.detail }));
    const softV = soft.filter((d) => ev.res.get(d.key)?.result === 'violated').map((d) => ({ key: d.key, detail: ev.res.get(d.key)!.detail }));
    const preserved = defs.filter((d) => ['satisfied', 'not_applicable'].includes(ev.res.get(d.key)?.result ?? '')).map((d) => d.key);
    const newlyBroken = defs.filter((d) => before.get(d.key) === 'satisfied' && ev.res.get(d.key)?.result === 'violated').map((d) => d.key);
    const ctxW = { workflows: wfs.map((w) => ({ key: w.wf_key, pack: w.pack, ops: w.plan.ops, status: {} })), actions: cand.actions };
    const ops = (x: PlanAction) => effective(ctxW, x.workflow, x.op);
    const irreversible = cand.actions.filter((x) => x.kind !== 'cancel' && ops(x)?.reversibility === 'irreversible').length;
    const withdrawn = wfs.filter((w) => { const mine = cand.actions.filter((x) => x.workflow === w.wf_key); return mine.length > 0 && mine.every((x) => ['cancel', 'compensate'].includes(x.kind)) && !mine.some((x) => String(x.note ?? '').includes('moot')); }).length;
    const cost = withdrawn * 10 + cand.actions.filter((x) => x.kind === 'compensate').length * 3 + cand.actions.filter((x) => x.kind === 'cancel').length + cand.actions.filter((x) => x.kind === 'modify').length + cand.actions.filter((x) => x.kind === 'add').length * 0.5 + softV.length * 5 + irreversible * 2;
    const touchedRefs = new Set(cand.actions.filter((x) => x.kind !== 'cancel').map((x) => { const o = ops(x); return o ? refKey(o) : ''; }));
    const levels: ApprovalLevel[] = [...cand.actions.filter((x) => x.kind !== 'cancel').map((x) => ops(x)?.approvalLevel ?? 'manager'), ...defs.filter((d) => specReads(d).some((r) => touchedRefs.has(r))).map((d) => d.approvalLevel)];
    const isRecovery = cand.actions.some((x) => x.kind === 'compensate' || (x.kind === 'execute' && !!ops(x)?.isCompensation));
    const status: OptionOut['status'] = violated.length || unknown.length || ev.sim.rejected.length || ev.sim.unknownActions.length ? 'rejected' : 'feasible';
    const rev = cand.actions.some((x) => x.kind !== 'cancel' && ops(x)?.reversibility === 'irreversible') ? 'irreversible' : cand.actions.some((x) => x.kind !== 'cancel' && ops(x)?.reversibility === 'compensable') ? 'compensable' : 'reversible';
    const id = cand.kind === 'proceed' ? 'proceed' : `${cand.kind}-${idx}`;
    return {
      id, kind: cand.kind, label: cand.label, rationale: cand.rationale, actions: cand.actions, hash: sha256(stable({ actions: cand.actions, basis: basisHashes })), status,
      preserved, violated, unknown, softViolations: softV, newlyBroken, rejectedActions: [...ev.sim.rejected, ...ev.sim.unknownActions], expectedEffects: ev.sim.effects,
      affectedWorkflows: [...new Set([...cand.actions.map((x) => x.workflow), ...defs.filter((d) => newlyBroken.includes(d.key)).flatMap((d) => ev.res.get(d.key)!.participants)])].filter((w) => wfs.some((x) => x.wf_key === w)).sort(),
      reversibility: rev, evidenceStrength: strength(basis), uncertainty: [...unknown.map((u) => u.detail), 'Simulated on independent reads taken for this arbitration; revalidated immediately before execution.'],
      approvalLevel: levels.includes('owner') ? 'owner' : 'manager', why: '', cost: Math.round(cost * 10) / 10, alternativesApplied: cand.alts, isRecovery,
    };
  }

  latestPlan(c: Row) { return this.db.get('SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC', c.id, c.workspace_id); }

  choose(a: Actor, cid: string, optionId: string, opts: { lenient?: boolean } = {}) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot choose a resolution.');
    if (!opts.lenient) this.engine.require(a, 'owner', 'manager');
    const c = this.campaign(a.workspaceId, cid); const plan = this.latestPlan(c);
    if (!plan || !['proposed', 'awaiting_approval'].includes(plan.status)) throw new EngineError(409, 'no_plan', 'There is no open arbitration to choose from.');
    const opt = j<OptionOut[]>(plan.options, []).find((o) => o.id === optionId);
    if (!opt) throw new EngineError(404, 'not_found', 'Unknown option.');
    if (opt.status === 'rejected') throw new EngineError(422, 'hard_constraint', `Option "${opt.label}" violates hard constraints and cannot be chosen by anyone. ${opt.why}`);
    if (opt.kind === 'escalate') {
      this.db.exec("UPDATE rw_recovery_plans SET chosen=?, status='escalated', decided_at=? WHERE id=?", optionId, nowIso(), plan.id);
      this.moveCampaign(c, 'REQUIRES_HUMAN', `Escalated by ${a.name}: no automatic action.`, a.name);
      this.causal(c, 'human_decision', 'REQUIRES_HUMAN', `${a.name} escalated: no automatic action`, a.name, { planId: plan.id });
      return this.detail(a.workspaceId, cid);
    }
    this.db.exec("UPDATE rw_approvals SET status='superseded', invalid_reason='superseded by a new choice' WHERE workflow_id=? AND workspace_id=? AND subject='resolution' AND status='recorded'", c.id, c.workspace_id);
    this.db.exec("UPDATE rw_recovery_plans SET chosen=?, plan_hash=?, status='awaiting_approval', decided_at=? WHERE id=?", optionId, opt.hash, nowIso(), plan.id);
    if (c.state !== 'AWAITING_APPROVAL') this.moveCampaign(c, 'AWAITING_APPROVAL', `${a.name} chose "${opt.label}"; ${opt.approvalLevel} approval bound to ${opt.hash.slice(0, 12)} required.`, a.name);
    this.causal(c, 'human_decision', 'AUTHORIZATION_PENDING', `${a.name} chose "${opt.label}" (plan hash ${opt.hash.slice(0, 12)})`, a.name, { planId: plan.id, optionId });
    return this.detail(a.workspaceId, cid);
  }

  approveResolution(a: Actor | null, cid: string, opts: { ws?: string; userHandle?: string; channel?: 'structured' | 'message' } = {}) {
    const ws = a?.workspaceId ?? opts.ws!;
    if (a && a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot approve.');
    const c = this.campaign(ws, cid); const plan = this.latestPlan(c);
    if (!plan || plan.status !== 'awaiting_approval' || !plan.chosen) throw new EngineError(409, 'no_choice', 'Choose a feasible option before approving it.');
    const opt = j<OptionOut[]>(plan.options, []).find((o) => o.id === plan.chosen)!;
    const user = a ? this.db.get('SELECT * FROM users WHERE id=? AND workspace_id=?', a.id, ws) : opts.userHandle ? this.userByHandle(ws, opts.userHandle) : undefined;
    if (!user) throw new EngineError(403, 'forbidden', 'Approvals must come from an authenticated user.');
    const ok = opt.approvalLevel === 'owner' ? user.role === 'owner' : ['owner', 'manager'].includes(user.role);
    if (!ok) throw new EngineError(403, 'forbidden', `This resolution needs ${opt.approvalLevel === 'owner' ? 'a workspace owner' : 'a manager or owner'} (it touches ${opt.approvalLevel}-level constraints).`);
    const id = uid('rap');
    this.db.insert('rw_approvals', { id, workspace_id: ws, workflow_id: c.id, subject: 'resolution', subject_hash: opt.hash, plan_version: c.round, user_id: user.id, user_name: user.name, role_at_decision: user.role, channel: opts.channel ?? 'structured', status: 'recorded', invalid_reason: null, created_at: nowIso(), expires_at: new Date(Date.now() + RESOLUTION_TTL_MS).toISOString() });
    this.causal(c, 'governance', 'AUTHORIZED', `${user.name} (${user.role}) approved "${opt.label}" bound to plan hash ${opt.hash.slice(0, 12)}`, user.name, { approvalId: id, planId: plan.id });
    this.graphBatch(c, 'resolution approval', 'approval', [{ id: `ap:${id}`, type: 'approval', label: `${user.name} approved ${opt.id}`, ref: id }], [{ from: `plan:${plan.id}`, to: `ap:${id}`, rel: 'governed_by', why: `approval bound to ${opt.hash.slice(0, 12)}` }]);
    this.audit(c, user.name, 'approval', `Resolution "${opt.label}" approved by ${user.name}, bound to ${opt.hash.slice(0, 12)}`, { approvalId: id });
    return this.detail(ws, cid);
  }

  // ================================================================== scripted concurrent events
  applyEvents(c: Row, at: 'before_resolution', ctl: CdCtl, hooks: CdHooks = {}) {
    const s = this.scenario(c); const done = j<string[]>(c.events_done, []); const lab = this.lab(c);
    for (const [i, ev] of (s.events ?? []).entries()) {
      if (ev.at !== at || done.includes(String(i))) continue;
      done.push(String(i));
      if (ev.kind === 'workflow_op') {
        const w = this.wfs(c).find((x) => x.wf_key === ev.workflow)!; const op = this.ops(c).find((o) => o.workflow_id === w.id && o.op_key === ev.op)!;
        const ap = this.validPlanApprovals(c, w, FULL_CTL)[0];
        this.executeOp(c, lab, w, op, op.spec, 'execute', ctl, { approvalId: ap?.id ?? null, boundHash: ap?.subject_hash ?? null, executedHash: w.plan_hash, idemScope: `wf:${String(w.plan_hash).slice(0, 12)}`, basis: {} }, hooks);
        this.settleWorkflowState(c, this.wfs(c).find((x) => x.id === w.id)!);
      } else if (ev.ref && ev.patch) lab.external(ev.ref.system, ev.ref.resource, ev.patch, ev.actor ?? 'external', `event:${i}`);
      this.causal(c, 'fault_injection', 'FAULT_INJECTED', `Scripted concurrent event (sandbox): ${ev.label}`, ev.workflow ?? ev.actor ?? 'world', { label: ev.label, at });
      this.audit(c, 'world', 'event', `Concurrent event: ${ev.label}`);
    }
    this.db.exec('UPDATE cd_campaigns SET events_done=? WHERE id=?', JSON.stringify(done), c.id); c.events_done = JSON.stringify(done);
  }

  // ================================================================== guarded execution
  /** The resolution path: events → authority → basis revalidation (re-plan on drift) → guarded writes → independent verification. */
  async resolve(a: Actor, cid: string, opts: { lenient?: boolean; hooks?: CdHooks } = {}) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot execute.');
    if (!opts.lenient) this.engine.require(a, 'owner', 'manager');
    const c = this.campaign(a.workspaceId, cid); const ctl = this.ctl(c); const hooks = opts.hooks ?? {};
    const plan = this.latestPlan(c);
    if (!plan || plan.status !== 'awaiting_approval' || !plan.chosen) throw new EngineError(409, 'no_choice', 'Choose and approve a resolution first.');
    const opt = j<OptionOut[]>(plan.options, []).find((o) => o.id === plan.chosen)!;
    const basis = j<any>(plan.basis, {});
    const approvals = () => this.db.all("SELECT * FROM rw_approvals WHERE workflow_id=? AND workspace_id=? AND subject='resolution' AND status='recorded' ORDER BY created_at DESC, rowid DESC", c.id, c.workspace_id);
    if (!approvals().length && ctl.approvalGate) throw new EngineError(409, 'authorization_required', `"${opt.label}" has not been approved.`);
    // 1. What happens in the world between approval and execution (scripted, labelled concurrent activity).
    this.applyEvents(c, 'before_resolution', ctl, hooks);
    // 2. Authority at execution time.
    const valid = approvals().find((r) => {
      if (ctl.structured && r.channel !== 'structured') return false;
      const role = this.db.get('SELECT role FROM users WHERE id=? AND workspace_id=?', r.user_id, c.workspace_id)?.role;
      if (ctl.roleCheck && !(opt.approvalLevel === 'owner' ? role === 'owner' : ['owner', 'manager'].includes(role))) return false;
      if (ctl.binding && (r.subject_hash !== opt.hash || r.expires_at < nowIso())) return false;
      return true;
    });
    if (!valid && ctl.approvalGate) throw new EngineError(409, 'authorization_required', `No valid approval for "${opt.label}" bound to ${opt.hash.slice(0, 12)} (structured, current role, unexpired).`);
    // 3. Revalidate the basis the plan was simulated on. Drift → the approval is stale and the plan is re-made.
    if (ctl.revalidate) {
      const lab = this.lab(c); const drift: { ref: string; was: string | null; now: string | null; obsId: string; oldObs: string }[] = [];
      for (const [ref, b] of Object.entries(basis.refs as Record<string, any>)) {
        const o = this.observe(c, lab, 'intersection', ref, 'cd-revalidate', c.id);
        if (!o.available || o.hash !== b.hash) drift.push({ ref, was: b.hash, now: o.hash, obsId: o.id, oldObs: b.obsId });
      }
      if (drift.length) {
        const stale = approvals();
        this.db.exec("UPDATE rw_recovery_plans SET status='superseded', result=? WHERE id=?", JSON.stringify({ outcome: 'superseded', drift }), plan.id);
        for (const r of stale) this.db.exec("UPDATE rw_approvals SET status='invalidated', invalid_reason=? WHERE id=?", `stale: bound to plan ${String(r.subject_hash).slice(0, 12)} whose evidence basis changed (${drift.map((d) => d.ref).join(', ')})`, r.id);
        for (const d of drift) this.db.exec('UPDATE rw_observations SET invalidated_at=?, invalidated_reason=? WHERE id=? AND workspace_id=?', nowIso(), `basis drift before execution: now ${d.now ?? 'unreadable'} (read ${d.obsId})`, d.oldObs, c.workspace_id);
        const pseudo: InvariantDef = { key: `basis:${plan.id}`, name: 'Approved plan basis changed before execution', explanation: 'The approved resolution was simulated on reads that no longer match the world.', scope: 'cross-domain', spec: { type: 'provenance', workflow: opt.affectedWorkflows[0] ?? '' }, severity: 'high', impact: 'Executing the approved plan would act on a world that no longer exists', resolutionPolicy: 'Reject the stale approval; re-plan on fresh reads; require a fresh approval.', approvalLevel: opt.approvalLevel, strength: 'hard', autoRestorable: false, provenance: { source: 'inferred', by: 'guarded executor revalidation' } };
        const touching = this.touchingFn(c);
        const parts = [...new Set(drift.flatMap((d) => touching(d.ref)))];
        this.upsertFinding(c, { ...this.finding(c, 'temporal_evidence_invalidation', pseudo, { key: pseudo.key, result: 'violated', detail: `approval ${stale.map((r) => r.id).join(', ')} rejected as stale: ${drift.map((d) => `${d.ref} ${String(d.was).slice(0, 8)} → ${String(d.now ?? 'unreadable').slice(0, 8)}`).join('; ')}`, reads: drift.map((d) => d.ref), participants: parts, unreadable: [] }, parts, drift.flatMap((d) => [d.oldObs, d.obsId]), { blocks: false, keySuffix: `basis:${plan.id}`, recommendation: 'The approval bound to the old basis was rejected. Review the re-made plan and approve it afresh.' }), status: 'resolved' }, c.round);
        this.graphBatch(c, 'basis drift before execution', 'revalidation', drift.flatMap((d) => [{ id: `obs:${d.obsId}`, type: 'evidence', label: `revalidation read of ${d.ref}`, ref: d.obsId }, { id: `obs:${d.oldObs}`, type: 'evidence', label: `arbitration basis read of ${d.ref}`, ref: d.oldObs }]), [...drift.map((d) => ({ from: `obs:${d.obsId}`, to: `obs:${d.oldObs}`, rel: 'invalidates', evidence: d.obsId, why: 'basis drift' })), ...stale.map((r) => ({ from: `plan:${plan.id}`, to: `ap:${r.id}`, rel: 'invalidates', why: 'stale approval rejected' }))]);
        this.causal(c, 'governance', 'REQUIRES_HUMAN', `Stale approval rejected: the basis of "${opt.label}" changed before execution (${drift.map((d) => d.ref).join(', ')}). Re-planning on fresh reads.`, 'governance', { planId: plan.id, drift: drift.map((d) => d.ref) });
        this.audit(c, 'governance', 'basis_drift', `Basis drift before execution: ${drift.map((d) => d.ref).join(', ')}; approval invalidated; re-planning.`);
        this.moveCampaign(c, 'ARBITRATION', 'Basis changed after approval; plan superseded.', 'governance');
        const blocking = this.runAnalysis(c);
        if (blocking.length) this.buildArbitration(c, blocking); else this.moveCampaign(c, 'CONSISTENT', 'After the change no blocking finding remains.', 'intersection');
        return { outcome: 'replanned' as const, drift: drift.map((d) => d.ref), detail: this.detail(a.workspaceId, cid) };
      }
    }
    // 4. Guarded execution of the chosen plan.
    this.moveCampaign(c, 'EXECUTING', `Executing "${opt.label}" under approval ${valid?.id ?? 'none (baseline)'}.`, 'governance');
    hooks.beforeRecovery?.();
    this.db.exec("UPDATE rw_recovery_plans SET status='executing' WHERE id=?", plan.id);
    const lab = this.lab(c); const wfs = this.wfs(c); const results: any[] = [];
    const basisHashes = Object.fromEntries(Object.entries(basis.refs as Record<string, any>).map(([k, v]) => [k, v.hash]));
    for (const w of wfs.filter((y) => opt.affectedWorkflows.includes(y.wf_key) && opt.actions.some((x) => x.workflow === y.wf_key) && !['CANCELLED'].includes(y.state))) if (canMove(w.state as RState, 'RECOVERING') || w.state === 'REQUIRES_HUMAN') this.walk(c, w, 'RECOVERING', `Executing the approved resolution "${opt.label}".`);
    for (const x of opt.actions) {
      const w = this.wfs(c).find((y) => y.wf_key === x.workflow)!;
      let opRow = this.ops(c).find((o) => o.workflow_id === w.id && o.op_key === x.op);
      if (x.kind === 'add' && x.newOp && !opRow) {
        this.db.insert('cd_ops', { id: uid('cdo'), workspace_id: c.workspace_id, campaign_id: c.id, workflow_id: w.id, op_key: x.op, kind: 'forward', label: x.newOp.label, system: x.newOp.system, resource: x.newOp.resource, agent: `exec.${x.newOp.system}`, spec: JSON.stringify(x.newOp), status: 'pending', origin: `resolution ${opt.id}`, created_at: nowIso(), updated_at: nowIso() });
        opRow = this.ops(c).find((o) => o.workflow_id === w.id && o.op_key === x.op)!;
      }
      if (!opRow) { results.push({ action: x, status: 'missing' }); continue; }
      if (x.kind === 'cancel') { this.db.exec("UPDATE cd_ops SET status='cancelled', last_error=?, plan_hash=?, approval_id=?, updated_at=? WHERE id=?", x.note ?? 'cancelled by resolution', opt.hash, valid?.id ?? null, nowIso(), opRow.id); results.push({ action: x, status: 'cancelled' }); continue; }
      const spec = effective({ workflows: wfs.map((y) => ({ key: y.wf_key, pack: y.pack, ops: y.plan.ops, status: {} })), actions: opt.actions }, x.workflow, x.op) ?? opRow.spec;
      if (x.kind === 'modify') this.db.exec('UPDATE cd_ops SET spec=?, label=?, system=?, resource=?, agent=?, origin=? WHERE id=?', JSON.stringify({ ...spec, _original: opRow.spec }), spec.label, spec.system, spec.resource, `exec.${spec.system}`, `modified by resolution ${opt.id}`, opRow.id);
      const r = this.executeOp(c, lab, w, { ...opRow, spec }, spec, x.kind === 'compensate' ? 'compensate' : 'execute', ctl, { approvalId: valid?.id ?? null, boundHash: valid?.subject_hash ?? null, executedHash: opt.hash, idemScope: `res:${opt.hash.slice(0, 12)}`, basis: basisHashes }, hooks);
      results.push({ action: x, status: r });
    }
    // 5. The plan's fresh basis becomes every included workflow's decision evidence; then re-evaluate everything.
    const revalObs = this.db.all("SELECT * FROM rw_observations WHERE workflow_id=? AND workspace_id=? AND purpose='cd-revalidate' ORDER BY rowid DESC", c.id, c.workspace_id);
    for (const w of this.wfs(c).filter((y) => opt.affectedWorkflows.includes(y.wf_key))) {
      const nb = { ...w.basis }; for (const r of Object.keys(nb)) { const o = revalObs.find((x) => `${x.system}/${x.resource}` === r) ?? (basis.refs?.[r] ? { id: basis.refs[r].obsId, state_hash: basis.refs[r].hash, observed_at: plan.created_at, available: basis.refs[r].available ? 1 : 0 } : null); if (o) nb[r] = { obsId: o.id, hash: o.state_hash, at: o.observed_at, available: !!o.available, via: `revalidated for resolution ${opt.id}` }; }
      this.db.exec('UPDATE cd_workflows SET basis=? WHERE id=?', JSON.stringify(nb), w.id);
    }
    const failedOps = results.filter((r) => ['failed', 'unknown', 'rejected', 'missing', 'applied'].includes(r.status) && !(r.status === 'applied' && !ctl.verify));
    for (const w of this.wfs(c).filter((y) => opt.affectedWorkflows.includes(y.wf_key))) {
      const mine = this.ops(c).filter((o) => o.workflow_id === w.id && o.status !== 'scheduled');
      const { m } = this.statusMap(c);
      if (mine.some((o) => ['failed', 'unknown', 'rejected'].includes(o.status) && opt.actions.some((x) => x.workflow === w.wf_key && x.op === o.op_key))) this.walk(c, w, 'REQUIRES_HUMAN', 'A resolution step did not verify.');
      else if (!this.isActiveIn(m, w)) { const comp = mine.some((o) => o.status === 'compensated' || (o.spec.isCompensation && o.status === 'verified')); this.walk(c, w, comp ? 'RECOVERED' : 'CANCELLED', comp ? 'Compensated and verified (a compensation is a new write, not an undo).' : 'Withdrawn by the approved resolution.'); }
      else if (mine.every((o) => ['verified', 'cancelled', 'compensated'].includes(o.status) || (o.status === 'failed' && !opt.actions.some((x) => x.workflow === w.wf_key && x.op === o.op_key)))) this.walk(c, w, w.state === 'RECOVERING' ? 'RECOVERED' : 'VERIFIED', 'Every remaining operation verified after the resolution.');
    }
    this.moveCampaign(c, 'RESOLVED', 'Execution finished; verifying every affected invariant.', 'verifier');
    const blocking = this.runAnalysis(c);
    const hardBad = this.invariants(c).filter((d) => isBlockingStrength(d) && ['violated', 'unknown'].includes(this.db.get('SELECT last_result FROM cd_invariants WHERE campaign_id=? AND inv_key=? AND workspace_id=?', c.id, d.key, c.workspace_id)?.last_result));
    const ok = !hardBad.length && !failedOps.length && !blocking.length;
    this.db.exec('UPDATE rw_recovery_plans SET status=?, result=?, finished_at=? WHERE id=?', ok ? 'verified' : 'failed', JSON.stringify({ outcome: ok ? 'verified' : 'failed', actions: results, hardViolations: hardBad.map((d) => d.key), blocking: blocking.map((f) => f.title) }), nowIso(), plan.id);
    if (ok) for (const f of this.db.all("SELECT id FROM cd_findings WHERE campaign_id=? AND workspace_id=? AND pattern='recovery_collateral' AND status='unresolved'", c.id, c.workspace_id)) this.db.exec("UPDATE cd_findings SET status='resolved', resolved_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), f.id);
    if (!ok) this.moveCampaign(c, blocking.length ? 'CONFLICTED' : 'REQUIRES_HUMAN', `Not consistent after execution: ${[...hardBad.map((d) => d.key), ...failedOps.map((r) => `${r.action.workflow}:${r.action.op} ${r.status}`)].join(', ')}.`, 'verifier');
    else this.moveCampaign(c, 'RESOLVED', 'Every affected invariant independently verified after the resolution.', 'verifier');
    this.causal(c, 'system_recovery', ok ? 'RECOVERED' : 'REQUIRES_HUMAN', `Resolution "${opt.label}" ${ok ? 'verified: every hard invariant holds on independent reads' : 'did not restore consistency'}`, 'verifier', { planId: plan.id });
    this.issuePassport(c);
    return { outcome: ok ? 'verified' as const : 'failed' as const, drift: [] as string[], detail: this.detail(a.workspaceId, cid) };
  }

  /** Guarded workflow execution: the intersection gate runs first; a blocked workflow does not execute. */
  async executeWorkflow(a: Actor, cid: string, wfKey: string, opts: { lenient?: boolean; hooks?: CdHooks } = {}) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot execute.');
    if (!opts.lenient) this.engine.require(a, 'owner', 'manager');
    const c = this.campaign(a.workspaceId, cid); const ctl = this.ctl(c);
    let w = this.wfs(c).find((x) => x.wf_key === wfKey); if (!w) throw new EngineError(404, 'not_found', 'Workflow not in this campaign.');
    if (!this.ops(c).some((o) => o.workflow_id === w!.id && o.status === 'pending')) throw new EngineError(409, 'nothing_pending', `${w.title} has no pending operation.`);
    if (ctl.gate) {
      const blocking = this.runAnalysis(c).filter((f) => j<string[]>(f.workflows, []).includes(wfKey));
      if (blocking.length) {
        this.causal(c, 'governance', 'REQUIRES_HUMAN', `Intersection gate refused "${w.title}": ${[...new Set(blocking.map((f) => PATTERN_LABELS[f.pattern as Pattern]))].join(', ')}`, 'intersection', { workflow: wfKey, findings: blocking.map((f) => f.id) });
        this.audit(c, 'intersection', 'gate_refused', `Unsafe continuation prevented: ${w.title}`, { findings: blocking.map((f) => f.id) });
        throw new EngineError(409, 'intersection_blocked', `"${w.title}" is locally valid but globally blocked: ${blocking.map((f) => `${PATTERN_LABELS[f.pattern as Pattern]} — ${f.title}`).join(' | ')}. Arbitrate first.`);
      }
      w = this.wfs(c).find((x) => x.wf_key === wfKey)!;
    }
    const ap = this.validPlanApprovals(c, w, ctl)[0];
    if (ctl.approvalGate && !ap) throw new EngineError(409, 'authorization_required', `${w.title} has no valid plan approval bound to ${String(w.plan_hash).slice(0, 12)}.`);
    const lab = this.lab(c);
    this.walk(c, w, 'EXECUTING', 'Executing its own plan (intersection gate passed).');
    const basis = Object.fromEntries(Object.entries(w.basis as Record<string, any>).map(([k, v]) => [k, v.hash]));
    for (const op of this.ops(c).filter((o) => o.workflow_id === w!.id && o.status === 'pending')) this.executeOp(c, lab, w, op, op.spec, 'execute', ctl, { approvalId: ap?.id ?? null, boundHash: ap?.subject_hash ?? null, executedHash: w.plan_hash, idemScope: `wf:${String(w.plan_hash).slice(0, 12)}`, basis }, opts.hooks ?? {});
    w = this.wfs(c).find((x) => x.wf_key === wfKey)!;
    const mine = this.ops(c).filter((o) => o.workflow_id === w!.id && o.status !== 'scheduled');
    if (mine.every((o) => o.status === 'verified')) this.walk(c, w, 'VERIFIED', 'Every operation independently verified.');
    else if (mine.some((o) => ['failed', 'unknown', 'rejected'].includes(o.status))) this.walk(c, w, 'REQUIRES_HUMAN', 'An operation did not verify.');
    else this.walk(c, w, 'OBSERVATION_PENDING', 'Agents declared success; this configuration does not verify independently.');
    if (ctl.gate) this.runAnalysis(c);
    return this.detail(a.workspaceId, cid);
  }

  /** Baseline behaviour only (benchmark): every workflow continues its own plan with no cross-domain gate. */
  async continueAsPlanned(a: Actor, cid: string, hooks: CdHooks = {}) {
    const c = this.campaign(a.workspaceId, cid); const ctl = this.ctl(c);
    if (c.source !== 'benchmark') throw new EngineError(409, 'benchmark_only', 'Continuing without the cross-domain gate is a benchmark baseline behaviour.');
    this.applyEvents(c, 'before_resolution', ctl, hooks);
    if (this.ops(c).some((o) => o.status === 'pending' && o.spec.isCompensation)) hooks.beforeRecovery?.();
    const lab = this.lab(c);
    for (const w of this.wfs(c)) {
      const ap = this.validPlanApprovals(c, w, ctl)[0];
      const pending = this.ops(c).filter((o) => o.workflow_id === w.id && o.status === 'pending');
      if (!pending.length || (ctl.approvalGate && !ap)) continue;
      const basis = Object.fromEntries(Object.entries(w.basis as Record<string, any>).map(([k, v]) => [k, v.hash]));
      for (const op of pending) this.executeOp(c, lab, w, op, op.spec, 'execute', ctl, { approvalId: ap?.id ?? null, boundHash: ap?.subject_hash ?? null, executedHash: w.plan_hash, idemScope: `wf:${String(w.plan_hash).slice(0, 12)}`, basis }, hooks);
    }
    return this.detail(a.workspaceId, cid);
  }

  /** One guarded write: capability-checked executor, idempotency key, compare-and-set, read-back on error, independent verification. */
  private executeOp(c: Row, lab: Lab, w: Row, opRow: Row, spec: OpDef, kind: 'execute' | 'compensate', ctl: CdCtl, auth: { approvalId: string | null; boundHash: string | null; executedHash: string | null; idemScope: string; basis: Record<string, string | null> }, hooks: CdHooks): string {
    const ref = `${spec.system}/${spec.resource}`; const agent = `exec.${spec.system}`; const opKey = `${w.wf_key}:${spec.key}${kind === 'compensate' ? ':compensate' : ''}`;
    const idem = ctl.cas ? `cd:${c.id}:${auth.idemScope}:${opKey}` : null;
    const pre = this.observe(c, lab, 'observer', ref, 'cd-pre-write', w.id, opRow.id);
    let patch: Patch = kind === 'compensate' ? (spec.compensate?.patch ?? {}) : materialize(spec, pre.available ? pre.state : undefined, ctl.cas);
    if (!ctl.cas) patch = { set: patch.set, inc: patch.inc };
    if (spec.effect.kind === 'schedule' && !pre.available) { this.db.exec("UPDATE cd_ops SET status='unknown', last_error=?, updated_at=? WHERE id=?", 'calendar unreadable: the slot cannot be materialized safely', nowIso(), opRow.id); return 'unknown'; }
    hooks.beforeWrite?.({ workflow: w.wf_key, op: spec.key, kind, system: spec.system, resource: spec.resource, approvalId: auth.approvalId, boundHash: auth.boundHash, executedHash: auth.executedHash, basis: auth.basis });
    let status = 'applied'; let response: unknown = null; let err: string | null = null;
    try { response = lab.mutate(agent, opKey, spec.system, spec.resource, patch, idem); }
    catch (e) {
      err = String((e as Error).message);
      if (e instanceof LabError && e.code === 'conflict') status = 'rejected';
      else if (e instanceof LabError && e.code === 'forbidden') status = 'failed';
      else if (ctl.readBack) {
        const rb = this.observe(c, lab, 'observer', ref, 'cd-readback', w.id, opRow.id);
        status = !rb.available ? 'unknown' : this.checks(spec, kind, pre.available ? pre.state : undefined, rb.state, patch).every((x) => x.ok) ? 'applied' : 'failed';
      } else status = 'failed';
    }
    let afterObs: string | null = null; let verifier: any[] = [];
    if (status === 'applied' && ctl.verify) {
      const after = this.observe(c, lab, 'verifier', ref, 'cd-verify', w.id, opRow.id); afterObs = after.id;
      if (!after.available) status = 'unknown';
      else { verifier = this.checks(spec, kind, pre.available ? pre.state : undefined, after.state, patch); status = verifier.every((x) => x.ok) ? (kind === 'compensate' ? 'compensated' : 'verified') : 'failed'; }
    }
    if (status === 'applied' && kind === 'compensate' && !ctl.verify) status = 'compensated';
    if (afterObs && ['verified', 'compensated'].includes(status)) {
      // a verified own write becomes this workflow's fresh decision evidence for that resource (the planning read is kept)
      const cur = j<Record<string, any>>(this.db.get('SELECT basis FROM cd_workflows WHERE id=?', w.id)?.basis, {}); const prev = cur[ref] ?? {}; const ob = this.obsRow(c.workspace_id, afterObs);
      cur[ref] = { obsId: afterObs, hash: ob?.state_hash ?? null, at: ob?.observed_at, available: true, planObs: prev.planObs ?? prev.obsId ?? null, planHash: prev.planHash ?? prev.hash ?? null, via: 'own verified write' };
      this.db.exec('UPDATE cd_workflows SET basis=? WHERE id=?', JSON.stringify(cur), w.id);
    }
    this.db.exec('UPDATE cd_ops SET status=?, attempts=attempts+1, idempotency_key=?, approval_id=?, plan_hash=?, tool_response=?, after_obs=?, verifier=?, last_error=?, updated_at=? WHERE id=?', status, idem, auth.approvalId, auth.executedHash, JSON.stringify(response), afterObs, JSON.stringify(verifier), err, nowIso(), opRow.id);
    if (spec.claim && ['applied', 'verified'].includes(status)) { const decl = j<any[]>(this.db.get('SELECT declared FROM cd_workflows WHERE id=?', w.id)?.declared, []); decl.push({ op: spec.key, agent, claim: spec.claim, at: nowIso() }); this.db.exec('UPDATE cd_workflows SET declared=? WHERE id=?', JSON.stringify(decl), w.id); }
    // The engine never reads lab_effects (ground truth); the effect node is the receipt the tool call returned.
    const receipt = (response as { receipt?: string } | null)?.receipt ?? null;
    const nodes: any[] = []; const edges: any[] = []; const opNode = `op:${w.wf_key}:${spec.key}`;
    if (!this.db.get('SELECT 1 x FROM cd_nodes WHERE campaign_id=? AND id=?', c.id, opNode) || spec.system !== opRow.system || spec.resource !== opRow.resource) { nodes.push({ id: opNode, type: 'operation', label: spec.label, ref: opRow.id, domain: w.pack }, { id: `res:${ref}`, type: 'resource', label: ref }); edges.push({ from: `wf:${w.wf_key}`, to: opNode, rel: 'requires' }, { from: opNode, to: `res:${ref}`, rel: spec.effect.kind === 'reserve' || spec.effect.kind === 'schedule' ? 'reserves' : ['consume', 'spend'].includes(spec.effect.kind) ? 'consumes' : spec.effect.kind === 'release' ? 'releases' : 'modifies' }); }
    if (receipt) { nodes.push({ id: `eff:${receipt}`, type: 'effect', label: `write receipt ${receipt} (${opKey}; tool response, not proof)`, ref: receipt }); edges.push({ from: opNode, to: `eff:${receipt}`, rel: 'executes', why: 'tool receipt; the verification read is the proof' }); }
    if (afterObs) { nodes.push({ id: `obs:${afterObs}`, type: 'evidence', label: `verification read of ${ref}`, ref: afterObs }); edges.push({ from: opNode, to: `obs:${afterObs}`, rel: 'verified_by', evidence: afterObs }); }
    if (auth.approvalId) edges.push({ from: `ap:${auth.approvalId}`, to: opNode, rel: 'governed_by', why: 'authorizing approval' });
    this.graphBatch(c, `${kind} ${opKey} → ${status}`, 'execution', nodes, edges);
    this.causal(c, 'action_execution', status === 'verified' || status === 'compensated' ? 'VERIFIED' : status === 'applied' ? 'OBSERVATION_PENDING' : status === 'unknown' ? 'EXECUTION_UNKNOWN' : 'FAILED', `${agentById(agent)?.name ?? agent}: ${kind === 'compensate' ? spec.compensate?.label : spec.label} → ${status}${err ? ` (${err})` : ''}`, agent, { ref, status, idempotencyKey: idem, approvalId: auth.approvalId });
    return status;
  }

  private checks(spec: OpDef, kind: 'execute' | 'compensate', before: ResourceState | undefined, after: ResourceState | undefined, patch: Patch) {
    if (kind === 'compensate') return compensationChecks(before, spec.compensate?.patch ?? {}, after).map((x) => ({ label: x.label, want: x.want, got: x.got, ok: x.ok }));
    const out: { label: string; want: unknown; got: unknown; ok: boolean }[] = spec.expect.map((e) => ({ label: `${e.field} = ${JSON.stringify(e.equals)}`, want: e.equals, got: after?.[e.field] ?? null, ok: after !== undefined && eq(after[e.field], e.equals) }));
    for (const [f, d] of Object.entries(patch.inc ?? {})) { const want = before === undefined ? null : Number(before[f] ?? 0) + d; out.push({ label: `${f} moved by ${d}`, want, got: after?.[f] ?? null, ok: want !== null && after !== undefined && Number(after[f] ?? 0) === want }); }
    if (spec.effect.kind === 'schedule' && spec.effect.window) { const slots = (after?.slots as any[]) ?? []; out.push({ label: `slot for ${spec.effect.holder} booked`, want: spec.effect.window, got: slots.filter((s) => s.holder === spec.effect.holder).map((s) => [s.start, s.end]), ok: slots.some((s) => s.holder === spec.effect.holder && s.start === spec.effect.window![0] && s.end === spec.effect.window![1]) }); }
    if (!out.length) out.push({ label: 'state changed', want: 'different from before', got: after === undefined ? null : stateHash(after), ok: before !== undefined && after !== undefined && stateHash(before) !== stateHash(after) });
    return out;
  }

  // ================================================================== proof-of-consistency passport
  issuePassport(c: Row) {
    const rows = this.db.all('SELECT * FROM cd_invariants WHERE campaign_id=? AND workspace_id=? ORDER BY rowid', c.id, c.workspace_id);
    const plan = this.latestPlan(c); const opt = plan?.chosen ? j<OptionOut[]>(plan.options, []).find((o) => o.id === plan.chosen) : null;
    const ev = (id: string) => { const o = this.obsRow(c.workspace_id, id); return o ? { id: o.id, observer: o.observer, system: o.system, resource: o.resource, observedAt: o.observed_at, available: !!o.available, stateHash: o.state_hash, invalidated: o.invalidated_reason } : null; };
    const invariants = rows.map((r) => { const le = j<any>(r.last_eval, {}); const shown = le.current?.result === 'violated' || le.current?.result === 'unknown' ? le.current : le.projected; return { key: r.inv_key, version: r.version, name: r.name, type: r.type, strength: r.strength, provenance: j(r.provenance, {}), result: r.last_result ?? 'not_evaluated', detail: shown?.detail ?? '', evidence: (le.evidence ?? []).map(ev).filter(Boolean) }; });
    const hard = invariants.filter((i) => ['hard', 'conditional'].includes(i.strength));
    const verdict = hard.some((i) => i.result === 'unknown') ? 'UNKNOWN' : hard.some((i) => i.result === 'violated') ? 'INCONSISTENT' : 'CONSISTENT';
    const body = {
      passportVersion: 1, kind: 'cross-domain-consistency', workspaceId: c.workspace_id, campaignId: c.id, scenario: c.scenario, title: c.title, baseline: c.baseline, analysisRound: c.round,
      workflows: this.wfs(c).map((w) => ({ key: w.wf_key, pack: w.pack, domain: w.domain, state: w.state, planHash: w.plan_hash, operations: this.ops(c).filter((o) => o.workflow_id === w.id).map((o) => ({ op: o.op_key, label: o.label, status: o.status, idempotencyKey: o.idempotency_key, approvalId: o.approval_id, boundPlanHash: o.plan_hash, afterObservation: o.after_obs })) })),
      invariants, summary: { satisfied: invariants.filter((i) => i.result === 'satisfied').length, violated: invariants.filter((i) => i.result === 'violated').length, unknown: invariants.filter((i) => i.result === 'unknown').length, notApplicable: invariants.filter((i) => i.result === 'not_applicable').length, total: invariants.length },
      findings: this.db.all('SELECT id, pattern, title, status, blocks FROM cd_findings WHERE campaign_id=? AND workspace_id=? ORDER BY detected_at, rowid', c.id, c.workspace_id),
      resolution: opt ? { planId: plan!.id, optionId: opt.id, label: opt.label, planHash: opt.hash, status: plan!.status, actions: opt.actions, approvals: this.db.all("SELECT id, user_name, role_at_decision, channel, subject_hash, status, invalid_reason, created_at FROM rw_approvals WHERE workflow_id=? AND workspace_id=? AND subject='resolution' ORDER BY created_at, rowid", c.id, c.workspace_id) } : null,
      verdict, issuedAt: nowIso(),
      integrityNote: 'A matching sha256 over the stable (key-sorted) JSON of this body proves this recorded body was not altered after it was issued. It does NOT prove that the (sandbox) systems behaved as recorded or that any claim is true; the evidence entries are what support each conclusion.',
      sandbox: LAB_LABEL, collaboration: this.engine.collab.describe(),
    };
    const id = uid('pp');
    this.db.insert('rw_passports', { id, workspace_id: c.workspace_id, workflow_id: c.id, operation_id: null, status: verdict, body: JSON.stringify(body), body_hash: sha256(stable(body)), created_at: nowIso() });
    this.causal(c, 'verification_probe', verdict === 'CONSISTENT' ? 'VERIFIED' : 'REQUIRES_HUMAN', `Proof-of-consistency passport issued: ${verdict} (${body.summary.satisfied} satisfied, ${body.summary.violated} violated, ${body.summary.unknown} unknown of ${body.summary.total})`, 'verifier', { passportId: id });
    this.graphBatch(c, 'passport', 'passport', [{ id: `pp:${id}`, type: 'passport', label: `Passport ${verdict}`, ref: id }], rows.map((r) => ({ from: `inv:${r.inv_key}`, to: `pp:${id}`, rel: 'verified_by', why: `result ${r.last_result}` })));
    return id;
  }
  passportNow(a: Actor, cid: string) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot issue passports.');
    this.engine.require(a, 'owner', 'manager');
    const c = this.campaign(a.workspaceId, cid); this.runAnalysis(c); const id = this.issuePassport(this.campaign(a.workspaceId, cid));
    return { passportId: id, ...this.detail(a.workspaceId, cid) };
  }
  passport(ws: string, cid: string, pid: string) {
    const p = this.db.get('SELECT * FROM rw_passports WHERE id=? AND workflow_id=? AND workspace_id=?', pid, cid, ws);
    if (!p) throw new EngineError(404, 'not_found', 'Passport not found in this campaign.');
    return { id: p.id, status: p.status, bodyHash: p.body_hash, createdAt: p.created_at, body: j(p.body, {}) };
  }

  // ================================================================== read models
  detail(ws: string, id: string) {
    const c = this.campaign(ws, id); const s = this.scenario(c); const lab = this.lab(c);
    const wfs = this.wfs(c); const ops = this.ops(c);
    const plans = this.db.all('SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at, rowid', id, ws).map((p) => ({ ...p, options: j(p.options, []), objections: j(p.objections, []), gap_ids: j(p.gap_ids, []), basis: j(p.basis, {}), result: j(p.result, null) }));
    const ids = [id, ...wfs.map((w) => w.id)];
    const approvals = this.db.all(`SELECT * FROM rw_approvals WHERE workspace_id=? AND workflow_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, rowid`, ws, ...ids);
    const { fault_state: _f, controls, ...pub } = c; void _f;
    return {
      campaign: { ...pub, controls: j(controls, {}), cdControls: this.ctl(c), events_done: j(c.events_done, []) },
      scenario: { id: s.id, title: s.title, story: s.story, packs: s.packs.map((p) => ({ id: p, label: cdPack(p)?.label, domain: cdPack(p)?.domain })), events: (s.events ?? []).map((e) => e.label), faults: (s.faults ?? []).map((f) => f.label), resolutionApprover: s.resolutionApprover },
      baseline: { id: c.baseline, ...BASELINES[c.baseline] },
      workflows: wfs.map((w) => ({ id: w.id, key: w.wf_key, pack: w.pack, domain: w.domain, title: w.title, intent: w.intent, owner: w.owner, state: w.state, stateReason: w.state_reason, planHash: w.plan_hash, declaredLinks: w.declared_links, declared: w.declared, basis: w.basis, local: j(w.local_status, null), global: w.global_status, approvals: approvals.filter((x) => x.workflow_id === w.id), operations: ops.filter((o) => o.workflow_id === w.id).map((o) => ({ id: o.id, key: o.op_key, label: o.label, kind: o.kind, system: o.system, resource: o.resource, agent: o.agent, status: o.status, origin: o.origin, attempts: o.attempts, idempotencyKey: o.idempotency_key, approvalId: o.approval_id, planHash: o.plan_hash, afterObs: o.after_obs, verifier: o.verifier, lastError: o.last_error, effect: o.spec.effect, reversibility: o.spec.reversibility, claim: o.spec.claim ?? null, scheduled: !!o.spec.scheduled })) })),
      invariants: this.db.all('SELECT * FROM cd_invariants WHERE campaign_id=? AND workspace_id=? ORDER BY rowid', id, ws).map(invOut),
      findings: this.db.all('SELECT * FROM cd_findings WHERE campaign_id=? AND workspace_id=? ORDER BY blocks DESC, detected_at, rowid', id, ws).map(findingOut),
      plans, approvals: approvals.filter((x) => x.workflow_id === id),
      passports: this.db.all('SELECT id, status, body_hash, created_at FROM rw_passports WHERE workflow_id=? AND workspace_id=? ORDER BY created_at, rowid', id, ws),
      sandbox: { label: LAB_LABEL, resources: lab.resources(), effectLog: lab.effects().map((e) => ({ seq: e.seq, system: e.system, resource: e.resource, op: e.op_key, actor: e.actor, applied: !!e.applied, note: e.note, idempotencyKey: e.idem_key, at: e.created_at })), effectLogNote: 'Sandbox-side effect log (ground truth), shown for transparency. The engine decides from independent observations only and never reads it.' },
      timeline: this.db.all('SELECT * FROM causal_events WHERE workspace_id=? AND mission_id=? ORDER BY created_at, rowid', ws, id).map((e) => ({ ...e, observed_state: j(e.observed_state, {}) })),
      graphStats: { nodes: this.db.get<{ n: number }>('SELECT count(*) n FROM cd_nodes WHERE campaign_id=? AND workspace_id=?', id, ws)?.n ?? 0, edges: this.db.get<{ n: number }>('SELECT count(*) n FROM cd_edges WHERE campaign_id=? AND workspace_id=?', id, ws)?.n ?? 0 },
      collab: this.engine.collab.describe(),
    };
  }
  list(ws: string, source = 'live') {
    return this.db.all(`SELECT id, scenario, title, state, state_reason, baseline, source, round, created_at, updated_at FROM cd_campaigns WHERE workspace_id=?${source === 'all' ? '' : ' AND source=?'} ORDER BY created_at DESC, rowid DESC LIMIT 200`, ws, ...(source === 'all' ? [] : [source]))
      .map((r) => ({ ...r, workflows: this.db.get<{ n: number }>('SELECT count(*) n FROM cd_workflows WHERE campaign_id=? AND workspace_id=?', r.id, ws)?.n ?? 0, openFindings: this.db.get<{ n: number }>("SELECT count(*) n FROM cd_findings WHERE campaign_id=? AND workspace_id=? AND blocks=1 AND status IN ('unresolved','unknown')", r.id, ws)?.n ?? 0 }));
  }
  inbox(ws: string, f: { severity?: string; domain?: string; status?: string; pattern?: string; campaign?: string; source?: string }) {
    const params: unknown[] = [ws]; let where = 'f.workspace_id=? AND c.workspace_id=f.workspace_id';
    if (f.severity) { where += ' AND f.severity=?'; params.push(f.severity); }
    if (f.status) { where += ' AND f.status=?'; params.push(f.status); }
    if (f.pattern) { where += ' AND f.pattern=?'; params.push(f.pattern); }
    if (f.campaign) { where += ' AND f.campaign_id=?'; params.push(f.campaign); }
    if (f.domain) { where += ' AND f.domains LIKE ?'; params.push(`%"${f.domain.replace(/[%_"\\]/g, '')}"%`); }
    where += ' AND c.source=?'; params.push(f.source === 'benchmark' ? 'benchmark' : 'live');
    return this.db.all(`SELECT f.*, c.title AS campaign_title, c.state AS campaign_state FROM cd_findings f JOIN cd_campaigns c ON c.id=f.campaign_id WHERE ${where} ORDER BY f.blocks DESC, f.detected_at DESC, f.rowid DESC LIMIT 300`, ...params).map(findingOut);
  }
  graph(ws: string, id: string) {
    const c = this.campaign(ws, id);
    const nodes = this.db.all('SELECT id, type, ref_id, label, domain, data FROM cd_nodes WHERE campaign_id=? AND workspace_id=? ORDER BY rowid', id, ws).map((n): Row => ({ ...n, data: j(n.data, {}) }));
    const edges = this.db.all('SELECT id, from_node, to_node, rel, provenance, evidence_id, causal_id, created_at FROM cd_edges WHERE campaign_id=? AND workspace_id=? ORDER BY rowid', id, ws).map((e): Row => ({ ...e, provenance: j(e.provenance, {}) }));
    // live status overlay from persisted rows (no client-side business logic)
    const wfs = this.wfs(c); const ops = this.ops(c);
    const fs = this.db.all('SELECT id, status, blocks, pattern FROM cd_findings WHERE campaign_id=? AND workspace_id=?', id, ws);
    const invs = this.db.all('SELECT inv_key, last_result, strength FROM cd_invariants WHERE campaign_id=? AND workspace_id=?', id, ws);
    for (const n of nodes) {
      if (n.type === 'workflow') { const w = wfs.find((x) => x.id === n.ref_id); n.data = { ...n.data, state: w?.state, global: w?.global_status, pack: w?.pack }; }
      if (n.type === 'finding') { const f = fs.find((x) => x.id === n.ref_id); n.data = { ...n.data, status: f?.status, blocks: !!f?.blocks }; }
      if (n.type === 'invariant' || n.type === 'policy') { const i = invs.find((x) => `inv:${x.inv_key}` === n.id); n.data = { ...n.data, result: i?.last_result, strength: i?.strength }; }
      if (n.type === 'operation') { const o = ops.find((x) => n.id === `op:${wfs.find((w) => w.id === x.workflow_id)?.wf_key}:${x.op_key}`); n.data = { ...n.data, status: o?.status }; }
    }
    return { nodes, edges, provenanceNote: 'Every edge carries the source that produced it and the causal_events id of that step.' };
  }
  /** Impact explorer: what a change to this node would reach, by traversing the persisted graph along change-carrying relations. */
  impact(ws: string, id: string, node: string) {
    const c = this.campaign(ws, id); const edges = this.edges(c);
    const types = new Map(this.db.all('SELECT id, type FROM cd_nodes WHERE campaign_id=? AND workspace_id=?', id, ws).map((r) => [r.id as string, r.type as string]));
    if (!types.has(node)) throw new EngineError(404, 'not_found', 'Node not in this campaign graph.');
    const follow: Record<string, string[]> = {
      resource: ['governed_by', 'reserves', 'consumes', 'modifies', 'releases', 'derived_from'], invariant: ['governed_by', 'derived_from'], policy: ['governed_by', 'derived_from'],
      operation: ['reserves', 'consumes', 'modifies', 'releases', 'requires', 'temporally_precedes', 'compensates_for'], workflow: ['requires', 'depends_on', 'shares_constraint_with', 'conflicts_with', 'governed_by'],
      evidence: ['derived_from', 'requires', 'invalidates'], finding: ['conflicts_with', 'derived_from'], plan: ['requires', 'resolves', 'governed_by'], approval: ['governed_by'], domain: ['belongs_to'], agent: ['executes'], effect: ['executes'], passport: ['verified_by'],
    };
    const seen = new Set([node]); const q: [string, number][] = [[node, 0]]; const path: { from: string; to: string; rel: string }[] = [];
    while (q.length) {
      const [n, depth] = q.shift()!; if (depth >= 4) continue;
      const allowed = follow[types.get(n) ?? 'resource'] ?? [];
      for (const e of edges) {
        const nx = e.from_node === n ? e.to_node : e.to_node === n ? e.from_node : null; if (!nx || seen.has(nx) || !allowed.includes(e.rel)) continue;
        seen.add(nx); path.push({ from: n, to: nx, rel: e.rel }); q.push([nx, depth + 1]);
      }
    }
    const pick = (p: string) => [...seen].filter((x) => x !== node && x.startsWith(p)).map((x) => x.slice(p.length));
    return {
      start: node, workflows: pick('wf:'), operations: pick('op:'), invariants: pick('inv:'), resources: pick('res:'),
      evidence: pick('obs:').map((x) => this.obsRow(ws, x)).filter(Boolean).map((o: any) => ({ id: o.id, purpose: o.purpose, ref: `${o.system}/${o.resource}`, at: o.observed_at, invalidated: o.invalidated_reason, wouldBeInvalidated: node === `res:${o.system}/${o.resource}` })),
      approvals: pick('ap:').map((x) => this.db.get('SELECT id, user_name, subject, status, subject_hash FROM rw_approvals WHERE id=? AND workspace_id=?', x, ws)).filter(Boolean),
      findings: pick('find:').map((x) => this.db.get('SELECT id, pattern, title, status FROM cd_findings WHERE id=? AND workspace_id=?', x, ws)).filter(Boolean),
      path,
    };
  }
  /** Evidence chain for a finding: observation → system → time → workflow/resource → invariant → freshness → later invalidation → agent → approval → action → outcome. */
  evidenceChain(ws: string, id: string, findingId: string) {
    const c = this.campaign(ws, id);
    const f = this.db.get('SELECT * FROM cd_findings WHERE id=? AND campaign_id=? AND workspace_id=?', findingId, id, ws); if (!f) throw new EngineError(404, 'not_found', 'Finding not found.');
    const plans = this.db.all('SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at, rowid', id, ws);
    const wfs = this.wfs(c); const ops = this.ops(c); const ids = [id, ...wfs.map((w) => w.id)];
    const approvals = this.db.all(`SELECT * FROM rw_approvals WHERE workspace_id=? AND workflow_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, rowid`, ws, ...ids);
    const chain = j<string[]>(f.evidence, []).map((eid) => {
      const o = this.db.get('SELECT rowid AS r, * FROM rw_observations WHERE id=? AND workspace_id=?', eid, ws); if (!o) return { id: eid, missing: true };
      const ref = `${o.system}/${o.resource}`;
      const later = this.db.all(`SELECT id, observed_at, state_hash, available, purpose FROM rw_observations WHERE workspace_id=? AND workflow_id IN (${ids.map(() => '?').join(',')}) AND system=? AND resource=? AND rowid>? ORDER BY rowid`, ws, ...ids, o.system, o.resource, o.r);
      const changed = later.find((x) => x.state_hash !== o.state_hash);
      const usedBy = plans.filter((p) => Object.values(j<any>(p.basis, {}).refs ?? {}).some((b: any) => b.obsId === eid));
      const ownerWf = wfs.find((w) => w.id === o.workflow_id);
      const relied = approvals.filter((ap) => usedBy.some((p) => j<any[]>(p.options, []).some((opt) => opt.hash === ap.subject_hash)) || (ownerWf && ap.workflow_id === ownerWf.id && Object.values(ownerWf.basis as Record<string, any>).some((b: any) => b.obsId === eid)));
      const resulted = ops.filter((op) => `${op.system}/${op.resource}` === ref && op.attempts > 0 && op.updated_at >= o.observed_at);
      const finalVerify = later.filter((x) => ['cd-verify', 'cd-analysis'].includes(x.purpose)).pop();
      const invs = this.db.all('SELECT inv_key, name, last_result FROM cd_invariants WHERE campaign_id=? AND workspace_id=? AND resources LIKE ?', id, ws, `%"${ref}"%`);
      return {
        id: eid, observed: { state: j(o.state, null), available: !!o.available, stateHash: o.state_hash }, system: o.system, resource: o.resource, at: o.observed_at, observer: o.observer, observerName: agentById(o.observer)?.name ?? o.observer, purpose: o.purpose,
        workflow: ownerWf?.wf_key ?? '(campaign-wide read)', invariants: invs, freshAtDecision: !o.invalidated_at, invalidated: o.invalidated_reason, laterChange: changed ? { id: changed.id, at: changed.observed_at, purpose: changed.purpose } : null,
        usedByPlans: usedBy.map((p) => p.id), approvalsRelying: relied.map((ap) => ({ id: ap.id, by: ap.user_name, subject: ap.subject, status: ap.status, invalid: ap.invalid_reason })),
        resultingActions: resulted.map((op) => ({ op: `${wfs.find((w) => w.id === op.workflow_id)?.wf_key}:${op.op_key}`, status: op.status, idempotencyKey: op.idempotency_key })),
        finalVerification: finalVerify ? { id: finalVerify.id, at: finalVerify.observed_at, purpose: finalVerify.purpose, matchesThisRead: finalVerify.state_hash === o.state_hash, available: !!finalVerify.available } : null,
        sandbox: LAB_LABEL,
      };
    });
    return { finding: findingOut(f), chain };
  }
}

// ------------------------------------------------------------------ helpers
const FULL_CTL: CdCtl = cdControls(BASELINES['B4-resolve-full'].controls);
interface FindingIn { key: string; pattern: Pattern; invariantKey?: string; title: string; workflows: string[]; operations: string[]; domains: string[]; resources: string[]; intended: unknown; declared: unknown; observed: unknown; evidence: string[]; predecessors: string[]; severity: string; blast: unknown; confidence: number; uncertainty: string; explanation: string; recommendation: string; blocks: boolean; approvalRequired: string; status: string }

export function specReads(d: InvariantDef): string[] {
  const s = d.spec as any; const out: string[] = [];
  for (const k of ['ref', 'upstream', 'downstream', 'if', 'then', 'pointer']) if (s[k]?.system) out.push(`${s[k].system}/${s[k].resource}`);
  if (s.type === 'pack') for (const r of s.reads ?? []) out.push(`${r.system}/${r.resource}`);
  return [...new Set(out)];
}
function inferred(key: string, name: string, explanation: string, spec: InvariantDef['spec'], owner: string, severity: InvariantDef['severity']): InvariantDef {
  return { key, name, explanation, scope: 'workflow', owner, spec, severity, impact: severity === 'medium' ? 'Unbacked claims cannot be relied on' : 'The workflow acts on something that is no longer true', resolutionPolicy: 'Re-plan on fresh evidence or obtain fresh authority.', approvalLevel: 'manager', strength: 'hard', autoRestorable: false, provenance: { source: 'inferred', by: 'CDII planner (derived from the plan and its recorded evidence)' }, confidence: 1, uncertainty: 'Derived from recorded planning evidence and operation states.' };
}
/** Builds the concrete patch for an op from a fresh read (calendar slots are appended to what is actually there). */
export function materialize(op: OpDef, cur: ResourceState | undefined, cas: boolean): Patch {
  if (op.effect.kind === 'schedule' && op.effect.window) {
    const slots = [...(((cur?.slots as any[]) ?? [])), { holder: op.effect.holder, start: op.effect.window[0], end: op.effect.window[1], op: op.key }];
    return { set: { slots }, inc: { slot_count: 1 }, expect: cas ? { slot_count: Number(cur?.slot_count ?? 0) } : undefined };
  }
  return cas ? op.patch : { set: op.patch.set, inc: op.patch.inc };
}
function applyAlt(plan: PlanAction[], alt: Alternative): PlanAction[] {
  const out = [...plan];
  for (const a of alt.actions) {
    if (a.kind === 'add') { if (out.some((x) => x.workflow === a.workflow && x.op === a.op)) continue; const last = out.map((x) => x.workflow).lastIndexOf(a.workflow); out.splice(last >= 0 ? last + 1 : out.length, 0, a); continue; }
    const i = out.findIndex((x) => x.workflow === a.workflow && x.op === a.op);
    if (i >= 0) out[i] = a; else { const first = out.findIndex((x) => x.workflow === a.workflow); out.splice(first >= 0 ? first : out.length, 0, a); }
  }
  return out;
}
function strength(basis: Record<string, { hash: string | null; available: boolean }>) {
  const total = Object.keys(basis).length; const readable = Object.values(basis).filter((b) => b.available).length;
  return { readable, total, fresh: readable, score: total ? Math.round((readable / total) * 100) / 100 : 1 };
}
function dedupeNodes<T extends { id: string }>(nodes: T[]): T[] { const s = new Set<string>(); return nodes.filter((n) => (s.has(n.id) ? false : (s.add(n.id), true))); }
function invOut(r: Row) { return { id: r.id, key: r.inv_key, version: r.version, type: r.type, name: r.name, explanation: r.explanation, scope: r.scope, owner: r.owner_workflow, systems: j(r.systems, []), resources: j(r.resources, []), requiredEvidence: j(r.required_evidence, []), preconditions: j(r.preconditions, []), spec: j(r.spec, {}), severity: r.severity, impact: r.impact, validFrom: r.valid_from, validUntil: r.valid_until, resolutionPolicy: r.resolution_policy, approvalLevel: r.approval_level, strength: r.strength, autoRestorable: !!r.auto_restorable, provenance: j(r.provenance, {}), confidence: r.confidence, uncertainty: r.uncertainty, dependsOn: j(r.depends_on, []), result: r.last_result, evaluation: j(r.last_eval, null) }; }
function findingOut(f: Row) { return { ...f, label: PATTERN_LABELS[f.pattern as Pattern] ?? f.pattern, workflows: j(f.workflows, []), operations: j(f.operations, []), domains: j(f.domains, []), resources: j(f.resources, []), intended: j(f.intended, null), declared: j(f.declared, null), observed: j(f.observed, null), evidence: j(f.evidence, []), predecessors: j(f.predecessors, []), blast_radius: j(f.blast_radius, {}), blocks: !!f.blocks, hypothesis: !!f.hypothesis }; }
