import { describe, it, expect } from 'vitest';
import { SwitchCollab, switchConfigFromEnv } from '../src/server/collab/switch.js';
import { makeEnv, newBaselinedMission, row, rows } from './helpers.js';

/**
 * MOCK bridge: implements ONLY the subset of the documented Switch agent protocol that the adapter uses
 * (docs/official/internals/agent-protocol.md). It proves the adapter's HTTP contract and engine wiring.
 * It is NOT a real Switch server and these tests do NOT show a real Switch integration works.
 */
function mockBridge() {
  const calls: { path: string; method: string; auth: string | null; conn: string | null; body: any }[] = [];
  const enc = new TextEncoder();
  let streamCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname + url.search, method: init.method ?? 'GET', auth: headers.get('authorization'), conn: headers.get('x-switch-connection-id'), body });
    if (url.pathname.endsWith('/events')) {
      const stream = new ReadableStream<Uint8Array>({ start(c) { streamCtl = c; c.enqueue(enc.encode('event: connection_state\ndata: {"cursor":0}\n\n')); } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname.endsWith('/connection/beat')) return Response.json({ ok: true });
    if (url.pathname.endsWith('/ops/create_room')) return Response.json({ result: { id: 'room-uuid-1', name: body.name } });
    if (url.pathname.includes('/ops/')) return Response.json({ result: { event_id: 'e1' } });
    return new Response('nf', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl, push: (s: string) => streamCtl!.enqueue(enc.encode(s)) };
}

describe('Switch adapter against a MOCK of the documented protocol', () => {
  it('creates a room with role agents, opens the SSE stream with room declared on the URL, claims the room, and sends targeted handoffs', async () => {
    const mb = mockBridge();
    const sw = new SwitchCollab({ bridgeUrl: 'http://bridge.test', agentId: 'agent-1', apiKey: 'k-secret', selfName: 'ripple', roleAgents: { kitchen: 'ripple-kitchen', procurement: 'ripple-procurement' }, fetchImpl: mb.fetchImpl, beatMs: 20 });
    const env = makeEnv(sw);
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);

    const create = mb.calls.find((c) => c.path.endsWith('/ops/create_room'))!;
    expect(create.auth).toBe('Bearer k-secret');
    expect(create.body.agent_names).toEqual(['ripple', 'ripple-kitchen', 'ripple-procurement']);
    const events = mb.calls.find((c) => c.path.includes('/events?'))!;
    expect(events.path).toMatch(/connection_id=[0-9a-f-]{36}/); expect(events.path).toContain('rooms=room-uuid-1'); expect(events.path).toContain('filter=all');
    const connect = mb.calls.find((c) => c.path.endsWith('/ops/connect_to_room'))!;
    expect(connect.body).toEqual({ room_id: 'room-uuid-1' }); expect(connect.conn).toMatch(/^[0-9a-f-]{36}$/);
    const targeted = mb.calls.filter((c) => c.path.endsWith('/ops/send_targeted_message'));
    expect(targeted.some((t) => t.body.target_names[0] === 'ripple-kitchen' && /Kitchen Agent/.test(t.body.body))).toBe(true);
    expect(mb.calls.some((c) => c.path.endsWith('/ops/post_message'))).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(mb.calls.some((c) => c.path.endsWith('/connection/beat'))).toBe(true);
    expect(row(env, 'SELECT * FROM rooms WHERE mission_id=?', mission.id)).toMatchObject({ mode: 'switch', external_id: 'room-uuid-1' });
    await sw.close();
  });

  it('engine records inbound Switch room messages as advisory external messages without changing mission state', async () => {
    const mb = mockBridge();
    const sw = new SwitchCollab({ bridgeUrl: 'http://bridge.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: mb.fetchImpl, beatMs: 5000 });
    const env = makeEnv(sw);
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    const before = row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state;
    mb.push('id: 3\nevent: message\ndata: {"type":"message","room_id":"room-uuid-1","payload":{"sender":"@switch-agent-x:s","sender_name":"ripple-kitchen","body":"Chestnut is a tree nut; chef must review.","addressed":true,"message_id":"mm1","timestamp":1},"sequence":3}\n\n');
    await new Promise((r) => setTimeout(r, 40));
    const inbound = rows(env, "SELECT * FROM messages WHERE mission_id=? AND source='switch'", mission.id);
    expect(inbound).toHaveLength(1); expect(inbound[0]).toMatchObject({ sender_kind: 'external', sender_name: 'ripple-kitchen' });
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe(before);
    await sw.close();
  });

  it('parses inbound SSE message frames from the room and ignores control frames / other rooms', async () => {
    const mb = mockBridge();
    const sw = new SwitchCollab({ bridgeUrl: 'http://bridge.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: mb.fetchImpl, beatMs: 5000 });
    const room = await sw.openRoom({ missionId: 'm', title: 't', topic: 'x', agentRoles: [] });
    const got: string[] = [];
    sw.subscribe(room, (m) => got.push(`${m.senderName}:${m.body}:${m.addressed}`));
    mb.push(': keepalive\n\n');
    mb.push('event: subscription_changed\ndata: {"rooms":[]}\n\n');
    mb.push('id: 7\nevent: message\ndata: {"type":"message","room_id":"other","payload":{"body":"nope"},"sequence":7}\n\n');
    mb.push('id: 8\nevent: message\ndata: {"type":"message","room_id":"room-uuid-1","payload":{"sender":"@switch-user-ab:srv","sender_name":"Priya","body":"18 vegan","addressed":true,"message_id":"m1","timestamp":1},"sequence":8}\n\n');
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual(['Priya:18 vegan:true']);
    await sw.close();
  });

  it('degrades honestly to a labelled local room when Switch is unreachable', async () => {
    const failing = (async () => new Response('boom', { status: 503 })) as typeof fetch;
    const sw = new SwitchCollab({ bridgeUrl: 'http://down.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: failing });
    const env = makeEnv(sw);
    const { mission, sample } = await newBaselinedMission(env);
    await env.engine.submitChange(env.maya, mission.id, sample.change);
    const room = row(env, 'SELECT * FROM rooms WHERE mission_id=?', mission.id);
    expect(room).toMatchObject({ mode: 'local', status: 'degraded' }); expect(room.note).toMatch(/Switch room could not be created/);
    expect(rows(env, "SELECT * FROM audit_events WHERE type='switch_error'").length).toBeGreaterThan(0);
    expect(row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state).toBe('blocked');   // core workflow still functions
  });

  it('with several mission rooms, re-claims the target room before posting (post_message has no room id)', async () => {
    const mb = mockBridge();
    const sw = new SwitchCollab({ bridgeUrl: 'http://bridge.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: mb.fetchImpl, beatMs: 5000 });
    const roomA = { mode: 'switch' as const, externalId: 'room-A', name: 'A', note: '' }, roomB = { ...roomA, externalId: 'room-B', name: 'B' };
    await sw.send(roomA, { kind: 'status', senderKey: 's', senderName: 'S', body: 'to A' });
    await Promise.all([sw.send(roomB, { kind: 'status', senderKey: 's', senderName: 'S', body: 'to B' }), sw.send(roomA, { kind: 'status', senderKey: 's', senderName: 'S', body: 'to A again' })]);
    const seq = mb.calls.filter((c) => /connect_to_room|post_message/.test(c.path)).map((c) => (c.path.endsWith('connect_to_room') ? `claim:${c.body.room_id}` : `post:${c.body.body.split(': ')[1]}`));
    expect(seq).toEqual(['claim:room-A', 'post:to A', 'claim:room-B', 'post:to B', 'claim:room-A', 'post:to A again']);
    await sw.close();
  });

  it('reads config from env and returns null when unset', () => {
    expect(switchConfigFromEnv({})).toBeNull();
    expect(switchConfigFromEnv({ SWITCH_BRIDGE_URL: 'http://x', SWITCH_AGENT_ID: 'i', SWITCH_AGENT_API_KEY: 'k', SWITCH_ROLE_AGENTS: 'kitchen=ripple-kitchen, service=ripple-service' })?.roleAgents).toEqual({ kitchen: 'ripple-kitchen', service: 'ripple-service' });
  });
});
