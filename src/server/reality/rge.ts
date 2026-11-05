import { j, nowIso, sha256, stable, uid, type Row } from '../db/db.js';
import type { Actor, Engine } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { recordCausalEvent, type CauseType, type CausalLifecycleState } from '../engine/causal.js';
import { instructionLikeText } from '../packs/untrusted.js';
import type { RoomInfo } from '../collab/port.js';
import { assertMove, type RState } from './states.js';
import { AGENTS, agentById, applyPatch, Lab, LabError, LAB_LABEL, stateHash } from './lab.js';
import { scenarioById, watchedResources } from './scenarios.js';
import { BASELINES, GAP_LABELS, type Controls, type GapClass, type Patch, type Reader, type ResourceState, type Scenario, type StepDef } from './types.js';

/**
 * REALITY GAP ENGINE.
 * Compares three independent layers for every consequential workflow:
 *   intended  — the execution contract (steps, post-conditions, cross-system invariants, approvals)
 *   declared  — what agents and tools said happened (tool responses, agent claims)
 *   observed  — what independent reads of the (sandbox) external systems show
 * and classifies every disagreement as a structured, persisted gap. Recovery is planned counterfactually
 * (simulated on the observed state), approved by a human bound to the plan hash, executed with guarded writes
 * and verified again. Nothing here trusts a tool response or an agent claim as proof.
 */

const APPROVAL_TTL_MS = 15 * 60_000;
const EVIDENCE_TTL_MS = 10 * 60_000;
const MAX_READS = 3;
const MAX_RECOVERY_ATTEMPTS = 3;

export interface RunHooks {
  /** Scoring-only hook (RIGOR). Called when a step with a precondition is decided. It cannot influence the run. */
  decision?(step: StepDef, executed: boolean): void;
}
type Snap = Record<string, { available: boolean; state: ResourceState; updated_by: string; obsId: string }>;
interface Contract {
  intent: string; steps: StepDef[]; invariants: { id: string; label: string }[]; approval: Scenario['approval'];
  amendments: Record<string, unknown>[]; messages: { body: string; flags: string[] }[];
  causalRoot?: string; timing?: { detectedAt?: number; recoveredAt?: number };
}
const k = (s: string, r: string) => `${s}/${r}`;
const FORWARD = "kind='forward'";

export class RealityEngine {
  constructor(public engine: Engine) {}
  get db() { return this.engine.db; }

  // ------------------------------------------------------------------ basics
  wf(ws: string, id: string): Row {
    const w = this.db.get('SELECT * FROM rw_workflows WHERE id=? AND workspace_id=?', id, ws);
    if (!w) throw new EngineError(404, 'not_found', 'Reality workflow not found.');
    return w;
  }
  scenario(w: Row): Scenario { const s = scenarioById(w.scenario); if (!s) throw new EngineError(500, 'no_scenario', `Scenario ${w.scenario} is not installed.`); return s; }
  contract(w: Row): Contract { return j<Contract>(w.contract, {}); }
  controls(w: Row): Controls { return j<Controls>(w.controls, BASELINES['B4-resolve-full'].controls); }
  private saveContract(w: Row, c: Contract) { this.db.exec('UPDATE rw_workflows SET contract=?, updated_at=? WHERE id=? AND workspace_id=?', JSON.stringify(c), nowIso(), w.id, w.workspace_id); w.contract = JSON.stringify(c); }
  private planHash(w: Row, c: Contract) { return sha256(stable({ scenario: w.scenario, steps: c.steps, approval: c.approval, amendments: c.amendments })); }
  private audit(w: Row, actor: string, type: string, summary: string, data: unknown = {}) { this.engine.audit(w.workspace_id, w.id, AGENTS.some((a) => a.id === actor) || ['ripple-rge', 'world'].includes(actor) ? 'agent' : 'user', actor, `rge_${type}`, summary, data); }
  private causal(w: Row, cause: CauseType, state: CausalLifecycleState, summary: string, actor: string, parent: string | null, observed: Record<string, unknown> = {}, idem?: string | null) {
    return recordCausalEvent(this.db, { workspaceId: w.workspace_id, missionId: w.id, parentEventId: parent, causeType: cause, lifecycleState: state, summary, actor, observedState: observed, idempotencyKey: idem ?? null }).id;
  }
  private move(w: Row, to: RState, reason: string, actor = 'ripple-rge') {
    const from = w.state as RState; assertMove(from, to);
    if (from === to) { this.db.exec('UPDATE rw_workflows SET state_reason=?, updated_at=? WHERE id=?', reason, nowIso(), w.id); w.state_reason = reason; return; }
    this.db.exec('UPDATE rw_workflows SET state=?, state_reason=?, updated_at=? WHERE id=? AND workspace_id=?', to, reason, nowIso(), w.id, w.workspace_id);
    this.audit(w, actor, 'state', `${from} → ${to}: ${reason}`, { from, to });
    w.state = to; w.state_reason = reason;
  }
  private moveOp(op: Row, to: RState, patch: Record<string, unknown> = {}) {
    assertMove(op.state as RState, to);
    this.db.update('rw_operations', op.id, op.workspace_id, { state: to, ...patch, updated_at: nowIso() });
    Object.assign(op, patch, { state: to });
  }
  private async room(w: Row): Promise<RoomInfo | null> {
    if (w.source !== 'live') return null;
    try { return await this.engine.collab.openRoom({ missionId: w.id, title: w.title, topic: w.intent, agentRoles: AGENTS.map((a) => ({ key: a.id, name: a.name })) }); } catch { return null; }
  }
  /** Mirrors a hand-off/decision to the collaboration port (Switch when configured; labelled local mode otherwise). */
  private async tell(w: Row, kind: 'handoff' | 'finding' | 'decision' | 'status' | 'escalation' | 'approval_request', from: string, to: string | undefined, body: string) {
    if (w.source !== 'live') return;
    const room = await this.room(w);
    if (!room) return;
    try { await this.engine.collab.send(room, { kind, senderKey: from, senderName: agentById(from)?.name ?? from, toKey: to, toName: to ? agentById(to)?.name ?? to : undefined, body }); }
    catch (e) { this.db.exec('UPDATE rw_workflows SET collab_note=? WHERE id=?', `Collaboration send failed: ${String((e as Error).message)}`, w.id); }
  }
  userByHandle(ws: string, handle: string): Row | undefined { return this.db.get('SELECT * FROM users WHERE workspace_id=? AND lower(email) LIKE ?', ws, `${handle.toLowerCase()}@%`); }
  private effectiveRole(w: Row, userId: string | null, fallback: string): string {
    if (!userId) return fallback;
    const ov = j<Record<string, string>>(w.authz_overrides, {});
    if (ov[userId]) return ov[userId];
    return this.db.get('SELECT role FROM users WHERE id=? AND workspace_id=?', userId, w.workspace_id)?.role ?? 'none';
  }

  // ------------------------------------------------------------------ creation (Planner)
  async create(a: Actor, scenarioId: string, opts: { baseline?: string; source?: 'live' | 'benchmark'; benchRunId?: string; seed?: string } = {}) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot start workflows.');
    const s = scenarioById(scenarioId); if (!s) throw new EngineError(404, 'not_found', `Unknown scenario "${scenarioId}".`);
    const baseline = opts.baseline ?? 'B4-resolve-full'; const b = BASELINES[baseline]; if (!b) throw new EngineError(422, 'bad_baseline', `Unknown baseline "${baseline}".`);
    const source = opts.source ?? 'live';
    if (source === 'live') this.engine.require(a, 'owner', 'manager');
    const c: Contract = { intent: s.intent, steps: s.steps, invariants: s.invariants.map((i) => ({ id: i.id, label: i.label })), approval: s.approval, amendments: [], messages: [] };
    const id = uid('rw');
    const w: Row = { id, workspace_id: a.workspaceId, scenario: s.id, family: s.family, title: s.title, intent: s.intent, contract: JSON.stringify(c), plan_version: 1, plan_hash: '', state: 'PLANNED', state_reason: 'Execution contract drafted by the Planner.', declared_status: null, observed_status: null, controls: JSON.stringify(b.controls), baseline, source, bench_run_id: opts.benchRunId ?? null, seed: opts.seed ?? 'live', fault_state: '{}', authz_overrides: '{}', collab_mode: this.engine.collab.mode, collab_note: this.engine.collab.describe().detail, created_by: a.id, created_at: nowIso(), updated_at: nowIso() };
    w.plan_hash = this.planHash(w, c);
    this.db.insert('rw_workflows', w);
    Lab.seed(this.db, a.workspaceId, id, s.initial, s.faults);
    c.causalRoot = this.causal(w, 'agent_inference', 'PLANNED', `Planner: execution contract for "${s.intent}" (${s.steps.length} steps, ${s.invariants.length} invariants)`, 'planner', null, { planHash: w.plan_hash, baseline });
    // Memory agent ingests stored messages as DATA: instruction-like text is flagged and never treated as authority.
    for (const ev of (s.events ?? []).filter((e) => e.kind === 'message')) c.messages.push({ body: ev.body ?? '', flags: instructionLikeText(ev.body ?? '') });
    this.saveContract(w, c);
    // Planning-time evidence for preconditions (mutable; expires).
    const lab = new Lab(this.db, a.workspaceId, id);
    for (const st of s.steps.filter((x) => x.precondition)) this.observe(w, lab, 'planner', st.precondition!.system, st.precondition!.resource, 'planning', null);
    if (source === 'live') {
      const room = await this.room(w);
      this.db.exec('UPDATE rw_workflows SET collab_mode=?, collab_note=? WHERE id=?', room?.mode ?? this.engine.collab.mode, room?.note ?? this.engine.collab.describe().detail, id);
      await this.tell(w, 'approval_request', 'planner', 'governance', `Execution contract ready: ${s.steps.map((x) => x.label).join(' → ')}. ${s.approval.role} approval${s.approval.twoPerson ? ' from two distinct people' : ''} required, bound to plan hash ${w.plan_hash.slice(0, 12)}.`);
    }
    this.move(w, 'AUTHORIZATION_PENDING', `Waiting for ${s.approval.role} approval${s.approval.twoPerson ? ' (two distinct approvers)' : ''} bound to plan v1.`, 'planner');
    this.audit(w, a.name, 'created', `Reality workflow "${s.title}" created (${baseline}, ${source}).`);
    return this.wf(a.workspaceId, id);
  }

  // ------------------------------------------------------------------ evidence
  private observe(w: Row, lab: Lab, observer: string, system: string, resource: string, purpose: string, opId: string | null) {
    const id = uid('ob'); let at: string;
    try {
      const r = lab.observe(observer, system, resource);
      at = nowIso(); // timestamp the observation when its result is known (keeps timeline order after any fault event)
      this.db.insert('rw_observations', { id, workspace_id: w.workspace_id, workflow_id: w.id, operation_id: opId, purpose, system, resource, observer, available: 1, state: JSON.stringify(r.state), state_hash: stateHash(r.state), updated_by: r.updated_by, policy: 'mutable', observed_at: at, valid_until: new Date(Date.now() + EVIDENCE_TTL_MS).toISOString(), invalidated_at: null, invalidated_reason: null });
      return { id, available: true as const, state: r.state, updated_by: r.updated_by, at, error: '' };
    } catch (e) {
      at = nowIso();
      this.db.insert('rw_observations', { id, workspace_id: w.workspace_id, workflow_id: w.id, operation_id: opId, purpose, system, resource, observer, available: 0, state: null, state_hash: null, updated_by: null, policy: 'mutable', observed_at: at, valid_until: at, invalidated_at: null, invalidated_reason: `unreadable: ${String((e as Error).message)}` });
      return { id, available: false as const, state: {} as ResourceState, updated_by: '', at, error: String((e as Error).message) };
    }
  }
  private latestObs(w: Row, system: string, resource: string, purpose?: string) {
    return this.db.get(`SELECT * FROM rw_observations WHERE workflow_id=? AND workspace_id=? AND system=? AND resource=?${purpose ? ' AND purpose=?' : ''} ORDER BY observed_at DESC, rowid DESC`, w.id, w.workspace_id, system, resource, ...(purpose ? [purpose] : []));
  }
  private snapshot(w: Row, lab: Lab, purpose = 'reconcile'): Snap {
    const s = this.scenario(w); const snap: Snap = {};
    for (const r of watchedResources(s)) {
      let o = this.observe(w, lab, 'observer', r.system, r.resource, purpose, null);
      for (let i = 1; i < MAX_READS && !o.available; i++) o = this.observe(w, lab, 'observer', r.system, r.resource, purpose, null);
      snap[k(r.system, r.resource)] = { available: o.available, state: o.state, updated_by: o.updated_by, obsId: o.id };
    }
    return snap;
  }
  private reader(snap: Snap): Reader { return (s, r) => (snap[k(s, r)]?.available ? snap[k(s, r)].state : undefined); }
  private expects(step: StepDef, state: ResourceState | undefined) {
    return step.expect.map((e) => {
      const got = state?.[e.field];
      const counter = !!step.patch.inc && e.field in step.patch.inc; // only incremented counters can show a duplicate
      const dup = counter && typeof e.equals === 'number' && typeof got === 'number' && got > e.equals;
      return { label: e.label, field: e.field, want: e.equals, got: got ?? null, ok: state !== undefined && got === e.equals, duplicate: dup };
    });
  }
  private evalInvariants(w: Row, read: Reader) {
    return this.scenario(w).invariants.map((i) => {
      const touched: string[] = []; let unknown = false;
      const tracking: Reader = (s, r) => { touched.push(k(s, r)); const v = read(s, r); if (v === undefined) unknown = true; return v; };
      const res = i.eval(tracking);
      const missing = [...new Set(touched)].filter((t) => { const [s, r] = t.split('/'); return read(s, r) === undefined; });
      return { id: i.id, label: i.label, ok: !unknown && res.ok, unknown, detail: unknown ? `cannot evaluate: ${missing.join(', ')} unreadable` : res.detail, reads: [...new Set(touched)] };
    });
  }

  // ------------------------------------------------------------------ governance
  recordApproval(a: Actor | null, w: Row, subject: 'plan' | 'recovery', opts: { channel?: 'structured' | 'message'; strict?: boolean; userHandle?: string } = {}) {
    const channel = opts.channel ?? 'structured';
    const user = a ? this.db.get('SELECT * FROM users WHERE id=? AND workspace_id=?', a.id, w.workspace_id) : opts.userHandle ? this.userByHandle(w.workspace_id, opts.userHandle) : undefined;
    if (opts.strict) {
      if (!user) throw new EngineError(403, 'forbidden', 'Approvals must come from an authenticated user.');
      const need = subject === 'plan' ? this.contract(w).approval.role : 'manager';
      const role = this.effectiveRole(w, user.id, user.role);
      if (!(need === 'owner' ? role === 'owner' : ['owner', 'manager'].includes(role))) throw new EngineError(403, 'forbidden', `Only a ${need === 'owner' ? 'workspace owner' : 'manager or owner'} can approve this ${subject}.`);
      if (subject === 'plan' && w.state !== 'AUTHORIZATION_PENDING') throw new EngineError(409, 'bad_state', `Plan approvals are recorded while the workflow is AUTHORIZATION_PENDING (it is ${w.state}).`);
    }
    let hash = w.plan_hash;
    if (subject === 'recovery') {
      const plan = this.db.get('SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC', w.id, w.workspace_id);
      if (!plan) throw new EngineError(409, 'no_plan', 'There is no recovery plan to approve.');
      if (!plan.chosen) throw new EngineError(409, 'no_choice', 'Choose a recovery option before approving it.');
      hash = plan.plan_hash;
    }
    const id = uid('rap');
    this.db.insert('rw_approvals', { id, workspace_id: w.workspace_id, workflow_id: w.id, subject, subject_hash: hash, plan_version: w.plan_version, user_id: user?.id ?? null, user_name: user?.name ?? 'external text (unauthenticated)', role_at_decision: user ? this.effectiveRole(w, user.id, user.role) : 'none', channel, status: 'recorded', invalid_reason: null, created_at: nowIso(), expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() });
    this.causal(w, 'governance', 'AUTHORIZED', `${channel === 'message' ? 'Text in a stored message claims' : `${user?.name} recorded`} ${subject} approval (bound to hash ${hash.slice(0, 10)})`, user?.name ?? 'external', this.contract(w).causalRoot ?? null, { approvalId: id, channel });
    this.audit(w, user?.name ?? 'external', 'approval', `${subject} approval recorded via ${channel} by ${user?.name ?? 'unauthenticated text'}`, { id });
    return id;
  }
  /** Amends the execution contract: plan version and hash change, so approvals of earlier versions stop authorizing it. Idempotent per amendment. */
  amendPlan(w: Row, amend: Record<string, unknown>, label: string) {
    const c = this.contract(w);
    if (c.amendments.some((x) => stable(x) === stable(amend))) return false;
    c.amendments.push(amend); this.saveContract(w, c);
    const ph = this.planHash(w, c);
    this.db.exec('UPDATE rw_workflows SET plan_version=plan_version+1, plan_hash=? WHERE id=?', ph, w.id); w.plan_version += 1; w.plan_hash = ph;
    this.audit(w, 'planner', 'plan_amended', `Plan amended (${label}); now v${w.plan_version}. Approvals of earlier versions no longer authorize it.`);
    this.causal(w, 'fault_injection', 'FAULT_INJECTED', `Injected: ${label} (plan now v${w.plan_version})`, 'world', c.causalRoot ?? null, { label, kind: 'amend_plan', trigger: 'after approval, before execution' });
    return true;
  }
  /** Adversarial harness: a permission change for one user, scoped to this workflow (the users table is not touched). */
  revokeAuthority(w: Row, handle: string, role: string, label: string) {
    const u = this.userByHandle(w.workspace_id, handle); if (!u) throw new EngineError(404, 'not_found', `No user "${handle}" in this workspace.`);
    const ov = j<Record<string, string>>(w.authz_overrides, {}); ov[u.id] = role; w.authz_overrides = JSON.stringify(ov);
    this.db.exec('UPDATE rw_workflows SET authz_overrides=? WHERE id=? AND workspace_id=?', w.authz_overrides, w.id, w.workspace_id);
    this.audit(w, 'world', 'authority_changed', `${u.name} is now "${role}" for this workflow (${label})`);
    this.causal(w, 'fault_injection', 'FAULT_INJECTED', `Injected: ${label}`, 'world', this.contract(w).causalRoot ?? null, { label, kind: 'authority_revoked', trigger: 'after approval, before execution' });
  }
  /** Adversarial harness: an outside change to a sandbox resource at a named lifecycle point (recorded in the causal ledger). */
  injectExternal(w: Row, system: string, resource: string, patch: Patch, actor: string, label: string, trigger: string) {
    new Lab(this.db, w.workspace_id, w.id).external(system, resource, patch, actor, `arena:${trigger}`);
    this.audit(w, 'world', 'external_event', `External event (${trigger}): ${label}`);
    this.causal(w, 'fault_injection', 'FAULT_INJECTED', `Injected: ${label}`, actor, this.contract(w).causalRoot ?? null, { label, kind: 'external_change', trigger });
  }
  /**
   * Adversarial harness only (Compound Failure Arena): re-submits an EARLIER approval record verbatim (same bound hash,
   * same user). It is stored with channel 'replay' so governance can see it is not a fresh, authenticated decision.
   */
  replayApproval(w: Row, approvalId: string) {
    const old = this.db.get('SELECT * FROM rw_approvals WHERE id=? AND workflow_id=? AND workspace_id=?', approvalId, w.id, w.workspace_id);
    if (!old) throw new EngineError(404, 'not_found', 'Approval to replay not found.');
    const id = uid('rap');
    this.db.insert('rw_approvals', { ...old, id, channel: 'replay', status: 'recorded', invalid_reason: null, created_at: nowIso() });
    this.causal(w, 'fault_injection', 'FAULT_INJECTED', `Injected: replay of approval ${approvalId} (bound to ${String(old.subject_hash).slice(0, 10)})`, 'adversary', this.contract(w).causalRoot ?? null, { label: 'stale approval replayed', kind: 'approval_replay', trigger: 'before execution' });
    return id;
  }
  /** A workflow refused ONLY for authorization (nothing executed) may return to AUTHORIZATION_PENDING for a fresh approval. */
  reauthorize(a: Actor, wfId: string, opts: { lenient?: boolean } = {}) {
    if (!opts.lenient) this.engine.require(a, 'owner', 'manager');
    const w = this.wf(a.workspaceId, wfId);
    if (w.state !== 'REQUIRES_HUMAN') throw new EngineError(409, 'bad_state', `Only a workflow in REQUIRES_HUMAN can be re-authorized (it is ${w.state}).`);
    const executed = this.db.get("SELECT 1 x FROM rw_operations WHERE workflow_id=? AND workspace_id=? AND attempts>0", w.id, w.workspace_id);
    const gaps = this.db.all("SELECT class FROM rw_gaps WHERE workflow_id=? AND workspace_id=? AND status IN ('open','prevented')", w.id, w.workspace_id);
    if (executed || !gaps.length || gaps.some((g) => g.class !== 'authorization_invalid')) throw new EngineError(409, 'not_reauthorizable', 'Re-authorization is only possible when execution was refused for authorization reasons and nothing ran.');
    this.db.exec("UPDATE rw_approvals SET status='superseded', invalid_reason='superseded by re-authorization' WHERE workflow_id=? AND workspace_id=? AND subject='plan' AND status='recorded'", w.id, w.workspace_id);
    this.db.exec("DELETE FROM rw_operations WHERE workflow_id=? AND workspace_id=? AND attempts=0 AND state='REQUIRES_HUMAN'", w.id, w.workspace_id);
    this.move(w, 'AUTHORIZATION_PENDING', `Re-authorization requested by ${a.name}: a fresh approval of plan v${w.plan_version} is required.`, a.name);
    this.db.exec('UPDATE rw_workflows SET declared_status=NULL WHERE id=?', w.id);
    return this.detail(a.workspaceId, w.id);
  }
  /** Governance agent. With `strict` every rule applies regardless of the workflow's controls. */
  governance(w: Row, subject: 'plan' | 'recovery', ctl: Controls, strict = false) {
    const c = this.contract(w);
    const need = subject === 'plan' ? c.approval : { role: 'manager' as const, twoPerson: false };
    if (!ctl.approvalGate && !strict) return { ok: true, valid: [] as Row[], reasons: ['approval gate disabled in this baseline'], kind: null as null | 'unauthorized' | 'bypass' };
    const plan = subject === 'recovery' ? this.db.get('SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC', w.id, w.workspace_id) : null;
    const hash = subject === 'plan' ? w.plan_hash : plan?.plan_hash;
    const rows = this.db.all("SELECT * FROM rw_approvals WHERE workflow_id=? AND workspace_id=? AND subject=? AND status='recorded' ORDER BY created_at, rowid", w.id, w.workspace_id, subject);
    const reasons: string[] = []; let roleFail = false; let otherFail = false;
    const valid = rows.filter((r) => {
      const why: string[] = [];
      if (r.channel !== 'structured') {
        if (strict || ctl.structuredApprovalsOnly) { why.push(r.channel === 'replay' ? 'replayed approval record — not a fresh authenticated decision' : 'text in a message is data, not an approval'); otherFail = true; }
        else if (r.channel === 'message' && !/approv/i.test(c.messages.map((m) => m.body).join(' '))) why.push('no approval wording found');
      }
      if (r.channel === 'structured' && (strict || ctl.roleCheck)) {
        const role = this.effectiveRole(w, r.user_id, r.role_at_decision);
        const okRole = need.role === 'owner' ? role === 'owner' : ['owner', 'manager'].includes(role);
        if (!okRole) { why.push(`${r.user_name} is "${role}" now; ${need.role} required`); roleFail = true; }
      }
      if (strict || ctl.approvalPlanBinding) {
        if (r.subject_hash !== hash) { why.push(`approved hash ${String(r.subject_hash).slice(0, 10)} ≠ current ${String(hash).slice(0, 10)} (plan is now v${w.plan_version})`); otherFail = true; }
        if (r.expires_at < nowIso()) { why.push('approval expired'); otherFail = true; }
      }
      if (why.length) reasons.push(`${r.user_name}: ${why.join('; ')}`);
      return why.length === 0;
    });
    const distinct = new Set(valid.map((r) => r.user_id ?? r.id)).size;
    const required = need.twoPerson && (strict || ctl.twoPersonRule) ? 2 : 1;
    if (rows.length === 0) reasons.push('no approval recorded');
    if (distinct < required) {
      if (required === 2 && valid.length >= 2) { reasons.push('two-person rule: both approvals come from the same person'); otherFail = true; }
      else if (required === 2 && distinct === 1) { reasons.push('two-person rule: only one distinct approver'); otherFail = true; }
      return { ok: false, valid, reasons, kind: roleFail && !otherFail ? 'unauthorized' as const : 'bypass' as const };
    }
    return { ok: true, valid, reasons, kind: null };
  }

  // ------------------------------------------------------------------ gaps
  private upsertGap(w: Row, g: { cls: GapClass; subject: string; status?: 'open' | 'prevented' | 'resolved'; title: string; agents: string[]; systems: string[]; expected: unknown; declared: unknown; observed: unknown; evidence: string[]; confidence?: number; uncertainty?: string; parentCausal?: string | null; blast?: unknown }) {
    const sev: Record<GapClass, string> = { partial_commit: 'critical', unknown_outcome: 'critical', duplicate_effect: 'critical', unauthorized_mutation: 'critical', compensation_failure: 'critical', no_op: 'high', stale_completion: 'high', conflicting_completion: 'high', invariant_violation: 'high', authorization_invalid: 'high', stale_evidence: 'high', lost_handoff: 'medium', delayed_consistency: 'low' };
    const hyp: Record<GapClass, string> = {
      partial_commit: 'One step committed in its system while a later step did not; the workflow is half-applied across systems.',
      unknown_outcome: 'A write errored and its effect could not be read back; it may or may not have happened.',
      duplicate_effect: 'The same consequential write landed more than once (redelivery or blind retry without an idempotency key).',
      unauthorized_mutation: 'A resource was changed by an actor that is neither a workflow agent nor a declared external authority.',
      compensation_failure: 'A compensating write was accepted but the independent read shows the invariant is still broken.',
      no_op: 'The tool reported success but the independent read shows no change.',
      stale_completion: 'The result was verified earlier but the external record changed afterwards.',
      conflicting_completion: 'An agent declared the outcome complete while independent reads (or another actor) contradict it.',
      invariant_violation: 'Every step did what it said, but the intended cross-system outcome was not reached.',
      authorization_invalid: 'The recorded approvals do not authorize this plan (role, plan version, two-person rule or channel).',
      stale_evidence: 'The evidence a decision depends on changed or could not be re-read before execution.',
      lost_handoff: 'A hand-off was delivered but not acknowledged before its lease expired.',
      delayed_consistency: 'The write was applied but reads lagged behind before converging.',
    };
    const investigate: Record<GapClass, string[]> = {
      partial_commit: ['Read every system touched by the workflow (done by the Observer)', 'Decide between resuming the missing steps and compensating the committed ones', 'Check that no customer-facing message was sent'],
      unknown_outcome: ['Retry the read-back, not the write', 'Ask the system owner for the record by idempotency key', 'Do not retry the write until the effect is known'],
      duplicate_effect: ['List all effects for the operation in the system of record', 'Plan a compensating reversal for the extra effect', 'Find the redelivery path that skipped deduplication'],
      unauthorized_mutation: ["Identify the actor from the system's audit log", "Freeze the actor's credentials", 'Restore the authorized state through an approved corrective action'],
      compensation_failure: ['Read the compensated system again', 'Escalate to the system owner', 'Do not mark the workflow consistent'],
      no_op: ['Re-read the target resource', 'Resume the step with the same idempotency key', "Report the tool's false success to its owner"],
      stale_completion: ['Find who changed the record after verification', 'Re-plan from the new state', 'Withhold dependent customer messages'],
      conflicting_completion: ["Invalidate the agent's completion claim", 'Compare each claim with independent reads', 'Escalate if evidence cannot settle it'],
      invariant_violation: ['Confirm the invariant reading', 'Investigate root cause beyond the executed steps', 'Escalate: no automatic action restores it'],
      authorization_invalid: ['Request a fresh approval of the current plan version from an authorized person'],
      stale_evidence: ['Review the changed evidence', 'Re-plan or re-approve with the current facts'],
      lost_handoff: ['Confirm the redelivered task completed', 'Check the agent restart cause'],
      delayed_consistency: ['No action: converged after re-reads'],
    };
    const existing = this.db.get('SELECT * FROM rw_gaps WHERE workflow_id=? AND workspace_id=? AND class=? AND subject=?', w.id, w.workspace_id, g.cls, g.subject);
    const status = g.status ?? 'open';
    if (existing) {
      const next = existing.status === 'prevented' ? 'prevented' : status;
      this.db.exec('UPDATE rw_gaps SET observed=?, evidence=?, status=?, resolved_at=? WHERE id=?', JSON.stringify(g.observed), JSON.stringify(g.evidence), next, next === 'resolved' ? nowIso() : null, existing.id);
      return existing.id as string;
    }
    const id = uid('gap');
    const causalId = this.causal(w, 'reality_gap', status === 'prevented' ? 'REQUIRES_HUMAN' : 'RECONCILIATION_REQUIRED', `Reality gap: ${GAP_LABELS[g.cls]} — ${g.title}`, 'verifier', g.parentCausal ?? this.contract(w).causalRoot ?? null, { class: g.cls, subject: g.subject });
    const c = this.contract(w);
    if (!c.timing?.detectedAt && status !== 'resolved') { c.timing = { ...(c.timing ?? {}), detectedAt: Date.now() }; this.saveContract(w, c); }
    this.db.insert('rw_gaps', { id, workspace_id: w.workspace_id, workflow_id: w.id, class: g.cls, subject: g.subject, severity: sev[g.cls], status, title: g.title, intent: w.intent, agents: JSON.stringify(g.agents), systems: JSON.stringify(g.systems), expected: JSON.stringify(g.expected), declared: JSON.stringify(g.declared), observed: JSON.stringify(g.observed), evidence: JSON.stringify(g.evidence), confidence: g.confidence ?? 1, uncertainty: g.uncertainty ?? 'Observed directly by independent reads.', blast_radius: JSON.stringify(g.blast ?? { systems: g.systems }), predecessors: JSON.stringify(g.parentCausal ? [g.parentCausal] : []), investigation: JSON.stringify(investigate[g.cls]), hypothesis: hyp[g.cls], approval_required: status === 'prevented' ? 'Fresh approval of the current plan by an authorized person' : (['delayed_consistency', 'lost_handoff'].includes(g.cls) ? 'None' : 'Manager approval of a recovery plan, bound to the plan hash'), causal_id: causalId, detected_at: nowIso(), resolved_at: status === 'resolved' ? nowIso() : null });
    this.audit(w, 'verifier', 'gap', `${GAP_LABELS[g.cls]}: ${g.title}`, { gapId: id, status });
    return id;
  }

  // ------------------------------------------------------------------ execution (Executor agents)
  async run(a: Actor, wfId: string, hooks: RunHooks = {}) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot run workflows.');
    const w = this.wf(a.workspaceId, wfId);
    if (w.source === 'live') this.engine.require(a, 'owner', 'manager');
    const s = this.scenario(w); const ctl = this.controls(w); const lab = new Lab(this.db, w.workspace_id, w.id); const c = this.contract(w);
    if (!['AUTHORIZATION_PENDING', 'AUTHORIZED'].includes(w.state)) throw new EngineError(409, 'bad_state', `Workflow is ${w.state}; it can only be started from AUTHORIZATION_PENDING.`);
    // Plan amendments after approval (scenario events) bump the plan version and hash.
    for (const ev of (s.events ?? []).filter((e) => e.kind === 'amend_plan')) this.amendPlan(w, ev.amend ?? {}, ev.label);
    void c;
    const g = this.governance(w, 'plan', ctl);
    if (!g.ok) {
      if (w.source === 'live') throw new EngineError(409, 'authorization_required', `Not authorized: ${g.reasons.join(' | ')}`);
      this.upsertGap(w, { cls: 'authorization_invalid', subject: 'plan', status: 'prevented', title: `Execution refused: ${g.reasons.join('; ')}`, agents: ['governance'], systems: [], expected: `${c.approval.role} approval of plan v${w.plan_version}${c.approval.twoPerson ? ' by two people' : ''}`, declared: 'approval present', observed: g.reasons, evidence: g.valid.map((r) => r.id) });
      this.move(w, 'REQUIRES_HUMAN', `Governance refused execution: ${g.reasons.join('; ')}`, 'governance');
      return this.finish(w, 'REQUIRES_HUMAN');
    }
    if (w.state === 'AUTHORIZATION_PENDING') this.move(w, 'AUTHORIZED', `Authorized by ${g.valid.map((r) => r.user_name).join(', ') || 'baseline policy'} for plan v${w.plan_version}.`, 'governance');
    this.move(w, 'EXECUTING', 'Executor agents are working through the contract.', 'planner');
    await this.forward(w, lab, s, ctl, hooks, 'main', g.valid.map((r) => r.id));
    return this.afterForward(w, lab, s, ctl, hooks);
  }

  private async afterForward(w: Row, lab: Lab, s: Scenario, ctl: Controls, hooks: RunHooks) {
    if (!ctl.reconciliation) {
      if (w.state === 'REQUIRES_HUMAN') return this.finish(w, 'REQUIRES_HUMAN');
      // Baselines without reconciliation: the workflow outcome is what the agents declared.
      const ops = this.db.all(`SELECT * FROM rw_operations WHERE workflow_id=? AND workspace_id=? AND ${FORWARD}`, w.id, w.workspace_id);
      const claimed = ops.some((o) => j<any>(o.declared, {}).claim);
      const failed = ops.some((o) => ['FAILED', 'EXECUTION_UNKNOWN', 'REQUIRES_HUMAN'].includes(o.state));
      const declared = claimed || !failed ? 'COMPLETED' : 'FAILED';
      this.move(w, failed && !claimed ? 'FAILED' : 'OBSERVATION_PENDING', `${declared === 'COMPLETED' ? 'Agents declared the workflow complete' : 'An agent reported failure'}; this baseline does not reconcile against observed state.`);
      return this.finish(w, declared);
    }
    const rec = this.reconcile(w, lab, s);
    if (w.state === 'REQUIRES_HUMAN') {
      // stopped by governance/freshness: still reconcile so partial commits are visible, then plan recovery if needed
      if (rec.clean || !ctl.recoveryPlanner || !this.db.get("SELECT 1 x FROM rw_gaps WHERE workflow_id=? AND status='open'", w.id)) return this.finish(w, 'REQUIRES_HUMAN');
      this.move(w, 'RECONCILIATION_REQUIRED', 'Stopped before a step; committed steps must be reconciled.', 'verifier');
      return this.toRecovery(w, lab, s, ctl);
    }
    if (rec.clean) {
      if (this.pendingFinal(w, s).length) {
        await this.forward(w, lab, s, ctl, hooks, 'final', this.governance(w, 'plan', ctl).valid.map((r) => r.id));
        const again = this.reconcile(w, lab, s);
        if (!again.clean) return this.toRecovery(w, lab, s, ctl);
      }
      if (w.state === 'EXECUTING') this.move(w, 'VERIFICATION_PENDING', 'All steps executed; verifying invariants.', 'verifier');
      this.move(w, 'VERIFIED', 'Every post-condition and cross-system invariant is confirmed by independent reads.', 'verifier');
      return this.finish(w, 'VERIFIED');
    }
    return this.toRecovery(w, lab, s, ctl);
  }

  private async toRecovery(w: Row, lab: Lab, s: Scenario, ctl: Controls) {
    const open = this.db.all("SELECT * FROM rw_gaps WHERE workflow_id=? AND workspace_id=? AND status='open'", w.id, w.workspace_id);
    const partial = open.some((g) => g.class === 'partial_commit');
    const unknown = open.some((g) => g.class === 'unknown_outcome');
    if (w.state === 'EXECUTING') this.move(w, unknown ? 'EXECUTION_UNKNOWN' : partial ? 'PARTIALLY_COMPLETED' : 'RECONCILIATION_REQUIRED', `${open.length} reality gap(s): ${open.map((g) => GAP_LABELS[g.class as GapClass]).join(', ')}.`, 'verifier');
    if (!ctl.recoveryPlanner) { this.move(w, 'REQUIRES_HUMAN', 'Gaps detected; no recovery planner in this configuration.', 'verifier'); return this.finish(w, 'REQUIRES_HUMAN'); }
    if (w.state !== 'RECONCILIATION_REQUIRED') this.move(w, 'RECONCILIATION_REQUIRED', 'Reconciliation required before any further write.', 'verifier');
    this.planRecovery(w, lab, s);
    this.db.exec("UPDATE rw_workflows SET declared_status='AWAITING_RECOVERY_DECISION' WHERE id=?", w.id);
    w.declared_status = 'AWAITING_RECOVERY_DECISION';
    this.issuePassports(w); // interim passports: verified operations are provable now; the rest say NOT PROVEN
    await this.tell(w, 'escalation', 'recovery', 'governance', `Reality gap: ${open.map((g) => g.title).join(' | ')}. Recovery options are ready; human approval required.`);
    return this.detail(w.workspace_id, w.id);
  }

  private pendingFinal(w: Row, s: Scenario) {
    const done = new Set(this.db.all(`SELECT step_key FROM rw_operations WHERE workflow_id=? AND workspace_id=? AND ${FORWARD}`, w.id, w.workspace_id).map((r) => r.step_key));
    return s.steps.filter((x) => x.afterInvariants && !done.has(x.key));
  }

  private applyEvents(w: Row, lab: Lab, s: Scenario, when: 'before' | 'after', stepKey: string) {
    for (const ev of (s.events ?? []).filter((e) => e[when] === stepKey)) {
      if (ev.kind === 'mutate') lab.external(ev.system!, ev.resource!, ev.patch!, ev.actor ?? 'external', `event:${when}:${stepKey}`);
      if (ev.kind === 'demote') {
        const u = this.userByHandle(w.workspace_id, ev.user!); if (!u) continue;
        const ov = j<Record<string, string>>(w.authz_overrides, {}); ov[u.id] = ev.role!; w.authz_overrides = JSON.stringify(ov);
        this.db.exec('UPDATE rw_workflows SET authz_overrides=? WHERE id=?', w.authz_overrides, w.id);
      }
      this.audit(w, 'world', 'external_event', `External event (${when} ${stepKey}): ${ev.label}`);
      this.causal(w, 'fault_injection', 'FAULT_INJECTED', `Injected: ${ev.label}`, ev.actor ?? 'world', this.contract(w).causalRoot ?? null, { label: ev.label, kind: ev.kind, trigger: `${when} ${stepKey}` });
    }
  }

  private async forward(w: Row, lab: Lab, s: Scenario, ctl: Controls, hooks: RunHooks, phase: 'main' | 'final', approvalIds: string[]) {
    const steps = s.steps.filter((x) => (phase === 'final' ? x.afterInvariants : !(ctl.gateFinalSteps && x.afterInvariants)));
    for (const step of steps) {
      if (this.db.get(`SELECT 1 x FROM rw_operations WHERE workflow_id=? AND workspace_id=? AND step_key=? AND ${FORWARD}`, w.id, w.workspace_id, step.key)) continue;
      this.applyEvents(w, lab, s, 'before', step.key);
      // Governance re-check at execution time (permission changes, plan amendments).
      if (ctl.roleCheck || ctl.approvalPlanBinding) {
        const g = this.governance(w, 'plan', ctl);
        if (!g.ok) {
          this.upsertGap(w, { cls: 'authorization_invalid', subject: step.key, status: 'prevented', title: `"${step.label}" refused at execution time: ${g.reasons.join('; ')}`, agents: ['governance', step.agent], systems: [step.system], expected: 'valid authority at execution time', declared: 'approved earlier', observed: g.reasons, evidence: [] });
          this.move(w, 'REQUIRES_HUMAN', `Authority no longer valid before "${step.label}": ${g.reasons.join('; ')}`, 'governance');
          return;
        }
      }
      // Evidence freshness for preconditions.
      if (step.precondition) {
        const p = step.precondition; const planning = this.latestObs(w, p.system, p.resource, 'planning');
        let verdict: 'pass' | 'fail' | 'unknown'; let basis: string;
        if (ctl.evidenceFreshness) {
          const fresh = this.observe(w, lab, 'observer', p.system, p.resource, 'precondition', null);
          if (planning && planning.available && fresh.available && planning.state_hash !== stateHash(fresh.state)) {
            this.db.exec('UPDATE rw_observations SET invalidated_at=?, invalidated_reason=? WHERE id=?', nowIso(), `superseded: ${p.system}/${p.resource} changed (updated by ${fresh.updated_by})`, planning.id);
          }
          verdict = !fresh.available ? 'unknown' : fresh.state[p.field] === p.equals ? 'pass' : 'fail'; basis = fresh.id;
        } else {
          const st = planning?.available ? j<ResourceState>(planning.state, {}) : null;
          verdict = st ? (st[p.field] === p.equals ? 'pass' : 'fail') : 'pass'; basis = planning?.id ?? 'none'; // naive: missing evidence treated as OK
        }
        hooks.decision?.(step, verdict === 'pass' || !ctl.evidenceFreshness);
        if (verdict !== 'pass' && ctl.evidenceFreshness) {
          this.upsertGap(w, { cls: 'stale_evidence', subject: step.key, status: 'prevented', title: `"${step.label}" not executed: precondition "${p.label}" is ${verdict === 'unknown' ? 'UNKNOWN (unreadable — not treated as satisfied)' : 'no longer true'}`, agents: ['observer', 'governance'], systems: [p.system], expected: `${p.system}/${p.resource}.${p.field} = ${JSON.stringify(p.equals)}`, declared: 'true at planning time', observed: verdict === 'unknown' ? 'unreadable' : j(this.db.get('SELECT state FROM rw_observations WHERE id=?', basis)?.state, {}), evidence: [basis, planning?.id].filter(Boolean) as string[], confidence: verdict === 'unknown' ? 0.5 : 1, uncertainty: verdict === 'unknown' ? 'The source could not be read; availability is unknown, not confirmed.' : 'Fresh read contradicts planning-time evidence.' });
          const op = this.newOp(w, step, 'forward', approvalIds, ctl);
          this.moveOp(op, 'AUTHORIZATION_PENDING'); this.moveOp(op, 'REQUIRES_HUMAN', { last_error: `precondition ${verdict}` });
          this.move(w, 'REQUIRES_HUMAN', `Stopped before "${step.label}": precondition "${p.label}" ${verdict === 'unknown' ? 'is unknown' : 'no longer holds'}.`, 'observer');
          return;
        }
      }
      const op = this.newOp(w, step, 'forward', approvalIds, ctl);
      this.moveOp(op, 'AUTHORIZATION_PENDING'); this.moveOp(op, 'AUTHORIZED');
      // Hand-off Planner -> Executor (durable or not).
      const hf = this.handoff(w, lab, step, op, ctl);
      await this.tell(w, 'handoff', 'planner', step.agent, `Task ${op.id}: ${step.label} on ${step.system}/${step.resource}. Idempotency key ${op.idempotency_key ?? 'none'}. Report the tool result; the Verifier decides the outcome.`);
      if (hf.lost) continue; // non-durable hand-off lost on restart: the step silently never runs
      if (ctl.independentVerification) { const b = this.observe(w, lab, 'observer', step.system, step.resource, 'before', op.id); this.db.update('rw_operations', op.id, w.workspace_id, { before_obs: b.id }); op.before_obs = b.id; }
      let outcome = this.execute(w, lab, step, op, ctl, step.key);
      // Redelivery (agent restart / webhook retry) of the SAME task after it already ran.
      if (lab.takeFault(step.key, step.system, ['handoff_duplicate'])) {
        this.db.exec("UPDATE rw_handoffs SET deliveries=deliveries+1 WHERE id=?", hf.id);
        if (ctl.durableHandoffs) this.audit(w, step.agent, 'handoff_deduped', `Redelivery of "${step.label}" discarded by dedupe key ${w.id}:${step.key} (task already ${outcome === 'present' ? 'completed' : 'settled'}).`);
        else outcome = this.execute(w, lab, step, op, ctl, step.key, true);
      }
      this.db.exec('UPDATE rw_handoffs SET status=?, resolved_at=? WHERE id=?', outcome === 'present' ? 'completed' : 'failed', nowIso(), hf.id);
      if (outcome === 'present' && ctl.independentVerification) outcome = this.verifyOp(w, lab, step, op);
      this.applyEvents(w, lab, s, 'after', step.key);
      if (outcome !== 'present' && (ctl.readBackOnError || ctl.reconciliation)) return; // never run dependent steps on an unsettled or failed predecessor
    }
  }

  private newOp(w: Row, step: StepDef, kind: 'forward' | 'recovery' | 'compensation', approvalIds: string[], ctl: Controls, extra: Record<string, unknown> = {}) {
    const op: Row = { id: uid('op'), workspace_id: w.workspace_id, workflow_id: w.id, step_key: step.key, kind, system: step.system, resource: step.resource, agent: step.agent, label: step.label, patch: JSON.stringify(step.patch), consequential: step.consequential ? 1 : 0, reversibility: step.reversibility, idempotency_key: ctl.guardedWrites ? `idem_${sha256(`${w.id}|${step.key}|${kind}|${w.plan_hash}`).slice(0, 20)}` : null, state: 'PLANNED', attempts: 0, declared: '{}', tool_response: null, before_obs: null, after_obs: null, verifier: '[]', classification: null, approval_ids: JSON.stringify(approvalIds), parent_op_id: null, gap_id: null, causal_id: null, last_error: null, created_at: nowIso(), updated_at: nowIso(), ...extra };
    this.db.insert('rw_operations', op);
    return op;
  }

  private handoff(w: Row, lab: Lab, step: StepDef, op: Row, ctl: Controls) {
    const id = uid('ho');
    const f = lab.takeFault(step.key, step.system, ['handoff_lost']); // a duplicate (redelivery) is decided after the work ran; see forward()
    const exp = new Date(Date.now() + 60_000).toISOString();
    this.db.insert('rw_handoffs', { id, workspace_id: w.workspace_id, workflow_id: w.id, task_id: op.id, from_agent: 'planner', to_agent: step.agent, action: step.label, body: JSON.stringify({ taskId: op.id, workflowId: w.id, from: 'planner', to: step.agent, action: step.label, contextRefs: [w.plan_hash], evidenceRefs: [], preconditions: step.precondition ? [step.precondition.label] : [], outputSchema: 'LabWrite{ok,receipt,version,deduped}', expiresAt: exp, permissionScope: `write:${step.system}/${step.resource}`, completionCriteria: step.expect.map((e) => e.label), failureHandling: 'report the error; never retry an unknown outcome' }), status: 'sent', dedupe_key: `${w.id}:${step.key}`, deliveries: 1, expires_at: exp, created_at: nowIso(), acked_at: null, resolved_at: null });
    const parent = this.causal(w, 'agent_handoff', 'AUTHORIZED', `Hand-off: Planner → ${agentById(step.agent)?.name ?? step.agent}: ${step.label}`, 'planner', this.contract(w).causalRoot ?? null, { handoffId: id, task: op.id });
    this.db.update('rw_operations', op.id, w.workspace_id, { causal_id: parent }); op.causal_id = parent;
    if (f?.kind === 'handoff_lost') {
      if (ctl.durableHandoffs) {
        this.db.exec("UPDATE rw_handoffs SET status='acknowledged', deliveries=2, acked_at=? WHERE id=?", nowIso(), id);
        this.upsertGap(w, { cls: 'lost_handoff', subject: step.key, status: 'resolved', title: `${agentById(step.agent)?.name} restarted before acknowledging "${step.label}"; the lease expired and the task was redelivered`, agents: ['planner', step.agent], systems: [step.system], expected: 'acknowledged hand-off', declared: 'delivered', observed: 'no acknowledgement before lease expiry; redelivered and acknowledged', evidence: [id] });
        return { id, lost: false, executions: 1 };
      }
      this.db.exec("UPDATE rw_handoffs SET status='lost' WHERE id=?", id);
      this.audit(w, 'planner', 'handoff_lost', `Hand-off for "${step.label}" lost (agent restarted; no durable redelivery in this baseline).`);
      return { id, lost: true, executions: 0 };
    }
    this.db.exec("UPDATE rw_handoffs SET status='acknowledged', acked_at=? WHERE id=?", nowIso(), id);
    return { id, lost: false, executions: 1 };
  }

  /** One tool call by an executor. Returns how the effect was settled. Never decides success from the error alone. */
  private execute(w: Row, lab: Lab, step: StepDef, op: Row, ctl: Controls, opKey: string, isRedelivery = false, idemOverride?: string | null): 'present' | 'absent' | 'unknown' | 'conflict' {
    const patch: Patch = ctl.guardedWrites ? step.patch : { set: step.patch.set, inc: step.patch.inc };
    const idem = idemOverride !== undefined ? idemOverride : op.idempotency_key;
    if (op.state !== 'EXECUTING') this.moveOp(op, 'EXECUTING');
    this.db.exec('UPDATE rw_operations SET attempts=attempts+1 WHERE id=?', op.id); op.attempts += 1;
    const attempt = (): 'ok' | LabError => { try { const r = lab.mutate(step.agent, opKey, step.system, step.resource, patch, idem); this.db.update('rw_operations', op.id, w.workspace_id, { tool_response: JSON.stringify(r) }); op.tool_response = JSON.stringify(r); return 'ok'; } catch (e) { if (e instanceof LabError) return e; throw e; } };
    let res = attempt();
    const claim = (status: string, extra: Record<string, unknown> = {}) => { const d = { ...j<any>(op.declared, {}), agent: step.agent, status, at: nowIso(), ...(status === 'succeeded' && step.claim ? { claim: step.claim } : {}), ...extra }; this.db.update('rw_operations', op.id, w.workspace_id, { declared: JSON.stringify(d) }); op.declared = JSON.stringify(d); };
    if (res === 'ok') {
      claim('succeeded', isRedelivery ? { redelivered: true } : {});
      this.moveOp(op, 'OBSERVATION_PENDING', { classification: 'present', last_error: null });
      this.settled(op, 'present');
      op.causal_id = this.causal(w, 'action_execution', 'EXECUTING', `${agentById(step.agent)?.name}: tool returned success for "${step.label}"${step.claim ? ` and declared "${step.claim}"` : ''}`, step.agent, op.causal_id, { receipt: j<any>(op.tool_response, {}).receipt }, idem);
      this.db.update('rw_operations', op.id, w.workspace_id, { causal_id: op.causal_id });
      return 'present';
    }
    const err = res;
    if (err.code === 'conflict' || err.code === 'forbidden') {
      claim('rejected', { error: err.message });
      this.moveOp(op, 'FAILED', { classification: 'absent', last_error: err.message }); this.settled(op, 'absent');
      if (err.code === 'conflict') {
        const now = this.observe(w, lab, 'observer', step.system, step.resource, 'conflict', op.id);
        this.upsertGap(w, { cls: 'conflicting_completion', subject: step.key, title: `"${step.label}" conflicts with a concurrent write by ${now.updated_by || 'another actor'}`, agents: [step.agent], systems: [step.system], expected: step.patch.set ?? {}, declared: `${step.agent} attempted the write`, observed: now.available ? now.state : 'unreadable', evidence: [now.id], parentCausal: op.causal_id });
      }
      return err.code === 'conflict' ? 'conflict' : 'absent';
    }
    if (ctl.readBackOnError) {
      // Bounded read-back window: a single stale replica read must not turn a lost response into a "failure".
      // ABSENT is concluded only when every read was available and showed no effect; any unreadable read with
      // no observed effect keeps the outcome UNKNOWN (reconciliation settles it later, the write is never repeated).
      const reads: ReturnType<RealityEngine['observe']>[] = [];
      for (let i = 0; i < MAX_READS; i++) {
        const o = this.observe(w, lab, 'observer', step.system, step.resource, 'read-back', op.id);
        reads.push(o);
        if (o.available && this.expects(step, o.state).every((e) => e.ok)) break;
      }
      const hit = reads.find((o) => o.available && this.expects(step, o.state).every((e) => e.ok));
      const rb = hit ?? reads[reads.length - 1];
      claim('error', { error: err.message, readBack: reads.map((o) => (o.available ? (this.expects(step, o.state).every((e) => e.ok) ? 'present' : 'absent') : 'unreadable')) });
      if (!hit && reads.some((o) => !o.available)) {
        this.moveOp(op, 'EXECUTION_UNKNOWN', { classification: 'unknown', last_error: `${err.message}; read-back window (${reads.length} reads) inconclusive: ${reads.map((o) => (o.available ? 'absent' : 'unreadable')).join(', ')}` }); this.settled(op, 'unknown');
        op.causal_id = this.causal(w, 'action_execution', 'EXECUTION_UNKNOWN', `Outcome UNKNOWN for "${step.label}": ${err.message}; read-back inconclusive. Not repeated.`, step.agent, op.causal_id, { reads: reads.map((o) => o.id) }, idem);
        this.db.update('rw_operations', op.id, w.workspace_id, { causal_id: op.causal_id });
        return 'unknown';
      }
      const present = !!hit;
      this.moveOp(op, present ? 'OBSERVATION_PENDING' : 'FAILED', { classification: present ? 'present' : 'absent', last_error: present ? `${err.message} (read-back: effect present; not repeated)` : `${err.message} (read-back: no effect)`, after_obs: rb.id });
      this.settled(op, present ? 'present' : 'absent');
      op.causal_id = this.causal(w, 'verification_probe', present ? 'OBSERVED' : 'FAILED', `Read-back after "${err.message}": effect ${present ? 'PRESENT (lost response — not repeated)' : 'ABSENT (confirmed)'}`, 'observer', op.causal_id, { observation: rb.id }, idem);
      this.db.update('rw_operations', op.id, w.workspace_id, { causal_id: op.causal_id });
      return present ? 'present' : 'absent';
    }
    // Baseline behaviour: blind retry once (same key only if the baseline uses idempotency keys).
    this.settled(op, 'absent'); // the baseline believes the failed attempt left no effect
    this.db.exec('UPDATE rw_operations SET attempts=attempts+1 WHERE id=?', op.id); op.attempts += 1;
    res = attempt();
    if (res === 'ok') { claim('succeeded', { retriedAfter: err.message }); this.moveOp(op, 'OBSERVATION_PENDING', { classification: 'present', last_error: null }); return 'present'; }
    claim('failed', { error: res.message });
    this.moveOp(op, 'FAILED', { classification: 'absent', last_error: res.message });
    return 'absent';
  }
  /** Records how the outcome of the FIRST faulted attempt was settled (scored by RIGOR as reconciliation accuracy). */
  private settled(op: Row, v: 'present' | 'absent' | 'unknown') {
    const d = j<any>(op.declared, {}); if (d.settled && d.settled !== 'unknown') return;
    d.settled = v; this.db.update('rw_operations', op.id, op.workspace_id, { declared: JSON.stringify(d) }); op.declared = JSON.stringify(d);
  }

  /** Verifier: independent read with bounded re-reads (replication lag). */
  private verifyOp(w: Row, lab: Lab, step: StepDef, op: Row): 'present' | 'absent' | 'unknown' {
    const log: { read: number; available: boolean; checks: ReturnType<RealityEngine['expects']> }[] = [];
    let lagged = false;
    for (let i = 1; i <= MAX_READS; i++) {
      const o = this.observe(w, lab, 'verifier', step.system, step.resource, 'verify', op.id);
      const checks = o.available ? this.expects(step, o.state) : [];
      log.push({ read: i, available: o.available, checks });
      this.db.update('rw_operations', op.id, w.workspace_id, { after_obs: o.id, verifier: JSON.stringify(log) }); op.after_obs = o.id;
      if (!o.available) continue;
      if (checks.some((c) => c.duplicate)) {
        this.moveOp(op, 'VERIFICATION_PENDING'); this.moveOp(op, 'FAILED', { classification: 'present', last_error: `duplicate effect: ${checks.filter((c) => c.duplicate).map((c) => `${c.field}=${JSON.stringify(c.got)} (want ${JSON.stringify(c.want)})`).join(', ')}` });
        this.upsertGap(w, { cls: 'duplicate_effect', subject: step.key, title: `"${step.label}" landed more than once`, agents: [step.agent], systems: [step.system], expected: step.expect, declared: j(op.declared, {}), observed: o.state, evidence: [o.id], parentCausal: op.causal_id });
        return 'present';
      }
      if (checks.every((c) => c.ok)) {
        this.moveOp(op, 'VERIFICATION_PENDING'); this.moveOp(op, 'VERIFIED', { classification: 'present' });
        op.causal_id = this.causal(w, 'verification_probe', 'VERIFIED', `Verifier: "${step.label}" confirmed by independent read${i > 1 ? ` (after ${i} reads)` : ''}`, 'verifier', op.causal_id, { observation: o.id }, op.idempotency_key);
        this.db.update('rw_operations', op.id, w.workspace_id, { causal_id: op.causal_id });
        if (lagged) this.upsertGap(w, { cls: 'delayed_consistency', subject: step.key, status: 'resolved', title: `"${step.label}" became visible only after ${i} reads`, agents: ['verifier'], systems: [step.system], expected: step.expect, declared: 'succeeded', observed: 'converged', evidence: [o.id] });
        return 'present';
      }
      lagged = true;
    }
    const last = log[log.length - 1];
    // An unreadable read inside the window means the window cannot confirm absence (it may be lag): keep it pending/unknown.
    if (log.some((r) => !r.available)) { this.moveOp(op, 'EXECUTION_UNKNOWN', { classification: 'unknown', last_error: `post-write verification inconclusive: ${log.map((r) => (r.available ? 'not visible' : 'unreadable')).join(', ')} — pending reconciliation` }); return 'unknown'; }
    this.moveOp(op, 'VERIFICATION_PENDING'); this.moveOp(op, 'FAILED', { classification: 'absent', last_error: `tool said success; ${MAX_READS} independent reads show no effect` });
    const d = j<any>(op.declared, {}); d.settled = 'absent'; this.db.update('rw_operations', op.id, w.workspace_id, { declared: JSON.stringify(d) }); op.declared = JSON.stringify(d);
    this.upsertGap(w, { cls: 'no_op', subject: step.key, title: `"${step.label}": tool reported success, nothing changed`, agents: [step.agent], systems: [step.system], expected: step.expect.map((e) => e.label), declared: { tool: 'success', receipt: j<any>(op.tool_response, {}).receipt }, observed: last.checks.map((c) => `${c.field} = ${JSON.stringify(c.got)}`), evidence: [op.after_obs], parentCausal: op.causal_id });
    return 'absent';
  }

  // ------------------------------------------------------------------ reconciliation (Observer + Verifier + Investigator)
  reconcile(w: Row, lab: Lab, s: Scenario) {
    const snap = this.snapshot(w, lab);
    const read = this.reader(snap);
    const ops = this.db.all(`SELECT * FROM rw_operations WHERE workflow_id=? AND workspace_id=? AND ${FORWARD} ORDER BY created_at, rowid`, w.id, w.workspace_id);
    const opByStep = new Map(ops.map((o) => [o.step_key, o]));
    const allowed = new Set(['seed', 'none', ...s.steps.map((x) => x.agent)]);
    // 1. settle unknown outcomes with the fresh snapshot
    for (const op of ops.filter((o) => o.state === 'EXECUTION_UNKNOWN')) {
      const step = s.steps.find((x) => x.key === op.step_key)!; const o = snap[k(op.system, op.resource)];
      if (!o?.available) { this.upsertGap(w, { cls: 'unknown_outcome', subject: op.step_key, title: `"${op.label}" outcome still unknown: ${op.system} unreadable`, agents: [op.agent, 'observer'], systems: [op.system], expected: step.expect.map((e) => e.label), declared: j(op.declared, {}), observed: 'unreadable', evidence: [o?.obsId].filter(Boolean) as string[], confidence: 0, uncertainty: 'The write may or may not have happened. It will not be repeated until a read settles it.', parentCausal: op.causal_id }); continue; }
      const present = this.expects(step, o.state).every((e) => e.ok);
      this.upsertGap(w, { cls: 'unknown_outcome', subject: op.step_key, status: 'resolved', title: `"${op.label}" timed out with an unknown outcome; the reconciliation read shows the effect is ${present ? 'PRESENT' : 'ABSENT'}`, agents: [op.agent, 'observer'], systems: [op.system], expected: step.expect.map((e) => e.label), declared: j(op.declared, {}), observed: o.state, evidence: [o.obsId], parentCausal: op.causal_id });
      const d = j<any>(op.declared, {}); d.settled = present ? 'present' : 'absent';
      this.moveOp(op, present ? 'OBSERVATION_PENDING' : 'FAILED', { classification: present ? 'present' : 'absent', declared: JSON.stringify(d), last_error: present ? op.last_error : `${op.last_error ?? ''}; reconciliation read: no effect` });
      if (present) {
        this.moveOp(op, 'VERIFICATION_PENDING'); this.moveOp(op, 'VERIFIED', { after_obs: o.obsId });
        if (j<any>(op.declared, {}).status === 'succeeded') this.upsertGap(w, { cls: 'delayed_consistency', subject: op.step_key, status: 'resolved', title: `"${op.label}": the tool reported success, verification reads were inconclusive (unreadable/stale), and the effect became visible at reconciliation`, agents: ['verifier', 'observer'], systems: [op.system], expected: step.expect.map((e) => e.label), declared: 'succeeded', observed: o.state, evidence: [o.obsId] });
      }
    }
    // 2. per-operation checks against the snapshot
    for (const op of ops) {
      const step = s.steps.find((x) => x.key === op.step_key)!; const o = snap[k(op.system, op.resource)];
      if (!o?.available || op.state === 'REQUIRES_HUMAN') continue;
      const checks = this.expects(step, o.state);
      if (checks.some((c) => c.duplicate)) { if (!this.db.get("SELECT 1 x FROM rw_gaps WHERE workflow_id=? AND class='duplicate_effect' AND subject=?", w.id, op.step_key)) this.upsertGap(w, { cls: 'duplicate_effect', subject: op.step_key, title: `"${op.label}" landed more than once`, agents: [op.agent], systems: [op.system], expected: step.expect, declared: j(op.declared, {}), observed: o.state, evidence: [o.obsId], parentCausal: op.causal_id }); }
      else if (op.state === 'VERIFIED' && !checks.every((c) => c.ok)) {
        this.moveOp(op, 'RECONCILIATION_REQUIRED', { last_error: `changed after verification by ${o.updated_by}` });
        this.upsertGap(w, { cls: 'stale_completion', subject: op.step_key, title: `"${op.label}" was verified, but ${o.updated_by} changed ${op.system}/${op.resource} afterwards`, agents: [op.agent, 'verifier'], systems: [op.system], expected: step.expect.map((e) => e.label), declared: 'VERIFIED earlier', observed: o.state, evidence: [o.obsId, op.after_obs].filter(Boolean), parentCausal: op.causal_id });
      }
    }
    // 3. unauthorized writers on any watched resource
    for (const [key, o] of Object.entries(snap)) {
      if (!o.available || allowed.has(o.updated_by) || o.updated_by.startsWith('provider:')) continue;
      this.upsertGap(w, { cls: 'unauthorized_mutation', subject: key, title: `${key} was changed by "${o.updated_by}", which has no authority in this workflow`, agents: ['observer'], systems: [key.split('/')[0]], expected: 'writes only by workflow agents or declared external authorities', declared: 'no such write planned or approved', observed: { updated_by: o.updated_by, state: o.state }, evidence: [o.obsId] });
    }
    // 4. cross-system: partial commit, conflicting completion claims, invariants
    const core = s.steps.filter((x) => !x.afterInvariants);
    const okStep = (x: StepDef) => { const o = snap[k(x.system, x.resource)]; return !!o?.available && this.expects(x, o.state).every((e) => e.ok); };
    const done = core.filter(okStep);
    const missing = core.filter((x) => !done.includes(x));
    const committedConsequential = done.filter((x) => x.consequential && opByStep.has(x.key));
    if (committedConsequential.length && missing.length) this.upsertGap(w, { cls: 'partial_commit', subject: 'workflow', title: `${committedConsequential.map((x) => x.label).join(', ')} committed; ${missing.map((x) => x.label).join(', ')} not`, agents: [...new Set([...committedConsequential, ...missing].map((x) => x.agent))], systems: [...new Set([...committedConsequential, ...missing].map((x) => x.system))], expected: core.map((x) => `${x.label}: ${x.expect.map((e) => e.label).join(', ')}`), declared: ops.map((o) => ({ step: o.step_key, agent: o.agent, status: j<any>(o.declared, {}).status ?? 'not reached', claim: j<any>(o.declared, {}).claim })), observed: Object.fromEntries([...committedConsequential, ...missing].map((x) => [k(x.system, x.resource), snap[k(x.system, x.resource)]?.available ? snap[k(x.system, x.resource)].state : 'unreadable'])), evidence: Object.values(snap).map((o) => o.obsId), blast: { systems: [...new Set(core.map((x) => x.system))], heldDownstream: s.steps.filter((x) => x.afterInvariants).map((x) => x.label), invariants: s.invariants.map((i) => i.label) } });
    for (const op of ops) {
      const claim = j<any>(op.declared, {}).claim;
      if (claim && missing.length) this.upsertGap(w, { cls: 'conflicting_completion', subject: `claim:${op.step_key}`, title: `${agentById(op.agent)?.name} declared "${claim}" — independent reads show ${missing.map((x) => x.label).join(', ')} not done`, agents: [op.agent, ...missing.map((x) => x.agent)], systems: [...new Set(missing.map((x) => x.system))], expected: 'all contract steps observed', declared: claim, observed: missing.map((x) => `${x.label}: not observed`), evidence: Object.values(snap).map((o) => o.obsId), parentCausal: op.causal_id });
    }
    const invs = this.evalInvariants(w, read);
    const failing = invs.filter((i) => !i.ok);
    const openNow = () => this.db.all("SELECT * FROM rw_gaps WHERE workflow_id=? AND workspace_id=? AND status='open'", w.id, w.workspace_id);
    if (failing.length && !openNow().length) {
      this.upsertGap(w, { cls: 'invariant_violation', subject: failing.map((i) => i.id).join(','), title: `Steps did what they said, but ${failing.map((i) => `"${i.label}"`).join(', ')} ${failing.length > 1 ? 'do' : 'does'} not hold (${failing.map((i) => i.detail).join('; ')})`, agents: ['verifier'], systems: [...new Set(failing.flatMap((i) => i.reads.map((r) => r.split('/')[0])))], expected: failing.map((i) => i.label), declared: ops.map((o) => j<any>(o.declared, {}).claim ?? j<any>(o.declared, {}).status), observed: failing.map((i) => i.detail), evidence: Object.values(snap).map((o) => o.obsId), confidence: failing.some((i) => i.unknown) ? 0.5 : 1 });
      for (const op of ops) { const claim = j<any>(op.declared, {}).claim; if (claim) this.upsertGap(w, { cls: 'conflicting_completion', subject: `claim:${op.step_key}`, title: `${agentById(op.agent)?.name} declared "${claim}" — ${failing.map((i) => i.label).join(', ')} does not hold`, agents: [op.agent, 'verifier'], systems: [op.system], expected: failing.map((i) => i.label), declared: claim, observed: failing.map((i) => i.detail), evidence: Object.values(snap).map((o) => o.obsId), parentCausal: op.causal_id }); }
    }
    const stopped = ops.some((o) => o.state === 'REQUIRES_HUMAN');
    const clean = !openNow().length && !failing.length && missing.length === 0;
    if (clean) this.db.exec("UPDATE rw_gaps SET status='resolved', resolved_at=? WHERE workflow_id=? AND workspace_id=? AND status='open'", nowIso(), w.id, w.workspace_id);
    this.db.exec('UPDATE rw_workflows SET observed_status=? WHERE id=?', clean ? 'consistent' : missing.length && done.length ? 'partially_completed' : stopped && !done.length ? 'not_started' : 'inconsistent', w.id);
    return { clean, snap, invariants: invs, done: done.map((x) => x.key), missing: missing.map((x) => x.key) };
  }

  // ------------------------------------------------------------------ counterfactual recovery planner
  planRecovery(w: Row, lab: Lab, s: Scenario) {
    const snap = this.snapshot(w, lab, 'recovery-basis');
    const ops = this.db.all(`SELECT * FROM rw_operations WHERE workflow_id=? AND workspace_id=? AND ${FORWARD}`, w.id, w.workspace_id);
    const gaps = this.db.all("SELECT * FROM rw_gaps WHERE workflow_id=? AND workspace_id=? AND status='open'", w.id, w.workspace_id);
    const core = s.steps.filter((x) => !x.afterInvariants); const finals = s.steps.filter((x) => x.afterInvariants);
    const okStep = (st: Snap, x: StepDef) => !!st[k(x.system, x.resource)]?.available && this.expects(x, st[k(x.system, x.resource)].state).every((e) => e.ok);
    const sim = (writes: { step: StepDef; patch: Patch }[]) => {
      const copy: Snap = JSON.parse(JSON.stringify(snap));
      for (const wr of writes) { const key = k(wr.step.system, wr.step.resource); if (!copy[key]?.available) return null; copy[key].state = applyPatch(copy[key].state, { set: wr.patch.set, inc: wr.patch.inc }); }
      const invs = this.evalInvariants(w, this.reader(copy));
      return { invariants: invs.map((i) => ({ id: i.id, label: i.label, ok: i.ok, detail: i.detail })), intentAchieved: s.steps.every((x) => okStep(copy, x)), duplicates: s.steps.filter((x) => copy[k(x.system, x.resource)]?.available && this.expects(x, copy[k(x.system, x.resource)].state).some((e) => e.duplicate)).map((x) => x.label) };
    };
    const missing = core.filter((x) => !okStep(snap, x));
    const done = core.filter((x) => okStep(snap, x) && ops.some((o) => o.step_key === x.key));
    const unreadable = Object.entries(snap).filter(([, o]) => !o.available).map(([key]) => key);
    const options: any[] = [];
    // Resume: run only what is missing (+ held downstream steps); the original key is reused when the effect was never observed.
    {
      const blocked: string[] = [];
      for (const x of missing) {
        if (x.precondition) { const p = snap[k(x.precondition.system, x.precondition.resource)]; if (!p?.available) blocked.push(`${x.precondition.label}: unreadable (unknown ≠ satisfied)`); else if (p.state[x.precondition.field] !== x.precondition.equals) blocked.push(`${x.precondition.label}: no longer true`); }
        if (!snap[k(x.system, x.resource)]?.available) blocked.push(`${x.system}/${x.resource} unreadable`);
        else if (this.expects(x, snap[k(x.system, x.resource)].state).some((e) => e.duplicate)) blocked.push(`${x.label} already over-applied`);
      }
      const writes = [...missing, ...finals].map((x) => ({ step: x, patch: x.patch }));
      const p = missing.length ? sim(writes) : null;
      options.push({ id: 'resume', kind: 'resume', label: missing.length ? `Resume: ${missing.map((x) => x.label).join(' → ')}${finals.length ? `, then ${finals.map((x) => x.label).join(', ')}` : ''}` : 'Resume (nothing missing)', writes: writes.map((x) => ({ step: x.step.key, label: x.step.label, system: x.step.system, resource: x.step.resource, reversibility: x.step.reversibility })), feasible: missing.length > 0 && blocked.length === 0, blockedBy: missing.length ? blocked : ['no missing step to resume'], predicted: p, risk: missing.some((x) => x.reversibility === 'irreversible') ? 'high' : 'low', reversibility: missing.every((x) => x.reversibility !== 'irreversible') ? 'compensable if it goes wrong' : 'contains an irreversible step', cost: `${writes.length} write(s); effects that already happened are not repeated`, policy: 'allowed', blastRadius: [...new Set(writes.map((x) => x.step.system))] });
    }
    // Compensate: undo committed compensable steps in reverse order. Irreversible ones are reported, never "undone".
    {
      const comp = [...done].reverse().filter((x) => x.compensate);
      const irreversible = done.filter((x) => x.reversibility === 'irreversible');
      const writes = comp.map((x) => ({ step: x, patch: x.compensate!.patch }));
      const p = comp.length ? sim(writes) : null;
      options.push({ id: 'compensate', kind: 'compensate', label: comp.length ? `Compensate: ${comp.map((x) => x.compensate!.label).join(' → ')}` : 'Compensate (nothing compensable)', writes: comp.map((x) => ({ step: x.key, label: x.compensate!.label, system: x.system, resource: x.resource, reversibility: 'irreversible' })), feasible: comp.length > 0 && comp.every((x) => snap[k(x.system, x.resource)]?.available), blockedBy: comp.length ? [] : ['no committed compensable step'], notes: irreversible.map((x) => `"${x.label}" is irreversible and cannot be undone`), predicted: p, risk: 'medium', reversibility: 'compensations are final', cost: `${comp.length} write(s); the intended outcome is abandoned`, policy: 'allowed', blastRadius: [...new Set(comp.map((x) => x.system))] });
    }
    // Blind retry of the whole workflow: simulated to show why policy rejects it.
    {
      const writes = core.map((x) => ({ step: x, patch: x.patch }));
      const p = unreadable.length ? null : sim(writes);
      const dupes = p?.duplicates ?? [];
      options.push({ id: 'blind_retry', kind: 'blind_retry', label: 'Re-run the whole workflow from the start (new idempotency keys)', writes: writes.map((x) => ({ step: x.step.key, label: x.step.label, system: x.step.system, resource: x.step.resource, reversibility: x.step.reversibility })), feasible: false, blockedBy: [dupes.length ? `would repeat effects that already happened: ${dupes.join(', ')}` : 'repeats committed side effects without reconciling first'], predicted: p, risk: 'high', reversibility: 'may duplicate irreversible effects', cost: `${writes.length} write(s)`, policy: 'rejected', blastRadius: [...new Set(writes.map((x) => x.step.system))] });
    }
    options.push({ id: 'escalate', kind: 'escalate', label: 'Stop and escalate to a human owner (no writes)', writes: [], feasible: true, blockedBy: [], predicted: sim([]), risk: 'low', reversibility: 'no change', cost: 'human time; the inconsistency remains until someone acts', policy: 'allowed', blastRadius: [] });
    const good = (o: any) => o.feasible && o.policy === 'allowed' && o.predicted && o.predicted.invariants.every((i: any) => i.ok);
    const recommended = options.find((o) => o.kind === 'resume' && good(o) && o.predicted.intentAchieved)?.id ?? options.find((o) => o.kind === 'compensate' && good(o))?.id ?? 'escalate';
    // Adversarial reviewer: challenges every option before a human sees it. Objections are preserved, not voted away.
    const objections: { option: string; by: string; text: string }[] = [];
    for (const o of options) {
      if (o.kind === 'resume' && o.feasible) objections.push({ option: o.id, by: 'adversary', text: 'Relies on the observations taken for this plan; the executor re-reads the basis immediately before writing and aborts if anything changed.' });
      if (o.kind === 'resume' && o.writes.some((x: any) => x.reversibility === 'irreversible')) objections.push({ option: o.id, by: 'adversary', text: 'Includes an irreversible customer-facing write; it runs only after the other invariants are re-verified.' });
      if (o.kind === 'compensate' && o.feasible) objections.push({ option: o.id, by: 'adversary', text: "Compensation abandons the client's intent, and refunds/cancellations are final; prefer resume when it is feasible." });
      if (o.kind === 'compensate' && o.notes?.length) objections.push({ option: o.id, by: 'adversary', text: o.notes.join('; ') });
      if (o.kind === 'blind_retry') objections.push({ option: o.id, by: 'adversary', text: `Rejected: ${o.blockedBy[0]}.` });
      if (o.kind === 'escalate' && o.predicted && !o.predicted.invariants.every((i: any) => i.ok)) objections.push({ option: o.id, by: 'adversary', text: `Leaves ${o.predicted.invariants.filter((i: any) => !i.ok).map((i: any) => i.label).join(', ')} broken until a human acts.` });
      if (o.predicted === null && o.kind !== 'blind_retry' && o.writes.length) objections.push({ option: o.id, by: 'adversary', text: 'Cannot be simulated: part of the state is unreadable. Do not execute on unknown state.' });
    }
    if (unreadable.length) objections.push({ option: '*', by: 'investigator', text: `Still unknown: ${unreadable.join(', ')} could not be read.` });
    const basis = Object.fromEntries(Object.entries(snap).map(([key, o]) => [key, o.available ? stateHash(o.state) : 'unreadable']));
    const id = uid('rp');
    const causalId = this.causal(w, 'system_recovery', 'RECONCILIATION_REQUIRED', `Recovery Planner: ${options.length} options simulated; recommended "${options.find((o) => o.id === recommended)?.label}"`, 'recovery', gaps[0]?.causal_id ?? null, { planId: id });
    this.db.exec("UPDATE rw_recovery_plans SET status='superseded' WHERE workflow_id=? AND workspace_id=? AND status IN ('proposed','awaiting_approval')", w.id, w.workspace_id);
    this.db.insert('rw_recovery_plans', { id, workspace_id: w.workspace_id, workflow_id: w.id, gap_ids: JSON.stringify(gaps.map((g) => g.id)), options: JSON.stringify(options), recommended, chosen: null, objections: JSON.stringify(objections), plan_hash: sha256(stable({ options, recommended, basis, chosen: null })), basis: JSON.stringify(basis), status: 'proposed', result: null, causal_id: causalId, created_at: nowIso(), decided_at: null, finished_at: null });
    this.audit(w, 'recovery', 'recovery_planned', `Recovery plan with ${options.length} options; recommended: ${recommended}.`, { planId: id });
    return id;
  }

  chooseRecovery(a: Actor, wfId: string, optionId: string, opts: { lenient?: boolean } = {}) {
    if (!opts.lenient) this.engine.require(a, 'owner', 'manager');
    const w = this.wf(a.workspaceId, wfId);
    const plan = this.db.get('SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC', w.id, w.workspace_id);
    if (!plan || !['proposed', 'awaiting_approval'].includes(plan.status)) throw new EngineError(409, 'no_plan', 'No open recovery plan.');
    const options = j<any[]>(plan.options, []); const o = options.find((x) => x.id === optionId);
    if (!o) throw new EngineError(404, 'not_found', 'Unknown recovery option.');
    if (o.policy !== 'allowed') throw new EngineError(422, 'policy_rejected', `Option rejected by policy: ${o.blockedBy.join('; ')}`);
    if (!o.feasible) throw new EngineError(422, 'infeasible', `Option not feasible: ${o.blockedBy.join('; ')}`);
    const hash = sha256(stable({ options, recommended: plan.recommended, basis: j(plan.basis, {}), chosen: optionId }));
    this.db.exec("UPDATE rw_recovery_plans SET chosen=?, plan_hash=?, status='awaiting_approval', decided_at=? WHERE id=?", optionId, hash, nowIso(), plan.id);
    this.db.exec("UPDATE rw_approvals SET status='superseded' WHERE workflow_id=? AND workspace_id=? AND subject='recovery' AND status='recorded'", w.id, w.workspace_id);
    this.audit(w, a.name, 'recovery_chosen', `Recovery option chosen: ${o.label} (plan hash ${hash.slice(0, 12)}). Approval must bind to this hash.`);
    return this.detail(a.workspaceId, w.id);
  }

  async executeRecovery(a: Actor, wfId: string, opts: { lenient?: boolean } = {}) {
    if (!opts.lenient) this.engine.require(a, 'owner', 'manager');
    const w = this.wf(a.workspaceId, wfId); const s = this.scenario(w); const ctl = this.controls(w); const lab = new Lab(this.db, w.workspace_id, w.id);
    if (w.state !== 'RECONCILIATION_REQUIRED') throw new EngineError(409, 'bad_state', `Recovery runs from RECONCILIATION_REQUIRED (workflow is ${w.state}).`);
    const plan = this.db.get('SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC', w.id, w.workspace_id);
    if (!plan?.chosen) throw new EngineError(409, 'no_choice', 'Choose a recovery option first.');
    const g = this.governance(w, 'recovery', ctl);
    if (!g.ok) throw new EngineError(409, 'authorization_required', `Recovery not authorized: ${g.reasons.join(' | ')}`);
    const option = j<any[]>(plan.options, []).find((o) => o.id === plan.chosen);
    if (option.kind === 'escalate') {
      this.db.exec("UPDATE rw_recovery_plans SET status='escalated', finished_at=? WHERE id=?", nowIso(), plan.id);
      this.move(w, 'REQUIRES_HUMAN', 'Escalated to a human owner by the approved recovery decision. No writes were made.', a.name);
      return this.finish(w, 'REQUIRES_HUMAN');
    }
    // Guard: the basis the plan was simulated on must still hold.
    const now = this.snapshot(w, lab, 'recovery-guard');
    const basis = j<Record<string, string>>(plan.basis, {});
    const drift = Object.entries(basis).filter(([key, h]) => (now[key]?.available ? stateHash(now[key].state) : 'unreadable') !== h).map(([key]) => key);
    if (drift.length) {
      this.db.exec("UPDATE rw_recovery_plans SET status='stale', result=? WHERE id=?", JSON.stringify({ drift }), plan.id);
      this.planRecovery(w, lab, s);
      throw new EngineError(409, 'plan_stale', `State changed since the plan was simulated (${drift.join(', ')}). A new plan was generated; review and approve it.`);
    }
    this.move(w, 'RECOVERING', `Executing approved recovery: ${option.label}`, a.name);
    this.db.exec("UPDATE rw_recovery_plans SET status='executing' WHERE id=?", plan.id);
    const results: any[] = [];
    let failed = false;
    for (const wr of option.writes as { step: string }[]) {
      const step = s.steps.find((x) => x.key === wr.step)!;
      if (option.kind === 'resume' && step.afterInvariants) continue; // held steps run only after invariants are re-verified
      const parent = this.db.get(`SELECT * FROM rw_operations WHERE workflow_id=? AND workspace_id=? AND step_key=? AND ${FORWARD}`, w.id, w.workspace_id, step.key);
      const isComp = option.kind === 'compensate';
      const eff: StepDef = isComp ? { ...step, label: step.compensate!.label, patch: step.compensate!.patch, expect: [], claim: undefined } : { ...step, claim: undefined };
      const priorPresent = !!parent && (['VERIFIED', 'RECONCILIATION_REQUIRED'].includes(parent.state) || j<any>(parent.declared, {}).settled === 'present');
      // Same key when the original effect was never observed (the provider dedupes a late commit); a corrective key when it was observed and later reversed by someone else.
      const idem = isComp ? `idem_${sha256(`${w.id}|${step.key}|compensate|${plan.id}`).slice(0, 20)}` : (parent?.idempotency_key && !priorPresent ? parent.idempotency_key : `idem_${sha256(`${w.id}|${step.key}|corrective|${plan.id}`).slice(0, 20)}`);
      const op = this.newOp(w, eff, isComp ? 'compensation' : 'recovery', [g.valid[0]?.id].filter(Boolean) as string[], ctl, { parent_op_id: parent?.id ?? null, idempotency_key: idem, gap_id: j<string[]>(plan.gap_ids, [])[0] ?? null, causal_id: plan.causal_id });
      this.moveOp(op, 'AUTHORIZATION_PENDING'); this.moveOp(op, 'AUTHORIZED');
      const b = this.observe(w, lab, 'observer', step.system, step.resource, 'before', op.id); this.db.update('rw_operations', op.id, w.workspace_id, { before_obs: b.id }); op.before_obs = b.id;
      // Guarded attempts: each retry follows a read-back that confirmed absence; a present effect is never repeated.
      let outcome: string = 'absent';
      for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
        outcome = this.execute(w, lab, eff, op, { ...ctl, readBackOnError: true }, isComp ? `${step.key}:compensate` : idem === parent?.idempotency_key ? step.key : `${step.key}:corrective`, false, idem);
        if (outcome !== 'absent') break;
        if (isComp) break;
      }
      let verified = false;
      if (outcome === 'present') {
        const after = this.observe(w, lab, 'verifier', step.system, step.resource, 'verify', op.id);
        // A compensation is verified against ITS OWN expected effect (before-state + compensating patch), never by "tool said ok".
        const target = isComp ? compensationChecks(b.available ? b.state : undefined, step.compensate!.patch, after.available ? after.state : undefined) : this.expects(step, after.state);
        verified = after.available && target.every((c) => c.ok);
        this.db.update('rw_operations', op.id, w.workspace_id, { after_obs: after.id, verifier: JSON.stringify([{ read: 1, available: after.available, checks: target }]) });
        this.moveOp(op, 'VERIFICATION_PENDING'); this.moveOp(op, verified ? 'VERIFIED' : 'FAILED', verified ? {} : { last_error: 'post-recovery read does not show the intended state' });
      }
      results.push({ op: op.id, step: step.key, outcome, verified });
      if (!verified && !isComp) { failed = true; break; }
    }
    let final = this.reconcileAfterRecovery(w, lab, s);
    if (!failed && final.ok && option.kind === 'resume' && this.pendingFinal(w, s).length) {
      await this.forward(w, lab, s, ctl, {}, 'final', this.governance(w, 'plan', ctl).valid.map((r) => r.id));
      final = this.reconcileAfterRecovery(w, lab, s);
    }
    const ok = !failed && final.ok && (option.kind !== 'resume' || final.intent);
    this.db.exec('UPDATE rw_recovery_plans SET status=?, result=?, finished_at=? WHERE id=?', ok ? 'verified' : 'failed', JSON.stringify({ results, invariants: final.invariants }), nowIso(), plan.id);
    if (ok) {
      this.db.exec("UPDATE rw_gaps SET status='resolved', resolved_at=? WHERE workflow_id=? AND workspace_id=? AND status='open'", nowIso(), w.id, w.workspace_id);
      const c = this.contract(w); c.timing = { ...(c.timing ?? {}), recoveredAt: Date.now() }; this.saveContract(w, c);
      this.causal(w, 'system_recovery', 'RECOVERED', `Recovery verified: ${option.label}. Invariants restored${final.intent ? ' and intent achieved' : ' (intent abandoned by compensation)'}.`, 'verifier', plan.causal_id, { planId: plan.id });
      this.move(w, 'RECOVERED', `Recovery "${option.label}" verified by independent reads; ${final.intent ? 'the intended outcome is in place' : 'the committed steps were compensated'}.`, 'verifier');
      this.db.exec('UPDATE rw_workflows SET observed_status=? WHERE id=?', final.intent ? 'consistent' : 'compensated', w.id);
      await this.tell(w, 'status', 'verifier', undefined, `Recovered and verified: ${option.label}.`);
      return this.finish(w, final.intent ? 'RECOVERED' : 'RECOVERED_COMPENSATED');
    }
    if (option.kind === 'compensate') this.upsertGap(w, { cls: 'compensation_failure', subject: 'compensation', title: `Compensation "${option.label}" did not restore: ${final.invariants.filter((i) => !i.ok).map((i) => i.label).join(', ')}`, agents: ['recovery', ...option.writes.map((x: any) => s.steps.find((st) => st.key === x.step)!.agent)], systems: option.blastRadius, expected: final.invariants.map((i) => i.label), declared: 'compensation write accepted by the tool', observed: final.invariants.map((i) => i.detail), evidence: results.map((r) => r.op), parentCausal: plan.causal_id });
    this.causal(w, 'system_recovery', 'REQUIRES_HUMAN', `Recovery did not restore the invariants: ${option.label}`, 'verifier', plan.causal_id, { results });
    this.move(w, 'REQUIRES_HUMAN', `Recovery "${option.label}" ran, but independent reads show the invariants are NOT restored. Escalated; nothing is marked consistent.`, 'verifier');
    return this.finish(w, 'REQUIRES_HUMAN');
  }
  private reconcileAfterRecovery(w: Row, lab: Lab, s: Scenario) {
    const snap = this.snapshot(w, lab, 'post-recovery');
    const invs = this.evalInvariants(w, this.reader(snap));
    const intent = s.steps.every((x) => !!snap[k(x.system, x.resource)]?.available && this.expects(x, snap[k(x.system, x.resource)].state).every((e) => e.ok));
    return { ok: invs.every((i) => i.ok), invariants: invs.map((i) => ({ id: i.id, label: i.label, ok: i.ok, detail: i.detail })), intent };
  }

  /** Re-observe a finished workflow: a verified outcome that no longer holds becomes a stale completion. */
  reaudit(a: Actor, wfId: string) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot re-audit.');
    const w = this.wf(a.workspaceId, wfId); const s = this.scenario(w); const lab = new Lab(this.db, w.workspace_id, w.id);
    if (!['VERIFIED', 'RECOVERED'].includes(w.state)) throw new EngineError(409, 'bad_state', 'Only verified or recovered workflows are re-audited.');
    const r = this.reconcile(w, lab, s);
    if (!r.clean) { this.move(w, 'RECONCILIATION_REQUIRED', 'Re-audit: observed state no longer matches the verified outcome.', 'verifier'); this.planRecovery(w, lab, s); this.finish(w, 'STALE'); }
    else this.audit(w, a.name, 'reaudit', 'Re-audit: the verified outcome still holds.');
    return this.detail(a.workspaceId, w.id);
  }

  cancel(a: Actor, wfId: string, reason: string) {
    this.engine.require(a, 'owner', 'manager');
    const w = this.wf(a.workspaceId, wfId);
    if (!reason.trim()) throw new EngineError(422, 'reason_required', 'Reason required.');
    this.move(w, 'CANCELLED', `Cancelled by ${a.name}: ${reason}`, a.name);
    return this.finish(w, 'CANCELLED');
  }

  // ------------------------------------------------------------------ passports
  private finish(w: Row, declared: string) {
    this.db.exec('UPDATE rw_workflows SET declared_status=?, updated_at=? WHERE id=?', declared, nowIso(), w.id);
    w.declared_status = declared;
    this.issuePassports(w);
    return this.detail(w.workspace_id, w.id);
  }
  private issuePassports(w: Row) {
    const c = this.contract(w);
    const ops = this.db.all('SELECT * FROM rw_operations WHERE workflow_id=? AND workspace_id=? ORDER BY created_at, rowid', w.id, w.workspace_id);
    const obs = (id: string | null) => { if (!id) return null; const o = this.db.get('SELECT * FROM rw_observations WHERE id=? AND workspace_id=?', id, w.workspace_id); return o ? { id: o.id, observer: o.observer, available: !!o.available, state: j(o.state, null), stateHash: o.state_hash, updatedBy: o.updated_by, observedAt: o.observed_at, validUntil: o.valid_until, invalidated: o.invalidated_reason } : null; };
    const approvals = (ids: string[]) => ids.map((id) => this.db.get('SELECT * FROM rw_approvals WHERE id=? AND workspace_id=?', id, w.workspace_id)).filter(Boolean).map((r: any) => ({ id: r.id, subject: r.subject, by: r.user_name, roleAtDecision: r.role_at_decision, channel: r.channel, boundToHash: r.subject_hash, planVersion: r.plan_version, at: r.created_at, expiresAt: r.expires_at }));
    this.db.exec('DELETE FROM rw_passports WHERE workflow_id=? AND workspace_id=?', w.id, w.workspace_id);
    const opPassports = ops.map((op) => {
      const step = c.steps.find((x) => x.key === op.step_key);
      const verifier = j<any[]>(op.verifier, []);
      const failed = verifier.flatMap((v) => (v.checks ?? []).filter((x: any) => !x.ok).map((x: any) => `${x.label}: got ${JSON.stringify(x.got)}`));
      const recov = ops.filter((o) => o.parent_op_id === op.id).map((o) => ({ id: o.id, kind: o.kind, label: o.label, state: o.state, idempotencyKey: o.idempotency_key }));
      const after = obs(op.after_obs);
      const body = {
        passportVersion: 1, kind: 'operation', workspaceId: w.workspace_id, workflowId: w.id, operationId: op.id,
        intent: w.intent, executionContract: { step: op.step_key, label: op.label, kind: op.kind, postconditions: step?.expect.map((e) => e.label) ?? [], precondition: step?.precondition?.label ?? null, reversibility: op.reversibility, consequential: !!op.consequential },
        invariants: c.invariants, planVersion: w.plan_version, planHash: w.plan_hash, approvals: approvals(j<string[]>(op.approval_ids, [])),
        actor: { agent: op.agent, capabilities: agentById(op.agent) ? { write: agentById(op.agent)!.mutate, read: agentById(op.agent)!.observe } : null },
        toolInvocation: { attempts: op.attempts, idempotencyKey: op.idempotency_key, response: j(op.tool_response, null) },
        externalResource: { system: op.system, resource: op.resource, sandbox: LAB_LABEL },
        beforeState: obs(op.before_obs), afterState: after, declared: j(op.declared, {}), verifierResults: verifier, failedConditions: failed,
        recoveryHistory: recov, parentOperation: op.parent_op_id, timestamps: { created: op.created_at, updated: op.updated_at },
        provenance: { verifier: 'ripple-rge/verifier@1 (independent read; never the tool response)', baseline: w.baseline, collaboration: `${w.collab_mode}: ${w.collab_note}` },
        finalStatus: op.state, confidence: op.state === 'VERIFIED' ? (after?.available ? 1 : 0) : op.state === 'EXECUTION_UNKNOWN' ? 0 : op.state === 'OBSERVATION_PENDING' ? 0.2 : 0.5,
        proofBasis: op.state === 'VERIFIED' ? 'independent after-state observation matched every post-condition' : op.state === 'OBSERVATION_PENDING' ? 'NOT PROVEN: only the tool/agent declaration exists' : 'NOT PROVEN',
      };
      return { op, body };
    });
    for (const p of opPassports) this.db.insert('rw_passports', { id: uid('pp'), workspace_id: w.workspace_id, workflow_id: w.id, operation_id: p.op.id, status: p.op.state, body: JSON.stringify(p.body), body_hash: sha256(stable(p.body)), created_at: nowIso() });
    const gaps = this.db.all('SELECT id, class, status, title FROM rw_gaps WHERE workflow_id=? AND workspace_id=? ORDER BY detected_at, rowid', w.id, w.workspace_id);
    const fresh = this.db.get('SELECT observed_status, state FROM rw_workflows WHERE id=?', w.id);
    const wfBody = { passportVersion: 1, kind: 'workflow', workspaceId: w.workspace_id, workflowId: w.id, scenario: w.scenario, title: w.title, intent: w.intent, planVersion: w.plan_version, planHash: w.plan_hash, baseline: w.baseline, declaredStatus: w.declared_status, workflowState: fresh?.state, observedStatus: fresh?.observed_status, operations: opPassports.map((p) => ({ operationId: p.op.id, step: p.op.step_key, kind: p.op.kind, status: p.op.state, bodyHash: sha256(stable(p.body)) })), gaps, recoveryPlans: this.db.all('SELECT id, chosen, status, plan_hash FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at, rowid', w.id, w.workspace_id), invariantsAtLastObservation: this.evalInvariants(w, this.reader(this.lastSnapshot(w))).map((i) => ({ id: i.id, label: i.label, ok: i.ok, detail: i.detail })), issuedAt: nowIso(), verify: 'Recompute sha256 over the stable (key-sorted) JSON of this body and compare with bodyHash.' };
    this.db.insert('rw_passports', { id: uid('pp'), workspace_id: w.workspace_id, workflow_id: w.id, operation_id: null, status: fresh?.state ?? w.state, body: JSON.stringify(wfBody), body_hash: sha256(stable(wfBody)), created_at: nowIso() });
  }
  private lastSnapshot(w: Row): Snap {
    const s = this.scenario(w); const snap: Snap = {};
    for (const r of watchedResources(s)) { const o = this.db.get('SELECT * FROM rw_observations WHERE workflow_id=? AND workspace_id=? AND system=? AND resource=? AND available=1 ORDER BY observed_at DESC, rowid DESC', w.id, w.workspace_id, r.system, r.resource); snap[k(r.system, r.resource)] = { available: !!o, state: j(o?.state, {}), updated_by: o?.updated_by ?? '', obsId: o?.id ?? '' }; }
    return snap;
  }
  passports(ws: string, wfId: string) { this.wf(ws, wfId); return this.db.all('SELECT * FROM rw_passports WHERE workflow_id=? AND workspace_id=? ORDER BY operation_id IS NULL DESC, created_at, rowid', wfId, ws).map((p): Row => ({ ...p, body: j(p.body, {}) })); }
  verifyPassport(ws: string, id: string) {
    const p = this.db.get('SELECT * FROM rw_passports WHERE id=? AND workspace_id=?', id, ws);
    if (!p) throw new EngineError(404, 'not_found', 'Passport not found.');
    const recomputed = sha256(stable(j(p.body, {})));
    return { id, storedHash: p.body_hash, recomputedHash: recomputed, intact: recomputed === p.body_hash };
  }

  // ------------------------------------------------------------------ read models
  detail(ws: string, id: string) {
    const w = this.wf(ws, id); const s = this.scenario(w);
    const q = (t: string, order = 'created_at') => this.db.all(`SELECT * FROM ${t} WHERE workflow_id=? AND workspace_id=? ORDER BY ${order}`, id, ws);
    const ops: Row[] = q('rw_operations', 'created_at, rowid').map((o): Row => ({ ...o, declared: j(o.declared, {}), tool_response: j(o.tool_response, null), verifier: j(o.verifier, []), approval_ids: j(o.approval_ids, []), consequential: !!o.consequential }));
    const lab = new Lab(this.db, ws, id);
    const claims = ops.filter((o) => o.declared.claim).map((o) => ({ agent: o.agent, agentName: agentById(o.agent)?.name ?? o.agent, claim: o.declared.claim, at: o.declared.at }));
    const { fault_state: _fs, ...wfPublic } = w; void _fs;
    return {
      workflow: { ...wfPublic, contract: j(w.contract, {}), controls: j(w.controls, {}), authz_overrides: j(w.authz_overrides, {}) } as Row,
      scenario: { id: s.id, family: s.family, familyLabel: s.familyLabel, title: s.title, showcase: !!s.showcase, faults: s.faults, events: (s.events ?? []).map((e) => e.label) },
      baseline: { id: w.baseline, ...BASELINES[w.baseline] },
      operations: ops,
      handoffs: q('rw_handoffs', 'created_at, rowid').map((h): Row => ({ ...h, body: j(h.body, {}) })),
      observations: q('rw_observations', 'observed_at, rowid').map((o): Row => ({ ...o, state: j(o.state, null), available: !!o.available })),
      approvals: q('rw_approvals', 'created_at, rowid'),
      gaps: q('rw_gaps', 'detected_at, rowid').map(gapOut),
      recoveryPlans: q('rw_recovery_plans', 'created_at, rowid').map((p): Row => ({ ...p, options: j(p.options, []), objections: j(p.objections, []), gap_ids: j(p.gap_ids, []), basis: j(p.basis, {}), result: j(p.result, null) })),
      passports: this.db.all('SELECT id, operation_id, status, body_hash, created_at FROM rw_passports WHERE workflow_id=? AND workspace_id=? ORDER BY operation_id IS NULL DESC, created_at, rowid', id, ws),
      declaredVsObserved: { claims, declaredStatus: w.declared_status, observedStatus: w.observed_status, state: w.state },
      sandbox: { label: LAB_LABEL, resources: lab.resources(), effectLog: lab.effects().map((e) => ({ seq: e.seq, system: e.system, resource: e.resource, op: e.op_key, actor: e.actor, applied: !!e.applied, note: e.note, idempotencyKey: e.idem_key, at: e.created_at })), effectLogNote: 'Sandbox-side effect log (ground truth). Shown for transparency; the engine never reads it — it decides from independent observations only.' },
      causal: this.db.all('SELECT * FROM causal_events WHERE workspace_id=? AND mission_id=? ORDER BY created_at, rowid', ws, id).map((c) => ({ ...c, observed_state: j(c.observed_state, {}) })),
      collab: { mode: w.collab_mode, note: w.collab_note, live: this.engine.collab.describe() },
    };
  }
  list(ws: string, source: string) {
    const rows = this.db.all(`SELECT id, scenario, family, title, state, declared_status, observed_status, baseline, source, bench_run_id, created_at, updated_at FROM rw_workflows WHERE workspace_id=?${source === 'all' ? '' : ' AND source=?'} ORDER BY created_at DESC, rowid DESC LIMIT 200`, ws, ...(source === 'all' ? [] : [source]));
    return rows.map((r) => ({ ...r, openGaps: this.db.get<{ n: number }>("SELECT count(*) n FROM rw_gaps WHERE workflow_id=? AND workspace_id=? AND status='open'", r.id, ws)?.n ?? 0 }));
  }
  gaps(ws: string, opts: { status?: string; source?: string } = {}) {
    const params: string[] = [ws]; let where = 'g.workspace_id=?';
    if (opts.status) { where += ' AND g.status=?'; params.push(opts.status); }
    if (opts.source) { where += ' AND w.source=?'; params.push(opts.source); }
    return this.db.all(`SELECT g.*, w.title AS workflow_title, w.source, w.baseline, w.state AS workflow_state FROM rw_gaps g JOIN rw_workflows w ON w.id=g.workflow_id AND w.workspace_id=g.workspace_id WHERE ${where} ORDER BY g.detected_at DESC, g.rowid DESC LIMIT 300`, ...params).map(gapOut);
  }
  commandCenter(ws: string) {
    const n = (sql: string, ...p: any[]) => this.db.get<{ n: number }>(sql, ws, ...p)?.n ?? 0;
    const live = "w.source='live'";
    return {
      workflows: { active: n(`SELECT count(*) n FROM rw_workflows w WHERE w.workspace_id=? AND ${live} AND state NOT IN ('VERIFIED','RECOVERED','CANCELLED','REQUIRES_HUMAN')`), requiresHuman: n(`SELECT count(*) n FROM rw_workflows w WHERE w.workspace_id=? AND ${live} AND state='REQUIRES_HUMAN'`), verified: n(`SELECT count(*) n FROM rw_workflows w WHERE w.workspace_id=? AND ${live} AND state IN ('VERIFIED','RECOVERED')`), total: n(`SELECT count(*) n FROM rw_workflows w WHERE w.workspace_id=? AND ${live}`) },
      byState: this.db.all(`SELECT state, count(*) n FROM rw_workflows w WHERE w.workspace_id=? AND ${live} GROUP BY state`, ws),
      gaps: { open: n(`SELECT count(*) n FROM rw_gaps g JOIN rw_workflows w ON w.id=g.workflow_id WHERE g.workspace_id=? AND ${live} AND g.status='open'`), byClass: this.db.all(`SELECT g.class, g.status, count(*) n FROM rw_gaps g JOIN rw_workflows w ON w.id=g.workflow_id WHERE g.workspace_id=? AND ${live} GROUP BY g.class, g.status`, ws) },
      partialCommits: n(`SELECT count(*) n FROM rw_gaps g JOIN rw_workflows w ON w.id=g.workflow_id WHERE g.workspace_id=? AND ${live} AND g.class='partial_commit' AND g.status='open'`),
      staleEvidence: n(`SELECT count(*) n FROM rw_observations o JOIN rw_workflows w ON w.id=o.workflow_id WHERE o.workspace_id=? AND ${live} AND (o.invalidated_at IS NOT NULL OR o.available=0)`),
      recoveries: { inProgress: n(`SELECT count(*) n FROM rw_recovery_plans p JOIN rw_workflows w ON w.id=p.workflow_id WHERE p.workspace_id=? AND ${live} AND p.status IN ('proposed','awaiting_approval','executing')`), verified: n(`SELECT count(*) n FROM rw_recovery_plans p JOIN rw_workflows w ON w.id=p.workflow_id WHERE p.workspace_id=? AND ${live} AND p.status='verified'`), failed: n(`SELECT count(*) n FROM rw_recovery_plans p JOIN rw_workflows w ON w.id=p.workflow_id WHERE p.workspace_id=? AND ${live} AND p.status='failed'`) },
      verifiedOutcomes: n(`SELECT count(*) n FROM rw_passports p JOIN rw_workflows w ON w.id=p.workflow_id WHERE p.workspace_id=? AND ${live} AND p.operation_id IS NOT NULL AND p.status='VERIFIED'`),
      agents: AGENTS.map((ag) => ({ ...ag, ops: n(`SELECT count(*) n FROM rw_operations o JOIN rw_workflows w ON w.id=o.workflow_id WHERE o.workspace_id=? AND ${live} AND o.agent=?`, ag.id), openTasks: n(`SELECT count(*) n FROM rw_handoffs h JOIN rw_workflows w ON w.id=h.workflow_id WHERE h.workspace_id=? AND ${live} AND h.to_agent=? AND h.status IN ('sent','acknowledged')`, ag.id) })),
      systems: this.db.all(`SELECT o.system, count(*) reads, sum(o.available) ok, max(o.observed_at) last FROM rw_observations o JOIN rw_workflows w ON w.id=o.workflow_id WHERE o.workspace_id=? AND ${live} GROUP BY o.system ORDER BY o.system`, ws).map((r) => ({ ...r, label: LAB_LABEL })),
      collab: this.engine.collab.describe(),
      benchmarkWorkflows: n("SELECT count(*) n FROM rw_workflows WHERE workspace_id=? AND source='benchmark'"),
    };
  }

  /** Reality audit of the EXISTING mission action ledger: re-reads every executed/verified action from its connector. */
  auditMissionActions(ws: string) {
    const out: any[] = [];
    for (const act of this.db.all("SELECT a.*, m.title AS mission_title FROM actions a JOIN missions m ON m.id=a.mission_id AND m.workspace_id=a.workspace_id WHERE a.workspace_id=? AND a.status IN ('executed','verified','execution_unknown','verification_failed')", ws)) {
      const conn = this.engine.connectors[act.connector];
      let obs: { found: boolean; count: number; content: string } | null = null; let err = '';
      try { obs = conn ? conn.observe({ workspaceId: ws, missionId: act.mission_id, idempotencyKey: act.idempotency_key }) : null; } catch (e) { err = String((e as Error).message); }
      const payload = j<any>(act.payload, {});
      const approval = act.consequential ? this.db.get('SELECT status FROM approvals WHERE subject_id=? AND workspace_id=? ORDER BY created_at DESC', act.id, ws) : null;
      let cls: string | null = null; let detail = '';
      if (act.status === 'execution_unknown') { cls = 'unknown_outcome'; detail = act.last_error ?? 'outcome unknown'; }
      else if (!obs) { cls = 'unknown_outcome'; detail = err || 'connector unavailable'; }
      else if (act.status === 'verified' && !obs.found) { cls = 'stale_completion'; detail = 'verified earlier; the effect is no longer present'; }
      else if (act.status === 'verified' && !obs.content.includes(payload.body ?? '')) { cls = 'stale_completion'; detail = 'verified earlier; the stored content no longer matches the approved text'; }
      else if (obs.count > 1) { cls = 'duplicate_effect'; detail = `${obs.count} effects for one idempotency key`; }
      else if (act.consequential && approval?.status !== 'approved') { cls = 'unauthorized_mutation'; detail = 'executed without a granted approval'; }
      out.push({ actionId: act.id, missionId: act.mission_id, mission: act.mission_title, title: act.title, status: act.status, connector: act.connector, observed: obs ? { found: obs.found, count: obs.count } : null, gap: cls, detail: cls ? detail : 'declared status matches the independent read-back' });
    }
    return { checkedAt: nowIso(), actions: out, gaps: out.filter((x) => x.gap).length };
  }

  /** Cross-system reality graph for one workflow (nodes + edges from persisted rows), with traversal. */
  graph(ws: string, id: string) {
    const d = this.detail(ws, id);
    const nodes: any[] = []; const edges: any[] = []; const add = (n: any) => { if (!nodes.some((x) => x.id === n.id)) nodes.push(n); };
    add({ id: `intent:${id}`, type: 'intent', label: d.workflow.intent, ref: id });
    for (const ap of d.approvals) { add({ id: ap.id, type: 'approval', label: `${ap.subject} approval · ${ap.user_name} (${ap.role_at_decision}, ${ap.channel})`, ref: ap.id }); edges.push({ from: `intent:${id}`, to: ap.id, rel: 'requires' }); }
    for (const h of d.handoffs) add({ id: h.id, type: 'handoff', label: `${h.from_agent} → ${h.to_agent}: ${h.action} [${h.status}]`, ref: h.id });
    for (const op of d.operations) {
      add({ id: op.id, type: op.kind === 'forward' ? 'operation' : op.kind, label: `${op.label} [${op.state}]`, ref: op.id, state: op.state });
      add({ id: `agent:${op.agent}`, type: 'agent', label: agentById(op.agent)?.name ?? op.agent });
      add({ id: `res:${op.system}/${op.resource}`, type: 'resource', label: `${op.system}/${op.resource}` });
      edges.push({ from: `agent:${op.agent}`, to: op.id, rel: 'executed' }, { from: op.id, to: `res:${op.system}/${op.resource}`, rel: 'mutates' });
      for (const apId of op.approval_ids) edges.push({ from: apId, to: op.id, rel: 'authorizes' });
      const h = d.handoffs.find((x: any) => x.task_id === op.id); if (h) edges.push({ from: h.id, to: op.id, rel: 'assigned' });
      if (op.parent_op_id) edges.push({ from: op.parent_op_id, to: op.id, rel: op.kind === 'compensation' ? 'compensated_by' : 'resumed_by' });
      for (const obsId of [op.before_obs, op.after_obs].filter(Boolean)) { const o = d.observations.find((x: any) => x.id === obsId); if (o) { add({ id: o.id, type: 'observation', label: `${o.purpose} read of ${o.system}/${o.resource}: ${o.available ? 'ok' : 'unreadable'}`, ref: o.id }); edges.push({ from: op.id, to: o.id, rel: 'observed_by' }, { from: o.id, to: `res:${o.system}/${o.resource}`, rel: 'reads' }); } }
    }
    const w = this.wf(ws, id);
    for (const i of this.evalInvariants(w, this.reader(this.lastSnapshot(w)))) { add({ id: `inv:${i.id}`, type: 'invariant', label: `${i.label} [${i.ok ? 'holds' : i.unknown ? 'unknown' : 'violated'}]`, ok: i.ok }); for (const r of i.reads) { add({ id: `res:${r}`, type: 'resource', label: r }); edges.push({ from: `res:${r}`, to: `inv:${i.id}`, rel: 'constrains' }); } }
    for (const g of d.gaps) { add({ id: g.id, type: 'gap', label: `${GAP_LABELS[g.class as GapClass]} [${g.status}]`, ref: g.id }); const op = d.operations.find((o: any) => o.step_key === g.subject && o.kind === 'forward'); edges.push({ from: op ? op.id : `intent:${id}`, to: g.id, rel: 'diverged' }); for (const sys of g.systems) for (const n of nodes.filter((x) => x.type === 'resource' && x.label.startsWith(`${sys}/`))) edges.push({ from: g.id, to: n.id, rel: 'affects' }); }
    for (const p of d.recoveryPlans) { add({ id: p.id, type: 'recovery_plan', label: `Recovery plan [${p.status}]${p.chosen ? ` · ${p.chosen}` : ''}`, ref: p.id }); for (const gid of p.gap_ids) edges.push({ from: gid, to: p.id, rel: 'recovered_by' }); }
    const lastPlan = d.recoveryPlans[d.recoveryPlans.length - 1];
    if (lastPlan) for (const o of d.operations.filter((x: any) => x.kind !== 'forward')) edges.push({ from: lastPlan.id, to: o.id, rel: 'executes' });
    for (const pp of d.passports.filter((x: any) => x.operation_id)) { add({ id: pp.id, type: 'passport', label: `Passport [${pp.status}]`, ref: pp.id }); edges.push({ from: pp.operation_id, to: pp.id, rel: 'proven_by' }); }
    const fw = d.operations.filter((o: any) => o.kind === 'forward');
    for (let i = 1; i < fw.length; i++) edges.push({ from: fw[i - 1].id, to: fw[i].id, rel: 'precedes' });
    return { nodes, edges: edges.filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to)) };
  }
  traverse(ws: string, id: string, node: string, dir: 'down' | 'up') {
    const g = this.graph(ws, id);
    if (!g.nodes.some((n) => n.id === node)) throw new EngineError(404, 'not_found', 'Node not in graph.');
    const seen = new Set([node]); const order: string[] = []; const queue = [node]; const via: any[] = [];
    while (queue.length) { const cur = queue.shift()!; for (const e of g.edges.filter((x) => (dir === 'down' ? x.from === cur : x.to === cur))) { const nx = dir === 'down' ? e.to : e.from; via.push(e); if (!seen.has(nx)) { seen.add(nx); order.push(nx); queue.push(nx); } } }
    return { start: node, direction: dir, nodes: order.map((nid) => g.nodes.find((n) => n.id === nid)), edges: via };
  }
}

/** Expected observable effect of a compensating write: `set` fields take the new value; `inc` fields move by the delta from the before-state. */
export function compensationChecks(before: ResourceState | undefined, patch: Patch, after: ResourceState | undefined) {
  const checks: { label: string; field: string; want: unknown; got: unknown; ok: boolean; duplicate: boolean }[] = [];
  for (const [f, v] of Object.entries(patch.set ?? {})) checks.push({ label: `compensation sets ${f} = ${JSON.stringify(v)}`, field: f, want: v, got: after?.[f] ?? null, ok: after !== undefined && after[f] === v, duplicate: false });
  for (const [f, d] of Object.entries(patch.inc ?? {})) {
    const want = before === undefined ? null : Number(before[f] ?? 0) + d;
    checks.push({ label: `compensation moves ${f} by ${d}`, field: f, want, got: after?.[f] ?? null, ok: want !== null && after !== undefined && Number(after[f] ?? 0) === want, duplicate: false });
  }
  if (!checks.length) checks.push({ label: 'compensation has no observable expectation', field: '', want: null, got: null, ok: false, duplicate: false });
  return checks;
}

function gapOut(g: Row): Row {
  return { ...g, label: GAP_LABELS[g.class as GapClass] ?? g.class, agents: j(g.agents, []), systems: j(g.systems, []), expected: j(g.expected, null), declared: j(g.declared, null), observed: j(g.observed, null), evidence: j(g.evidence, []), blast_radius: j(g.blast_radius, {}), predecessors: j(g.predecessors, []), investigation: j(g.investigation, []) };
}
