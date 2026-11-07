import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Actor, Engine } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { j, nowIso, uid, type Row } from '../db/db.js';
import type { InboundMessage, RoomInfo } from '../collab/port.js';
import { briefing, capabilities, missionControl, sealLedger, verifySeals } from '../api/dashboards.js';
import { HELP, PAGES, interpreterFromEnv, isWrite, parseIntent, type Intent, type ModelInterpreter } from './intents.js';

type Env = { Variables: { actor: Actor } };
type Status = 'off' | 'connected' | 'unreachable' | 'not_configured' | 'disconnected';
interface Link { label: string; href: string }
interface Reply { body: string; data: Record<string, unknown> }
const PENDING_TTL_MS = 15 * 60_000;

/**
 * The Switch Console: one conversational room reachable from every page of RIPPLE.
 *
 * - The on/off switch controls ONLY the connection to a Switch room. The console itself always works locally.
 * - Authority stays in RIPPLE: a message that arrives from Switch is advisory. It may ask read-only questions; anything that
 *   changes state is queued until a signed-in RIPPLE user confirms it.
 * - Every state change runs through the normal Engine method with the confirming user's identity, so roles,
 *   who-specific approvals, stale-plan checks and independent verification apply exactly as in the UI.
 * - Switch has only been exercised against a mock of its documented protocol (see docs/SWITCH.md). The status shown is what
 *   this process actually observed (health probe, create_room, stream), never assumed.
 */
export class SwitchConsole {
  private rooms = new Map<string, { room: RoomInfo; unsub: () => void }>();
  constructor(private engine: Engine, private model: ModelInterpreter | null = null) {}

  get interpreter() { return this.model ? `deterministic parser, falling back to ${this.model.name} for unrecognised phrasing` : 'deterministic parser (no model configured)'; }
  private get switchCapable() { const c: any = this.engine.collab; return c.mode === 'switch' && typeof c.health === 'function'; }

  state(ws: string) {
    const r = this.engine.db.get('SELECT * FROM console_state WHERE workspace_id=?', ws);
    let status: Status = (r?.status as Status) ?? 'off';
    let detail = r?.detail ?? 'Switch connection is off. The console works locally; nothing is sent to Switch.';
    if (status === 'connected' && !this.rooms.has(ws)) { status = 'disconnected'; detail = 'This server restarted since the room was connected. Turn the switch on again to reconnect.'; }
    return { enabled: !!r?.enabled, status, detail, room: r?.room_external_id ?? null, updatedBy: r?.updated_by ?? null, updatedAt: r?.updated_at ?? null, switchConfigured: this.switchCapable, collab: this.engine.collab.describe(), interpreter: this.interpreter };
  }
  private saveState(ws: string, patch: { enabled: boolean; status: Status; detail: string; room?: string | null; by: string }) {
    this.engine.db.exec(`INSERT INTO console_state (workspace_id, enabled, status, detail, room_external_id, updated_by, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled, status=excluded.status, detail=excluded.detail, room_external_id=excluded.room_external_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      ws, patch.enabled ? 1 : 0, patch.status, patch.detail, patch.room ?? null, patch.by, nowIso());
  }

  async toggle(a: Actor, enabled: boolean) {
    this.engine.require(a, 'owner', 'manager');
    const ws = a.workspaceId;
    const prev = this.rooms.get(ws); if (prev) { prev.unsub(); this.rooms.delete(ws); }
    if (!enabled) {
      this.saveState(ws, { enabled: false, status: 'off', detail: 'Switch connection is off. The console works locally; nothing is sent to Switch.', by: a.name });
    } else if (!this.switchCapable) {
      this.saveState(ws, { enabled: true, status: 'not_configured', detail: 'Switch is not configured on this server (set SWITCH_BRIDGE_URL, SWITCH_AGENT_ID and SWITCH_AGENT_API_KEY, then restart). The console keeps working locally; nothing is sent to Switch.', by: a.name });
    } else {
      const collab: any = this.engine.collab;
      try {
        if (!(await collab.health())) throw new Error('GET /health did not return 200');
        const wsName = this.engine.db.get('SELECT name FROM workspaces WHERE id=?', ws)?.name ?? 'RIPPLE';
        const room: RoomInfo = await collab.openRoom({ missionId: `console-${ws}`, title: `${wsName} console`, topic: 'RIPPLE console room. Ask RIPPLE for status; changes need confirmation by a signed-in RIPPLE user.', agentRoles: [] });
        const unsub = collab.subscribe ? collab.subscribe(room, (m: InboundMessage) => { void this.fromSwitch(ws, m); }) : () => {};
        this.rooms.set(ws, { room, unsub });
        this.saveState(ws, { enabled: true, status: 'connected', detail: `Connected to Switch room "${room.name}" (${room.externalId}). Messages from the room are advisory; state changes still need confirmation here.`, room: room.externalId, by: a.name });
      } catch (e) {
        this.saveState(ws, { enabled: true, status: 'unreachable', detail: `Could not connect to Switch: ${(e as Error).message}. The console keeps working locally.`, by: a.name });
      }
    }
    const s = this.state(ws);
    this.engine.audit(ws, null, 'user', a.name, 'switch_console_toggled', `Switch console connection turned ${enabled ? 'on' : 'off'}: ${s.status}`, { status: s.status });
    this.post(ws, null, 'ripple', 'RIPPLE', `Switch connection ${enabled ? 'on' : 'off'}: ${s.detail}`, { kind: 'system', status: s.status });
    return s;
  }

  messages(ws: string, limit = 80) {
    return this.engine.db.all<Row>('SELECT * FROM (SELECT *, rowid AS rid FROM console_messages WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rid', ws, limit).map((m): Row => { const { rid, ...rest } = m; void rid; return { ...rest, data: j(m.data, {}) }; });
  }
  private post(ws: string, userId: string | null, author: 'user' | 'ripple' | 'switch', name: string, body: string, data: Record<string, unknown> = {}) {
    const row = { id: uid('cmsg'), workspace_id: ws, user_id: userId, author, author_name: name, body, data, created_at: nowIso() };
    this.engine.db.insert('console_messages', row);
    return row;
  }
  private async mirror(ws: string, body: string) {
    const r = this.rooms.get(ws); if (!r) return;
    try { await this.engine.collab.send(r.room, { kind: 'status', senderKey: 'ripple', senderName: 'RIPPLE', body }); }
    catch (e) { this.saveState(ws, { enabled: true, status: 'unreachable', detail: `Sending to Switch failed: ${(e as Error).message}`, room: r.room.externalId, by: 'system' }); }
  }

  private async interpret(text: string): Promise<{ intent: Intent; by: string }> {
    const d = parseIntent(text);
    if (d.kind !== 'unknown' || !this.model) return { intent: d, by: 'deterministic' };
    const m = await this.model.interpret(text);
    if (!m || m.kind === 'confirm' || m.kind === 'cancel') return { intent: d, by: 'deterministic' }; // a model may never confirm on anyone's behalf
    return { intent: m, by: this.model.name };
  }

  /** A signed-in RIPPLE user talks to the console. */
  async say(a: Actor, text: string) {
    const ws = a.workspaceId;
    const userMsg = this.post(ws, a.id, 'user', a.name, text);
    const { intent, by } = await this.interpret(text);
    let reply: Reply;
    if (intent.kind === 'confirm') reply = await this.confirmLatest(a);
    else if (intent.kind === 'cancel') reply = this.cancelLatest(a);
    else if (isWrite(intent.kind)) reply = a.role === 'viewer' ? { body: 'Viewers can read everything here but cannot change anything.', data: {} } : this.propose(ws, intent, 'console');
    else reply = this.read(ws, intent);
    const out = this.post(ws, null, 'ripple', 'RIPPLE', reply.body, { ...reply.data, intent: intent.kind, interpreter: by });
    void this.mirror(ws, `${a.name}: ${text}\nRIPPLE: ${reply.body}`);
    return { messages: [userMsg, out] };
  }

  /** A message that arrived from the connected Switch room. Read-only intents are answered; changes are queued for a RIPPLE user. */
  async fromSwitch(ws: string, m: InboundMessage) {
    this.post(ws, null, 'switch', m.senderName || 'Switch', m.body, { messageId: m.messageId, addressed: m.addressed });
    const { intent, by } = await this.interpret(m.body);
    let reply: Reply;
    if (intent.kind === 'confirm' || intent.kind === 'cancel') reply = { body: 'Confirmations from Switch are not accepted. A signed-in RIPPLE user must confirm in the console.', data: {} };
    else if (isWrite(intent.kind)) { reply = this.propose(ws, intent, 'switch'); reply.body = `Requested from Switch by ${m.senderName || 'a room member'}. ${reply.body}`; }
    else reply = this.read(ws, intent);
    this.post(ws, null, 'ripple', 'RIPPLE', reply.body, { ...reply.data, intent: intent.kind, interpreter: by, origin: 'switch' });
    await this.mirror(ws, reply.body);
  }

  // ---------------- read-only answers ----------------
  private lists(ws: string) {
    const db = this.engine.db;
    return {
      approvals: db.all("SELECT a.id, a.mission_id, a.title, a.required_role, a.approver_label, m.title AS mission_title FROM approvals a JOIN missions m ON m.id=a.mission_id AND m.workspace_id=a.workspace_id WHERE a.workspace_id=? AND a.status='pending' ORDER BY a.created_at, a.rowid", ws),
      actions: db.all("SELECT a.id, a.mission_id, a.title, a.connector, a.status, m.title AS mission_title FROM actions a JOIN missions m ON m.id=a.mission_id AND m.workspace_id=a.workspace_id WHERE a.workspace_id=? AND a.status IN ('approved','failed','execution_unknown') AND a.analysis_rev=m.analysis_rev ORDER BY a.created_at, a.rowid", ws),
      questions: db.all("SELECT q.id, q.mission_id, q.text, q.blocking, m.title AS mission_title FROM questions q JOIN missions m ON m.id=q.mission_id AND m.workspace_id=q.workspace_id WHERE q.workspace_id=? AND q.status='open' ORDER BY q.created_at, q.rowid", ws),
    };
  }
  private read(ws: string, i: Intent): Reply {
    const L = this.lists(ws);
    const numbered = (rows: Row[], f: (r: Row) => string) => rows.map((r, n) => `${n + 1}. ${f(r)}`).join('\n');
    switch (i.kind) {
      case 'help': return { body: `You can type:\n${HELP.map((h) => `• ${h}`).join('\n')}\n\nAnything that changes state asks you to confirm first.`, data: {} };
      case 'status': {
        const k = missionControl(this.engine, ws).kpis;
        return { body: `${k.active} active of ${k.total} missions · ${k.awaitingApproval} awaiting approval · ${k.blocked} blocked · ${k.recovery} need recovery.\nVerified actions: ${k.verifiedRate === null ? 'none executed yet' : `${k.verified}/${k.finished} (${k.verifiedRate}%)`} · independent checks (30d): ${k.checksPassedRate === null ? 'none yet' : `${k.checksPassedRate}% of ${k.checks30d} passed`}.`, data: { links: [{ label: 'Mission Control', href: '#/mission-control' }] } };
      }
      case 'attention': {
        const items = missionControl(this.engine, ws).attention.slice(0, 6);
        return { body: items.length ? `Needs attention:\n${numbered(items, (x) => `[${x.priority}] ${x.title}: ${x.detail} (${x.owner})`)}` : 'Nothing needs attention right now.', data: { links: items.map((x) => ({ label: x.title, href: x.href })) as Link[] } };
      }
      case 'approvals': return { body: L.approvals.length ? `Pending approvals:\n${numbered(L.approvals, (a) => `${a.title} (${a.mission_title}; needs ${a.approver_label ?? a.required_role})`)}\n\nSay "approve 1" or "reject 1 because …".` : 'No approvals are pending.', data: { links: [{ label: 'Approvals', href: '#/approvals' }] } };
      case 'actions': return { body: L.actions.length ? `Actions ready to execute or retry:\n${numbered(L.actions, (a) => `${a.title} (${a.mission_title}; ${a.connector}; ${String(a.status).replace(/_/g, ' ')})`)}\n\nSay "execute 1".` : 'No approved action is waiting to execute.', data: {} };
      case 'questions': return { body: L.questions.length ? `Open questions:\n${numbered(L.questions, (q) => `${q.blocking ? '[blocking] ' : ''}${q.text} (${q.mission_title})`)}\n\nSay "answer 1: …".` : 'No open questions.', data: {} };
      case 'missions': {
        const ms = this.engine.db.all("SELECT id, title, state FROM missions WHERE workspace_id=? AND state NOT IN ('completed','cancelled') ORDER BY updated_at DESC LIMIT 10", ws);
        return { body: ms.length ? `Active missions:\n${numbered(ms, (m) => `${m.title} (${String(m.state).replace(/_/g, ' ')})`)}` : 'No active missions. Try "start demo podflow".', data: { links: ms.map((m) => ({ label: m.title, href: `#/mission/${m.id}` })) } };
      }
      case 'brief': { const b = briefing(this.engine, ws); return { body: `Briefing (${b.generator}, from recorded state):\n${b.lines.map((l) => `• ${l}`).join('\n')}`, data: { links: [{ label: 'Knowledge & Decisions', href: '#/knowledge' }] } }; }
      case 'verify': {
        const v = verifySeals(this.engine, ws);
        const broken = v.seals.filter((s) => !s.intact).length;
        return { body: `${v.seals.length ? `${v.seals.length} seal(s) re-verified: ${broken ? `${broken} BROKEN, the audit log changed after sealing` : 'all intact'}.` : 'No seal recorded yet. Say "seal the ledger" to anchor the current chain head.'}\nCurrent chain head ${v.current.head.slice(0, 16)}… over ${v.current.count} audit event(s).`, data: { links: [{ label: 'Trust & Evidence', href: '#/trust' }] } };
      }
      case 'capabilities': {
        const c = capabilities(this.engine, ws);
        return { body: `${c.totals.projects} source projects → ${c.totals.systems} capability systems → ${c.totals.dashboards} dashboards → 1 engine (${c.totals.packs} implemented packs).\n${c.systems.map((s) => `${s.no} ${s.short}: ${s.projects.length} source(s), packs: ${s.packs.map((p) => p.name).join(', ') || 'none yet'}`).join('\n')}\n${c.totals.pending} awaiting classification.`, data: { links: [{ label: 'Mission Control', href: '#/mission-control' }] } };
      }
      case 'packs': return { body: this.engine.packs.all().map((p) => `• ${p.id} — ${p.name} (${p.domain})`).join('\n'), data: {} };
      case 'switch': { const s = this.state(ws); return { body: `Switch: ${s.status.replace(/_/g, ' ')}. ${s.detail}\nInterpreter: ${s.interpreter}.`, data: { status: s.status } }; }
      case 'navigate': { const p = PAGES[i.page ?? '']; return p ? { body: `Opening ${p.label}.`, data: { navigate: p.hash } } : { body: 'I do not know that page.', data: {} }; }
      default: return { body: `I did not understand that${this.model ? '' : ' (no model is configured for free-form phrasing)'}. Type "help" for what I can do.`, data: {} };
    }
  }

  // ---------------- proposals (state changes wait for a human) ----------------
  private propose(ws: string, i: Intent, origin: 'console' | 'switch'): Reply {
    const L = this.lists(ws);
    const pick = (rows: Row[], ref: string | undefined, field: string): { row?: Row; err?: string } => {
      if (!ref) return { err: 'Which one? Give its number from the list.' };
      if (/^\d+$/.test(ref)) { const r = rows[Number(ref) - 1]; return r ? { row: r } : { err: `There is no #${ref}; the list has ${rows.length} item(s).` }; }
      const hits = rows.filter((r) => String(r[field]).toLowerCase().includes(ref.toLowerCase()));
      return hits.length === 1 ? { row: hits[0] } : { err: hits.length ? `"${ref}" matches ${hits.length} items; use the number.` : `Nothing matches "${ref}".` };
    };
    let pending: Record<string, unknown>; let summary: string;
    switch (i.kind) {
      case 'approve': case 'reject': {
        const p = pick(L.approvals, i.ref, 'title'); if (!p.row) return { body: `${p.err} Say "list approvals" to see them.`, data: {} };
        if (i.kind === 'reject' && !i.text) return { body: 'A reason is required to reject: say "reject N because …".', data: {} };
        pending = { op: i.kind, approvalId: p.row.id, missionId: p.row.mission_id, note: i.text ?? '' };
        summary = `${i.kind === 'approve' ? 'Approve' : 'Reject'} "${p.row.title}" (${p.row.mission_title})${i.text ? `, note: ${i.text}` : ''}`; break;
      }
      case 'execute': {
        const p = pick(L.actions, i.ref, 'title'); if (!p.row) return { body: `${p.err} Say "list actions" to see them.`, data: {} };
        pending = { op: 'execute', actionId: p.row.id, missionId: p.row.mission_id };
        const mode = this.engine.connectors[p.row.connector]?.mode ?? 'unknown';
        summary = p.row.status === 'execution_unknown'
          ? `Recover "${p.row.title}": read the ${p.row.connector} effect back first (${mode} connector); repeat it only if the read-back proves it is absent, then verify independently`
          : `Execute "${p.row.title}" via ${p.row.connector} (${mode} connector), then verify it independently`; break;
      }
      case 'complete': {
        const ms = this.engine.db.all("SELECT id, title FROM missions WHERE workspace_id=? AND state='verifying' ORDER BY updated_at DESC", ws);
        const p = pick(ms, i.ref ?? (ms.length === 1 ? '1' : undefined), 'title'); if (!p.row) return { body: ms.length ? `${p.err} Missions ready to complete:\n${ms.map((m, n) => `${n + 1}. ${m.title}`).join('\n')}` : 'No mission is in verifying state, so none can be completed yet.', data: {} };
        pending = { op: 'complete', missionId: p.row.id };
        summary = `Complete "${p.row.title}" (only succeeds if every completion criterion is met)`; break;
      }
      case 'answer': {
        const p = pick(L.questions, i.ref, 'text'); if (!p.row) return { body: `${p.err} Say "list questions" to see them.`, data: {} };
        if (!i.text) return { body: 'What is the answer? Say "answer N: …".', data: {} };
        pending = { op: 'answer', questionId: p.row.id, missionId: p.row.mission_id, answer: i.text };
        summary = `Answer "${p.row.text}" with: ${i.text}`; break;
      }
      case 'demo': {
        const q = (i.pack ?? '').toLowerCase().replace(/[^a-z0-9 -]/g, '').trim();
        const all = this.engine.packs.all();
        const pk = all.find((p) => p.id === q || p.name.toLowerCase() === q) ?? all.find((p) => q.length > 2 && (p.id.includes(q) || p.name.toLowerCase().includes(q)));
        if (!pk) return { body: `No workflow pack matches "${i.pack ?? ''}". Say "packs" for the list.`, data: {} };
        pending = { op: 'demo', packId: pk.id };
        summary = `Start a labelled demo mission from the ${pk.name} sample (baseline approved, sample change analysed)`; break;
      }
      case 'seal': pending = { op: 'seal' }; summary = 'Seal the audit ledger at its current hash-chain head'; break;
      default: return { body: 'Nothing to propose.', data: {} };
    }
    const who = origin === 'switch' ? 'a signed-in RIPPLE user with the right role' : 'you';
    return { body: `Proposed: ${summary}.\nNothing has changed yet. To proceed, ${who} must say "yes" or press Confirm.`, data: { pending: { ...pending, summary, origin, expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString() }, resolved: false } };
  }
  private latestPending(ws: string) {
    return this.engine.db.all("SELECT * FROM console_messages WHERE workspace_id=? AND author='ripple' ORDER BY created_at DESC, rowid DESC LIMIT 40", ws)
      .map((m): Row => ({ ...m, data: j(m.data, {}) })).find((m) => m.data.pending && !m.data.resolved && Date.parse(m.data.pending.expiresAt) > Date.now());
  }
  private resolve(ws: string, id: string, patch: Record<string, unknown>) {
    const m = this.engine.db.get('SELECT data FROM console_messages WHERE id=? AND workspace_id=?', id, ws);
    if (m) this.engine.db.exec('UPDATE console_messages SET data=? WHERE id=? AND workspace_id=?', JSON.stringify({ ...j(m.data, {}), resolved: true, ...patch }), id, ws);
  }
  private async confirmLatest(a: Actor): Promise<Reply> {
    if (a.role === 'viewer') return { body: 'Viewers cannot confirm changes.', data: {} };
    const p = this.latestPending(a.workspaceId);
    return p ? this.run(a, p.id, p.data.pending) : { body: 'There is nothing waiting for confirmation.', data: {} };
  }
  private cancelLatest(a: Actor): Reply {
    const p = this.latestPending(a.workspaceId);
    if (!p) return { body: 'There is nothing to cancel.', data: {} };
    this.resolve(a.workspaceId, p.id, { cancelledBy: a.name, result: 'cancelled' });
    return { body: `Cancelled: ${p.data.pending.summary}. Nothing changed.`, data: {} };
  }
  private pendingById(a: Actor, id: string) {
    const m = this.engine.db.get("SELECT * FROM console_messages WHERE id=? AND workspace_id=? AND author='ripple'", id, a.workspaceId);
    const d = j(m?.data, {});
    if (!m || !d.pending) throw new EngineError(404, 'not_found', 'Proposal not found.');
    if (d.resolved) throw new EngineError(409, 'already_resolved', 'This proposal was already confirmed or cancelled.');
    return d;
  }
  /** Confirm a specific proposal by id (the Confirm button). */
  async confirm(a: Actor, id: string) {
    const d = this.pendingById(a, id);
    if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot confirm changes.');
    if (Date.parse(d.pending.expiresAt) <= Date.now()) throw new EngineError(409, 'expired', 'This proposal expired. Ask again.');
    this.post(a.workspaceId, a.id, 'user', a.name, 'Confirm', { confirms: id });
    const reply = await this.run(a, id, d.pending);
    const out = this.post(a.workspaceId, null, 'ripple', 'RIPPLE', reply.body, { ...reply.data, intent: 'confirm', interpreter: 'deterministic' });
    void this.mirror(a.workspaceId, reply.body);
    return { message: out };
  }
  cancel(a: Actor, id: string) {
    this.pendingById(a, id);
    this.resolve(a.workspaceId, id, { cancelledBy: a.name, result: 'cancelled' });
    return { ok: true };
  }

  private async run(a: Actor, id: string, p: any): Promise<Reply> {
    const e = this.engine; const ws = a.workspaceId;
    try {
      let body: string;
      let links: Link[] = p.missionId ? [{ label: 'Open mission', href: `#/mission/${p.missionId}` }] : [];
      if (p.op === 'approve' || p.op === 'reject') {
        await e.decideApproval(a, p.missionId, p.approvalId, p.op === 'approve' ? 'approved' : 'rejected', p.note || (p.op === 'approve' ? 'Approved from the RIPPLE console' : ''));
        body = p.op === 'approve' ? `Approved, recorded as ${a.name}'s decision. The action can now be executed ("list actions").` : `Rejected, recorded as ${a.name}'s decision.`;
      } else if (p.op === 'execute') {
        await e.executeAction(a, p.missionId, p.actionId);
        const act = e.db.get('SELECT status, last_error, result FROM actions WHERE id=? AND workspace_id=?', p.actionId, ws);
        const res = j(act?.result, {});
        body = act?.status === 'verified'
          ? (res.recoveredBy === 'read-back' ? 'Recovered: the read-back found the effect already in place, so it was NOT repeated. Independently verified.' : 'Executed and independently verified (the effect was read back).')
          : act?.status === 'execution_unknown'
            ? `Outcome UNKNOWN, recorded as execution unknown (not success, not failure): ${act.last_error ?? ''}. Nothing was repeated. Say "list actions" and execute it again to read the effect back first.`
            : `Current status is ${String(act?.status).replace(/_/g, ' ')}${act?.last_error ? `: ${act.last_error}` : ''}. It is NOT verified.`;
      } else if (p.op === 'complete') {
        await e.completeMission(a, p.missionId);
        body = 'Mission completed: every completion criterion was met and the outcome is recorded.';
      } else if (p.op === 'answer') {
        await e.answerQuestion(a, p.missionId, p.questionId, p.answer);
        body = 'Answer recorded; the affected agents re-ran their analysis.';
      } else if (p.op === 'demo') {
        const pack = e.packs.get(p.packId); if (!pack) throw new EngineError(404, 'not_found', 'Pack not found.');
        const s = pack.sample();
        const m = await e.createMission(a, { packId: pack.id, title: `${s.title} [demo]`, plan: s.plan, source: 'demo-sample' });
        e.approveBaseline(a, m.id, 'Demo baseline from labelled sample data (console)');
        await e.submitChange(a, m.id, s.change, 'demo-sample');
        body = `Started "${s.title} [demo]" from labelled sample data. It is now ${String(e.mission(ws, m.id).state).replace(/_/g, ' ')}.`;
        links = [{ label: 'Open mission', href: `#/mission/${m.id}` }];
      } else if (p.op === 'seal') {
        const v = sealLedger(e, a); const last = v.seals[v.seals.length - 1];
        body = `Ledger sealed at ${last?.upto ?? 0} event(s), head ${String(last?.expected ?? '').slice(0, 16)}…`;
        links = [{ label: 'Trust & Evidence', href: '#/trust' }];
      } else throw new EngineError(422, 'unknown_op', 'Unknown proposal.');
      this.resolve(ws, id, { confirmedBy: a.name, result: 'done' });
      return { body, data: { links } };
    } catch (err) {
      const msg = err instanceof EngineError ? err.message : 'Internal error';
      if (!(err instanceof EngineError)) console.error(err);
      this.resolve(ws, id, { confirmedBy: a.name, result: 'refused', error: msg });
      return { body: `Not done: ${msg}`, data: { error: msg } };
    }
  }

  static fromEnv(engine: Engine, env: NodeJS.ProcessEnv) { return new SwitchConsole(engine, interpreterFromEnv(env)); }
}

export function registerConsoleRoutes(app: Hono<Env>, sc: SwitchConsole) {
  const A = (c: Context<Env>) => c.get('actor');
  const body = async <T extends z.ZodTypeAny>(c: Context<Env>, s: T): Promise<z.infer<T>> => s.parse(await c.req.json().catch(() => ({})));
  app.get('/api/console', (c) => { const ws = A(c).workspaceId; return c.json({ state: sc.state(ws), messages: sc.messages(ws), help: HELP }); });
  app.post('/api/console/say', async (c) => { const b = await body(c, z.object({ text: z.string().trim().min(1).max(1000) })); return c.json(await sc.say(A(c), b.text)); });
  app.post('/api/console/confirm/:id', async (c) => c.json(await sc.confirm(A(c), c.req.param('id') as string)));
  app.post('/api/console/cancel/:id', (c) => c.json(sc.cancel(A(c), c.req.param('id') as string)));
  app.post('/api/console/switch', async (c) => { const b = await body(c, z.object({ enabled: z.boolean() })); return c.json(await sc.toggle(A(c), b.enabled)); });
}
