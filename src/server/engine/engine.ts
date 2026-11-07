import { Db, j, nowIso, sha256, stable, uid, type Row } from '../db/db.js';
import { EngineError, type ActionSpec, type AnalysisContext, type ChangeItem, type MissionState, type RoleResult, type WorkflowPack } from './types.js';
import { assertTransition, STATE_LABEL } from './states.js';
import { buildImpactGraph } from './graph.js';
import { recordCausalEvent } from './causal.js';
import type { PackRegistry } from '../packs/registry.js';
import type { CollabPort, OutboundMessage, RoomInfo, CaseRoomRecord, InboundMessage } from '../collab/port.js';
import { chatRef, parseChatCommand } from '../collab/chat.js';
import { parseStrictDecision } from '../collab/authority.js';
import type { Connector, Observation } from '../connectors/index.js';
import type { TextProvider } from '../agents/provider.js';
import { sanitizeAttachments } from '../capabilities/reclaim/attachments.js';
import { untrustedFindings } from '../packs/untrusted.js';
import { RepeatGuard } from './repeat.js';
import { inQuietWindow, validQuietWindow } from './quiet.js';
import { evaluateCompletion } from './completion.js';
import { MAX_PASSES, ORCHESTRATOR, TASK_TIMEOUT_MS, depsOf, roleFingerprint, validateRoleResult } from './orchestrator.js';
import { CaseOps, type PreflightFn } from './caseops.js';

export interface Actor { id: string; name: string; role: 'owner' | 'manager' | 'member' | 'viewer'; workspaceId: string }
export interface EngineDeps {
  db: Db; packs: PackRegistry; collab: CollabPort; connectors: Record<string, Connector>; provider: TextProvider; today?: () => string;
  /** Switch sender name (lower-case) -> RIPPLE user email. See collab/chat.ts. */ chatIdentities?: Record<string, string>;
  /** Session 21 competition mode (RIPPLE_SWITCH_REQUIRED=1): Switch-native packs run only on a verified Switch fabric (fail-closed). */
  switchRequired?: boolean;
  /** Session 21: the real-server preflight (collab/preflight.ts) used by competition mode. */
  preflight?: PreflightFn;
}
/** How an approval decision arrived. Only CaseOps (after authenticating the Switch event) passes channel 'switch'. */
export interface DecisionVia { channel: 'switch'; decisionId: string; senderId: string; roomId: string | null; messageId: string }

const isManager = (a: Actor) => a.role === 'owner' || a.role === 'manager';
const AGENT_SENDER = 'ripple';
const isoMinus = (ms: number) => new Date(Date.now() - ms).toISOString();

export class Engine {
  /** Session 16: suppresses repeated identical findings (see repeat.ts). */
  private repeats = new RepeatGuard();
  db: Db; packs: PackRegistry; collab: CollabPort; connectors: Record<string, Connector>; provider: TextProvider;
  private chatIdentities: Record<string, string> = {};
  /** Session 21: Switch-native case operations (rooms, authenticated decisions, verifier, receipts, memory, routing). */
  cases: CaseOps;
  constructor(public deps: EngineDeps) {
    this.db = deps.db; this.packs = deps.packs; this.collab = deps.collab; this.connectors = deps.connectors; this.provider = deps.provider;
    this.cases = new CaseOps(this, !!deps.switchRequired, deps.preflight);
    this.chatIdentities = Object.fromEntries(Object.entries(deps.chatIdentities ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v.trim().toLowerCase()]));
  }

  // ---------- helpers ----------
  require(a: Actor, ...roles: Actor['role'][]) {
    if (!roles.includes(a.role)) throw new EngineError(403, 'forbidden', `Role "${a.role}" is not permitted to do this (requires ${roles.join(' or ')}).`);
  }
  mission(ws: string, id: string): Row {
    const m = this.db.get('SELECT * FROM missions WHERE id=? AND workspace_id=?', id, ws);
    if (!m) throw new EngineError(404, 'not_found', 'Mission not found.');
    return m;
  }
  pack(m: Row): WorkflowPack {
    const p = this.packs.get(m.pack_id);
    if (!p) throw new EngineError(500, 'pack_missing', `Workflow pack ${m.pack_id} is not installed.`);
    return p;
  }
  audit(ws: string, missionId: string | null, kind: 'user' | 'agent' | 'system', actor: string, type: string, summary: string, data: unknown = {}) {
    this.db.insert('audit_events', { id: uid('aud'), workspace_id: ws, mission_id: missionId, actor_kind: kind, actor, type, summary, data: JSON.stringify(data), created_at: nowIso() });
  }
  transition(m: Row, to: MissionState, reason: string, actor: string) {
    if (m.state === to) { this.db.update('missions', m.id, m.workspace_id, { state_reason: reason, updated_at: nowIso() }); m.state_reason = reason; return; }
    assertTransition(m.state, to);
    this.db.update('missions', m.id, m.workspace_id, { state: to, state_reason: reason, updated_at: nowIso() });
    this.audit(m.workspace_id, m.id, actor === AGENT_SENDER || actor === ORCHESTRATOR ? 'system' : 'user', actor, 'state_change', `${STATE_LABEL[m.state as MissionState]} → ${STATE_LABEL[to]}: ${reason}`, { from: m.state, to });
    m.state = to; m.state_reason = reason;
  }
  roleUser(ws: string, packId: string, roleKey: string): Row | undefined {
    const r = this.db.get('SELECT user_id FROM agent_roles WHERE workspace_id=? AND pack_id=? AND key=?', ws, packId, roleKey);
    return r?.user_id ? this.db.get('SELECT id,name,role,title FROM users WHERE id=? AND workspace_id=?', r.user_id, ws) : undefined;
  }
  /** Resolves an action's optional named-approver gate to a concrete workspace user (or an explicit "nobody" when unmapped). */
  resolveApprover(ws: string, packId: string, pack: WorkflowPack, spec: ActionSpec): { userId: string | null; label: string } | null {
    if (!spec.approver || (!spec.approver.role && !spec.approver.email)) return null;
    if (spec.approver.email) {
      const u = this.db.get('SELECT id,name FROM users WHERE workspace_id=? AND lower(email)=lower(?)', ws, spec.approver.email);
      return { userId: u?.id ?? null, label: u ? `${u.name} (${spec.approver.email})` : `${spec.approver.email} (not a user of this workspace)` };
    }
    const roleName = pack.roles.find((r) => r.key === spec.approver!.role)?.name ?? spec.approver.role!;
    const u = this.roleUser(ws, packId, spec.approver.role!);
    return { userId: u?.id ?? null, label: u ? `${u.name} (${roleName})` : `${roleName} (unmapped role)` };
  }

  // ---------- room / messages ----------
  async ensureRoom(m: Row, roomKey?: string): Promise<{ row: Row; info: RoomInfo }> {
    const pack = this.pack(m);
    if (pack.caseRooms) {
      // Session 21: a Switch-native pack opens its whole declared topology once; every message goes to its role's room.
      const key = roomKey ?? pack.caseRooms.defaultRoom;
      let row = this.cases.roomByKey(m, key);
      if (!row) { await this.cases.openCaseRooms(m, pack); row = this.cases.roomByKey(m, key) ?? this.cases.roomByKey(m, pack.caseRooms.defaultRoom); }
      if (!row) throw new EngineError(500, 'room_missing', `Case room ${key} was not opened.`);
      return { row, info: this.cases.info(row) };
    }
    const existing = this.db.get('SELECT * FROM rooms WHERE mission_id=? AND workspace_id=? ORDER BY created_at DESC', m.id, m.workspace_id);
    if (existing) return { row: existing, info: { mode: existing.mode, externalId: existing.external_id, name: existing.name, note: existing.note } };
    let info: RoomInfo; let status = 'open';
    try {
      info = await this.collab.openRoom({ missionId: m.id, title: m.title, topic: `RIPPLE mission ${m.id} (${pack.name})`, agentRoles: pack.roles.filter((r) => r.kind === 'agent').map((r) => ({ key: r.key, name: r.name })) });
    } catch (e) {
      // Honest degradation: record the failure and fall back to a clearly-labelled local room.
      info = { mode: 'local', externalId: null, name: `ripple-${m.id}`, note: `Switch room could not be created (${String((e as Error).message).slice(0, 160)}); using LOCAL fallback.` };
      status = 'degraded';
      this.audit(m.workspace_id, m.id, 'system', AGENT_SENDER, 'switch_error', info.note);
    }
    const row = { id: uid('room'), workspace_id: m.workspace_id, mission_id: m.id, mode: info.mode, external_id: info.externalId, name: info.name, status, note: info.note, created_at: nowIso() };
    this.db.insert('rooms', row);
    if (info.externalId && this.collab.subscribe) this.subscribeRoom(m, row, info);
    this.audit(m.workspace_id, m.id, 'system', AGENT_SENDER, 'room_opened', `Collaboration room opened in ${info.mode.toUpperCase()} mode`, { name: info.name });

    // Level 3 (session 15): a pack-declared case topology is bootstrapped generically when the room is a real Switch room.
    if (pack.switchCaseTopology && info.mode === 'switch' && this.collab.openCaseTopology) {
      try {
        const topology = await this.collab.openCaseTopology({ missionId: m.id, caseId: String(m.id), title: m.title, topic: `RIPPLE mission ${m.id} (${pack.name})`, intakeRoom: info, agentRoles: pack.roles.filter((r) => r.kind === 'agent').map((r) => ({ key: r.key, name: r.name })), topology: pack.switchCaseTopology });
        for (const cr of topology.rooms) {
          this.db.insert('rooms', { id: uid('room'), workspace_id: m.workspace_id, mission_id: m.id, mode: 'switch', external_id: cr.externalId, name: cr.name, status: 'open', note: `Level-3 case room (${cr.key}) · ${cr.note}`, created_at: nowIso() });
        }
        this.audit(m.workspace_id, m.id, 'system', AGENT_SENDER, 'case_topology_bootstrapped', `Level 3 Switch topology for case ${topology.caseId}: ${topology.rooms.length} case room(s) linked to #ripple-intake; membership-isolation refusal ${topology.isolation.verifiedRefusal ? `confirmed by the server (HTTP ${topology.isolation.status}, "not a member")` : 'NOT confirmed'}; follow-ups bootstrap ${topology.followUps.bootstrapPosted ? 'posted' : 'not posted'}; ${topology.role?.confirmedHolder ? `settlement-signer held by ${topology.role.confirmedHolder}` : 'settlement-signer not assumed in this runtime'}`, topology as unknown as Record<string, unknown>);
        this.db.insert('messages', { id: uid('msg'), workspace_id: m.workspace_id, mission_id: m.id, room_id: row.id, kind: 'status', sender_kind: 'system', sender_key: 'ripple', sender_name: 'RIPPLE', to_key: null, body: `Level 3 Switch bootstrap for case ${topology.caseId}: ${topology.rooms.map((r) => `#${r.name}`).join(', ') || 'no case rooms'} linked to the intake room. Membership isolation (non-members refused, observed HTTP 400/403 on switch-core 0.31): ${topology.isolation.attempted ? `${topology.isolation.verifiedRefusal ? `the server refused the coordinator (HTTP ${topology.isolation.status})` : 'NOT confirmed'}` : 'not attempted'}. ${topology.labels.join(' ')}`, data: JSON.stringify({ topology }), ref_id: null, source: 'ripple', created_at: nowIso() });
      } catch (e) {
        this.audit(m.workspace_id, m.id, 'system', AGENT_SENDER, 'switch_error', `Level 3 case topology bootstrap failed (mission continues in the intake room): ${String((e as Error).message).slice(0, 200)}`);
      }
    }
    return { row, info };
  }
  /** Records inbound Switch activity for one room (attachments guarded, untrusted text flagged, decisions authenticated). */
  subscribeRoom(m: Row, row: Row, info: RoomInfo) {
    if (!this.collab.subscribe) return;
    // Inbound Switch activity is recorded as ADVISORY, clearly external messages. It never changes mission state by itself:
    // answers and approvals must come through authenticated RIPPLE users.
    // Attachments bypass text guardrails (Switch issue #908), so every one is inspected by RECLAIM's deterministic
    // sanitizer BEFORE any parsing; the sanitized, labelled form is the only thing downstream analysis may read.
    const seen = new Set<string>();
    this.collab.subscribe(info, (im) => {
      if (im.messageId && seen.has(im.messageId)) return; if (im.messageId) seen.add(im.messageId);
      // Session 21: another RIPPLE identity's post heard by this room's listener is our own echo (already recorded by say()),
      // EXCEPT a decision command: an agent "APPROVE" must reach the authority check so it is refused and recorded.
      const ours = (this.collab.identities?.() ?? []).some((x) => x.name.toLowerCase() === (im.senderName ?? '').toLowerCase());
      if (ours && !parseStrictDecision(im.body)) return;
      const guard = sanitizeAttachments(im.attachments ?? []);
      this.db.insert('messages', { id: uid('msg'), workspace_id: m.workspace_id, mission_id: m.id, room_id: row.id, kind: 'status', sender_kind: 'external', sender_key: im.senderId, sender_name: im.senderName || im.senderId, to_key: null, body: im.body, data: JSON.stringify({ addressed: im.addressed, messageId: im.messageId, ...(guard.length ? { attachments: guard.map((g) => ({ safeLabel: g.safeLabel, guard: g.guard, quarantined: g.quarantined, findings: g.findings.map((f) => `${f.code}: ${f.detail}`) })) } : {}) }), ref_id: null, source: 'switch', created_at: nowIso() });
      // Session 16: the same untrusted-text scan used by packs. Flags are advisory: recorded for a human, never acted on.
      // Session 19: a decision typed in the room counts only through the same authority checks as the RIPPLE UI (see chatDecision).
      // Session 21: the strict, hash-bound grammar (APPROVE <case> <A-ref> <sha256>) is authenticated by CaseOps; the legacy
      // short grammar stays available for packs that are not Switch-native, and never in competition mode.
      void (async () => {
        if (await this.cases.onInbound(m, row, im)) return;   // room id comes ONLY from the server event (fail-closed)
        if (!this.pack(m).caseRooms && !this.cases.switchRequired) await this.chatDecision(m, im);
      })().catch((err) => this.audit(m.workspace_id, m.id, 'system', 'switch', 'switch_error', `Inbound decision handling failed: ${String((err as Error).message).slice(0, 200)}`));
      const flags = untrustedFindings(im.body ?? '');
      // Repeat suppression (session 16): the same flag from the same sender is not re-recorded within 5 minutes.
      if (flags.length && this.repeats.admit(`${m.id}|${im.senderId}|${flags.join('|')}`)) this.audit(m.workspace_id, m.id, 'system', 'switch', 'untrusted_content_flagged', `Inbound Switch message from ${im.senderName || im.senderId} flagged for human review (not acted on): ${flags.join('; ')}`, { messageId: im.messageId, flags });
      this.audit(m.workspace_id, m.id, 'system', 'switch', 'switch_inbound', `Message from ${im.senderName || im.senderId} received via Switch (advisory)${guard.some((g) => g.quarantined) ? `; ${guard.filter((g) => g.quarantined).length} attachment(s) quarantined by the RECLAIM guardrail` : guard.length ? `; ${guard.length} attachment(s) passed the guardrail` : ''}`, { messageId: im.messageId });
    });
  }
  /**
   * Session 19: a decision typed in a bridged Switch room. Identity is the Switch sender name, mapped by the operator
   * (SWITCH_CHAT_IDENTITIES). Authority is NOT decided here: answerQuestion / decideApproval run the same checks as the
   * RIPPLE UI (assignee-only, approver gate, four-eyes, manager role, expiry). Every refusal is audited and changes nothing.
   */
  private async chatDecision(m: Row, im: InboundMessage) {
    const cmd = parseChatCommand(im.body);
    if (!cmd) return;
    const who = im.senderName || im.senderId;
    const refuse = (why: string) => this.audit(m.workspace_id, m.id, 'system', 'switch', 'chat_decision_refused', `Chat "${cmd.verb} ${cmd.ref}" from ${who} refused: ${why}`, { messageId: im.messageId, ref: cmd.ref });
    const email = this.chatIdentities[who.trim().toLowerCase()];
    if (!email) return refuse('this Switch sender is not mapped to a RIPPLE user (SWITCH_CHAT_IDENTITIES)');
    const u = this.db.get('SELECT * FROM users WHERE workspace_id=? AND lower(email)=lower(?)', m.workspace_id, email);
    if (!u) return refuse('the mapped email is not a user of this workspace');
    const actor: Actor = { id: u.id, name: u.name, role: u.role, workspaceId: u.workspace_id };
    const qs = this.db.all("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND status='open'", m.id, m.workspace_id).filter((q: Row) => chatRef('Q', q.id) === cmd.ref);
    const aps = this.db.all("SELECT * FROM approvals WHERE mission_id=? AND workspace_id=? AND status='pending'", m.id, m.workspace_id).filter((a: Row) => chatRef('A', a.id) === cmd.ref);
    if (qs.length + aps.length !== 1) return refuse(qs.length + aps.length === 0 ? 'no open question or pending approval has that reference' : 'the reference matches more than one item');
    try {
      if (qs.length) {
        if (cmd.verb === 'decline' && cmd.rest.length < 3) return refuse('a decline needs a reason');
        const text = cmd.verb === 'answer' ? cmd.rest : cmd.verb === 'approve' ? `approve${cmd.rest ? ` ${cmd.rest}` : ''}` : `decline ${cmd.rest}`;
        await this.answerQuestion(actor, m.id, qs[0]!.id, text);
        this.audit(m.workspace_id, m.id, 'user', u.name, 'chat_decision', `${u.name} answered ${cmd.ref} from Switch chat (sender ${who})`, { messageId: im.messageId, ref: cmd.ref, questionId: qs[0]!.id });
        return;
      }
      if (cmd.verb === 'answer') return refuse('an approval is decided with approve or decline');
      if (cmd.verb === 'decline' && cmd.rest.length < 3) return refuse('a decline needs a reason');
      const decision = cmd.verb === 'approve' ? 'approved' : 'rejected';
      await this.decideApproval(actor, m.id, aps[0]!.id, decision, cmd.rest);
      this.audit(m.workspace_id, m.id, 'user', u.name, 'chat_decision', `${u.name} ${decision} ${cmd.ref} from Switch chat (sender ${who})`, { messageId: im.messageId, ref: cmd.ref, approvalId: aps[0]!.id });
    } catch (e) { refuse(String((e as Error).message).slice(0, 200)); }
  }

  async say(m: Row, msg: OutboundMessage & { senderKind: 'agent' | 'human' | 'system'; data?: unknown; refId?: string; roomKey?: string }) {
    const pack = this.pack(m);
    const { row, info } = await this.ensureRoom(m, pack.caseRooms ? this.cases.roomKeyFor(pack, msg) : undefined);
    this.db.insert('messages', { id: uid('msg'), workspace_id: m.workspace_id, mission_id: m.id, room_id: row.id, kind: msg.kind, sender_kind: msg.senderKind, sender_key: msg.senderKey, sender_name: msg.senderName, to_key: msg.toKey ?? null, body: msg.body, data: JSON.stringify(msg.data ?? {}), ref_id: msg.refId ?? null, source: 'ripple', created_at: nowIso() });
    try { await this.collab.send(info, msg); }
    catch (e) {
      // Recorded, never hidden. Critical operations are gated BEFORE they run (CaseOps.assertReady); a post that fails after an
      // effect already happened is marked undelivered instead of aborting halfway through a state change.
      this.audit(m.workspace_id, m.id, 'system', AGENT_SENDER, 'switch_error', `Message not delivered to Switch room #${row.name}: ${String((e as Error).message).slice(0, 200)}`, { undelivered: true, kind: msg.kind });
      this.db.exec("UPDATE messages SET data=json_set(data, '$.undelivered', json('true')) WHERE id=(SELECT id FROM messages WHERE mission_id=? AND workspace_id=? ORDER BY rowid DESC LIMIT 1)", m.id, m.workspace_id);
    }
  }

  // ---------- missions & baseline ----------
  async createMission(a: Actor, input: { packId: string; title: string; plan: unknown; source?: string }) {
    this.require(a, 'owner', 'manager');
    const pack = this.packs.get(input.packId);
    if (!pack) throw new EngineError(404, 'pack_not_found', `Unknown workflow pack "${input.packId}".`);
    await this.cases.assertReady(a.workspaceId, null, pack, 'Opening a case');
    const title = input.title.trim();
    if (!title || title.length > 160) throw new EngineError(422, 'invalid_title', 'Title is required (max 160 chars).');
    const parsed = pack.planSchema.safeParse(input.plan);
    if (!parsed.success) throw new EngineError(422, 'invalid_plan', 'Plan failed validation: ' + parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const id = uid('mis'); const t = nowIso();
    this.db.tx(() => {
      this.db.insert('missions', { id, workspace_id: a.workspaceId, pack_id: pack.id, title, state: 'draft', state_reason: 'Original plan entered. Approve it as the baseline to start tracking changes.', plan_source: input.source ?? 'form', created_by: a.id, created_at: t, updated_at: t });
      const plan = JSON.stringify(parsed.data);
      this.db.insert('artifacts', { id: uid('art'), workspace_id: a.workspaceId, mission_id: id, kind: 'original_plan', name: 'Original event plan (as entered)', content: plan, content_hash: sha256(plan), status: 'final', generated_by: `user:${a.name}`, owner_role: null, created_at: t });
    });
    this.audit(a.workspaceId, id, 'user', a.name, 'mission_created', `Mission "${title}" created from ${pack.name}`, { source: input.source ?? 'form' });
    return this.mission(a.workspaceId, id);
  }

  approveBaseline(a: Actor, missionId: string, note: string) {
    this.require(a, 'owner', 'manager');
    const m = this.mission(a.workspaceId, missionId);
    if (m.state !== 'draft') throw new EngineError(409, 'baseline_exists', 'Baseline can only be approved from draft; later baselines are created when a change completes.');
    const original = this.db.get('SELECT content FROM artifacts WHERE mission_id=? AND workspace_id=? AND kind=?', m.id, m.workspace_id, 'original_plan')!;
    const plan = this.pack(m).planSchema.parse(JSON.parse(original.content));
    const text = JSON.stringify(plan);
    this.db.tx(() => {
      this.db.insert('baselines', { id: uid('bl'), workspace_id: a.workspaceId, mission_id: m.id, version: 1, plan: text, plan_hash: sha256(stable(plan)), note: note || 'Initial approved plan', approved_by: a.id, created_at: nowIso() });
      this.db.update('missions', m.id, a.workspaceId, { current_baseline_version: 1 });
      m.current_baseline_version = 1;
      this.transition(m, 'baseline_ready', 'Baseline v1 approved and saved. Enter the incoming change, request or update to begin impact analysis.', a.name);
    });
    this.audit(a.workspaceId, m.id, 'user', a.name, 'baseline_approved', 'Baseline v1 approved', { hash: sha256(stable(plan)) });
    return this.mission(a.workspaceId, m.id);
  }
  baseline(m: Row, version?: number): Row {
    return this.db.get('SELECT * FROM baselines WHERE mission_id=? AND workspace_id=? AND version=?', m.id, m.workspace_id, version ?? m.current_baseline_version)!;
  }

  // ---------- change intake ----------
  async submitChange(a: Actor, missionId: string, input: unknown, source = 'ui') {
    this.require(a, 'owner', 'manager');
    const m = this.mission(a.workspaceId, missionId);
    if (m.paused) throw new EngineError(409, 'paused', 'Mission is paused. Resume it before submitting a change.');
    if (['draft', 'cancelled'].includes(m.state)) throw new EngineError(409, 'no_baseline', `Cannot submit a change while mission is ${m.state}; approve a baseline first.`);
    const pack = this.pack(m);
    await this.cases.assertReady(a.workspaceId, m.id, pack, 'Submitting a change');
    const parsed = pack.changeSchema.safeParse(input);
    if (!parsed.success) throw new EngineError(422, 'invalid_change', 'Change failed validation: ' + parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const bl = this.baseline(m);
    const items = pack.detectChanges(JSON.parse(bl.plan), parsed.data);
    if (!items.length) throw new EngineError(422, 'no_change', 'The request does not differ from the approved baseline — nothing to analyze.');
    const seq = m.change_seq + 1;
    if (m.state === 'completed') this.transition(m, 'baseline_ready', 'New change received after completion.', a.name);
    this.db.tx(() => {
      this.db.exec("UPDATE change_events SET status='superseded' WHERE mission_id=? AND workspace_id=? AND status='open'", m.id, m.workspace_id);
      this.db.insert('change_events', { id: uid('chg'), workspace_id: a.workspaceId, mission_id: m.id, seq, baseline_version: m.current_baseline_version, source, description: (parsed.data as any).description ?? '', input: JSON.stringify(parsed.data), items: JSON.stringify(items), status: 'open', created_by: a.id, created_at: nowIso() });
      this.db.update('missions', m.id, a.workspaceId, { change_seq: seq });
    });
    this.audit(a.workspaceId, m.id, 'user', a.name, 'change_submitted', `Change #${seq} against baseline v${m.current_baseline_version}: ${items.map((i) => i.label).join(', ')}`, { items });
    recordCausalEvent(this.db, {
      workspaceId: a.workspaceId,
      missionId: m.id,
      causeType: 'contract_deviation',
      lifecycleState: 'PLANNED',
      summary: `Change #${seq} submitted: ${items.map((i) => i.label).join(', ')}`,
      actor: a.name,
      observedState: { seq, itemsCount: items.length },
    });
    m.change_seq = seq;
    return this.runAnalysis(a, m.id, `Change #${seq} submitted`);
  }

  // ---------- analysis ----------
  /** Marks live (not yet executed) actions of earlier analysis revisions as stale so they can never be executed. */
  private markStale(m: Row, reason: string) {
    const live = this.db.all("SELECT * FROM actions WHERE mission_id=? AND workspace_id=? AND status IN ('proposed','approved','failed','verification_failed')", m.id, m.workspace_id);
    for (const act of live) {
      this.db.update('actions', act.id, m.workspace_id, { status: 'stale', stale_reason: reason });
      this.db.exec("UPDATE approvals SET status='stale' WHERE subject_id=? AND workspace_id=? AND status IN ('pending','approved')", act.id, m.workspace_id);
      this.audit(m.workspace_id, m.id, 'system', AGENT_SENDER, 'action_stale', `Action "${act.title}" marked stale: ${reason}`, { actionId: act.id });
    }
    this.db.exec("UPDATE actions SET stale_reason=? WHERE mission_id=? AND workspace_id=? AND status='verified' AND stale_reason IS NULL", reason + ' (effects already applied may be outdated)', m.id, m.workspace_id);
    return live.length;
  }

  /**
   * Mission Orchestrator entry point. Plans the role tasks for a new analysis revision, dispatches them in bounded
   * passes (see orchestrate), then materialises the final results into drafts, work items, actions and approvals.
   */
  async runAnalysis(a: Actor, missionId: string, trigger: string) {
    const m = this.mission(a.workspaceId, missionId);
    if (m.paused) throw new EngineError(409, 'paused', 'Mission is paused. Resume it before agents run again.');
    const pack = this.pack(m);
    const ws = m.workspace_id;
    const change = this.db.get("SELECT * FROM change_events WHERE mission_id=? AND workspace_id=? AND status='open' ORDER BY seq DESC", m.id, ws);
    if (!change) throw new EngineError(409, 'no_open_change', 'There is no open change to analyze.');
    await this.cases.assertReady(ws, m.id, pack, 'Running analysis');
    // Switch-native packs open their rooms BEFORE any state changes: if Switch refuses a room, the case stays where it was.
    if (pack.caseRooms) await this.ensureRoom(m);
    this.transition(m, 'analyzing', `Analyzing: ${trigger}`, a.name);
    const rev = m.analysis_rev + 1;
    this.db.update('missions', m.id, ws, { analysis_rev: rev }); m.analysis_rev = rev;
    const staleCount = this.markStale(m, `${trigger}; this action was built from an earlier analysis (rev ${rev - 1}).`);
    this.db.exec("UPDATE artifacts SET status='superseded' WHERE mission_id=? AND workspace_id=? AND kind NOT IN ('original_plan') AND status IN ('draft','provisional')", m.id, ws);

    const bl = this.baseline(m, change.baseline_version);
    const plan = JSON.parse(bl.plan);
    const input = JSON.parse(change.input);
    const answers: AnalysisContext['answers'] = {};
    for (const q of this.db.all("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND status='answered'", m.id, ws)) answers[q.key] = { text: q.answer, value: j(q.answer_value) };
    const items: ChangeItem[] = pack.detectChanges(plan, input, answers);
    const revisedPlan = pack.applyChange(plan, input, answers);
    const graph = buildImpactGraph(pack, items);
    const nodeIds = new Map<string, string>();
    const addNode = (kind: string, key: string, label: string, data: unknown = {}, status = 'open') => {
      if (nodeIds.has(key)) return nodeIds.get(key)!;
      const id = uid('n'); nodeIds.set(key, id);
      this.db.insert('graph_nodes', { id, workspace_id: ws, mission_id: m.id, analysis_rev: rev, kind, key, label, status, data: JSON.stringify(data) });
      return id;
    };
    const addEdge = (from: string, to: string, relation: string) => {
      const f = nodeIds.get(from), t = nodeIds.get(to); if (!f || !t) return;
      this.db.insert('dependencies', { id: uid('dep'), workspace_id: ws, mission_id: m.id, analysis_rev: rev, from_node: f, to_node: t, relation });
    };
    const impacted = { artifacts: graph.impactedArtifacts, departments: graph.departments };
    this.db.tx(() => {
      for (const n of graph.nodes) addNode(n.kind, n.key, n.label, n.data);
      for (const e of graph.edges) addEdge(e.from, e.to, e.relation);
    });

    const ctx: AnalysisContext = { today: this.deps.today?.() ?? change.created_at.slice(0, 10), plan, change: input, items, answers, revisedPlan, results: {}, impacted, ...(pack.memoryFacts ? { memory: this.cases.memoryFor(ws, pack) } : {}), caseRef: this.cases.caseRef(m) };
    const room = await this.ensureRoom(m);
    await this.say(m, { kind: 'status', senderKey: AGENT_SENDER, senderName: 'RIPPLE', senderKind: 'system', body: `Analysis rev ${rev} started (${trigger}). Change #${change.seq} vs baseline v${change.baseline_version}. Impacted: ${graph.impactedArtifacts.length} artifacts across ${graph.departments.join(', ')}. ${staleCount ? `${staleCount} earlier action(s) marked stale.` : ''}` });

    // 1) Orchestrate: dispatch role tasks (bounded passes, fingerprint reuse, validated outputs, agent requests).
    const run = await this.orchestrate(m, pack, rev, change, ctx, room.info.mode, trigger);
    if (run.stopped) return this.mission(ws, m.id);

    // 2) Materialise final results in roleOrder: drafts (artifacts), then actions that may reference any earlier draft.
    const collected: { spec: ActionSpec; content: string; artifactId: string; draftKind: string }[] = [];
    const draftIndex = new Map<string, { content: string; artifactId: string }>();
    const order = pack.roleOrder.filter((r) => ctx.results[r]);
    for (let i = 0; i < order.length; i++) {
      const roleKey = order[i]; const result = ctx.results[roleKey];
      const blockingOpen = !!this.db.get(`SELECT 1 x FROM questions WHERE mission_id=? AND status='open' AND blocking=1 AND asked_by_role IN (${order.slice(0, i + 1).map(() => '?').join(',')})`, m.id, ...order.slice(0, i + 1));
      for (const d of result.drafts) {
        let content = d.content;
        let by = `${result.analyzer} (deterministic)`;
        if (d.kind === 'client_communication' && this.provider.kind === 'model' && !blockingOpen) {
          const must = [String((revisedPlan as any)?.event?.guestCount ?? ''), ...items.filter((it) => it.field.endsWith('serviceTime')).map((it) => String(it.after))].filter(Boolean);
          const rw = await this.provider.rewrite(d.kind, content, must);
          if (rw) { content = rw; by = `${this.provider.name} (wording only; facts verified present)`; }
        }
        const artId = uid('art');
        this.db.insert('artifacts', { id: artId, workspace_id: ws, mission_id: m.id, kind: d.kind, name: d.name, content, content_hash: sha256(content), status: blockingOpen ? 'provisional' : 'draft', generated_by: by, baseline_version: change.baseline_version, change_seq: change.seq, analysis_rev: rev, owner_role: d.ownerRole, created_at: nowIso() });
        draftIndex.set(d.kind, { content, artifactId: artId });
      }
      for (const act of result.actions) { const dr = draftIndex.get(act.draftKind); if (dr) collected.push({ spec: act, content: dr.content, artifactId: dr.artifactId, draftKind: act.draftKind }); }
    }

    // Session 21: room documents each role writes in ITS room, and cross-room handoffs carrying only claims + references.
    for (const roleKey of order) {
      const r = ctx.results[roleKey];
      if (pack.caseRooms) for (const d of r.documents ?? []) await this.cases.writeDocument(m, pack.caseRooms.roleRoom[roleKey] ?? pack.caseRooms.defaultRoom, { ...d, kind: 'role_document' }, roleKey);
      for (const h of r.handoffs ?? []) {
        const digest = this.cases.recordHandoff(m, rev, roleKey, h.to, h.summary, h.claims, h.evidenceRefs ?? []);
        await this.say(m, { kind: 'handoff', senderKey: roleKey, senderName: pack.roles.find((x) => x.key === roleKey)?.name ?? roleKey, senderKind: 'agent', toKey: h.to, toName: pack.roles.find((x) => x.key === h.to)?.name ?? h.to, body: `${h.summary}\nClaims: ${h.claims.map((c) => `• ${c}`).join(' ')}${h.evidenceRefs?.length ? `\nEvidence references (manifest ids): ${h.evidenceRefs.join(', ')}` : ''}\nHandoff digest SHA-256 ${digest}`, data: { type: 'cross_room_handoff', digest } });
      }
    }

    // work items + task nodes
    this.db.tx(() => {
      for (const r of Object.values(ctx.results)) for (const w of r.workItems) {
        const owner = this.roleUser(ws, pack.id, w.roleKey);
        this.db.insert('work_items', { id: uid('wi'), workspace_id: ws, mission_id: m.id, analysis_rev: rev, node_key: w.artifactKey ? `artifact:${w.artifactKey}` : null, title: w.title, detail: w.detail, department: w.department, owner_user_id: owner?.id ?? null, role_key: w.roleKey, status: 'open', kind: w.kind, due: w.due ?? null, data: JSON.stringify({ key: w.key, by: r.roleKey, dependsOn: w.dependsOn ?? [], satisfiedBy: w.satisfiedBy ?? null }), created_at: nowIso() });
        const tk = `task:${w.key}`;
        addNode('task', tk, w.title, { roleKey: w.roleKey, kind: w.kind, department: w.department });
        if (w.artifactKey) addEdge(`artifact:${w.artifactKey}`, tk, 'requires');
        if (nodeIds.has(`owner:${w.roleKey}`) || addNode('owner', `owner:${w.roleKey}`, pack.roles.find((r) => r.key === w.roleKey)?.name ?? w.roleKey, { roleKey: w.roleKey })) addEdge(tk, `owner:${w.roleKey}`, 'owned_by');
      }
    });
    // actions + approvals (not created when the orchestrator escalated after its iteration limit: a human must decide first)
    for (const c of run.escalated ? [] : collected) {
      const { spec } = c;
      const payload = { subject: c.spec.title, target: spec.target, body: c.content, draftKind: c.draftKind, ...(spec.blockedUntil ? { blockedUntil: spec.blockedUntil } : {}) };
      const payloadHash = sha256(stable(payload));
      const idem = sha256(`${ws}|${m.id}|${spec.effectKey}|${payloadHash}`).slice(0, 32);
      const prior = this.db.get("SELECT * FROM actions WHERE mission_id=? AND idempotency_key=? AND status='verified' ORDER BY executed_at DESC", m.id, idem);
      const aid = uid('act');
      const owner = this.roleUser(ws, pack.id, spec.ownerRole);
      const base = { id: aid, workspace_id: ws, mission_id: m.id, key: spec.key, type: spec.type, title: spec.title, connector: spec.connector, owner_role: spec.ownerRole, owner_user_id: owner?.id ?? null, consequential: spec.consequential, artifact_id: c.artifactId, payload: JSON.stringify(payload), payload_hash: payloadHash, idempotency_key: idem, baseline_version: change.baseline_version, change_seq: change.seq, analysis_rev: rev, created_at: nowIso(), effect_key: spec.effectKey, spec: JSON.stringify({ approver: spec.approver ?? null, coApprover: spec.coApprover ?? null, decisionRoom: spec.decisionRoom ?? null, separateExecutor: !!spec.separateExecutor, requiresVerifierPass: !!spec.requiresVerifierPass }) };
      if (prior) {
        // Identical content was already executed AND verified: do not repeat the effect, carry the proof over.
        this.db.insert('actions', { ...base, status: 'verified', attempts: 0, result: prior.result, executed_at: prior.executed_at });
        this.db.exec("INSERT INTO acknowledgements (id,workspace_id,mission_id,action_id,user_id,status,note,acked_at) SELECT 'ack_'||substr(lower(hex(randomblob(6))),1,12),workspace_id,mission_id,?,user_id,status,note,acked_at FROM acknowledgements WHERE action_id=?", aid, prior.id);
        this.db.exec("UPDATE actions SET status='superseded', stale_reason=? WHERE id=?", `Identical content carried over to ${aid}`, prior.id);
        this.audit(ws, m.id, 'system', AGENT_SENDER, 'action_carried_over', `"${spec.title}": identical content already executed & verified (action ${prior.id}); effect NOT repeated (idempotent).`, { from: prior.id, to: aid });
        continue;
      }
      this.db.insert('actions', { ...base, status: 'proposed', attempts: 0, quiet_hours: spec.quietHours && validQuietWindow(spec.quietHours) ? JSON.stringify(spec.quietHours) : null });
      const gate = this.resolveApprover(ws, pack.id, pack, spec);
      const aprId = uid('apr');
      // Session 21: an approval is bound to the exact payload hash, to its decision room, and (for Switch-native packs in
      // competition mode) to the Switch channel. Two-person control adds a second slot bound to a different person.
      const channel = this.cases.switchRequired && pack.caseRooms && spec.decisionRoom ? 'switch' : 'any';
      const slots: { slot: number; gate: { userId: string | null; label: string } | null; title: string }[] = [{ slot: 1, gate, title: `Approve: ${spec.title}` }];
      if (spec.coApprover) slots.push({ slot: 2, gate: this.resolveApprover(ws, pack.id, pack, { ...spec, approver: { role: spec.coApprover.role } }), title: `Second approval (two-person control): ${spec.title}` });
      // Previous revision's GRANTED approvals of the same action key (markStale turned approved → stale; rejected/expired keep their status).
      const prev = this.db.all("SELECT a.* FROM approvals a JOIN actions x ON x.id=a.subject_id WHERE a.mission_id=? AND a.workspace_id=? AND x.key=? AND x.analysis_rev=? AND a.status='stale' AND a.decided_by IS NOT NULL", m.id, ws, spec.key, rev - 1);
      const prevAct = this.db.get('SELECT payload_hash FROM actions WHERE mission_id=? AND workspace_id=? AND key=? AND analysis_rev=?', m.id, ws, spec.key, rev - 1);
      const carried: string[] = [];
      for (const sl of slots) {
        const id = sl.slot === 1 ? aprId : uid('apr');
        // Carry a GRANTED approval over only when the payload hash is byte-identical and the same person holds the slot.
        const old = prevAct?.payload_hash === payloadHash ? prev.find((p) => (p.slot ?? 1) === sl.slot && p.decided_by === sl.gate?.userId && p.payload_hash === payloadHash) : undefined;
        this.db.insert('approvals', { id, workspace_id: ws, mission_id: m.id, subject_kind: 'action', subject_id: aid, title: sl.title, rationale: spec.rationale, required_role: spec.approvalRole, status: old ? 'approved' : 'pending', baseline_version: change.baseline_version, change_seq: change.seq, analysis_rev: rev, created_at: nowIso(), approver_user_id: sl.gate?.userId ?? null, approver_label: sl.gate?.label ?? null, separate_from_requester: spec.separateFromRequester ? 1 : 0, expires_at: spec.approvalTtlMinutes ? new Date(Date.now() + spec.approvalTtlMinutes * 60_000).toISOString() : null, channel_required: channel, decision_room_key: spec.decisionRoom ?? null, payload_hash: payloadHash, slot: sl.slot, ...(old ? { decided_by: old.decided_by, decided_at: old.decided_at, decision_note: `Carried over from ${old.id}: identical payload hash ${payloadHash.slice(0, 12)}…`, decided_via: old.decided_via, decision_ref: old.decision_ref, carried_from: old.id } : {}) });
        if (old) carried.push(id);
      }
      if (carried.length) {
        this.audit(ws, m.id, 'system', AGENT_SENDER, 'approval_carried_over', `"${spec.title}": ${carried.length} granted approval(s) carried over (identical payload hash, same approver); nobody is re-asked.`, { actionId: aid, approvals: carried });
        if (carried.length === slots.length) this.db.update('actions', aid, ws, { status: 'approved' });
      }
      for (const rk of spec.ackRoles) {
        const u = this.roleUser(ws, pack.id, rk);
        if (u) this.db.insert('acknowledgements', { id: uid('ack'), workspace_id: ws, mission_id: m.id, action_id: aid, user_id: u.id, status: 'pending' });
      }
      addNode('action', `action:${spec.key}`, spec.title, { actionId: aid, connector: spec.connector }, 'proposed');
      const ak = Object.values(ctx.results).flatMap((r) => r.drafts).find((d) => d.kind === c.draftKind)?.artifactKey;
      if (ak && nodeIds.has(`artifact:${ak}`)) addEdge(`artifact:${ak}`, `action:${spec.key}`, 'produces');
      for (const d of pack.decisions) if (nodeIds.has(`decision:${d.key}`) && ak && d.gates.includes(ak)) addEdge(`decision:${d.key}`, `action:${spec.key}`, 'authorizes');
      if (pack.caseRooms) {
        // Session 21: only the room where the decision is owned is asked, with the exact hash-bound command.
        for (const sl of slots) {
          const ap = this.db.get('SELECT * FROM approvals WHERE subject_id=? AND slot=? AND workspace_id=?', aid, sl.slot, ws)!;
          if (ap.status !== 'pending') continue;
          const sender = pack.roles.find((r) => r.key === spec.ownerRole && r.kind === 'agent')?.key ?? Object.entries(pack.caseRooms.roleRoom).find(([k, room]) => room === spec.decisionRoom && pack.roles.find((r) => r.key === k)?.kind === 'agent')?.[0] ?? pack.caseRooms.coordinatorRole;
          await this.say(m, { kind: 'approval_request', senderKey: sender, senderName: pack.roles.find((r) => r.key === sender)?.name ?? sender, senderKind: 'agent', roomKey: spec.decisionRoom ?? pack.caseRooms.roleRoom[sender], toKey: spec.approver?.role, toName: sl.gate?.label ?? 'approver', body: `Decision needed from ${sl.gate?.label ?? 'the bound approver'} (${sl.slot === 2 ? 'second person, two-person control' : 'first approval'}): ${spec.title}. ${spec.rationale}\nPayload SHA-256: ${payloadHash}\nApprove exactly this payload with:\nAPPROVE ${this.cases.caseRef(m)} ${chatRef('A', ap.id)} ${payloadHash}\nor reject with: REJECT ${this.cases.caseRef(m)} ${chatRef('A', ap.id)} <reason>\nOnly the authenticated person bound to this approval can decide it${channel === 'switch' ? ', and only here in Switch' : ''}. Agents cannot approve. Nothing executes until every required person approves.`, refId: aid });
        }
      } else
      await this.say(m, { kind: 'approval_request', senderKey: 'coordinator', senderName: pack.roles.find((r) => r.key === 'coordinator')?.name ?? 'Coordinator', senderKind: 'agent', toKey: 'human_manager', toName: this.roleUser(ws, pack.id, 'human_manager')?.name ?? 'Event Manager', body: `Approval requested: ${spec.title}. ${spec.rationale} Nothing is sent until you approve. Reply in this thread: approve ${chatRef('A', aprId)}, or decline ${chatRef('A', aprId)} <reason>.`, refId: aid });
    }

    const openBlocking = this.db.all("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND status='open' AND blocking=1", m.id, ws);
    if (openBlocking.length) {
      this.transition(m, 'blocked', `Blocked: waiting for human answer — ${openBlocking.map((q) => q.text).join(' | ')}`, AGENT_SENDER);
      await this.say(m, { kind: 'escalation', senderKey: AGENT_SENDER, senderName: 'RIPPLE', senderKind: 'system', toKey: 'human_manager', body: `Mission blocked. No actions or approvals are created until this is answered: ${openBlocking[0].text}` });
    } else {
      const pend = this.db.all("SELECT * FROM approvals WHERE mission_id=? AND workspace_id=? AND status='pending'", m.id, ws).length;
      this.transition(m, 'awaiting_approval', pend ? `${pend} approval(s) required before anything is executed.` : 'No approvals pending.', AGENT_SENDER);
    }
    this.audit(ws, m.id, 'system', AGENT_SENDER, 'analysis_complete', `Analysis rev ${rev} complete (${room.info.mode} collaboration; ${run.passes} pass(es))`, { rev, roles: pack.roleOrder, passes: run.passes, escalated: run.escalated });
    if (pack.caseRooms) this.cases.route(this.mission(ws, m.id), rev);
    this.reconcile(this.mission(ws, m.id), AGENT_SENDER);
    return this.mission(ws, m.id);
  }

  /**
   * Dispatches role tasks for one analysis revision. Pass 1 runs every role in roleOrder. Later passes re-run only
   * roles whose fingerprint changed (their inputs or dependencies produced new output). Stops when nothing changes
   * (converged), when a pause is requested (blocked, resumable), when a role throws (failed), or after MAX_PASSES
   * (escalated to a human as a blocking question).
   */
  private async orchestrate(m: Row, pack: WorkflowPack, rev: number, change: Row, ctx: AnalysisContext, mode: string, trigger: string): Promise<{ stopped: boolean; escalated: boolean; passes: number }> {
    const ws = m.workspace_id;
    const roleName = (k: string) => pack.roles.find((r) => r.key === k)?.name ?? k;
    // Reuse candidates: the latest completed result of each role from an earlier revision.
    const last = new Map<string, { fp: string; result: RoleResult; taskId: string; runId: string }>();
    for (const t of this.db.all("SELECT * FROM workflow_tasks WHERE mission_id=? AND workspace_id=? AND status IN ('done','reused') AND analysis_rev<? ORDER BY analysis_rev DESC, created_at DESC, rowid DESC", m.id, ws, rev)) {
      if (last.has(t.role_key) || !t.run_id) continue;
      const run = this.db.get('SELECT output FROM agent_runs WHERE id=? AND workspace_id=?', t.run_id, ws);
      if (run) last.set(t.role_key, { fp: t.fingerprint, result: j<RoleResult>(run.output, null as any), taskId: t.id, runId: t.run_id });
    }
    let toRun = new Set(pack.roleOrder);
    const reasons = new Map<string, { reason: string; by: string | null }>();
    for (let pass = 1; ; pass++) {
      const kind = pass === 1 ? 'analysis' : 'reanalysis';
      const planned = new Map<string, string>();
      for (const roleKey of pack.roleOrder) {
        if (!toRun.has(roleKey)) continue;
        const id = uid('wft'); planned.set(roleKey, id);
        const why = reasons.get(roleKey);
        this.db.insert('workflow_tasks', { id, workspace_id: ws, mission_id: m.id, analysis_rev: rev, pass, role_key: roleKey, kind, status: 'queued', fingerprint: '', reason: pass === 1 ? trigger : why?.reason ?? 'inputs changed', requested_by: why?.by ?? null, depends_on: JSON.stringify(depsOf(pack, roleKey)), created_at: nowIso() });
      }
      this.audit(ws, m.id, 'system', ORCHESTRATOR, 'orch_pass', `Pass ${pass} of analysis rev ${rev}: ${planned.size} task(s) planned (${[...planned.keys()].map(roleName).join(', ')})`, { rev, pass, roles: [...planned.keys()] });

      const requests: { from: string; to: string; reason: string }[] = [];
      for (let idx = 0; idx < pack.roleOrder.length; idx++) {
        const roleKey = pack.roleOrder[idx];
        const taskId = planned.get(roleKey); if (!taskId) continue;
        // Pause is honoured between tasks: remaining queued work is left resumable, the mission is blocked.
        if (this.db.get('SELECT paused FROM missions WHERE id=? AND workspace_id=?', m.id, ws)?.paused) {
          this.db.exec("UPDATE workflow_tasks SET status='interrupted', error=? WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status='queued'", 'Paused before dispatch', m.id, ws, rev);
          this.audit(ws, m.id, 'system', ORCHESTRATOR, 'orch_paused_mid_run', `Analysis rev ${rev} paused between agent tasks; resume to continue`, { rev });
          this.transition(m, 'blocked', 'Paused by a human between agent tasks. Resume the mission to continue the remaining work.', ORCHESTRATOR);
          return { stopped: true, escalated: false, passes: pass };
        }
        const fp = roleFingerprint(pack, roleKey, ctx);
        const prev = last.get(roleKey);
        if (prev && prev.fp === fp) {
          ctx.results[roleKey] = prev.result;
          this.db.exec("UPDATE workflow_tasks SET status='reused', fingerprint=?, reused_from=?, run_id=?, finished_at=? WHERE id=?", fp, prev.taskId, prev.runId, nowIso(), taskId);
          this.audit(ws, m.id, 'system', ORCHESTRATOR, 'orch_task_reused', `${roleName(roleKey)}: inputs unchanged since its last run, so its previous result was reused (not re-run).`, { taskId, from: prev.taskId });
          continue;
        }
        // ---- dispatch the role ----
        const runId = uid('run'); const started = nowIso();
        this.db.insert('agent_runs', { id: runId, workspace_id: ws, mission_id: m.id, analysis_rev: rev, role_key: roleKey, status: 'working', mode: `${mode}/rule-engine`, started_at: started });
        this.db.exec("UPDATE workflow_tasks SET status='running', fingerprint=?, run_id=?, attempts=attempts+1, started_at=? WHERE id=?", fp, runId, started, taskId);
        const prevKey = idx > 0 ? pack.roleOrder[idx - 1] : null;
        const why = reasons.get(roleKey);
        await this.say(m, { kind: 'handoff', senderKey: prevKey ?? AGENT_SENDER, senderName: prevKey ? roleName(prevKey) : 'RIPPLE', senderKind: prevKey ? 'agent' : 'system', toKey: roleKey, toName: roleName(roleKey), body: `Handoff to ${roleName(roleKey)}${pass > 1 ? ` (pass ${pass}${why ? `: ${why.reason}` : ''})` : ''}: ${pack.roles.find((r) => r.key === roleKey)?.responsibility} Inputs: change items (${ctx.items.length}), baseline v${change.baseline_version}${Object.keys(ctx.results).length ? `, outputs from ${Object.keys(ctx.results).filter((k) => k !== roleKey).map(roleName).join(', ')}` : ''}.`, data: { runId, taskId, type: 'handoff', pass } });
        let raw: unknown;
        try { raw = pack.analyzeRole(roleKey, ctx); }
        catch (e) {
          const msg = String((e as Error).message);
          this.db.exec("UPDATE agent_runs SET status='failed', summary=?, finished_at=? WHERE id=?", msg, nowIso(), runId);
          this.db.exec("UPDATE workflow_tasks SET status='failed', error=?, finished_at=? WHERE id=?", msg, nowIso(), taskId);
          this.db.exec("UPDATE workflow_tasks SET status='cancelled', error=? WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status='queued'", 'Analysis failed before this task ran', m.id, ws, rev);
          await this.say(m, { kind: 'escalation', senderKey: roleKey, senderName: roleName(roleKey), senderKind: 'agent', toKey: 'human_manager', body: `I could not complete my analysis: ${msg}. Human intervention required.` });
          this.transition(m, 'failed', `${roleName(roleKey)} failed: ${msg}`, AGENT_SENDER);
          return { stopped: true, escalated: false, passes: pass };
        }
        // Validate the structured output BEFORE it can touch mission state.
        const v = validateRoleResult(pack, roleKey, raw);
        if (!v.ok) {
          this.db.exec("UPDATE agent_runs SET status='failed', summary=?, finished_at=? WHERE id=?", `Output rejected: ${v.error}`, nowIso(), runId);
          this.db.exec("UPDATE workflow_tasks SET status='rejected', error=?, finished_at=? WHERE id=?", v.error, nowIso(), taskId);
          this.audit(ws, m.id, 'system', ORCHESTRATOR, 'orch_output_rejected', `${roleName(roleKey)} output rejected and discarded: ${v.error}`, { taskId });
          const qkey = `output_rejected_${roleKey}_${rev}`;
          if (!this.db.get('SELECT 1 x FROM questions WHERE mission_id=? AND key=?', m.id, qkey)) {
            const assignee = this.roleUser(ws, pack.id, 'human_manager');
            this.db.insert('questions', { id: uid('q'), workspace_id: ws, mission_id: m.id, analysis_rev: rev, key: qkey, asked_by_role: roleKey, assignee_user_id: assignee?.id ?? null, text: `${roleName(roleKey)} returned output that failed validation (${v.error}). Its result was discarded. Re-run the analysis, or record how to proceed.`, blocking: 1, status: 'open', created_at: nowIso(), assignee_only: 0 });
          }
          continue; // no drafts, actions or questions from a rejected output; other roles proceed
        }
        const result = v.result;
        ctx.results[roleKey] = result;
        last.set(roleKey, { fp, result, taskId, runId });
        // questions (keyed per mission; an existing answered question is never re-opened)
        for (const q of result.questions) {
          const ex = this.db.get('SELECT * FROM questions WHERE mission_id=? AND key=?', m.id, q.key);
          const assignee = this.roleUser(ws, pack.id, q.assigneeRole);
          if (!ex) {
            const qid = uid('q');
            this.db.insert('questions', { id: qid, workspace_id: ws, mission_id: m.id, analysis_rev: rev, key: q.key, asked_by_role: roleKey, assignee_user_id: assignee?.id ?? null, text: q.text, blocking: q.blocking, status: 'open', created_at: nowIso(), assignee_only: q.assigneeOnly ? 1 : 0 });
            await this.say(m, { kind: 'question', senderKey: roleKey, senderName: roleName(roleKey), senderKind: 'agent', toKey: q.assigneeRole, toName: assignee?.name ?? roleName(q.assigneeRole), body: `${q.blocking ? '⛔ BLOCKING QUESTION' : 'Question'}: ${q.text} Reply in this thread: answer ${chatRef('Q', qid)} <text>${q.blocking ? `, or approve ${chatRef('Q', qid)}, or decline ${chatRef('Q', qid)} <reason>` : ''}.`, refId: qid });
          } else if (ex.status === 'open') this.db.exec('UPDATE questions SET text=?, analysis_rev=? WHERE id=?', q.text, rev, ex.id);
        }
        for (const req of result.requests ?? []) requests.push({ from: roleKey, to: req.roleKey, reason: req.reason });
        this.db.exec("UPDATE agent_runs SET status='done', summary=?, output=?, finished_at=? WHERE id=?", result.summary, JSON.stringify(result), nowIso(), runId);
        this.db.exec("UPDATE workflow_tasks SET status='done', finished_at=? WHERE id=?", nowIso(), taskId);
        const risks = result.findings.filter((f) => f.severity === 'risk').length;
        await this.say(m, { kind: 'finding', senderKey: roleKey, senderName: roleName(roleKey), senderKind: 'agent', toKey: 'human_manager', body: `${result.summary}${risks ? ` ${risks} item(s) flagged for human review.` : ''}\n${result.findings.slice(0, 6).map((f) => `• [${f.severity}] ${f.text}`).join('\n')}`, data: { runId, taskId, analyzer: result.analyzer, pass } });
      }

      // Agent requests are messages: recorded and routed. A request is honoured (its target re-runs) only when that
      // target's inputs actually changed after this pass; otherwise it is recorded as already converged.
      const changed = pack.roleOrder.filter((r) => last.has(r) && last.get(r)!.fp !== roleFingerprint(pack, r, ctx));
      for (const r of requests) {
        await this.say(m, { kind: 'handoff', senderKey: r.from, senderName: roleName(r.from), senderKind: 'agent', toKey: r.to, toName: roleName(r.to), body: `Request to ${roleName(r.to)}: ${r.reason}`, data: { type: 'request', pass, from: r.from, to: r.to } });
        const honoured = changed.includes(r.to);
        this.audit(ws, m.id, 'system', ORCHESTRATOR, honoured ? 'orch_request_honoured' : 'orch_request_converged', `${roleName(r.from)} → ${roleName(r.to)}: ${r.reason}${honoured ? ' (target inputs changed; re-running)' : ' (target inputs unchanged; no re-run needed)'}`, { from: r.from, to: r.to, pass });
      }
      if (changed.length === 0) {
        this.audit(ws, m.id, 'system', ORCHESTRATOR, 'orch_converged', `Converged after ${pass} pass(es): no role inputs changed.`, { rev, passes: pass });
        return { stopped: false, escalated: false, passes: pass };
      }
      if (pass >= MAX_PASSES) {
        // Bounded: stop the automatic loop and put the unresolved issue in front of a human.
        const qkey = `iteration_limit_${rev}`;
        const assignee = this.roleUser(ws, pack.id, 'human_manager');
        const text = `The agents did not converge after ${MAX_PASSES} passes (still changing: ${changed.map(roleName).join(', ')}). Automatic re-analysis stopped; a human must decide how to proceed before anything is approved.`;
        if (!this.db.get('SELECT 1 x FROM questions WHERE mission_id=? AND key=?', m.id, qkey)) this.db.insert('questions', { id: uid('q'), workspace_id: ws, mission_id: m.id, analysis_rev: rev, key: qkey, asked_by_role: 'coordinator', assignee_user_id: assignee?.id ?? null, text, blocking: 1, status: 'open', created_at: nowIso(), assignee_only: 0 });
        this.audit(ws, m.id, 'system', ORCHESTRATOR, 'orch_iteration_limit', text, { rev, passes: pass, changed });
        await this.say(m, { kind: 'escalation', senderKey: ORCHESTRATOR, senderName: 'Mission Orchestrator', senderKind: 'system', toKey: 'human_manager', body: text });
        return { stopped: false, escalated: true, passes: pass };
      }
      for (const r of changed) if (!reasons.has(r)) reasons.set(r, { reason: `inputs changed after pass ${pass}`, by: null });
      for (const r of requests) if (changed.includes(r.to)) reasons.set(r.to, { reason: r.reason, by: r.from });
      toRun = new Set(changed);
    }
  }

  // ---------- pause / resume / reassignment / recovery ----------
  pauseMission(a: Actor, missionId: string, reason: string) {
    this.require(a, 'owner', 'manager');
    const m = this.mission(a.workspaceId, missionId);
    if (m.paused) throw new EngineError(409, 'already_paused', 'Mission is already paused.');
    if (['completed', 'cancelled'].includes(m.state)) throw new EngineError(409, 'closed', `Mission is ${m.state}.`);
    this.db.update('missions', m.id, a.workspaceId, { paused: 1, updated_at: nowIso() });
    this.audit(a.workspaceId, m.id, 'user', a.name, 'orch_paused', `Paused by ${a.name}: ${reason.trim() || 'no reason given'}. Agents stop before their next task; executions are refused.`, { reason });
    return this.mission(a.workspaceId, m.id);
  }

  /** Resumes a paused mission. Interrupted or unfinished analysis of the open change is re-run (completed roles are reused). */
  async resumeMission(a: Actor, missionId: string) {
    this.require(a, 'owner', 'manager');
    const m = this.mission(a.workspaceId, missionId);
    if (!m.paused) throw new EngineError(409, 'not_paused', 'Mission is not paused.');
    this.db.update('missions', m.id, a.workspaceId, { paused: 0, updated_at: nowIso() });
    this.audit(a.workspaceId, m.id, 'user', a.name, 'orch_resumed', `Resumed by ${a.name}`, {});
    const open = this.db.get("SELECT 1 x FROM change_events WHERE mission_id=? AND workspace_id=? AND status='open'", m.id, a.workspaceId);
    const unfinished = this.db.get("SELECT 1 x FROM workflow_tasks WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status IN ('queued','interrupted','timed_out')", m.id, a.workspaceId, m.analysis_rev);
    if (open && (unfinished || m.state === 'analyzing')) return this.runAnalysis(a, m.id, `Resumed by ${a.name}`);
    return this.mission(a.workspaceId, m.id);
  }

  /** Manager-requested re-run of analysis after an interruption, timeout or rejected output. Completed agent work is reused. */
  async retryAnalysis(a: Actor, missionId: string) {
    this.require(a, 'owner', 'manager');
    const m = this.mission(a.workspaceId, missionId);
    if (m.paused) throw new EngineError(409, 'paused', 'Mission is paused. Resume it before retrying.');
    if (!this.db.get("SELECT 1 x FROM change_events WHERE mission_id=? AND workspace_id=? AND status='open'", m.id, a.workspaceId)) throw new EngineError(409, 'no_open_change', 'There is no open change to re-analyse.');
    if (!['blocked', 'failed', 'analyzing'].includes(m.state)) throw new EngineError(409, 'bad_state', `Re-analysis is offered from blocked or failed states (mission is ${m.state}).`);
    return this.runAnalysis(a, m.id, `Retry requested by ${a.name}`);
  }

  /** Human reassignment of an open work item to another workspace member (managers only; audited). */
  reassignWorkItem(a: Actor, missionId: string, wiId: string, userId: string) {
    this.require(a, 'owner', 'manager');
    const m = this.mission(a.workspaceId, missionId);
    const wi = this.db.get('SELECT * FROM work_items WHERE id=? AND mission_id=? AND workspace_id=?', wiId, m.id, a.workspaceId);
    if (!wi) throw new EngineError(404, 'not_found', 'Work item not found.');
    if (wi.status === 'done') throw new EngineError(409, 'done', 'A completed work item cannot be reassigned.');
    const to = this.db.get('SELECT id,name,role FROM users WHERE id=? AND workspace_id=?', userId, a.workspaceId);
    if (!to || to.role === 'viewer') throw new EngineError(422, 'invalid_assignee', 'Assignee must be an active member of this workspace (not a viewer).');
    const from = wi.owner_user_id ? this.db.get('SELECT name FROM users WHERE id=?', wi.owner_user_id)?.name ?? 'unknown' : 'unassigned';
    this.db.update('work_items', wi.id, a.workspaceId, { owner_user_id: to.id });
    this.audit(a.workspaceId, m.id, 'user', a.name, 'work_item_reassigned', `"${wi.title}" reassigned from ${from} to ${to.name}`, { id: wi.id, to: to.id });
    return this.mission(a.workspaceId, m.id);
  }

  /** Restart recovery: tasks left `running` by a previous process are marked interrupted and the mission is blocked, resumable. */
  recoverInterrupted(): number {
    let count = 0;
    for (const { id: ws } of this.db.all<{ id: string }>('SELECT id FROM workspaces')) {
      for (const t of this.db.all("SELECT * FROM workflow_tasks WHERE workspace_id=? AND status='running'", ws)) {
        this.db.exec("UPDATE workflow_tasks SET status='interrupted', error=?, finished_at=? WHERE id=?", 'Server restarted while this task was running', nowIso(), t.id);
        this.db.exec("UPDATE agent_runs SET status='failed', summary=?, finished_at=? WHERE id=? AND status='working'", 'Interrupted by server restart', nowIso(), t.run_id);
        this.audit(ws, t.mission_id, 'system', ORCHESTRATOR, 'orch_interrupted', `Task "${t.role_key}" (rev ${t.analysis_rev}) was interrupted by a restart`, { taskId: t.id });
        count++;
      }
      for (const m of this.db.all("SELECT * FROM missions WHERE workspace_id=? AND state='analyzing'", ws)) {
        this.transition(m, 'blocked', 'Interrupted by a server restart. Resume the mission to re-run analysis (completed agent work is reused).', ORCHESTRATOR);
      }
    }
    return count;
  }

  /** Agent-timeout recovery: running tasks older than the timeout are marked timed_out and escalated (no silent hang). */
  sweepStaleTasks(timeoutMs = TASK_TIMEOUT_MS): number {
    const cutoff = isoMinus(timeoutMs);
    let count = 0;
    for (const { id: ws } of this.db.all<{ id: string }>('SELECT id FROM workspaces')) {
      for (const t of this.db.all("SELECT * FROM workflow_tasks WHERE workspace_id=? AND status='running' AND started_at < ?", ws, cutoff)) {
        this.db.exec("UPDATE workflow_tasks SET status='timed_out', error=?, finished_at=? WHERE id=?", `No result within ${Math.round(timeoutMs / 1000)}s`, nowIso(), t.id);
        this.db.exec("UPDATE agent_runs SET status='failed', summary=?, finished_at=? WHERE id=? AND status='working'", 'Timed out', nowIso(), t.run_id);
        this.audit(ws, t.mission_id, 'system', ORCHESTRATOR, 'orch_timed_out', `Task "${t.role_key}" timed out; escalated to a human`, { taskId: t.id });
        const room = this.db.get('SELECT id FROM rooms WHERE mission_id=? AND workspace_id=? ORDER BY created_at DESC', t.mission_id, ws);
        if (room) this.db.insert('messages', { id: uid('msg'), workspace_id: ws, mission_id: t.mission_id, room_id: room.id, kind: 'escalation', sender_kind: 'system', sender_key: ORCHESTRATOR, sender_name: 'Mission Orchestrator', to_key: 'human_manager', body: `Agent task "${t.role_key}" did not respond within the time limit. Resume the mission to retry.`, data: '{}', ref_id: null, source: 'ripple', created_at: nowIso() });
        const m = this.db.get('SELECT * FROM missions WHERE id=? AND workspace_id=?', t.mission_id, ws);
        if (m && m.state === 'analyzing') this.transition(m, 'blocked', `Agent "${t.role_key}" timed out. Resume the mission to retry.`, ORCHESTRATOR);
        count++;
      }
    }
    return count;
  }

  // ---------- questions ----------
  async answerQuestion(a: Actor, missionId: string, questionId: string, text: string) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot answer questions.');
    const m = this.mission(a.workspaceId, missionId);
    if (m.paused) throw new EngineError(409, 'paused', 'Mission is paused. Resume it before answering questions.');
    const q = this.db.get('SELECT * FROM questions WHERE id=? AND mission_id=? AND workspace_id=?', questionId, m.id, a.workspaceId);
    if (!q) throw new EngineError(404, 'not_found', 'Question not found.');
    if (q.status !== 'open') throw new EngineError(409, 'already_answered', 'Question is already answered.');
    if (q.assignee_only && q.assignee_user_id !== a.id) throw new EngineError(403, 'forbidden', q.assignee_user_id ? 'Only the person this question is assigned to can answer it (managers cannot answer on their behalf).' : 'This question is assignee-only but no person is mapped to the assignee role, so nobody can answer it. Map the role to a user first.');
    if (!isManagerRole(a) && q.assignee_user_id !== a.id) throw new EngineError(403, 'forbidden', 'Only the assignee or a manager can answer this question.');
    if (['completed', 'cancelled', 'failed'].includes(m.state)) throw new EngineError(409, 'closed', `Mission is ${m.state}.`);
    const pack = this.pack(m);
    const bl = this.baseline(m);
    const parsed = pack.parseAnswer ? pack.parseAnswer(q.key, text, JSON.parse(bl.plan)) : { value: text.trim() };
    if (parsed.error) throw new EngineError(422, 'invalid_answer', parsed.error);
    this.db.exec("UPDATE questions SET status='answered', answer=?, answer_value=?, answered_by=?, answered_at=? WHERE id=?", text.trim(), JSON.stringify(parsed.value ?? null), a.id, nowIso(), q.id);
    this.audit(a.workspaceId, m.id, 'user', a.name, 'question_answered', `Answered "${q.key}": ${text.trim().slice(0, 120)}`, { questionId: q.id });
    await this.say(m, { kind: 'answer', senderKey: 'human', senderName: a.name, senderKind: 'human', toKey: q.asked_by_role, body: `Answer to ${q.key}: ${text.trim()}`, refId: q.id });
    return this.runAnalysis(a, m.id, `Answer received for "${q.key}"`);
  }

  // ---------- approvals ----------
  /** Session 16 (Shipyard approval TTL): every pending approval past its expiry becomes expired and its action returns to stale. */
  sweepExpiredApprovals(nowMs: number = Date.now()): number {
    const rows = this.db.all("SELECT * FROM approvals WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < ?", new Date(nowMs).toISOString());
    for (const ap of rows) this.expireApproval(ap, ap.workspace_id, ap.mission_id);
    return rows.length;
  }
  private expireApproval(ap: Row, ws: string, missionId: string) {
    this.db.exec("UPDATE approvals SET status='expired', decided_at=?, decision_note=? WHERE id=?", nowIso(), 'Expired: not decided within the approval window.', ap.id);
    this.db.exec("UPDATE actions SET status='stale', stale_reason=? WHERE id=? AND status='proposed'", 'Approval expired before it was decided', ap.subject_id);
    this.audit(ws, missionId, 'system', AGENT_SENDER, 'approval_expired', `Approval expired (not decided in time): ${ap.title}`, { approvalId: ap.id, actionId: ap.subject_id });
  }

  async decideApproval(a: Actor, missionId: string, approvalId: string, decision: 'approved' | 'rejected', note: string, via?: DecisionVia) {
    const m = this.mission(a.workspaceId, missionId);
    const ap = this.db.get('SELECT * FROM approvals WHERE id=? AND mission_id=? AND workspace_id=?', approvalId, m.id, a.workspaceId);
    if (!ap) throw new EngineError(404, 'not_found', 'Approval not found.');
    // Session 21: a Switch-bound approval (competition mode) is decided ONLY by an authenticated Switch event, never a UI click.
    if (ap.channel_required === 'switch' && via?.channel !== 'switch') {
      const room = ap.decision_room_key ? this.cases.roomByKey(m, ap.decision_room_key) : undefined;
      this.audit(a.workspaceId, m.id, 'user', a.name, 'local_decision_refused', `Local decision on "${ap.title}" refused: competition mode requires the decision in Switch room #${room?.name ?? ap.decision_room_key}`, { approvalId: ap.id });
      throw new EngineError(409, 'switch_approval_required', `This approval must be decided by its bound person in Switch room #${room?.name ?? ap.decision_room_key}, quoting the payload hash. A RIPPLE UI or console decision does not count in competition mode.`);
    }
    if (ap.required_role === 'manager' && !isManagerRole(a)) throw new EngineError(403, 'forbidden', 'Only a manager/owner can decide this approval.');
    if (ap.required_role === 'owner' && a.role !== 'owner') throw new EngineError(403, 'forbidden', 'Only the workspace owner can decide this approval.');
    // who-specific gate (optional, fail-closed): approver_label is set whenever the action declared an `approver`
    if (ap.approver_label && ap.approver_user_id !== a.id) throw new EngineError(403, 'forbidden', ap.approver_user_id ? `Only ${ap.approver_label} can decide this approval.` : `This approval is bound to ${ap.approver_label}, but no person is mapped to it in this workspace, so nobody can decide it. Map the role to a user first.`);
    // four-eyes (optional per action): the person who submitted the change may not decide its approval
    if (ap.separate_from_requester) {
      const sub = this.db.get('SELECT created_by FROM change_events WHERE mission_id=? AND workspace_id=? AND seq=?', m.id, a.workspaceId, ap.change_seq);
      if (sub?.created_by === a.id) throw new EngineError(403, 'four_eyes', 'Four-eyes rule: the person who submitted this change cannot approve this action. A different person must decide it.');
    }
    if (ap.status === 'pending' && ap.expires_at && nowIso() > ap.expires_at) {
      this.expireApproval(ap, a.workspaceId, m.id);
      throw new EngineError(409, 'expired', 'This approval expired before it was decided. Its action has been returned to stale; propose it again.');
    }
    if (ap.status === 'stale') throw new EngineError(409, 'stale', 'This approval is stale — the plan changed after it was requested. Review the new proposal.');
    if (ap.status !== 'pending') throw new EngineError(409, 'already_decided', `Approval already ${ap.status}.`);
    if (ap.change_seq !== m.change_seq || ap.analysis_rev !== m.analysis_rev) throw new EngineError(409, 'stale', 'Approval does not match the current change/analysis version.');
    if (decision === 'rejected' && !note.trim()) throw new EngineError(422, 'note_required', 'A reason is required when rejecting.');
    // Session 21 two-person control: the same person may not fill two approval slots of one action.
    const siblings = this.db.all('SELECT * FROM approvals WHERE subject_id=? AND workspace_id=? AND analysis_rev=? AND id!=?', ap.subject_id, a.workspaceId, ap.analysis_rev, ap.id);
    if (decision === 'approved' && siblings.some((x) => x.decided_by === a.id && x.status === 'approved')) {
      this.audit(a.workspaceId, m.id, 'user', a.name, 'two_person_refused', `Two-person control: ${a.name} already approved another slot of "${ap.title}"`, { approvalId: ap.id });
      throw new EngineError(403, 'two_person', 'Two-person control: you already approved this action; a second, different person must give the other approval.');
    }
    if (m.state !== 'awaiting_approval' && m.state !== 'executing' && m.state !== 'verifying') throw new EngineError(409, 'bad_state', `Approvals cannot be decided while mission is ${m.state}.`);
    const act = this.db.get('SELECT * FROM actions WHERE id=? AND workspace_id=?', ap.subject_id, a.workspaceId)!;
    this.db.exec('UPDATE approvals SET status=?, decided_by=?, decision_note=?, decided_at=?, decided_via=?, decision_ref=? WHERE id=?', decision, a.id, note.trim(), nowIso(), via?.channel ?? 'ripple-ui', via?.decisionId ?? null, ap.id);
    // The action is approved only when EVERY slot is approved; any rejection rejects it.
    const allApproved = decision === 'approved' && siblings.every((x) => x.status === 'approved');
    this.db.update('actions', act.id, a.workspaceId, { status: decision === 'rejected' ? 'rejected' : allApproved ? 'approved' : act.status });
    this.audit(a.workspaceId, m.id, 'user', a.name, `approval_${decision}`, `${decision === 'approved' ? 'Approved' : 'Rejected'}: ${act.title}${note ? ` — ${note}` : ''}${via ? ` (via Switch, sender ${via.senderId})` : ''}${decision === 'approved' && !allApproved ? ' — waiting for the second person' : ''}`, { approvalId: ap.id, actionId: act.id, baseline: ap.baseline_version, change: ap.change_seq, via: via ?? null });
    recordCausalEvent(this.db, {
      workspaceId: a.workspaceId,
      missionId: m.id,
      causeType: 'human_decision',
      lifecycleState: decision === 'approved' ? 'AUTHORIZED' : 'REQUIRES_HUMAN',
      summary: `${decision === 'approved' ? 'Approved' : 'Rejected'}: ${act.title}`,
      actor: a.name,
      observedState: { approvalId: ap.id, decisionNote: note.trim() },
    });
    const pk = this.pack(m);
    await this.say(m, { kind: 'decision', senderKey: pk.caseRooms ? pk.caseRooms.coordinatorRole : 'human', senderName: pk.caseRooms ? 'RIPPLE decision record' : a.name, senderKind: pk.caseRooms ? 'system' : 'human', toKey: 'coordinator', roomKey: ap.decision_room_key ?? undefined, body: `${decision.toUpperCase()} by ${a.name}${via ? ` (authenticated Switch sender ${via.senderId})` : ' (RIPPLE UI, LOCAL decision)'}: ${act.title}${note ? ` — ${note}` : ''}${decision === 'approved' && !allApproved ? '. Waiting for the second person (two-person control).' : ''}`, refId: act.id });
    this.reconcile(m, a.name);
    return this.mission(a.workspaceId, m.id);
  }

  // ---------- execution & verification ----------
  async executeAction(a: Actor, missionId: string, actionId: string, opts: { recoveryPlanHash?: string } = {}) {
    this.require(a, 'owner', 'manager');
    const m = this.mission(a.workspaceId, missionId);
    await this.cases.assertReady(a.workspaceId, m.id, this.pack(m), 'Executing an action');
    if (m.paused) throw new EngineError(409, 'paused', 'Mission is paused. Executions are refused until it is resumed.');
    const act = this.db.get('SELECT * FROM actions WHERE id=? AND mission_id=? AND workspace_id=?', actionId, m.id, a.workspaceId);
    if (!act) throw new EngineError(404, 'not_found', 'Action not found.');
    if (act.status === 'stale') throw new EngineError(409, 'stale', `Action is stale and cannot be executed: ${act.stale_reason}`);
    if (!['approved', 'failed', 'verification_failed', 'execution_unknown'].includes(act.status)) throw new EngineError(409, 'not_approved', `Action is "${act.status}"; only approved actions (or failed ones being retried) can be executed.`);
    if (act.change_seq !== m.change_seq || act.analysis_rev !== m.analysis_rev) throw new EngineError(409, 'stale', 'Action was built from an older version of the plan.');
    if (!['awaiting_approval', 'executing', 'recovery_required', 'verifying'].includes(m.state)) throw new EngineError(409, 'bad_state', `Cannot execute while mission is ${m.state}.`);
    if (act.consequential) {
      // Every approval slot of THIS action (two-person control adds a second one) must be granted.
      const aps = this.db.all('SELECT * FROM approvals WHERE subject_id=? AND workspace_id=?', act.id, a.workspaceId);
      if (!aps.length || aps.some((x) => x.status !== 'approved')) throw new EngineError(409, 'no_approval', `Consequential action has no granted human approval${aps.length > 1 ? ` from every required person (${aps.filter((x) => x.status === 'approved').length}/${aps.length})` : ''}.`);
      const spec = j<any>(act.spec, {});
      if (spec.separateExecutor && aps.some((x) => x.decided_by === a.id)) {
        this.audit(a.workspaceId, m.id, 'user', a.name, 'separation_refused', `${a.name} may not execute "${act.title}": they approved it (separation of duties)`, { actionId: act.id });
        throw new EngineError(403, 'separation_of_duties', 'Separation of duties: a person who approved this action cannot also execute it.');
      }
      if (spec.requiresVerifierPass) {
        const v = this.cases.verifierPassed(m);
        if (!v.passed) throw new EngineError(409, 'verifier_required', `"${act.title}" waits for the independent verifier: ${v.detail}`);
      }
    }
    const openDeps = this.openDependencies(a.workspaceId, act);
    if (openDeps.length) {
      this.audit(a.workspaceId, m.id, 'system', AGENT_SENDER, 'dependency_blocked', `"${act.title}" refused: waiting for ${openDeps.join('; ')}`, { actionId: act.id });
      throw new EngineError(409, 'blocked_by_dependency', `"${act.title}" is blocked until: ${openDeps.join('; ')}.`);
    }
    // Quiet hours (session 16): refused without changing the action's state, so it can run once the window ends.
    const quiet = act.quiet_hours ? JSON.parse(act.quiet_hours) : null;
    if (quiet && validQuietWindow(quiet) && inQuietWindow(quiet, new Date())) {
      this.audit(a.workspaceId, m.id, 'system', AGENT_SENDER, 'action_deferred_quiet', `"${act.title}" not executed: quiet hours (${String(quiet.fromHour).padStart(2, '0')}:00–${String(quiet.toHour).padStart(2, '0')}:00 UTC). Nothing changed; it can run after the window.`, { actionId: act.id });
      throw new EngineError(423, 'quiet_hours', `"${act.title}" is in quiet hours (${String(quiet.fromHour).padStart(2, '0')}:00–${String(quiet.toHour).padStart(2, '0')}:00 UTC). Try again after the window.`);
    }
    if (act.status === 'execution_unknown') {
      // An unknown outcome is never repeated blindly. Read back first: if the effect exists, verify it instead of executing again.
      if (opts.recoveryPlanHash) {
        // Session 21: a simulated recovery plan is bound to the basis it observed; re-read it immediately before acting.
        const sim = this.cases.simulateRecovery(a, m.id, act.id);
        if (sim.planHash !== opts.recoveryPlanHash) {
          this.audit(a.workspaceId, m.id, 'user', a.name, 'recovery_basis_changed', `Recovery of "${act.title}" refused: the observed basis changed since the plan was simulated.`, { actionId: act.id });
          throw new EngineError(409, 'recovery_basis_changed', 'The ledger state changed since this recovery plan was simulated. Simulate again and review the new plan.');
        }
      }
      const probe = this.connectors[act.connector];
      let obs: Observation;
      try {
        if (!probe) throw new Error(`Connector ${act.connector} not installed.`);
        obs = probe.observe({ workspaceId: a.workspaceId, missionId: m.id, idempotencyKey: act.idempotency_key });
      } catch (oe) {
        throw new EngineError(409, 'still_unknown', `Outcome of "${act.title}" is still unknown: the read-back failed (${String((oe as Error).message)}). Nothing was repeated.`);
      }
      if (obs.found) {
        this.db.update('actions', act.id, a.workspaceId, { status: 'executed', result: JSON.stringify({ location: obs.location, contentHash: obs.contentHash, mode: probe.mode, recoveredBy: 'read-back', deduped: true }), executed_at: nowIso(), last_error: null, executed_by: act.executed_by ?? a.id });
        this.audit(a.workspaceId, m.id, 'system', 'ripple-verifier', 'action_effect_observed', `Read-back found the effect of "${act.title}" already in place. It was NOT repeated; verifying it now.`, { actionId: act.id, location: obs.location });
        recordCausalEvent(this.db, { workspaceId: a.workspaceId, missionId: m.id, causeType: 'verification_probe', lifecycleState: 'OBSERVED', summary: `Read-back observed the effect of an unknown-outcome action: ${act.title}`, actor: 'ripple-verifier', idempotencyKey: act.idempotency_key, observedState: { location: obs.location, count: obs.count } });
        this.verifyAction(a, m, act.id);
        await this.say(m, { kind: 'status', senderKey: AGENT_SENDER, senderName: 'RIPPLE', senderKind: 'system', body: `Read-back found "${act.title}" already executed; verification: ${this.db.get('SELECT status FROM actions WHERE id=?', act.id)!.status}. The write was NOT repeated.` });
        this.reconcile(m, a.name);
        await this.maybeRunVerifier(m);
        return this.mission(a.workspaceId, m.id);
      }
      this.audit(a.workspaceId, m.id, 'system', 'ripple-verifier', 'unknown_resolved_absent', `Read-back confirmed "${act.title}" has no effect. Retrying with the same idempotency key.`, { actionId: act.id });
    }
    const retry = act.status !== 'approved';
    if (retry) this.audit(a.workspaceId, m.id, 'user', a.name, 'recovery_retry', `Recovery: retrying "${act.title}" (attempt ${act.attempts + 1}) after: ${act.last_error ?? 'verification failure'}`, { actionId: act.id });
    if (m.state !== 'executing') this.transition(m, 'executing', `Executing "${act.title}"`, a.name);
    const conn = this.connectors[act.connector];
    if (!conn) throw new EngineError(500, 'no_connector', `Connector ${act.connector} not installed.`);
    const cfg = this.db.get('SELECT * FROM connectors WHERE workspace_id=? AND key=?', a.workspaceId, act.connector);
    const payload = JSON.parse(act.payload);
    this.db.update('actions', act.id, a.workspaceId, { attempts: act.attempts + 1, executed_by: a.id });
    try {
      if (cfg?.fail_next) { this.db.exec('UPDATE connectors SET fail_next=0 WHERE id=?', cfg.id); throw new Error('Injected connector fault (development fault-injection switch in Settings)'); }
      const res = conn.execute({ workspaceId: a.workspaceId, missionId: m.id, idempotencyKey: act.idempotency_key, subject: payload.subject, target: payload.target, body: payload.body });
      this.db.update('actions', act.id, a.workspaceId, { status: 'executed', result: JSON.stringify({ ...res, mode: conn.mode }), executed_at: nowIso(), last_error: null, executed_by: a.id });
      this.audit(a.workspaceId, m.id, 'user', a.name, 'action_executed', `Executed "${act.title}" via ${conn.name}${res.deduped ? ' (idempotent: effect already existed, not repeated)' : ''}`, { actionId: act.id, location: res.location });
      recordCausalEvent(this.db, {
        workspaceId: a.workspaceId,
        missionId: m.id,
        causeType: 'action_execution',
        lifecycleState: 'EXECUTING',
        summary: `Executed: ${act.title}`,
        actor: a.name,
        idempotencyKey: act.idempotency_key,
        observedState: { connector: conn.name, location: res.location, deduped: res.deduped },
      });
    } catch (e) {
      const msg = String((e as Error).message);
      // A thrown error is not proof that nothing happened (lost response, timeout). Read the real effect back before deciding.
      const outcome = this.settleFailedExecution(a, m, act, conn, msg);
      if (outcome !== 'effect_present') {
        if (outcome === 'unknown') {
          await this.say(m, { kind: 'escalation', senderKey: AGENT_SENDER, senderName: 'RIPPLE', senderKind: 'system', toKey: 'human_manager', body: `Outcome of "${act.title}" is UNKNOWN: the connector errored (${msg}) and could not be read back. Nothing was repeated. Human check required before any retry.` });
        } else {
          await this.say(m, { kind: 'escalation', senderKey: AGENT_SENDER, senderName: 'RIPPLE', senderKind: 'system', toKey: 'human_manager', body: `Action failed: ${act.title} — ${msg}. Recovery required: retry or cancel.` });
        }
        this.reconcile(m, AGENT_SENDER);
        return this.mission(a.workspaceId, m.id);
      }
      // effect_present: the read-back shows the effect exists, so fall through to independent verification below.
    }
    this.verifyAction(a, m, act.id);
    await this.say(m, { kind: 'status', senderKey: AGENT_SENDER, senderName: 'RIPPLE', senderKind: 'system', body: `Verification for "${act.title}": ${this.db.get('SELECT status FROM actions WHERE id=?', act.id)!.status}` });
    this.reconcile(m, a.name);
    await this.maybeRunVerifier(m);
    return this.mission(a.workspaceId, m.id);
  }

  /** Session 21: once every action the verifier covers is verified, the independent verifier runs (as its own identity). */
  private async maybeRunVerifier(m: Row) {
    const pack = this.pack(m); if (!pack.independentVerifier) return;
    const acts = this.db.all("SELECT status, spec, payload_hash FROM actions WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status NOT IN ('superseded','stale','rejected')", m.id, m.workspace_id, m.analysis_rev).filter((x) => !j<any>(x.spec, {}).requiresVerifierPass);
    if (!acts.length || acts.some((x) => x.status !== 'verified')) return;
    if (this.cases.verifierPassed(this.mission(m.workspace_id, m.id)).passed) return;
    await this.cases.runVerifier(null, m.id, m.workspace_id);
  }

  /**
   * Decides what a connector error means by reading the real effect back (never by the error alone).
   * - effect_present: the effect exists (the response was lost). Recorded as executed; the caller verifies it.
   * - failed: the read-back confirms NO effect. Safe to retry with the same idempotency key.
   * - unknown: the read-back itself failed. The outcome is unknown and is never repeated automatically.
   */
  private settleFailedExecution(a: Actor, m: Row, act: Row, conn: Connector, msg: string): 'effect_present' | 'failed' | 'unknown' {
    let obs: Observation;
    try {
      obs = conn.observe({ workspaceId: a.workspaceId, missionId: m.id, idempotencyKey: act.idempotency_key });
    } catch (oe) {
      const why = `${msg}; read-back also failed: ${String((oe as Error).message)}`;
      this.db.update('actions', act.id, a.workspaceId, { status: 'execution_unknown', last_error: why });
      this.db.insert('evidence', { id: uid('ev'), workspace_id: a.workspaceId, mission_id: m.id, action_id: act.id, kind: 'execution', check_name: 'connector read-back', passed: false, detail: why, data: '{}', verifier: 'ripple-engine', created_at: nowIso() });
      this.audit(a.workspaceId, m.id, 'system', AGENT_SENDER, 'action_unknown', `UNKNOWN outcome for "${act.title}": ${why}. Not repeated.`, { actionId: act.id });
      recordCausalEvent(this.db, { workspaceId: a.workspaceId, missionId: m.id, causeType: 'action_execution', lifecycleState: 'EXECUTION_UNKNOWN', summary: `Execution outcome unknown: ${act.title}`, actor: a.name, idempotencyKey: act.idempotency_key, observedState: { error: why } });
      return 'unknown';
    }
    if (obs.found) {
      this.db.update('actions', act.id, a.workspaceId, { status: 'executed', result: JSON.stringify({ location: obs.location, contentHash: obs.contentHash, mode: conn.mode, recoveredBy: 'read-back', deduped: true }), executed_at: nowIso(), last_error: null });
      this.audit(a.workspaceId, m.id, 'system', 'ripple-verifier', 'action_effect_observed', `Connector reported an error for "${act.title}" (${msg}), but the read-back shows the effect exists. It was not repeated; verifying it now.`, { actionId: act.id, location: obs.location });
      recordCausalEvent(this.db, { workspaceId: a.workspaceId, missionId: m.id, causeType: 'verification_probe', lifecycleState: 'OBSERVED', summary: `Read-back observed the effect after a connector error: ${act.title}`, actor: 'ripple-verifier', idempotencyKey: act.idempotency_key, observedState: { error: msg, location: obs.location, count: obs.count } });
      return 'effect_present';
    }
    this.db.update('actions', act.id, a.workspaceId, { status: 'failed', last_error: msg });
    this.db.insert('evidence', { id: uid('ev'), workspace_id: a.workspaceId, mission_id: m.id, action_id: act.id, kind: 'execution', check_name: 'connector execution', passed: false, detail: msg, data: '{}', verifier: 'ripple-engine', created_at: nowIso() });
    this.audit(a.workspaceId, m.id, 'system', AGENT_SENDER, 'action_failed', `FAILED "${act.title}": ${msg} (read-back confirms no effect)`, { actionId: act.id });
    recordCausalEvent(this.db, { workspaceId: a.workspaceId, missionId: m.id, causeType: 'action_execution', lifecycleState: 'FAILED', summary: `Action execution failed: ${act.title} — ${msg}`, actor: a.name, idempotencyKey: act.idempotency_key, observedState: { error: msg, readBack: 'absent' } });
    return 'failed';
  }

  /** Independent verification: re-reads the effect from the connector and checks it. Never trusts the executor's own report. */
  /** Unmet obligation dependencies of an action (empty = free to run). A missing dependency counts as unmet (fail-closed). */
  openDependencies(ws: string, act: Row): string[] {
    const dep = (j<any>(act.payload, {}).blockedUntil ?? {}) as { actions?: string[]; workItems?: string[] };
    const out: string[] = [];
    for (const k of dep.actions ?? []) {
      const d = this.db.get("SELECT title,status FROM actions WHERE mission_id=? AND workspace_id=? AND key=? AND analysis_rev=? AND status NOT IN ('superseded','stale')", act.mission_id, ws, k, act.analysis_rev);
      if (!d) out.push(`action "${k}" (not proposed in this revision)`); else if (d.status !== 'verified') out.push(`"${d.title}" to be verified (now ${d.status})`);
    }
    if (dep.workItems?.length) {
      const items = this.db.all('SELECT title,status,data FROM work_items WHERE mission_id=? AND workspace_id=? AND analysis_rev=?', act.mission_id, ws, act.analysis_rev);
      for (const k of dep.workItems) { const w = items.find((x) => j<any>(x.data, {}).key === k); if (!w) out.push(`work item "${k}" (missing)`); else if (w.status !== 'done') out.push(`"${w.title}" to be done`); }
    }
    return out;
  }

  verifyAction(a: Actor, m: Row, actionId: string) {
    const act = this.db.get('SELECT * FROM actions WHERE id=? AND workspace_id=?', actionId, a.workspaceId)!;
    const conn = this.connectors[act.connector];
    const pack = this.pack(m);
    const obs = conn.observe({ workspaceId: a.workspaceId, missionId: m.id, idempotencyKey: act.idempotency_key });
    const payload = JSON.parse(act.payload);
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    checks.push({ name: 'effect exists in connector', passed: obs.found, detail: obs.found ? `found at ${obs.location}` : 'no record found when reading back' });
    checks.push({ name: 'exactly one effect (idempotency)', passed: obs.count === 1, detail: `${obs.count} record(s) for key ${act.idempotency_key.slice(0, 8)}…` });
    checks.push({ name: 'content contains approved body', passed: obs.found && obs.content.includes(payload.body), detail: obs.found ? (obs.content.includes(payload.body) ? 'approved text present byte-for-byte' : 'observed content differs from approved text') : 'no content' });
    const bl = this.baseline(m, act.baseline_version);
    const change = this.db.get('SELECT * FROM change_events WHERE mission_id=? AND seq=?', m.id, act.change_seq)!;
    const answers: AnalysisContext['answers'] = {};
    for (const q of this.db.all("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND status='answered'", m.id, a.workspaceId)) answers[q.key] = { text: q.answer, value: j(q.answer_value) };
    const revised = pack.applyChange(JSON.parse(bl.plan), JSON.parse(change.input), answers);
    if (pack.verifyAction) checks.push(...pack.verifyAction({ type: act.type, payload }, { content: obs.content }, revised, { baselinePlan: JSON.parse(bl.plan), change: JSON.parse(change.input), answers }));
    const mode = this.connectors[act.connector].mode;
    checks.push({ name: 'delivery scope (informational)', passed: true, detail: `Connector mode "${mode}": ${JSON.parse(act.result ?? '{}').deliveryNote ?? ''}` });
    this.db.exec('DELETE FROM evidence WHERE action_id=? AND kind=?', act.id, 'verification');
    for (const c of checks) this.db.insert('evidence', { id: uid('ev'), workspace_id: a.workspaceId, mission_id: m.id, action_id: act.id, kind: 'verification', check_name: c.name, passed: c.passed, detail: c.detail, data: JSON.stringify({ location: obs.location, observedHash: obs.contentHash }), verifier: 'ripple-verifier/readback@1', created_at: nowIso() });
    const ok = checks.every((c) => c.passed);
    this.db.update('actions', act.id, a.workspaceId, { status: ok ? 'verified' : 'verification_failed', last_error: ok ? null : checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join('; ') });
    this.audit(a.workspaceId, m.id, 'system', 'ripple-verifier', ok ? 'action_verified' : 'verification_failed', `${ok ? 'Verified' : 'VERIFICATION FAILED'}: ${act.title} (${checks.filter((c) => c.passed).length}/${checks.length} checks)`, { actionId: act.id });
    recordCausalEvent(this.db, {
      workspaceId: a.workspaceId,
      missionId: m.id,
      causeType: 'verification_probe',
      lifecycleState: ok ? 'VERIFIED' : 'FAILED',
      summary: `${ok ? 'Action Verified' : 'Action Verification Failed'}: ${act.title}`,
      actor: 'ripple-verifier',
      idempotencyKey: act.idempotency_key,
      observedState: {
        passedChecks: checks.filter((c) => c.passed).length,
        totalChecks: checks.length,
        location: obs.location,
      },
    });
  }

  // ---------- acknowledgements / work items ----------
  acknowledge(a: Actor, missionId: string, actionId: string, note: string) {
    const m = this.mission(a.workspaceId, missionId);
    const act = this.db.get('SELECT * FROM actions WHERE id=? AND mission_id=? AND workspace_id=?', actionId, m.id, a.workspaceId);
    if (!act) throw new EngineError(404, 'not_found', 'Action not found.');
    const ack = this.db.get('SELECT * FROM acknowledgements WHERE action_id=? AND user_id=? AND workspace_id=?', act.id, a.id, a.workspaceId);
    if (!ack) throw new EngineError(403, 'forbidden', 'You are not a required recipient for this action.');
    if (act.status !== 'verified') throw new EngineError(409, 'not_delivered', 'Acknowledgement is only possible after the action is executed and verified.');
    if (ack.status === 'acknowledged') throw new EngineError(409, 'already', 'Already acknowledged.');
    this.db.exec("UPDATE acknowledgements SET status='acknowledged', note=?, acked_at=? WHERE id=?", note.trim(), nowIso(), ack.id);
    this.audit(a.workspaceId, m.id, 'user', a.name, 'acknowledged', `${a.name} acknowledged "${act.title}"`, { actionId: act.id });
    return this.mission(a.workspaceId, m.id);
  }
  updateWorkItem(a: Actor, missionId: string, wiId: string, status: 'open' | 'done') {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot update work.');
    const m = this.mission(a.workspaceId, missionId);
    const wi = this.db.get('SELECT * FROM work_items WHERE id=? AND mission_id=? AND workspace_id=?', wiId, m.id, a.workspaceId);
    if (!wi) throw new EngineError(404, 'not_found', 'Work item not found.');
    if (!isManagerRole(a) && wi.owner_user_id !== a.id) throw new EngineError(403, 'forbidden', 'Only the owner or a manager can update this item.');
    const meta = j<{ key: string; dependsOn?: string[]; satisfiedBy?: string | null }>(wi.data, {});
    if (status === 'done') {
      // prerequisites: every work item this one depends on (same analysis rev) must already be done
      const open = (meta.dependsOn ?? []).map((k) => this.db.all('SELECT title,status,data FROM work_items WHERE mission_id=? AND workspace_id=? AND analysis_rev=?', m.id, a.workspaceId, wi.analysis_rev).find((x) => j<any>(x.data, {}).key === k)).filter((x) => x && x.status !== 'done');
      if (open.length) throw new EngineError(409, 'prerequisite_open', `Cannot complete "${wi.title}" yet — prerequisite(s) still open: ${open.map((x: any) => x.title).join('; ')}.`);
    }
    this.db.exec('UPDATE work_items SET status=? WHERE id=?', status, wi.id);
    this.audit(a.workspaceId, m.id, 'user', a.name, 'work_item_updated', `"${wi.title}" → ${status}`, { id: wi.id });
    if (status === 'done' && meta.key) {
      // explicit evidence link: items declared satisfiedBy this one are satisfied (and the link is audited)
      for (const o of this.db.all("SELECT * FROM work_items WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status!='done'", m.id, a.workspaceId, wi.analysis_rev)) {
        if (j<any>(o.data, {}).satisfiedBy === meta.key) {
          this.db.exec("UPDATE work_items SET status='done' WHERE id=?", o.id);
          this.audit(a.workspaceId, m.id, 'system', AGENT_SENDER, 'evidence_linked', `"${o.title}" satisfied by evidence from "${wi.title}" (explicit link)`, { from: wi.id, to: o.id });
        }
      }
    }
    return this.mission(a.workspaceId, m.id);
  }

  // ---------- state reconciliation & completion ----------
  /** Derives the right mission state from observable action state, through validated transitions only. */
  reconcile(m: Row, actor: string) {
    const fresh = this.mission(m.workspace_id, m.id);
    if (['draft', 'baseline_ready', 'analyzing', 'blocked', 'completed', 'cancelled', 'failed'].includes(fresh.state)) { Object.assign(m, fresh); return; }
    const acts = this.db.all("SELECT * FROM actions WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status NOT IN ('superseded','stale')", m.id, m.workspace_id, fresh.analysis_rev);
    const failed = acts.filter((x) => ['failed', 'verification_failed', 'execution_unknown'].includes(x.status));
    const approvedPending = acts.filter((x) => x.status === 'approved');
    const proposed = acts.filter((x) => x.status === 'proposed');
    const verified = acts.filter((x) => x.status === 'verified');
    let to: MissionState; let reason: string;
    if (failed.length) { to = 'recovery_required'; reason = `Recovery required: ${failed.map((f) => `"${f.title}" — ${f.last_error}`).join(' | ')}`; }
    else if (approvedPending.length) { to = 'executing'; reason = `${approvedPending.length} approved action(s) ready to execute: ${approvedPending.map((x) => x.title).join(', ')}.`; }
    else if (proposed.length) { to = 'awaiting_approval'; reason = `${proposed.length} approval(s) still required: ${proposed.map((x) => x.title).join(', ')}.`; }
    else if (verified.length) { to = 'verifying'; reason = 'All decided actions executed and verified. Collect acknowledgements and resolve review items, then complete the mission.'; }
    else { to = 'awaiting_approval'; reason = 'All proposed actions were rejected; nothing verified. Re-analyze with a new change or cancel.'; }
    if (fresh.state !== to) {
      try { this.transition(fresh, to, reason, actor); } catch { /* invalid edge: keep state */ }
    } else this.transition(fresh, to, reason, actor);
    Object.assign(m, fresh);
  }

  completionPreview(a: Actor, missionId: string) { const m = this.mission(a.workspaceId, missionId); return evaluateCompletion(this, m); }

  async completeMission(a: Actor, missionId: string) {
    this.require(a, 'owner', 'manager');
    const m = this.mission(a.workspaceId, missionId);
    await this.cases.assertReady(a.workspaceId, m.id, this.pack(m), 'Completing the case');
    const res = evaluateCompletion(this, m);
    if (!res.allPassed) {
      this.audit(a.workspaceId, m.id, 'user', a.name, 'completion_refused', `Completion refused: ${res.checks.filter((c) => !c.passed).map((c) => c.label).join('; ')}`);
      throw new EngineError(422, 'criteria_unmet', 'Completion criteria are not satisfied: ' + res.checks.filter((c) => !c.passed).map((c) => c.label).join('; '));
    }
    const pack = this.pack(m);
    const change = this.db.get("SELECT * FROM change_events WHERE mission_id=? AND workspace_id=? AND status='open' ORDER BY seq DESC", m.id, a.workspaceId)!;
    const answers: AnalysisContext['answers'] = {};
    for (const q of this.db.all("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND status='answered'", m.id, a.workspaceId)) answers[q.key] = { text: q.answer, value: j(q.answer_value) };
    const revised = pack.applyChange(JSON.parse(this.baseline(m, change.baseline_version).plan), JSON.parse(change.input), answers);
    const newV = m.current_baseline_version + 1;
    const unresolved = res.unresolved;
    const completed = [
      ...this.db.all("SELECT title FROM actions WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status='verified'", m.id, a.workspaceId, m.analysis_rev).map((x) => `Executed & independently verified: ${x.title}`),
      ...this.db.all("SELECT w.title, u.name AS owner FROM work_items w LEFT JOIN users u ON u.id=w.owner_user_id WHERE w.mission_id=? AND w.workspace_id=? AND w.analysis_rev=? AND w.status='done'", m.id, a.workspaceId, m.analysis_rev).map((x) => `Done (${x.owner ?? 'unassigned'}): ${x.title}`),
      ...this.db.all("SELECT k.status, u.name, x.title FROM acknowledgements k JOIN users u ON u.id=k.user_id JOIN actions x ON x.id=k.action_id WHERE k.mission_id=? AND k.workspace_id=? AND k.status='acknowledged' AND x.analysis_rev=?", m.id, a.workspaceId, m.analysis_rev).map((x) => `Acknowledged by ${x.name}: ${x.title}`),
      ...this.db.all("SELECT text, answer FROM questions WHERE mission_id=? AND workspace_id=? AND status='answered'", m.id, a.workspaceId).map((x) => `Human answer recorded: ${String(x.text).slice(0, 90)} → ${x.answer}`),
    ];
    this.db.tx(() => {
      this.db.insert('baselines', { id: uid('bl'), workspace_id: a.workspaceId, mission_id: m.id, version: newV, plan: JSON.stringify(revised), plan_hash: sha256(stable(revised)), note: `Change #${change.seq} applied after verified execution`, approved_by: a.id, created_at: nowIso() });
      this.db.update('missions', m.id, a.workspaceId, { current_baseline_version: newV });
      this.db.exec("UPDATE change_events SET status='applied' WHERE id=?", change.id);
      const summary = `Change #${change.seq} applied. ${this.db.all("SELECT 1 FROM actions WHERE mission_id=? AND analysis_rev=? AND status='verified'", m.id, m.analysis_rev).length} action(s) verified. ${unresolved.length} unresolved item(s) recorded.`;
      this.db.insert('outcomes', { id: uid('out'), workspace_id: a.workspaceId, mission_id: m.id, status: 'completed', summary, criteria: JSON.stringify(res.checks), unresolved: JSON.stringify(unresolved), completed: JSON.stringify(completed), new_baseline_version: newV, created_by: a.id, created_at: nowIso() });
      m.current_baseline_version = newV;
      this.transition(m, 'completed', `All completion criteria satisfied. Baseline v${newV} saved.`, a.name);
    });
    this.audit(a.workspaceId, m.id, 'user', a.name, 'mission_completed', `Mission completed; baseline v${newV}`, { unresolved });
    // Session 21: only a completed, verified case leaves facts for later cases; Switch-native cases get a final sealed receipt.
    this.cases.writeMemory(m, pack, { baselinePlan: JSON.parse(this.baseline(m, change.baseline_version).plan), revisedPlan: revised, change: JSON.parse(change.input), answers, today: this.deps.today?.() ?? nowIso().slice(0, 10) });
    if (pack.caseRooms) await this.cases.issueResolutionReceipt(m, 'final', a.name);
    await this.captureResolvedPlaybook(a, m);
    return this.mission(a.workspaceId, m.id);
  }

  /**
   * Session 15, capability 6 (self-encoding room capture). On completion, a Switch-mode mission exports its
   * resolved room topology as a reusable `version: 2` YAML playbook (switch gateway GET /rooms/{id}/yaml when a
   * human session is configured, else a labelled local fallback), plus the final Trust & ROI telemetry document.
   * All telemetry numbers are counted from workspace rows here; nothing is fabricated. Best-effort: a failure is
   * audited, never blocks completion.
   */
  private async captureResolvedPlaybook(a: Actor, m: Row) {
    if (!this.collab.captureResolvedPlaybook) return;
    const intake = this.db.get("SELECT * FROM rooms WHERE mission_id=? AND workspace_id=? ORDER BY created_at ASC", m.id, a.workspaceId);
    if (!intake || intake.mode !== 'switch' || !intake.external_id) return;
    const caseRooms: CaseRoomRecord[] = this.db.all("SELECT * FROM rooms WHERE mission_id=? AND workspace_id=? AND external_id IS NOT NULL", m.id, a.workspaceId)
      .filter((r: Row) => r.id !== intake.id && !['draft', 'degraded'].includes(String(r.status)))
      .map((r: Row) => { const key = String(r.name).startsWith('ops-verify') ? 'ops-verify' : String(r.name).startsWith('finance-settle') ? 'finance-settle' : 'ops-verify'; return { key: key as CaseRoomRecord['key'], externalId: r.external_id, name: r.name, linkedTo: intake.external_id, note: r.note }; });
    const telemetry = {
      guardrail: (() => { const inspected = this.db.all("SELECT * FROM messages WHERE mission_id=? AND workspace_id=? AND source='switch'", m.id, a.workspaceId).map((x: Row) => j(x.data)).filter((d) => d?.attachments?.length); const total = inspected.reduce((s, d) => s + (d as any).attachments.length, 0); const quarantined = inspected.reduce((s, d) => s + (d as any).attachments.filter((g: any) => g.quarantined).length, 0); return { inspected: total, quarantined, status: total ? (quarantined ? `QUARANTINE (${quarantined} of ${total})` : 'PASS') : 'PASS (none received)', zeroLlm: true }; })(),
      verification: {
        actionsVerified: this.db.all("SELECT 1 FROM actions WHERE mission_id=? AND workspace_id=? AND status='verified'", m.id, a.workspaceId).length,
        actionsExecuted: this.db.all("SELECT 1 FROM actions WHERE mission_id=? AND workspace_id=? AND status IN ('executed','verified')", m.id, a.workspaceId).length,
        llmCalls: 0,
      },
      rows: { messages: this.db.all('SELECT 1 FROM messages WHERE mission_id=? AND workspace_id=?', m.id, a.workspaceId).length, workItemsDone: this.db.all("SELECT 1 FROM work_items WHERE mission_id=? AND workspace_id=? AND status='done'", m.id, a.workspaceId).length, audits: this.db.all('SELECT 1 FROM audit_events WHERE mission_id=? AND workspace_id=?', m.id, a.workspaceId).length },
    };
    try {
      const book = await this.collab.captureResolvedPlaybook({ caseId: String(m.id), missionId: String(m.id), title: String(m.title), rooms: caseRooms, intakeRoom: { mode: 'switch', externalId: intake.external_id, name: intake.name, note: intake.note }, telemetry });
      if (book) {
        this.db.insert('artifacts', { id: uid('art'), workspace_id: a.workspaceId, mission_id: m.id, kind: 'resolved_playbook', name: `Resolved room playbook (${book.source === 'gateway' ? 'gateway export' : 'local fallback'})`, content: book.yaml, content_hash: sha256(book.yaml), status: 'final', generated_by: `switch:${book.source}`, owner_role: null, created_at: nowIso() });
        this.audit(a.workspaceId, m.id, 'system', AGENT_SENDER, 'room_playbook_captured', `Resolved room topology saved as a reusable version-2 YAML playbook (${book.source}): ${book.path}`, { path: book.path, source: book.source, rooms: caseRooms.length + 1, telemetry });
      } else this.audit(a.workspaceId, m.id, 'system', AGENT_SENDER, 'switch_error', 'Room playbook was not captured (adapter returned no result).');
    } catch (e) {
      this.audit(a.workspaceId, m.id, 'system', AGENT_SENDER, 'switch_error', `Room playbook capture failed: ${String((e as Error).message).slice(0, 200)}`);
      this.db.insert('artifacts', { id: uid('art'), workspace_id: a.workspaceId, mission_id: m.id, kind: 'resolved_playbook', name: 'Resolved room playbook (capture failed — see audit)', content: `{ "error": ${JSON.stringify(String((e as Error).message).slice(0, 300))} }`, content_hash: sha256(String((e as Error).message)), status: 'final', generated_by: 'switch:error', owner_role: null, created_at: nowIso() });
    }
  }

  cancelMission(a: Actor, missionId: string, reason: string) {
    this.require(a, 'owner', 'manager');
    const m = this.mission(a.workspaceId, missionId);
    if (!reason.trim()) throw new EngineError(422, 'reason_required', 'Reason required.');
    this.markStale(m, `Mission cancelled: ${reason}`);
    this.db.exec("UPDATE workflow_tasks SET status='cancelled', error=?, finished_at=? WHERE mission_id=? AND workspace_id=? AND status IN ('queued','running')", 'Mission cancelled', nowIso(), m.id, a.workspaceId);
    this.transition(m, 'cancelled', `Cancelled by ${a.name}: ${reason}`, a.name);
    return this.mission(a.workspaceId, m.id);
  }
}
const isManagerRole = (a: Actor) => isManager(a);
