/**
 * MOCK of the switch-core 0.31 agent bridge, multi-identity (session 21). It models only what RIPPLE uses, from the
 * 0.31 source (core/switch_core/bridges/agent/operations/definitions.py, protocol/message_events.py, agent-protocol.md):
 *  - every API key is one agent identity; `Authorization: Bearer <key>` decides who calls
 *  - create_room: agent_names (caller is a member only if listed), user_names (people on the bridged chat), linked_rooms,
 *    read/write_visibility, internal_only; refused with HTTP 400 when the default chat bridge is down and the room is bridged
 *  - connect_to_room: HTTP 400 "Agent is not a member of this room" for non-members (observed live)
 *  - post_message / send_targeted_message act on the room the connection last claimed; the SERVER assigns `sender`
 *    (@switch-agent-<id>:localhost for agents, @switch-user-<id>:localhost for people) and `sender_name`
 *  - message events reach every member identity's stream (SSE frames `id:` + `data:{type,room_id,payload}`)
 *  - list_participants {id,name,type:'agent'|'user',status}; list_bridges; get_my_context; create_room_document +
 *    load_internal_documents (ids required); GET rooms/{id}/history (members only)
 * A mock proves RIPPLE's protocol usage and refusal logic. It is NOT a Switch server and never proves one works.
 */
export interface MockRoom { id: string; name: string; agents: string[]; users: string[]; linked: { target_room_id: string; label: string }[]; privateRead: boolean; internalOnly: boolean; docs: { id: string; name: string; content: string }[]; messages: { sender: string; sender_name: string; body: string; message_id: string }[] }

export function switchCoreMock(opts: { agents: Record<string, string> /* name -> apiKey */; bridgeActive?: boolean }) {
  const enc = new TextEncoder();
  const keyToName = new Map(Object.entries(opts.agents).map(([n, k]) => [k, n]));
  const agentIds = new Map(Object.keys(opts.agents).map((n, i) => [n, `ag-${i + 1}`]));
  const rooms = new Map<string, MockRoom>();
  const claims = new Map<string, string>();                     // connection id -> room id
  const streams: { agent: string; room: string; ctl: ReadableStreamDefaultController<Uint8Array> }[] = [];
  const calls: { agent: string; op: string; body: any }[] = [];
  let n = 0; let seq = 0;
  const state = { bridgeActive: opts.bridgeActive ?? true, down: false, rejectKeys: new Set<string>() };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ok = (result: unknown) => json(200, { result });
  const fail = (status: number, detail: string) => json(status, { detail });
  const userSender = (u: string) => `@switch-user-${u.toLowerCase()}:localhost`;
  const agentSender = (a: string) => `@switch-agent-${agentIds.get(a)}:localhost`;

  function deliver(room: MockRoom, payload: Record<string, unknown>) {
    const id = ++seq;
    const frame = enc.encode(`id: ${id}\nevent: message\ndata: ${JSON.stringify({ type: 'message', room_id: room.id, payload })}\n\n`);
    for (const s of streams) if (s.room === room.id && room.agents.includes(s.agent)) { try { s.ctl.enqueue(frame); } catch { /* closed */ } }
  }
  function post(room: MockRoom, sender: string, senderName: string, body: string, extra: Record<string, unknown> = {}) {
    const message_id = `$ev${++seq}`;
    room.messages.push({ sender, sender_name: senderName, body, message_id });
    deliver(room, { addressed: false, sender, sender_name: senderName, message_id, body, timestamp: Date.now(), thread_id: null, attachments: [], ...extra });
    return message_id;
  }

  const fetchImpl = (async (input: any, init: any = {}) => {
    if (state.down) throw new TypeError('fetch failed (mock Switch outage)');
    const url = new URL(String(input)); const headers = new Headers(init.headers);
    const key = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (url.pathname.endsWith('/health')) return json(200, { status: 'ok' });
    const me = state.rejectKeys.has(key) ? undefined : keyToName.get(key);
    if (!me) return fail(401, 'Invalid agent API key');
    const body = init.body ? JSON.parse(init.body) : {};
    const conn = headers.get('x-switch-connection-id');
    if (url.pathname.endsWith('/events')) {
      const roomId = url.searchParams.get('rooms') ?? '';
      const r = rooms.get(roomId);
      if (r && !r.agents.includes(me)) return fail(403, 'Agent is not a member of this room');
      const stream = new ReadableStream<Uint8Array>({ start(ctl) { streams.push({ agent: me, room: roomId, ctl }); ctl.enqueue(enc.encode(`event: connection_state\ndata: {"type":"connection_state","cursor":${seq},"generation":1,"heartbeat_interval_seconds":30}\n\n`)); } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname.endsWith('/connection/beat')) return json(200, { ok: true });
    const hist = /\/rooms\/([^/]+)\/history$/.exec(url.pathname);
    if (hist) { const r = rooms.get(hist[1]!); if (!r) return fail(404, 'Room not found'); if (!r.agents.includes(me)) return fail(403, 'Not a member'); return json(200, { events: r.messages.map((m) => ({ type: 'message', payload: m })) }); }
    const opm = /\/ops\/([a-z_]+)$/.exec(url.pathname); if (!opm) return fail(404, 'no route');
    const op = opm[1]!; calls.push({ agent: me, op, body });
    const claimed = () => (conn ? rooms.get(claims.get(conn) ?? '') : undefined);
    switch (op) {
      case 'get_my_context': return ok({ you: { name: me, id: agentIds.get(me) }, agents: [{ name: me, who_can_talk: 'owner_and_owner_agents' }], person: { name: 'Owner', email: 'owner@switch.local' }, server: { version: '0.31.0' } });
      case 'list_bridges': return ok([{ id: 'br-mm', type: 'mattermost', display_name: 'Mattermost', status: state.bridgeActive ? 'active' : 'stopped', is_default: true, can_create_channels: true }]);
      case 'create_room': {
        if (!body.internal_only && !state.bridgeActive) return fail(400, "Default bridge 'Mattermost' is not running, so the room cannot be bridged");
        const id = `rm-${++n}`;
        const r: MockRoom = { id, name: body.name, agents: [...new Set<string>(body.agent_names ?? [])], users: body.internal_only ? [] : [...(body.user_names ?? [])], linked: body.linked_rooms ?? [], privateRead: body.read_visibility === 'private', internalOnly: !!body.internal_only, docs: [], messages: [] };
        for (const a of r.agents) if (!agentIds.has(a)) return fail(400, `Unknown agent ${a}`);
        rooms.set(id, r);
        return ok({ id, name: r.name, transport_room_id: `!${id}:localhost`, caller_is_member: r.agents.includes(me) });
      }
      case 'connect_to_room': { const r = rooms.get(body.room_id); if (!r) return fail(404, 'Room not found'); if (!r.agents.includes(me)) return fail(400, 'Agent is not a member of this room'); if (conn) claims.set(conn, r.id); return ok({ room_id: r.id, name: r.name, linked_rooms: r.linked }); }
      case 'post_message': case 'send_targeted_message': { const r = claimed(); if (!r) return fail(409, 'No connected room'); const b = op === 'send_targeted_message' ? `${(body.target_names ?? []).map((t: string) => `@${t}`).join(' ')} ${body.body}` : body.body; return ok({ message_id: post(r, agentSender(me), me, b) }); }
      case 'list_participants': { const r = claimed(); if (!r) return fail(409, 'No connected room'); return ok([...r.agents.map((a) => ({ id: agentIds.get(a), name: a, type: 'agent', status: 'online' })), ...r.users.map((u) => ({ id: `ext-${u}`, name: u, type: 'user', status: null }))]); }
      case 'create_room_document': { const r = claimed(); if (!r) return fail(409, 'No connected room'); const d = { id: `doc-${++n}`, name: body.name, content: body.content }; r.docs.push(d); return ok({ document_id: d.id }); }
      case 'load_internal_documents': { const r = claimed(); if (!r) return fail(409, 'No connected room'); if (!Array.isArray(body.ids)) return fail(400, 'load_internal_documents requires: ids'); return ok(r.docs.filter((d) => body.ids.includes(d.id)).map((d) => ({ document_id: d.id, name: d.name, content: d.content }))); }
      default: return fail(404, `unknown op ${op}`);
    }
  }) as unknown as typeof fetch;

  return {
    fetchImpl, rooms, calls, state, agentSender, userSender,
    roomByPrefix: (p: string) => [...rooms.values()].find((r) => r.name.startsWith(p)),
    /** A person types in the bridged chat (the server assigns the sender id). */
    personSays: (roomId: string, username: string, body: string, extra: { senderKind?: string; onBehalfOf?: string; senderId?: string; messageId?: string } = {}) => {
      const r = rooms.get(roomId)!; const sender = extra.senderId ?? userSender(username);
      if (extra.messageId) { r.messages.push({ sender, sender_name: username, body, message_id: extra.messageId }); deliver(r, { addressed: false, sender, sender_name: extra.onBehalfOf ?? username, sender_kind: extra.senderKind, on_behalf_of: extra.onBehalfOf, message_id: extra.messageId, body, timestamp: Date.now(), thread_id: null, attachments: [] }); return extra.messageId; }
      return post(r, sender, extra.onBehalfOf ?? username, body, { ...(extra.senderKind ? { sender_kind: extra.senderKind } : {}), ...(extra.onBehalfOf ? { on_behalf_of: extra.onBehalfOf } : {}) });
    },
    /** An agent identity posts with its own key (e.g. a forged APPROVE). */
    agentSays: (roomId: string, agent: string, body: string) => post(rooms.get(roomId)!, agentSender(agent), agent, body),
    redeliver: (roomId: string, messageId: string) => { const r = rooms.get(roomId)!; const m = r.messages.find((x) => x.message_id === messageId)!; deliver(r, { addressed: false, ...m, timestamp: Date.now(), thread_id: null, attachments: [] }); },
    joinUser: (roomId: string, username: string) => { rooms.get(roomId)!.users.push(username); },
    closeStreams: () => { for (const s of streams.splice(0)) { try { s.ctl.close(); } catch { /* */ } } },
  };
}
