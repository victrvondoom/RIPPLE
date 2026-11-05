import { Db, j, nowIso, sha256, stable, uid } from '../db/db.js';
import type { Fault, Patch, ResourceState } from './types.js';
import { recordCausalEvent } from '../engine/causal.js';

/**
 * REALITY LAB — a controlled, persisted sandbox of "external systems" (payments, bookings, deploy, health, warehouse…).
 * It is NOT a production integration and is labelled as such everywhere. It exists so that partial commits, lost
 * responses, false successes and drift can be produced deterministically and observed independently.
 *
 * Boundaries enforced here (not just by convention):
 *  - Each agent has a capability set. Only an executor bound to a system may write to it; verifiers/observers may only read.
 *  - Writes may carry an idempotency key (the system dedupes) and an `expect` clause (compare-and-set).
 *  - Every applied or refused write is appended to lab_effects (the ground-truth effect log used by the RIGOR scorer).
 *  - `truth()` bypasses injected read faults; only the benchmark scorer calls it, never the engine.
 */
/** The lifecycle point at which each fault kind activates (used to label timeline events). */
export const FAULT_TRIGGER: Record<string, string> = {
  timeout_after_commit: 'system accepted the write, acknowledgement lost', timeout_before_commit: 'write attempt, before commit',
  false_success: 'write attempt (tool reports success)', unavailable: 'write attempt (service down)', observe_unavailable: 'independent read',
  delayed_consistency: 'after commit, during read-after-write', handoff_duplicate: 'hand-off redelivery', handoff_lost: 'hand-off delivered, before acknowledgement',
  compensation_fails: 'compensation write',
};
export const LAB_LABEL ='Controlled sandbox system (Reality Lab) — not a production integration';

export interface AgentDef { id: string; name: string; role: string; observe: boolean; mutate: string[]; duty: string }
const exec = (system: string, name: string): AgentDef => ({ id: `exec.${system}`, name, role: 'Executor', observe: false, mutate: [system], duty: `Performs authorized writes to the ${system} system only, with idempotency keys and checkpoints.` });
export const AGENTS: AgentDef[] = [
  { id: 'planner', name: 'Planner', role: 'Planner', observe: true, mutate: [], duty: 'Turns intent into an execution contract: steps, preconditions, invariants, approvals required.' },
  { id: 'observer', name: 'Observer', role: 'Observer', observe: true, mutate: [], duty: 'Reads external systems independently. Never writes.' },
  { id: 'investigator', name: 'Investigator', role: 'Investigator', observe: true, mutate: [], duty: 'Reconstructs the causal chain of a gap and lists what is still unknown.' },
  { id: 'verifier', name: 'Verifier', role: 'Verifier', observe: true, mutate: [], duty: 'Checks post-conditions and invariants against independent reads. Never trusts a tool response.' },
  { id: 'recovery', name: 'Recovery Planner', role: 'Recovery', observe: true, mutate: [], duty: 'Proposes and simulates recovery options. Cannot execute them.' },
  { id: 'governance', name: 'Governance', role: 'Governance', observe: false, mutate: [], duty: 'Enforces roles, plan-bound approvals, two-person rules, expiry and policy.' },
  { id: 'adversary', name: 'Adversarial Reviewer', role: 'Adversarial Reviewer', observe: true, mutate: [], duty: 'Challenges evidence, assumptions and recovery proposals before consequential decisions.' },
  { id: 'memory', name: 'Memory', role: 'Memory', observe: false, mutate: [], duty: 'Keeps durable, evidence-backed decisions and constraints; treats message text as data, never as authority.' },
  exec('payments', 'Payments agent'), exec('bookings', 'Booking agent'), exec('inventory', 'Inventory agent'),
  exec('orders', 'Order agent'), exec('notifications', 'Messaging agent'), exec('deploy', 'Release agent'),
  exec('warehouse', 'Data agent'), exec('production', 'Production agent'), exec('tasks', 'Task agent'),
  exec('itinerary', 'Itinerary agent'), exec('budget', 'Budget agent'), exec('knowledge', 'Knowledge agent'),
  exec('reservations', 'Reservation agent'), exec('ledger', 'Finance agent'),
  // Cross-Domain Invariant Intelligence (session 9): executors for the extra sandbox systems + two read-only agents.
  exec('analytics', 'Analytics agent'), exec('procurement', 'Procurement agent'), exec('scheduling', 'Scheduling agent'), exec('shipping', 'Shipping agent'),
  { id: 'intersection', name: 'Intersection Analyst', role: 'Cross-Domain Analyst', observe: true, mutate: [], duty: 'Evaluates every workflow against shared invariants, other workflows, pending approvals and fresh evidence. Never writes.' },
  { id: 'arbiter', name: 'Cross-Domain Arbiter', role: 'Arbiter', observe: true, mutate: [], duty: 'Builds and simulates candidate resolution plans against the shared invariant set. Proposes; never executes or approves.' },
];
export const agentById = (id: string): AgentDef | undefined => AGENTS.find((a) => a.id === id);

export class LabError extends Error { constructor(public code: 'timeout' | 'unavailable' | 'forbidden' | 'conflict', message: string) { super(message); } }
export interface LabWrite { ok: true; receipt: string; version: number; deduped: boolean }
export interface LabRead { state: ResourceState; version: number; updated_by: string }
interface FaultState { faults: (Fault & { remaining: number })[]; blocked: Record<string, number> }

export function applyPatch(state: ResourceState, patch: Patch): ResourceState {
  const next: ResourceState = { ...state, ...(patch.set ?? {}) };
  for (const [k, n] of Object.entries(patch.inc ?? {})) next[k] = Number(next[k] ?? 0) + n;
  return next;
}

/** Where a sandbox world keeps its injected-fault state: one reality workflow, or one cross-domain campaign (a shared world). */
export type FaultHost = 'rw_workflows' | 'cd_campaigns';

export class Lab {
  /** `wf` keys the sandbox world. For cross-domain campaigns several workflows share one world keyed by the campaign id. */
  constructor(private db: Db, private ws: string, private wf: string, private faultHost: FaultHost = 'rw_workflows') {}

  static seed(db: Db, ws: string, wf: string, initial: { system: string; resource: string; state: ResourceState }[], faults: Fault[], host: FaultHost = 'rw_workflows') {
    for (const r of initial) db.insert('lab_resources', { id: uid('lr'), workspace_id: ws, workflow_id: wf, system: r.system, resource: r.resource, state: JSON.stringify(r.state), version: 1, updated_by: 'seed', lag: null, updated_at: nowIso() });
    const fs: FaultState = { faults: faults.map((f) => ({ ...f, remaining: f.times ?? 1 })), blocked: {} };
    db.exec(`UPDATE ${host === 'cd_campaigns' ? 'cd_campaigns' : 'rw_workflows'} SET fault_state=? WHERE id=? AND workspace_id=?`, JSON.stringify(fs), wf, ws);
  }

  private get host() { return this.faultHost === 'cd_campaigns' ? 'cd_campaigns' : 'rw_workflows'; }
  private fs(): FaultState { return j<FaultState>(this.db.get(`SELECT fault_state FROM ${this.host} WHERE id=? AND workspace_id=?`, this.wf, this.ws)?.fault_state, { faults: [], blocked: {} }); }
  private saveFs(fs: FaultState) { this.db.exec(`UPDATE ${this.host} SET fault_state=? WHERE id=? AND workspace_id=?`, JSON.stringify(fs), this.wf, this.ws); }
  /** Consumes one matching fault (by operation key, or by system for system-wide faults). */
  takeFault(opKey: string, system: string, kinds: Fault['kind'][]): Fault | null {
    const fs = this.fs();
    const f = fs.faults.find((x) => x.remaining > 0 && kinds.includes(x.kind) && (x.step ? x.step === opKey : x.system === system));
    if (!f) return null;
    f.remaining -= 1; this.saveFs(fs);
    // Every activation is an observable, ordered event in the causal ledger (keyed by workflow id).
    recordCausalEvent(this.db, { workspaceId: this.ws, missionId: this.wf, causeType: 'fault_injection', lifecycleState: 'FAULT_INJECTED', summary: `Injected fault activated: ${f.label}`, actor: 'reality-lab', observedState: { label: f.label, kind: f.kind, opKey, system, trigger: FAULT_TRIGGER[f.kind] } });
    return f;
  }
  private row(system: string, resource: string) { return this.db.get('SELECT * FROM lab_resources WHERE workflow_id=? AND workspace_id=? AND system=? AND resource=?', this.wf, this.ws, system, resource); }
  private effect(system: string, resource: string, opKey: string, idem: string | null, actor: string, patch: Patch, applied: boolean, note: string) {
    const seq = (this.db.get<{ n: number }>('SELECT count(*) n FROM lab_effects WHERE workflow_id=? AND workspace_id=?', this.wf, this.ws)?.n ?? 0) + 1;
    this.db.insert('lab_effects', { id: uid('le'), workspace_id: this.ws, workflow_id: this.wf, seq, system, resource, op_key: opKey, idem_key: idem, actor, patch: JSON.stringify(patch), applied: applied ? 1 : 0, note, created_at: nowIso() });
  }
  private apply(system: string, resource: string, patch: Patch, actor: string, lagReads = 0) {
    const r = this.row(system, resource);
    const prev = j<ResourceState>(r?.state, {});
    const next = applyPatch(prev, { set: patch.set, inc: patch.inc });
    const lag = lagReads ? JSON.stringify({ state: prev, version: r?.version ?? 0, updated_by: r?.updated_by ?? 'none', remaining: lagReads }) : null;
    if (r) this.db.exec('UPDATE lab_resources SET state=?, version=version+1, updated_by=?, lag=?, updated_at=? WHERE id=?', JSON.stringify(next), actor, lag, nowIso(), r.id);
    else this.db.insert('lab_resources', { id: uid('lr'), workspace_id: this.ws, workflow_id: this.wf, system, resource, state: JSON.stringify(next), version: 1, updated_by: actor, lag, updated_at: nowIso() });
    return (r?.version ?? 0) + 1;
  }

  /** A write by an agent. Capability check, idempotency, compare-and-set and fault injection happen here. */
  mutate(agentId: string, opKey: string, system: string, resource: string, patch: Patch, idem: string | null): LabWrite {
    const agent = agentById(agentId);
    if (!agent || !agent.mutate.includes(system)) throw new LabError('forbidden', `Agent "${agentId}" has no write capability on ${system}.`);
    if (idem) {
      const prior = this.db.get('SELECT 1 x FROM lab_effects WHERE workflow_id=? AND workspace_id=? AND system=? AND idem_key=? AND applied=1', this.wf, this.ws, system, idem);
      if (prior) { this.effect(system, resource, opKey, idem, agentId, patch, false, 'deduped by idempotency key'); return { ok: true, receipt: `rcpt_${sha256(idem).slice(0, 10)}`, version: this.row(system, resource)?.version ?? 0, deduped: true }; }
    }
    const fault = this.takeFault(opKey, system, ['timeout_after_commit', 'timeout_before_commit', 'false_success', 'unavailable', 'delayed_consistency', 'compensation_fails']);
    if (fault?.kind === 'timeout_before_commit') { this.effect(system, resource, opKey, idem, agentId, patch, false, `timeout before commit (injected: ${fault.label})`); throw new LabError('timeout', `${system}: request timed out (injected: ${fault.label}).`); }
    if (fault?.kind === 'unavailable') {
      const fs = this.fs(); fs.blocked[system] = (fs.blocked[system] ?? 0) + (fault.reads ?? 3); this.saveFs(fs);
      this.effect(system, resource, opKey, idem, agentId, patch, false, `system unavailable (injected: ${fault.label})`);
      throw new LabError('unavailable', `${system}: service unavailable (injected: ${fault.label}).`);
    }
    if (fault?.kind === 'false_success' || fault?.kind === 'compensation_fails') {
      this.effect(system, resource, opKey, idem, agentId, patch, false, `no effect (injected: ${fault.label})`);
      return { ok: true, receipt: `rcpt_${uid('x').slice(2, 12)}`, version: this.row(system, resource)?.version ?? 0, deduped: false };
    }
    if (patch.expect) {
      const cur = j<ResourceState>(this.row(system, resource)?.state, {});
      const bad = Object.entries(patch.expect).filter(([k, v]) => (cur[k] ?? null) !== v);
      if (bad.length) { this.effect(system, resource, opKey, idem, agentId, patch, false, 'conditional write rejected'); throw new LabError('conflict', `${system}/${resource}: conditional write rejected (${bad.map(([k]) => `${k} is ${JSON.stringify(cur[k] ?? null)}`).join(', ')}).`); }
    }
    const version = this.apply(system, resource, patch, agentId, fault?.kind === 'delayed_consistency' ? (fault.reads ?? 2) : fault?.kind === 'timeout_after_commit' ? (fault.reads ?? 0) : 0);
    this.effect(system, resource, opKey, idem, agentId, patch, true, fault ? `applied (${fault.label})` : 'applied');
    if (fault?.kind === 'timeout_after_commit') throw new LabError('timeout', `${system}: request timed out after the write (injected: ${fault.label}).`);
    return { ok: true, receipt: `rcpt_${sha256(`${this.wf}|${opKey}|${version}`).slice(0, 10)}`, version, deduped: false };
  }

  /** The outside world changing state (a cancellation, an operator, drift). Recorded with its real actor. */
  external(system: string, resource: string, patch: Patch, actor: string, opKey: string) {
    this.apply(system, resource, patch, actor);
    this.effect(system, resource, opKey, null, actor, patch, true, 'external change');
  }

  /** An independent read. Subject to injected read faults (unavailability, replication lag). */
  observe(agentId: string, system: string, resource: string): LabRead {
    const agent = agentById(agentId);
    if (!agent?.observe) throw new LabError('forbidden', `Agent "${agentId}" has no read capability.`);
    const fs = this.fs();
    if ((fs.blocked[system] ?? 0) > 0) { fs.blocked[system] -= 1; this.saveFs(fs); throw new LabError('unavailable', `${system}: read failed (service unavailable).`); }
    const wrote = !!this.db.get('SELECT 1 x FROM lab_effects WHERE workflow_id=? AND workspace_id=? AND system=? AND actor LIKE ?', this.wf, this.ws, system, 'exec.%');
    const pending = fs.faults.find((x) => x.remaining > 0 && x.kind === 'observe_unavailable' && x.system === system);
    const ro = pending && (!pending.afterWrite || wrote) ? this.takeFault(`observe:${system}`, system, ['observe_unavailable']) : null;
    if (ro) { const f2 = this.fs(); f2.blocked[system] = Math.max(0, (ro.reads ?? 1) - 1); this.saveFs(f2); throw new LabError('unavailable', `${system}: read failed (injected: ${ro.label}).`); }
    const r = this.row(system, resource);
    if (!r) return { state: {}, version: 0, updated_by: 'none' };
    const lag = j<any>(r.lag, null);
    if (lag && lag.remaining > 0) {
      lag.remaining -= 1;
      this.db.exec('UPDATE lab_resources SET lag=? WHERE id=?', lag.remaining > 0 ? JSON.stringify(lag) : null, r.id);
      recordCausalEvent(this.db, { workspaceId: this.ws, missionId: this.wf, causeType: 'fault_injection', lifecycleState: 'FAULT_INJECTED', summary: `Injected fault activated: stale replica read of ${system}/${resource} (replication lag, ${lag.remaining} more)`, actor: 'reality-lab', observedState: { label: 'stale replica read', kind: 'replication_lag', system, resource, trigger: 'read-after-write' } });
      return { state: lag.state, version: lag.version, updated_by: lag.updated_by };
    }
    return { state: j(r.state, {}), version: r.version, updated_by: r.updated_by };
  }

  /** Ground truth for the scorer (bypasses read faults). Never used for engine decisions. */
  truth(system: string, resource: string): ResourceState | undefined { const r = this.row(system, resource); return r ? j(r.state, {}) : undefined; }
  effects() { return this.db.all('SELECT * FROM lab_effects WHERE workflow_id=? AND workspace_id=? ORDER BY seq', this.wf, this.ws); }
  resources() { return this.db.all('SELECT system, resource, state, version, updated_by, updated_at FROM lab_resources WHERE workflow_id=? AND workspace_id=? ORDER BY system, resource', this.wf, this.ws).map((r) => ({ ...r, state: j(r.state, {}) })); }
}
export const stateHash = (s: unknown) => sha256(stable(s)).slice(0, 16);
