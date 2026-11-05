import { randomUUID } from 'node:crypto';
import type { CollabPort, InboundMessage, OutboundMessage, RoomInfo } from './port.js';

/**
 * Switch adapter (https://github.com/sandbox-quantum/switch, docs/official/internals/agent-protocol.md).
 * RIPPLE registers (out of band) as ONE Switch agent. It:
 *   - POST {bridge}/agents/{agent_id}/ops/create_room         (agent_names = role agents registered in Switch + RIPPLE itself)
 *   - GET  {bridge}/agents/{agent_id}/events?connection_id=…&rooms=… (SSE; domain events `message`, `room_join`, …)
 *   - POST {bridge}/agents/{agent_id}/ops/connect_to_room     (header X-Switch-Connection-Id)
 *   - POST {bridge}/agents/{agent_id}/connection/beat         every 2s (or the interval the server announces)
 *   - POST {bridge}/agents/{agent_id}/ops/send_targeted_message | post_message
 * Authority stays in RIPPLE: Switch replies are ingested as advisory room messages, never as verified state.
 * NOT TESTED against a real Switch server in this repository's development environment; see docs/SWITCH.md.
 * Session 3: stream resume (Last-Event-ID), server-provided heartbeat interval, evicted/gap handling, de-duplication and own-message
 * filtering were ported from CrewPilot's Switch client (MIT, github.com/vincenzo-afk/CrewPilot, switch/agent_client.py) and are
 * tested ONLY against a mock of the protocol (tests/switch-resilience.test.ts).
 */
export interface SwitchConfig {
  bridgeUrl: string; agentId: string; apiKey: string;
  /** RIPPLE role key -> Switch agent name (must already be registered in Switch) */
  roleAgents: Record<string, string>;
  /** this agent's own Switch name, included in create_room.agent_names so RIPPLE is a member */
  selfName?: string;
  fetchImpl?: typeof fetch;
  beatMs?: number;
  /** back-off between stream re-opens; the last value repeats. Default 1s, 2s, 5s, 10s (as CrewPilot's client). */
  reconnectDelaysMs?: number[];
}

export class SwitchError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const MAX_SEEN = 500;

export class SwitchCollab implements CollabPort {
  readonly mode = 'switch' as const;
  readonly label = 'SWITCH';
  private f: typeof fetch;
  private connId = randomUUID();
  private handlers = new Map<string, Set<(m: InboundMessage) => void>>();
  private streams = new Map<string, AbortController>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private beatTimer: ReturnType<typeof setTimeout> | null = null;
  private beatEvery: number;
  private cursor = 0;
  /** Stream incarnation announced by Switch 0.31+ on `connection_state`; echoed on every heartbeat (server fences displaced clients). */
  private generation: number | null = null;
  private closed = false;
  private seen = new Set<string>();
  private lastError: string | null = null;
  private connectedRooms = new Set<string>();
  constructor(private cfg: SwitchConfig) { this.f = cfg.fetchImpl ?? fetch; this.beatEvery = cfg.beatMs ?? 2000; }

  describe() {
    return { mode: 'switch', connected: this.connectedRooms.size > 0, detail: `Switch bridge ${this.cfg.bridgeUrl}; agent ${this.cfg.agentId}; connected rooms: ${this.connectedRooms.size}${this.lastError ? `; last error: ${this.lastError}` : ''}` };
  }
  private base() { return `${this.cfg.bridgeUrl.replace(/\/$/, '')}/agents/${this.cfg.agentId}`; }
  private headers(withConn = false): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json', ...(withConn ? { 'X-Switch-Connection-Id': this.connId } : {}) };
  }
  /** GET /health is the documented, public probe for "is this the bridge base URL". */
  async health(): Promise<boolean> {
    const r = await this.f(`${this.cfg.bridgeUrl.replace(/\/$/, '')}/health`);
    return r.ok;
  }
  async op<T = any>(name: string, args: Record<string, unknown>, withConn = false): Promise<T> {
    const r = await this.f(`${this.base()}/ops/${name}`, { method: 'POST', headers: this.headers(withConn), body: JSON.stringify(args) });
    const text = await r.text();
    if (!r.ok) { this.lastError = `${name}: HTTP ${r.status}`; throw new SwitchError(r.status, `Switch op ${name} failed: HTTP ${r.status} ${text.slice(0, 200)}`); }
    return (JSON.parse(text) as { result: T }).result;
  }

  async openRoom(a: { missionId: string; title: string; topic: string; agentRoles: { key: string; name: string }[] }): Promise<RoomInfo> {
    const agentNames = [...new Set([...(this.cfg.selfName ? [this.cfg.selfName] : []), ...a.agentRoles.map((r) => this.cfg.roleAgents[r.key]).filter(Boolean)])];
    const room = await this.op<{ id: string; name: string }>('create_room', {
      name: `RIPPLE · ${a.title}`.slice(0, 80), description: a.topic, agent_names: agentNames,
      instructions: 'RIPPLE mission room. RIPPLE holds authoritative state; answer handoffs addressed to your role with concrete findings. Do not claim to certify food safety. Ask the human if information is missing.',
    });
    await this.attach(room.id);
    return { mode: 'switch', externalId: room.id, name: room.name, note: 'Switch room created via create_room.' };
  }

  /** Open the SSE stream declaring the room on the URL, then claim the room with connect_to_room, then heartbeat. */
  private async attach(roomId: string) {
    await this.openStream(roomId);
    await this.op('connect_to_room', { room_id: roomId }, true);
    this.connectedRooms.add(roomId);
    this.startBeat();
  }

  /** Opens (or re-opens) the event stream with the SAME connection id and, when we have a cursor, `Last-Event-ID` so Switch can replay what we missed. */
  private async openStream(roomId: string) {
    const ac = new AbortController(); this.streams.set(roomId, ac);
    const url = `${this.base()}/events?connection_id=${this.connId}&scope=single&filter=all&start_from=head&rooms=${roomId}&client=ripple&client_version=0.1.0`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: 'text/event-stream' };
    if (this.cursor > 0) headers['Last-Event-ID'] = String(this.cursor);
    const res = await this.f(url, { headers, signal: ac.signal });
    if (!res.ok || !res.body) { this.streams.delete(roomId); throw new SwitchError(res.status, `Switch event stream refused: HTTP ${res.status}`); }
    const stillCurrent = () => !this.closed && this.streams.get(roomId) === ac;
    void this.pump(res.body, roomId).then(
      () => { if (stillCurrent()) { this.lastError = 'event stream closed by Switch; reconnecting'; void this.reopen(roomId); } },
      (e) => { if (stillCurrent()) { this.lastError = `stream: ${String(e)}`; void this.reopen(roomId); } },
    );
  }

  private later(ms: number) { return new Promise<void>((resolve) => { const t = setTimeout(() => { this.timers.delete(t); resolve(); }, ms); t.unref?.(); this.timers.add(t); }); }
  /** Re-opens a dropped stream with back-off. Gives up on 401/403 (a bad key does not fix itself) or when closed. */
  private async reopen(roomId: string, attempt = 0): Promise<void> {
    const delays = this.cfg.reconnectDelaysMs?.length ? this.cfg.reconnectDelaysMs : [1000, 2000, 5000, 10000];
    await this.later(delays[Math.min(attempt, delays.length - 1)]);
    if (this.closed) return;
    try { await this.openStream(roomId); await this.op('connect_to_room', { room_id: roomId }, true); this.lastError = null; }
    catch (e) {
      this.lastError = `reconnect: ${String(e)}`;
      if (e instanceof SwitchError && (e.status === 401 || e.status === 403)) return;
      return this.reopen(roomId, attempt + 1);
    }
  }
  private dropAndReopen(roomId: string) { const ac = this.streams.get(roomId); this.streams.delete(roomId); ac?.abort(); void this.reopen(roomId); }

  private startBeat() {
    if (this.beatTimer || this.closed) return;
    const tick = () => {
      this.beatTimer = setTimeout(async () => {
        try {
          const r = await this.f(`${this.base()}/connection/beat`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ connection_id: this.connId, cursor: this.cursor, ...(this.generation !== null ? { generation: this.generation } : {}) }) });
          if (r.status === 404 || r.status === 409) { this.lastError = `heartbeat ${r.status}: connection reopened`; for (const id of this.connectedRooms) this.dropAndReopen(id); }
          else if (r.status === 401 || r.status === 403) this.lastError = `heartbeat rejected (HTTP ${r.status}): check the agent API key`;
        } catch (e) { this.lastError = `heartbeat: ${String(e)}`; }
        if (!this.closed) tick();
      }, this.beatEvery);
      this.beatTimer.unref?.();
    };
    tick();
  }

  private async pump(body: ReadableStream<Uint8Array>, roomId: string) {
    const reader = body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) { this.frame(buf.slice(0, i), roomId); buf = buf.slice(i + 2); }
    }
  }
  private frame(raw: string, roomId: string) {
    let eventName = ''; let data = ''; let id: string | undefined;
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue; // keepalive comment
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
    }
    if (id && /^\d+$/.test(id)) this.cursor = Math.max(this.cursor, Number(id));
    if (!data) return;
    let d: any; try { d = JSON.parse(data); } catch { return; }
    const type = String(d.type ?? eventName ?? '');           // Switch puts the type in the JSON; some servers also send an `event:` line
    switch (type) {
      case 'connection_state': {
        if (Number.isFinite(Number(d.cursor))) this.cursor = Math.max(this.cursor, Number(d.cursor));
        if (d.generation !== undefined && d.generation !== null && Number.isFinite(Number(d.generation))) this.generation = Number(d.generation);
        const s = Number(d.heartbeat_interval_seconds);
        if (s > 0 && s <= 60) this.beatEvery = s * 1000;
        return;
      }
      case 'gap': this.lastError = `Switch reported lost events (${d.reason ?? 'unknown'}); room context may be incomplete.`; return;
      case 'evicted': this.lastError = `Switch evicted this connection (${d.reason ?? 'unknown'}); reconnecting`; this.dropAndReopen(roomId); return;
      case 'message': break;
      default: return;                                          // subscription_changed, room_released, … are not messages
    }
    if (d.room_id !== roomId) return;
    const p = d.payload ?? {};
    const mid = String(p.message_id ?? '');
    if (mid) { if (this.seen.has(mid)) return; this.seen.add(mid); if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string); }
    const name = String(p.sender_name ?? p.sender ?? '');
    if (this.cfg.selfName && name.toLowerCase() === this.cfg.selfName.toLowerCase()) return;   // never react to our own posts
    for (const h of this.handlers.get(roomId) ?? []) h({ senderId: String(p.sender ?? ''), senderName: name, body: String(p.body ?? ''), messageId: mid, addressed: !!p.addressed, timestamp: Number(p.timestamp ?? Date.now()) });
  }
  subscribe(room: RoomInfo, handler: (m: InboundMessage) => void) {
    const id = room.externalId!; const set = this.handlers.get(id) ?? new Set(); set.add(handler); this.handlers.set(id, set);
    return () => { set.delete(handler); };
  }

  async send(room: RoomInfo, msg: OutboundMessage) {
    if (!room.externalId) return;
    const body = `[${msg.kind}] ${msg.senderName}${msg.toName ? ` → ${msg.toName}` : ''}: ${msg.body}`;
    const target = msg.toKey ? this.cfg.roleAgents[msg.toKey] : undefined;
    if (msg.kind === 'handoff' || msg.kind === 'question' || msg.kind === 'escalation') {
      if (target) { await this.op('send_targeted_message', { body, target_names: [target] }, true); return; }
    }
    await this.op('post_message', { body }, true);
  }

  async close() {
    this.closed = true;
    if (this.beatTimer) clearTimeout(this.beatTimer);
    this.beatTimer = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const ac of this.streams.values()) ac.abort();
    this.streams.clear(); this.connectedRooms.clear();
  }
}

export function switchConfigFromEnv(env: NodeJS.ProcessEnv): SwitchConfig | null {
  if (!env.SWITCH_BRIDGE_URL || !env.SWITCH_AGENT_ID || !env.SWITCH_AGENT_API_KEY) return null;
  const roleAgents: Record<string, string> = {};
  for (const pair of (env.SWITCH_ROLE_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = pair.split('='); if (k && v) roleAgents[k.trim()] = v.trim();
  }
  return { bridgeUrl: env.SWITCH_BRIDGE_URL, agentId: env.SWITCH_AGENT_ID, apiKey: env.SWITCH_AGENT_API_KEY, roleAgents, selfName: env.SWITCH_SELF_NAME };
}
