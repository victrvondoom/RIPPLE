import { j, nowIso, sha256, stable, uid, type Row } from '../db/db.js';
import { EngineError, type AnalysisContext, type MemoryItem, type VerifierInput, type WorkflowPack } from './types.js';
import type { Actor, Engine } from './engine.js';
import type { CaseRoomsTopology, InboundMessage, OpenedCaseRoom, RoomInfo } from '../collab/port.js';
import { caseRefOf, evaluateDecision, parseStrictDecision, type StrictDecision } from '../collab/authority.js';
import { chatRef } from '../collab/chat.js';
import { recordCausalEvent } from './causal.js';
import { buildManifest, disclose, verifyDisclosure, type Disclosure, type DisclosableRecord } from '../capabilities/disclose/manifest.js';
import { sealReceipt, verifierReceiptBody, verifyReceipt } from '../capabilities/verify/receipt.js';
import { routeImpact, type RouteAction } from '../capabilities/route/impact.js';
import type { PreflightResult } from '../collab/preflight.js';

/**
 * Case operations (session 21): the Switch-native machinery of the flagship, kept out of engine.ts so the engine stays
 * the single writer of mission state and this module only adds generic, pack-declared behaviour:
 *   - case room topology (several rooms, real Switch rooms or labelled LOCAL rooms) and per-role room routing
 *   - authenticated Switch decisions (collab/authority.ts) entering the ONE engine transition, Engine.decideApproval
 *   - competition mode gate (RIPPLE_SWITCH_REQUIRED=1): fail-closed preflight + live identity status
 *   - room documents (written as the role's identity, read back), cross-room handoffs with digests only
 *   - evidence manifest + selective disclosure, independent verifier receipt, resolution receipt
 *   - evidence-based memory and impact routing
 * Nothing here is pack-specific: every behaviour is driven by what the pack declares (caseRooms, independentVerifier,
 * evidenceRecords, memoryFacts, ActionSpec.decisionRoom / coApprover / separateExecutor / requiresVerifierPass).
 */
const SYS = 'ripple';
const PREFLIGHT_TTL_MS = 10 * 60_000;

export type PreflightFn = (req: { requiredRoles: string[]; people: { roleKey: string; pinned: boolean; who: string }[] }) => Promise<PreflightResult>;

export class CaseOps {
  private preflights = new Map<string, PreflightResult>();
  constructor(private e: Engine, public switchRequired: boolean, private preflightFn?: PreflightFn) {}
  lastPreflight(ws: string) { return this.preflights.get(ws) ?? null; }

  get db() { return this.e.db; }
  caseRef(m: Row) { return caseRefOf(String(m.id)); }
  isNative(pack: WorkflowPack) { return !!pack.caseRooms; }

  // ---------- competition mode (fail-closed) ----------
  /** Agent roles and decision-making people every Switch-native pack needs (from the packs' declared topology). */
  requirements(ws: string) {
    const native = this.e.packs.all().filter((p) => p.caseRooms);
    const requiredRoles = [...new Set(native.flatMap((p) => p.caseRooms!.rooms.flatMap((r) => r.agentRoles)))];
    const people = native.flatMap((p) => [...new Set(p.caseRooms!.rooms.flatMap((r) => r.humanRoles))].map((roleKey) => {
      const u = this.e.roleUser(ws, p.id, roleKey);
      const pinned = !!u && !!this.db.get('SELECT 1 x FROM switch_people WHERE workspace_id=? AND user_id=?', ws, u.id);
      return { roleKey, pinned, who: u ? `${u.name} (${p.roles.find((r) => r.key === roleKey)?.name ?? roleKey})` : `${roleKey} (unmapped)` };
    }));
    return { requiredRoles, people };
  }
  async preflight(ws: string): Promise<PreflightResult> {
    let res: PreflightResult;
    if (!this.preflightFn) res = { ok: false, checkedAt: nowIso(), mode: 'competition', checks: [{ key: 'switch_config', label: 'Switch fabric configured', passed: false, detail: 'No Switch configuration (SWITCH_BRIDGE_URL / SWITCH_AGENT_ID / SWITCH_AGENT_API_KEY + data/switch-agents.local.json). Competition mode cannot run.' }] };
    else {
      try { res = await this.preflightFn(this.requirements(ws)); }
      catch (e) { res = { ok: false, checkedAt: nowIso(), mode: 'competition', checks: [{ key: 'preflight', label: 'Preflight ran', passed: false, detail: String((e as Error).message).slice(0, 300) }] }; }
    }
    this.preflights.set(ws, res);
    this.e.audit(ws, null, 'system', SYS, res.ok ? 'switch_preflight_passed' : 'switch_preflight_failed', `Switch preflight ${res.ok ? 'PASSED' : 'FAILED'}: ${res.checks.filter((c) => c.passed).length}/${res.checks.length} checks${res.ok ? '' : ` — ${res.checks.filter((c) => !c.passed).map((c) => c.label).join('; ')}`}`, res);
    return res;
  }
  /** Refuses (and audits) a critical operation of a Switch-native mission when competition mode cannot prove Switch is live. */
  async assertReady(ws: string, missionId: string | null, pack: WorkflowPack, what: string) {
    if (!this.switchRequired || !this.isNative(pack)) return;
    const refuse = (why: string) => {
      this.e.audit(ws, missionId, 'system', SYS, 'switch_required_refused', `${what} refused (competition mode, fail-closed): ${why}`, { what });
      throw new EngineError(503, 'switch_required', `${what} refused: competition mode requires a live, verified Switch fabric — ${why}`);
    };
    if (this.e.collab.mode !== 'switch') refuse('collaboration is LOCAL; competition mode never falls back to local rooms');
    const last = this.preflights.get(ws);
    const pf = last && last.ok && Date.now() - Date.parse(last.checkedAt) < PREFLIGHT_TTL_MS ? last : await this.preflight(ws);
    if (!pf.ok) refuse(`preflight failed: ${pf.checks.filter((c) => !c.passed).map((c) => `${c.label} (${c.detail})`).join('; ').slice(0, 400)}`);
    if (missionId) {
      const members = new Set(this.db.all('SELECT members FROM rooms WHERE mission_id=? AND workspace_id=? AND mode=?', missionId, ws, 'switch').flatMap((r) => j<string[]>(r.members, [])));
      const st = this.e.collab.identities?.() ?? [];
      const down = st.filter((s) => members.has(s.name) && !s.connected);
      if (down.length) refuse(`agent identities not connected: ${down.map((d) => `${d.name}${d.lastError ? ` (${d.lastError})` : ''}`).join(', ')}`);
    }
  }

  // ---------- rooms ----------
  humanUsernames(ws: string, pack: WorkflowPack, roles: string[]): string[] {
    const out: string[] = [];
    for (const r of roles) {
      const u = this.e.roleUser(ws, pack.id, r); if (!u) continue;
      const p = this.db.get('SELECT chat_username, switch_name FROM switch_people WHERE workspace_id=? AND user_id=? ORDER BY pinned_at DESC', ws, u.id);
      if (p) out.push(p.chat_username || p.switch_name);
    }
    return out;
  }
  /** Opens every declared room. Switch failures THROW in competition mode (no local fallback) and are labelled otherwise. */
  async openCaseRooms(m: Row, pack: WorkflowPack): Promise<Row[]> {
    const t = pack.caseRooms as CaseRoomsTopology; const ws = m.workspace_id; const ref = this.caseRef(m);
    const humans = Object.fromEntries(t.rooms.map((r) => [r.key, this.humanUsernames(ws, pack, r.humanRoles)]));
    let opened: OpenedCaseRoom[]; let labels: string[] = []; let status = 'open';
    if (this.e.collab.mode === 'switch' && this.e.collab.openCaseRooms) {
      try { ({ rooms: opened, labels } = await this.e.collab.openCaseRooms({ missionId: m.id, caseRef: ref, title: m.title, topology: t, humans })); }
      catch (err) {
        const msg = String((err as Error).message).slice(0, 300);
        this.e.audit(ws, m.id, 'system', SYS, 'switch_error', `Case rooms could not be created on Switch: ${msg}`);
        if (this.switchRequired) throw new EngineError(503, 'switch_required', `Case rooms could not be created on Switch (competition mode never falls back to local rooms): ${msg}`);
        status = 'degraded';
        opened = t.rooms.map((r) => ({ key: r.key, externalId: null, name: `${r.name}-${ref}`, note: `LOCAL fallback — Switch room creation failed (${msg.slice(0, 120)}).`, members: [], humans: [], linkedTo: [], mode: 'local' as const }));
      }
    } else {
      if (this.switchRequired) throw new EngineError(503, 'switch_required', 'Competition mode requires Switch; collaboration is LOCAL.');
      opened = t.rooms.map((r) => ({ key: r.key, externalId: null, name: `${r.name}-${ref}`, note: 'LOCAL MODE (not Switch): labelled development room; membership is recorded, not enforced by a server.', members: r.agentRoles, humans: humans[r.key] ?? [], linkedTo: r.links ?? [], mode: 'local' as const }));
    }
    const rows: Row[] = [];
    for (const r of opened) {
      const spec = t.rooms.find((x) => x.key === r.key)!;
      const row = { id: uid('room'), workspace_id: ws, mission_id: m.id, mode: r.mode, external_id: r.externalId, name: r.name, status, note: r.note, created_at: nowIso(), room_key: r.key, members: JSON.stringify(r.members), links: JSON.stringify(r.linkedTo.length ? r.linkedTo : spec.links ?? []), sensitivity: spec.sensitivity };
      this.db.insert('rooms', row); rows.push(row);
    }
    this.e.audit(ws, m.id, 'system', SYS, 'case_rooms_opened', `Case ${ref}: ${rows.length} room(s) opened in ${rows[0]?.mode?.toUpperCase()} mode (${rows.map((r) => `#${r.name}`).join(', ')})`, { rooms: rows.map((r) => ({ key: r.room_key, name: r.name, externalId: r.external_id, members: j(r.members, []) })), labels });
    for (const row of rows) if (row.external_id && this.e.collab.subscribe) this.e.subscribeRoom(m, row, this.info(row));
    return rows;
  }
  info(row: Row): RoomInfo { return { mode: row.mode, externalId: row.external_id, name: row.name, note: row.note }; }
  roomByKey(m: Row, key: string): Row | undefined { return this.db.get('SELECT * FROM rooms WHERE mission_id=? AND workspace_id=? AND room_key=? ORDER BY created_at DESC', m.id, m.workspace_id, key); }
  /** Which declared room a message belongs in: explicit key, else the sender role's room, else the target role's, else the default. */
  roomKeyFor(pack: WorkflowPack, msg: { roomKey?: string; senderKey: string; toKey?: string; kind: string }): string {
    const t = pack.caseRooms!;
    if (msg.roomKey && t.rooms.some((r) => r.key === msg.roomKey)) return msg.roomKey;
    if (msg.kind === 'handoff' && msg.toKey && t.roleRoom[msg.toKey]) return t.roleRoom[msg.toKey]!;
    return t.roleRoom[msg.senderKey] ?? (msg.toKey ? t.roleRoom[msg.toKey] : undefined) ?? t.defaultRoom;
  }

  // ---------- inbound decisions from Switch ----------
  /** Returns true when the message was a strict decision (handled here, accepted or refused). */
  async onInbound(m: Row, room: Row, im: InboundMessage): Promise<boolean> {
    const ws = m.workspace_id;
    this.observeSender(ws, m.id, room, im);
    const cmd = parseStrictDecision(im.body);
    if (!cmd) return false;
    await this.decide(m, room, im, cmd);
    return true;
  }
  private observeSender(ws: string, missionId: string, room: Row, im: InboundMessage) {
    if (!im.senderId) return;
    const ex = this.db.get('SELECT id, messages FROM switch_observed_senders WHERE workspace_id=? AND sender_id=?', ws, im.senderId);
    if (ex) this.db.exec('UPDATE switch_observed_senders SET last_seen_at=?, messages=?, sender_name=?, mission_id=?, room_id=? WHERE id=?', nowIso(), ex.messages + 1, im.senderName, missionId, room.id, ex.id);
    else this.db.insert('switch_observed_senders', { id: uid('obs'), workspace_id: ws, mission_id: missionId, room_id: room.id, sender_id: im.senderId, sender_name: im.senderName, roster_type: null, first_seen_at: nowIso(), last_seen_at: nowIso(), messages: 1 });
  }
  private async decide(m: Row, room: Row, im: InboundMessage, cmd: StrictDecision) {
    const ws = m.workspace_id;
    const bodyHash = sha256(im.body ?? '');
    const decisionId = uid('swd');
    // Duplicate event delivery: the message id is unique per workspace; a second delivery is recorded and ignored.
    try {
      this.db.insert('switch_decisions', { id: decisionId, workspace_id: ws, mission_id: m.id, approval_id: null, message_id: im.messageId || `nomid-${bodyHash}`, room_id: room.id, room_external_id: im.roomId ?? room.external_id, room_key: room.room_key, sender_id: im.senderId ?? '', sender_name: im.senderName ?? '', sender_kind: im.senderKind ?? null, on_behalf_of: im.onBehalfOf ?? null, received_by: im.receivedBy ?? null, verb: cmd.verb, case_ref: cmd.caseRef, approval_ref: cmd.approvalRef, quoted_hash: cmd.hash, outcome: 'processing', reasons: '[]', user_id: null, body_hash: bodyHash, created_at: nowIso() });
    } catch {
      this.e.audit(ws, m.id, 'system', 'switch', 'switch_decision_duplicate', `Duplicate delivery of Switch message ${im.messageId} ignored (already processed once).`, { messageId: im.messageId });
      return;
    }
    const aps = this.db.all('SELECT a.*, x.payload_hash AS act_hash FROM approvals a LEFT JOIN actions x ON x.id=a.subject_id WHERE a.mission_id=? AND a.workspace_id=? ORDER BY a.analysis_rev DESC, a.created_at DESC', m.id, ws).filter((a) => chatRef('A', a.id) === cmd.approvalRef);
    const ap = aps[0];
    const info = this.info(room);
    let roster: { id: string | null; name: string; type: string }[] | null = null;
    if (this.e.collab.listParticipants && room.external_id) { try { roster = await this.e.collab.listParticipants(info); } catch { roster = null; } }
    else if (room.mode === 'local') roster = null;
    if (roster && im.senderId) { const t = roster.find((p) => p.name.toLowerCase() === (im.senderName ?? '').toLowerCase())?.type ?? null; this.db.exec('UPDATE switch_observed_senders SET roster_type=? WHERE workspace_id=? AND sender_id=?', t, ws, im.senderId); }
    const pinnedRow = im.senderId ? this.db.get('SELECT * FROM switch_people WHERE workspace_id=? AND sender_id=?', ws, im.senderId) : undefined;
    const decisionRoom = ap?.decision_room_key ? this.roomByKey(m, ap.decision_room_key) : undefined;
    const agentNames = (this.e.collab.identities?.() ?? []).map((s) => s.name);
    const reasons = evaluateDecision({
      message: { senderId: im.senderId, senderName: im.senderName, senderKind: im.senderKind, onBehalfOf: im.onBehalfOf, roomId: im.roomId ?? room.external_id },
      roster, agentNames, pinned: pinnedRow ? { userId: pinnedRow.user_id, switchName: pinnedRow.switch_name, chatUsername: pinnedRow.chat_username } : null,
      decision: cmd, mission: { caseRef: this.caseRef(m), analysisRev: m.analysis_rev },
      approval: ap ? { status: ap.status, analysisRev: ap.analysis_rev, expiresAt: ap.expires_at, payloadHash: ap.payload_hash ?? ap.act_hash, decisionRoomId: decisionRoom?.external_id ?? null } : null,
      now: nowIso(),
    });
    const finish = (outcome: string, rs: { code: string; detail: string }[], userId: string | null) => this.db.exec('UPDATE switch_decisions SET outcome=?, reasons=?, user_id=?, approval_id=? WHERE id=?', outcome, JSON.stringify(rs), userId, ap?.id ?? null, decisionId);
    const who = `${im.senderName || '?'} (${im.senderId || 'no sender id'})`;
    if (reasons.length) {
      finish('refused', reasons, pinnedRow?.user_id ?? null);
      this.e.audit(ws, m.id, 'system', 'switch', 'switch_decision_refused', `Switch ${cmd.verb.toUpperCase()} ${cmd.approvalRef} from ${who} REFUSED: ${reasons.map((r) => r.code).join(', ')}`, { decisionId, reasons, messageId: im.messageId });
      recordCausalEvent(this.db, { workspaceId: ws, missionId: m.id, causeType: 'human_decision', lifecycleState: 'REQUIRES_HUMAN', summary: `Refused Switch ${cmd.verb} from ${im.senderName || im.senderId}: ${reasons.map((r) => r.code).join(', ')}`, actor: 'switch-authority' });
      try { await this.e.collab.send(info, { kind: 'status', senderKey: pack(this.e, m).caseRooms?.coordinatorRole ?? SYS, senderName: 'RIPPLE authority check', body: `Not accepted: ${cmd.verb.toUpperCase()} ${cmd.caseRef} ${cmd.approvalRef} from ${im.senderName || im.senderId}. ${reasons.map((r) => `[${r.code}] ${r.detail}`).join(' ')} Nothing changed.` }); } catch { /* the refusal is recorded in RIPPLE either way */ }
      return;
    }
    const u = this.db.get('SELECT * FROM users WHERE id=? AND workspace_id=?', pinnedRow!.user_id, ws)!;
    const actor: Actor = { id: u.id, name: u.name, role: u.role, workspaceId: ws };
    try {
      await this.e.decideApproval(actor, m.id, ap!.id, cmd.verb === 'approve' ? 'approved' : 'rejected', cmd.verb === 'approve' ? (cmd.reason || `approved in Switch, payload ${cmd.hash!.slice(0, 12)}…`) : cmd.reason, { channel: 'switch', decisionId, senderId: im.senderId, roomId: im.roomId ?? room.external_id ?? null, messageId: im.messageId });
      finish('accepted', [], u.id);
      this.e.audit(ws, m.id, 'user', u.name, 'switch_decision_accepted', `${u.name} ${cmd.verb === 'approve' ? 'APPROVED' : 'REJECTED'} ${cmd.approvalRef} in Switch room #${room.name} (sender ${im.senderId}, payload ${String(ap!.payload_hash ?? ap!.act_hash).slice(0, 12)}…)`, { decisionId, approvalId: ap!.id, messageId: im.messageId });
    } catch (err) {
      const rs = [{ code: 'engine_refused', detail: String((err as Error).message).slice(0, 300) }];
      finish('refused', rs, u.id);
      this.e.audit(ws, m.id, 'system', 'switch', 'switch_decision_refused', `Switch ${cmd.verb.toUpperCase()} ${cmd.approvalRef} from ${who} REFUSED by the engine: ${rs[0]!.detail}`, { decisionId, reasons: rs });
      try { await this.e.collab.send(info, { kind: 'status', senderKey: pack(this.e, m).caseRooms?.coordinatorRole ?? SYS, senderName: 'RIPPLE authority check', body: `Not accepted: ${cmd.verb.toUpperCase()} ${cmd.approvalRef} from ${im.senderName}. [engine_refused] ${rs[0]!.detail} Nothing changed.` }); } catch { /* recorded */ }
    }
  }

  /** Pins a Switch sender id to a workspace person (owner only). Discovery: senders seen in rooms are listed for the owner. */
  pinPerson(a: Actor, input: { userId: string; senderId: string; switchName: string; chatUsername?: string | null }) {
    this.e.require(a, 'owner');
    const u = this.db.get('SELECT id,name FROM users WHERE id=? AND workspace_id=?', input.userId, a.workspaceId);
    if (!u) throw new EngineError(404, 'not_found', 'User not found in this workspace.');
    const sid = input.senderId.trim(); if (!/^@?[\w.-]+(:[\w.-]+)?$/.test(sid) || sid.length > 200) throw new EngineError(422, 'bad_sender', 'A Switch sender id looks like @switch-user-<id>:<server>.');
    const agentNames = (this.e.collab.identities?.() ?? []).map((s) => s.name.toLowerCase());
    if (agentNames.includes(input.switchName.trim().toLowerCase())) throw new EngineError(422, 'agent_identity', 'That name is a RIPPLE agent identity; agents cannot be pinned as people.');
    this.db.exec('DELETE FROM switch_people WHERE workspace_id=? AND sender_id=?', a.workspaceId, sid);
    this.db.insert('switch_people', { id: uid('swp'), workspace_id: a.workspaceId, user_id: u.id, switch_name: input.switchName.trim(), chat_username: input.chatUsername?.trim() || null, sender_id: sid, source: 'owner_pin', pinned_by: a.id, pinned_at: nowIso() });
    this.e.audit(a.workspaceId, null, 'user', a.name, 'switch_person_pinned', `Switch sender ${sid} (${input.switchName}) pinned to ${u.name}`, { userId: u.id, senderId: sid });
  }

  // ---------- room documents & handoffs ----------
  async writeDocument(m: Row, roomKey: string, doc: { name: string; description: string; content: string; kind: string }, authorRole: string | null) {
    const row = this.roomByKey(m, roomKey); if (!row) return null;
    let documentId: string | null = null; let readBack: string | null = null; let note = 'LOCAL room document (recorded in RIPPLE; not a Switch document)';
    if (row.external_id && this.e.collab.writeDocument) {
      try { const r = await this.e.collab.writeDocument(this.info(row), { name: doc.name, description: doc.description, instructions: 'Written by a RIPPLE agent identity. Hashes are SHA-256 over the exact content.', content: doc.content }, authorRole ?? undefined); documentId = r.documentId; readBack = r.readBackHash; note = r.note; }
      catch (err) { note = `Switch create_room_document FAILED: ${String((err as Error).message).slice(0, 200)}`; this.e.audit(m.workspace_id, m.id, 'system', SYS, 'switch_error', note); if (this.switchRequired) throw new EngineError(503, 'switch_required', note); }
    }
    const id = uid('rdoc');
    this.db.insert('room_documents', { id, workspace_id: m.workspace_id, mission_id: m.id, room_id: row.id, name: doc.name, kind: doc.kind, content: doc.content, content_hash: sha256(doc.content), author_role: authorRole, external_doc_id: documentId, read_back_hash: readBack, mode: row.mode, note, created_at: nowIso() });
    return { id, documentId, readBackHash: readBack, contentHash: sha256(doc.content), note, room: row };
  }
  recordHandoff(m: Row, rev: number, from: string, to: string, summary: string, claims: string[], evidenceRefs: string[], messageId: string | null = null) {
    const pk = pack(this.e, m); const t = pk.caseRooms;
    const fromRoom = t ? this.roomByKey(m, t.roleRoom[from] ?? t.defaultRoom)?.id ?? null : null;
    const toRoom = t ? this.roomByKey(m, t.roleRoom[to] ?? t.defaultRoom)?.id ?? null : null;
    const digest = sha256(stable({ claims, evidenceRefs }));
    this.db.insert('handoffs', { id: uid('hof'), workspace_id: m.workspace_id, mission_id: m.id, analysis_rev: rev, from_role: from, to_role: to, from_room: fromRoom, to_room: toRoom, digest, summary, message_id: messageId, created_at: nowIso() });
    return digest;
  }

  // ---------- evidence manifest & disclosure ----------
  private caseSecret(m: Row) {
    let row = this.db.get("SELECT content FROM artifacts WHERE mission_id=? AND workspace_id=? AND kind='case_secret'", m.id, m.workspace_id);
    if (!row) { const secret = sha256(`${uid('sec')}|${Math.random()}|${Date.now()}`); this.db.insert('artifacts', { id: uid('art'), workspace_id: m.workspace_id, mission_id: m.id, kind: 'case_secret', name: 'Evidence salt secret (server only; never shown)', content: secret, content_hash: sha256(secret), status: 'final', generated_by: 'ripple-engine', owner_role: null, created_at: nowIso() }); row = { content: secret }; }
    return String(row.content);
  }
  evidence(m: Row): { records: DisclosableRecord[]; secret: string } | null {
    const pk = pack(this.e, m); if (!pk.evidenceRecords) return null;
    const ch = this.db.get("SELECT * FROM change_events WHERE mission_id=? AND workspace_id=? ORDER BY seq DESC", m.id, m.workspace_id); if (!ch) return null;
    const plan = JSON.parse(this.e.baseline(m, ch.baseline_version).plan);
    return { records: pk.evidenceRecords(plan, JSON.parse(ch.input)), secret: this.caseSecret(m) };
  }
  manifest(m: Row) { const ev = this.evidence(m); return ev ? buildManifest(ev.records, ev.secret).manifest : null; }
  /** A participant requests only the records needed for one question. Restricted-room records go only to members of that room. */
  discloseEvidence(a: Actor, missionId: string, ids: string[], forRoomKey: string, question: string) {
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot request evidence disclosure.');
    const m = this.e.mission(a.workspaceId, missionId);
    const ev = this.evidence(m); if (!ev) throw new EngineError(404, 'no_manifest', 'This case has no evidence manifest.');
    if (!question.trim()) throw new EngineError(422, 'question_required', 'State the question the evidence is needed for.');
    const t = pack(this.e, m).caseRooms;
    const target = t?.rooms.find((r) => r.key === forRoomKey); if (!target) throw new EngineError(422, 'bad_room', 'Unknown room.');
    for (const id of ids) {
      const r = ev.records.find((x) => x.id === id); if (!r) throw new EngineError(404, 'not_in_manifest', `Record ${id} is not in this case's evidence manifest.`);
      const src = t!.rooms.find((x) => x.key === r.room);
      const disclosable = src ? (src.discloseRecords ?? src.sensitivity !== 'restricted') : false;
      if (src && src.key !== forRoomKey && !disclosable) throw new EngineError(403, 'restricted_evidence', `Record ${id} belongs to the restricted room #${src.name}, whose records are never disclosed outside it; it is not disclosed to #${target.name}. Ask its members for a claim instead.`);
    }
    const ds = disclose(ev.records, ev.secret, ids);
    const pub = buildManifest(ev.records, ev.secret).manifest;
    this.e.audit(a.workspaceId, m.id, 'user', a.name, 'evidence_disclosed', `${ids.length} evidence record(s) disclosed to #${target.name} for: ${question.slice(0, 120)}`, { ids, room: forRoomKey, root: pub.root });
    return { root: pub.root, count: pub.count, disclosures: ds };
  }
  verifyDisclosure(root: string, count: number, disclosures: Disclosure[], requested: string[]) { return verifyDisclosure({ root, count }, disclosures, requested); }

  // ---------- memory ----------
  memoryFor(ws: string, pk: WorkflowPack): MemoryItem[] {
    return this.db.all('SELECT * FROM memory_items WHERE workspace_id=? AND pack_id=? ORDER BY recorded_at DESC LIMIT 200', ws, pk.id).map((r) => ({ id: r.id, subject: r.subject, kind: r.kind, fact: r.fact, data: j(r.data, {}), status: r.status, confidence: r.confidence, ownerRole: r.owner_role, sourceMissionId: r.source_mission_id, sourceRef: r.source_ref, policyVersion: r.policy_version, recordedAt: r.recorded_at }));
  }
  writeMemory(m: Row, pk: WorkflowPack, ctx: Parameters<NonNullable<WorkflowPack['memoryFacts']>>[0]) {
    if (!pk.memoryFacts) return 0;
    const facts = pk.memoryFacts(ctx);
    for (const f of facts) this.db.insert('memory_items', { id: uid('mem'), workspace_id: m.workspace_id, pack_id: pk.id, subject: f.subject, kind: f.kind, fact: f.fact, data: JSON.stringify(f.data ?? {}), status: 'recorded', confidence: f.confidence ?? 1, owner_role: f.ownerRole ?? null, source_mission_id: m.id, source_ref: f.sourceRef, policy_version: f.policyVersion ?? null, recorded_at: nowIso() });
    if (facts.length) this.e.audit(m.workspace_id, m.id, 'system', SYS, 'memory_recorded', `${facts.length} fact(s) recorded for later cases (only completed, verified cases write memory)`, { kinds: facts.map((f) => f.kind) });
    return facts.length;
  }

  // ---------- impact routing ----------
  route(m: Row, rev: number) {
    const pk = pack(this.e, m); const t = pk.caseRooms; if (!t) return null;
    const ws = m.workspace_id;
    const roomOfRole = (r: string) => this.roomByKey(m, t.roleRoom[r] ?? t.defaultRoom)?.name ?? null;
    const dept = (roleKey: string) => pk.roles.find((r) => r.key === roleKey)?.department ?? 'Unassigned';
    const toRoute = (x: Row): RouteAction => { const spec = j<any>(x.spec, {}); return { key: x.key, title: x.title, payloadHash: x.payload_hash, approverRoles: [spec.approver?.role, spec.coApprover?.role].filter(Boolean), room: spec.decisionRoom ? this.roomByKey(m, spec.decisionRoom)?.name ?? null : null, department: dept(x.owner_role) }; };
    const current = this.db.all("SELECT * FROM actions WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status NOT IN ('superseded')", m.id, ws, rev).map(toRoute);
    const previous = this.db.all('SELECT * FROM actions WHERE mission_id=? AND workspace_id=? AND analysis_rev=?', m.id, ws, rev - 1).map((x) => ({ ...toRoute(x), status: x.status, approved: !!this.db.get("SELECT 1 x FROM approvals WHERE subject_id=? AND status IN ('approved','stale') AND decided_by IS NOT NULL", x.id) && !this.db.get("SELECT 1 x FROM approvals WHERE subject_id=? AND decided_by IS NULL", x.id) }));
    const graphArts = this.db.all("SELECT key FROM graph_nodes WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND kind='artifact'", m.id, ws, rev).map((n) => String(n.key).replace(/^artifact:/, ''));
    const impactedArtifacts = pk.artifacts.filter((a) => graphArts.includes(a.key)).map((a) => ({ key: a.key, department: a.department, ownerRole: a.ownerRole, room: roomOfRole(a.ownerRole) }));
    const teams = [...new Set(pk.roles.map((r) => r.department ?? 'Unassigned'))].map((d) => ({ department: d, room: roomOfRole(pk.roles.find((r) => (r.department ?? 'Unassigned') === d)!.key), roles: pk.roles.filter((r) => (r.department ?? 'Unassigned') === d).map((r) => r.key) }));
    const roleOfUser = (uid0: string | null): string => (uid0 ? String(this.db.get('SELECT key FROM agent_roles WHERE workspace_id=? AND pack_id=? AND user_id=? ORDER BY key', ws, pk.id, uid0)?.key ?? 'unassigned') : 'unassigned');
    const openQuestions = this.db.all("SELECT key, assignee_user_id, blocking FROM questions WHERE mission_id=? AND workspace_id=? AND status='open'", m.id, ws).map((q) => { const role = roleOfUser(q.assignee_user_id); return { key: q.key, assigneeRole: role, room: roomOfRole(role), blocking: !!q.blocking }; });
    const plan = routeImpact({ rev, current, previous, impactedArtifacts, teams, openQuestions });
    this.db.insert('impact_routes', { id: uid('rte'), workspace_id: ws, mission_id: m.id, analysis_rev: rev, body: JSON.stringify(plan), created_at: nowIso() });
    this.e.audit(ws, m.id, 'system', SYS, 'impact_routed', `Rev ${rev} routing: ${plan.deciders.length} decision(s) needed from ${[...new Set(plan.deciders.map((d) => d.role))].join(', ') || 'nobody'}; ${plan.carriedOver.length} approval(s) carried over; not interrupted: ${plan.notInterrupted.join(', ') || 'none'}`, plan);
    return plan;
  }

  // ---------- independent verifier ----------
  async runVerifier(a: Actor | null, missionId: string, ws: string) {
    const m = this.e.mission(ws, missionId); const pk = pack(this.e, m);
    if (!pk.independentVerifier) throw new EngineError(409, 'no_verifier', 'This pack declares no independent verifier.');
    const verifierRole = pk.independentVerifier.roleKey;
    const verifierName = (this.e.collab.identities?.() ?? []).find((s) => s.roleKeys.includes(verifierRole))?.name ?? pk.roles.find((r) => r.key === verifierRole)?.name ?? verifierRole;
    const change = this.db.get("SELECT * FROM change_events WHERE mission_id=? AND workspace_id=? AND status IN ('open','applied') ORDER BY seq DESC", m.id, ws);
    if (!change) throw new EngineError(409, 'no_change', 'No case to verify.');
    const answers: AnalysisContext['answers'] = {};
    for (const q of this.db.all("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND status='answered'", m.id, ws)) answers[q.key] = { text: q.answer, value: j(q.answer_value) };
    const acts = this.db.all("SELECT * FROM actions WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status NOT IN ('superseded','stale')", m.id, ws, m.analysis_rev);
    const input: VerifierInput = {
      baselinePlan: JSON.parse(this.e.baseline(m, change.baseline_version).plan), change: JSON.parse(change.input), answers,
      actions: acts.map((x) => {
        const conn = this.e.connectors[x.connector]; let observed: VerifierInput['actions'][number]['observed'];
        try { const o = conn.observe({ workspaceId: ws, missionId: m.id, idempotencyKey: x.idempotency_key }); observed = { found: o.found, count: o.count, content: o.content }; } catch { observed = null; }
        const payload = JSON.parse(x.payload);
        return { key: x.key, type: x.type, status: x.status, payload, payloadHash: x.payload_hash, recomputedPayloadHash: sha256(stable(payload)), idempotencyKey: x.idempotency_key, recomputedIdempotencyKey: sha256(`${ws}|${m.id}|${x.effect_key ?? ''}|${sha256(stable(payload))}`).slice(0, 32), observed, executedBy: x.executed_by ?? null };
      }),
      approvals: this.db.all('SELECT a.*, x.key AS action_key FROM approvals a JOIN actions x ON x.id=a.subject_id WHERE a.mission_id=? AND a.workspace_id=? AND a.analysis_rev=?', m.id, ws, m.analysis_rev).map((p) => {
        const d = p.decision_ref ? this.db.get('SELECT outcome FROM switch_decisions WHERE id=? AND workspace_id=?', p.decision_ref, ws) : undefined;
        return { actionKey: p.action_key, slot: p.slot ?? 1, status: p.status, decidedBy: p.decided_by, decidedVia: p.decided_via, approverUserId: p.approver_user_id, payloadHash: p.payload_hash, decisionAccepted: d ? d.outcome === 'accepted' : null };
      }),
      requesterUserId: this.db.get('SELECT created_by FROM change_events WHERE id=?', change.id)?.created_by ?? null,
      switchRequired: this.switchRequired,
    };
    const checks = pk.independentVerifier.verify(input);
    const gated = acts.filter((x) => j<any>(x.spec, {}).requiresVerifierPass);
    const covered = acts.filter((x) => !gated.includes(x));
    const body = verifierReceiptBody({ caseRef: this.caseRef(m), missionId: m.id, analysisRev: m.analysis_rev, verifier: verifierName, checks, inputsDigest: sha256(stable(input.actions.map((x) => ({ k: x.key, h: x.payloadHash, o: x.observed ? sha256(x.observed.content) : null })))), payloadHashes: covered.map((x) => x.payload_hash), issuedAt: nowIso() });
    const sealed = sealReceipt(body as unknown as Record<string, unknown>);
    const id = uid('rcp');
    this.db.insert('case_receipts', { id, workspace_id: ws, mission_id: m.id, kind: 'verifier', analysis_rev: m.analysis_rev, result: body.result, body: JSON.stringify(sealed.body), body_hash: sealed.bodyHash, merkle_root: sealed.sectionRoot, issued_by: verifierName, created_at: nowIso() });
    this.e.audit(ws, m.id, 'agent', verifierName, body.result === 'PASS' ? 'verifier_pass' : 'verifier_fail', `Independent verifier ${body.result}: ${checks.filter((c) => c.passed).length}/${checks.length} checks${body.workOrder.length ? `; work order: ${body.workOrder.map((w) => `${w.id} ${w.check} → ${w.owner}`).join('; ')}` : ''}`, { receiptId: id, bodyHash: sealed.bodyHash });
    recordCausalEvent(this.db, { workspaceId: ws, missionId: m.id, causeType: 'verification_probe', lifecycleState: body.result === 'PASS' ? 'VERIFIED' : 'FAILED', summary: `Independent verifier ${body.result} (${checks.length} checks)`, actor: verifierName });
    const vRoom = pk.caseRooms?.roleRoom[verifierRole];
    if (vRoom) {
      await this.writeDocument(m, vRoom, { name: `verifier-receipt-${this.caseRef(m)}-r${m.analysis_rev}-${id.slice(-4)}`, description: `Independent verifier ${body.result}`, kind: 'verifier_receipt', content: JSON.stringify(sealed, null, 2) }, verifierRole);
      await this.e.say(m, { kind: 'finding', senderKey: verifierRole, senderName: verifierName, senderKind: 'agent', roomKey: vRoom, body: `Independent verification ${body.result} for ${this.caseRef(m)} (rev ${m.analysis_rev}): ${checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.name}`).join('; ')}. Receipt SHA-256 ${sealed.bodyHash}.${body.workOrder.length ? ` Work order: ${body.workOrder.map((w) => `${w.id} → ${w.owner}: ${w.action}`).join(' | ')}` : ''}` });
    }
    if (body.result === 'PASS') await this.issueResolutionReceipt(m, 'verified-resolution', verifierName);
    return { id, ...sealed };
  }
  latestVerifier(m: Row) { return this.db.get("SELECT * FROM case_receipts WHERE mission_id=? AND workspace_id=? AND kind='verifier' ORDER BY created_at DESC, rowid DESC", m.id, m.workspace_id); }
  verifierPassed(m: Row): { passed: boolean; detail: string } {
    const r = this.latestVerifier(m);
    if (!r) return { passed: false, detail: 'The independent verifier has not issued a receipt yet.' };
    if (r.analysis_rev !== m.analysis_rev) return { passed: false, detail: `Latest verifier receipt is for rev ${r.analysis_rev}; the case is at rev ${m.analysis_rev}.` };
    if (r.result !== 'PASS') return { passed: false, detail: `Latest verifier receipt is FAIL (${r.body_hash.slice(0, 12)}…); see its work order.` };
    const hashes = j<any>(r.body, {}).payloadHashes as string[] ?? [];
    const now = this.db.all("SELECT payload_hash, spec FROM actions WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status='verified'", m.id, m.workspace_id, m.analysis_rev).filter((x) => !j<any>(x.spec, {}).requiresVerifierPass).map((x) => x.payload_hash);
    const missing = now.filter((h) => !hashes.includes(h));
    if (missing.length) return { passed: false, detail: `${missing.length} verified action(s) were not covered by the verifier receipt; re-run the verifier.` };
    return { passed: true, detail: `PASS receipt ${r.body_hash.slice(0, 16)}… by ${r.issued_by}` };
  }

  // ---------- resolution receipt ----------
  async issueResolutionReceipt(m: Row, kind: 'verified-resolution' | 'final', issuer: string) {
    const ws = m.workspace_id; const pk = pack(this.e, m); const fresh = this.e.mission(ws, m.id);
    const change = this.db.get("SELECT * FROM change_events WHERE mission_id=? AND workspace_id=? ORDER BY seq DESC", m.id, ws);
    const man = this.manifest(fresh);
    const rooms = this.db.all('SELECT * FROM rooms WHERE mission_id=? AND workspace_id=? ORDER BY created_at', m.id, ws);
    const acts = this.db.all('SELECT * FROM actions WHERE mission_id=? AND workspace_id=? AND analysis_rev=?', m.id, ws, fresh.analysis_rev);
    const names = (id: string | null) => (id ? this.db.get('SELECT name FROM users WHERE id=?', id)?.name ?? id : null);
    const verifier = this.latestVerifier(fresh);
    const body = {
      format: 'ripple-resolution-receipt/1', kind, caseRef: this.caseRef(fresh), missionId: fresh.id, pack: pk.id, analysisRev: fresh.analysis_rev, issuedAt: nowIso(), issuedBy: issuer,
      intent: { changeDigest: change ? sha256(change.input) : null, title: fresh.title },
      timeline: this.db.all("SELECT type, summary, created_at FROM audit_events WHERE mission_id=? AND workspace_id=? AND type IN ('state_change','case_rooms_opened','switch_decision_accepted','switch_decision_refused','action_executed','action_unknown','action_effect_observed','action_verified','verifier_pass','verifier_fail','mission_completed') ORDER BY rowid", m.id, ws).map((x) => ({ at: x.created_at, type: x.type, summary: String(x.summary).slice(0, 200) })),
      rooms: rooms.map((r) => ({ key: r.room_key, name: r.name, mode: r.mode, switchRoomId: r.external_id, members: j(r.members, []), sensitivity: r.sensitivity })),
      handoffs: this.db.all('SELECT from_role, to_role, digest, summary FROM handoffs WHERE mission_id=? AND workspace_id=? AND analysis_rev=? ORDER BY created_at', m.id, ws, fresh.analysis_rev),
      evidence: man ? { manifestRoot: man.root, records: man.count } : null,
      decisions: this.db.all('SELECT verb, approval_ref, sender_id, sender_name, outcome, reasons, quoted_hash, created_at FROM switch_decisions WHERE mission_id=? AND workspace_id=? ORDER BY created_at', m.id, ws).map((d) => ({ ...d, reasons: j(d.reasons, []) })),
      approvals: this.db.all('SELECT a.slot, a.status, a.decided_by, a.decided_via, a.payload_hash, x.title FROM approvals a JOIN actions x ON x.id=a.subject_id WHERE a.mission_id=? AND a.workspace_id=? AND a.analysis_rev=?', m.id, ws, fresh.analysis_rev).map((a) => ({ action: a.title, slot: a.slot, status: a.status, decidedBy: names(a.decided_by), via: a.decided_via ?? 'not decided', payloadHash: a.payload_hash })),
      executions: acts.map((x) => ({ action: x.title, status: x.status, attempts: x.attempts, executedBy: names(x.executed_by), idempotencyKey: x.idempotency_key, payloadHash: x.payload_hash })),
      observations: acts.filter((x) => ['verified', 'executed'].includes(x.status)).map((x) => { try { const o = this.e.connectors[x.connector].observe({ workspaceId: ws, missionId: m.id, idempotencyKey: x.idempotency_key }); return { action: x.title, before: 'no effect for this idempotency key (recorded before execution)', after: { found: o.found, count: o.count, contentHash: o.contentHash } }; } catch (err) { return { action: x.title, before: 'no effect', after: { readBackError: String((err as Error).message).slice(0, 120) } }; } }),
      verifier: verifier ? { result: verifier.result, receiptHash: verifier.body_hash, by: verifier.issued_by, rev: verifier.analysis_rev } : null,
      recovery: this.db.all("SELECT type, summary, created_at FROM audit_events WHERE mission_id=? AND workspace_id=? AND type IN ('action_unknown','action_effect_observed','unknown_resolved_absent','recovery_retry','recovery_simulated') ORDER BY rowid", m.id, ws).map((x) => ({ at: x.created_at, type: x.type, summary: String(x.summary).slice(0, 220) })),
      uncertainty: [
        ...this.db.all("SELECT text FROM questions WHERE mission_id=? AND workspace_id=? AND status='open'", m.id, ws).map((q) => `open question: ${String(q.text).slice(0, 140)}`),
        ...acts.filter((x) => !['verified', 'rejected', 'superseded'].includes(x.status)).map((x) => `${x.title}: ${x.status}`),
        `collaboration: ${rooms[0]?.mode === 'switch' ? 'real Switch rooms' : 'LOCAL MODE (not Switch)'}`,
        'money targets the labelled billing sandbox (no payment provider); email is dry-run (nothing sent)',
      ],
      status: { state: fresh.state, completed: fresh.state === 'completed' },
    };
    const sealed = sealReceipt(body as unknown as Record<string, unknown>);
    const id = uid('rcp');
    this.db.insert('case_receipts', { id, workspace_id: ws, mission_id: m.id, kind, analysis_rev: fresh.analysis_rev, result: kind === 'final' ? 'COMPLETED' : 'VERIFIED', body: JSON.stringify(sealed.body), body_hash: sealed.bodyHash, merkle_root: sealed.sectionRoot, issued_by: issuer, created_at: nowIso() });
    const t = pk.caseRooms;
    if (t) {
      const full = t.roleRoom[pk.independentVerifier?.roleKey ?? ''] ?? t.defaultRoom;
      await this.writeDocument(fresh, full, { name: `resolution-receipt-${kind}-${this.caseRef(fresh)}-${id.slice(-4)}`, description: `RIPPLE ${kind} receipt (SHA-256 ${sealed.bodyHash.slice(0, 16)}…)`, kind: 'resolution_receipt', content: JSON.stringify(sealed, null, 2) }, pk.independentVerifier?.roleKey ?? null);
      if (t.defaultRoom !== full) {
        const shareable = { caseRef: body.caseRef, kind, receiptHash: sealed.bodyHash, sectionRoot: sealed.sectionRoot, verifier: body.verifier, status: body.status, note: 'Shareable digest. The full receipt (with ledger observations) is in the verification room.' };
        await this.writeDocument(fresh, t.defaultRoom, { name: `resolution-digest-${kind}-${this.caseRef(fresh)}-${id.slice(-4)}`, description: 'Shareable resolution digest', kind: 'resolution_digest', content: JSON.stringify(shareable, null, 2) }, t.coordinatorRole);
      }
    }
    this.e.audit(ws, m.id, 'system', issuer, 'resolution_receipt_issued', `${kind} receipt issued: SHA-256 ${sealed.bodyHash}`, { receiptId: id });
    return { id, ...sealed };
  }
  verifyStoredReceipt(ws: string, receiptId: string) {
    const r = this.db.get('SELECT * FROM case_receipts WHERE id=? AND workspace_id=?', receiptId, ws);
    if (!r) throw new EngineError(404, 'not_found', 'Receipt not found.');
    return verifyReceipt({ body: JSON.parse(r.body), bodyHash: r.body_hash, sectionRoot: r.merkle_root });
  }

  // ---------- recovery simulation ----------
  /** Read-only: what a recovery of an UNCERTAIN action would do, bound to the observed basis hash. Executes nothing. */
  simulateRecovery(a: Actor, missionId: string, actionId: string) {
    const m = this.e.mission(a.workspaceId, missionId);
    const act = this.db.get('SELECT * FROM actions WHERE id=? AND mission_id=? AND workspace_id=?', actionId, m.id, a.workspaceId);
    if (!act) throw new EngineError(404, 'not_found', 'Action not found.');
    if (!['execution_unknown', 'failed', 'verification_failed'].includes(act.status)) throw new EngineError(409, 'not_uncertain', `Action is ${act.status}; recovery simulation applies to unknown or failed outcomes.`);
    let basis: { found: boolean; count: number; contentHash: string } | { error: string };
    try { const o = this.e.connectors[act.connector].observe({ workspaceId: a.workspaceId, missionId: m.id, idempotencyKey: act.idempotency_key }); basis = { found: o.found, count: o.count, contentHash: o.contentHash }; }
    catch (err) { basis = { error: String((err as Error).message).slice(0, 200) }; }
    const steps = 'error' in basis
      ? ['The read-back itself failed: the outcome stays UNKNOWN.', 'Nothing will be executed. Try the read-back again; escalate if it keeps failing.']
      : basis.found
        ? [`Read-back found ${basis.count} effect(s) for idempotency key ${act.idempotency_key.slice(0, 8)}…: the write happened and only its response was lost.`, 'Recovery = record the effect and verify it independently. The write is NOT repeated.']
        : ['Read-back found NO effect for this idempotency key.', 'Recovery = retry with the SAME idempotency key and the SAME approved payload (no new approval needed: nothing material changed).'];
    const planHash = sha256(stable({ actionId: act.id, payloadHash: act.payload_hash, basis }));
    this.e.audit(a.workspaceId, m.id, 'user', a.name, 'recovery_simulated', `Recovery simulated for "${act.title}": ${steps[0]}`, { actionId: act.id, planHash, basis });
    return { actionId: act.id, title: act.title, status: act.status, basis, steps, planHash, willExecute: !('error' in basis) && !basis.found, willRepeatWrite: false };
  }
}

const pack = (e: Engine, m: Row) => e.pack(m);
