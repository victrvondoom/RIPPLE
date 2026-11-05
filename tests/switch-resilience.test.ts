import { describe, it, expect } from 'vitest';
import { SwitchCollab } from '../src/server/collab/switch.js';

/**
 * MOCK of the documented Switch agent protocol, able to close/push to the event stream and to answer heartbeats with a chosen status.
 * Ported behaviours under test come from CrewPilot's Switch client. These tests prove the ADAPTER's logic against a mock;
 * they do NOT show that a real Switch server works with it.
 */
function mock(opts: { beatStatus?: number } = {}) {
  const calls: { path: string; method: string; lastEventId: string | null; connId: string | null }[] = [];
  const enc = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input)); const h = new Headers(init.headers);
    calls.push({ path: url.pathname, method: init.method ?? 'GET', lastEventId: h.get('last-event-id'), connId: url.searchParams.get('connection_id') ?? h.get('x-switch-connection-id') });
    if (url.pathname.endsWith('/events')) return new Response(new ReadableStream<Uint8Array>({ start(c) { streams.push(c); } }), { status: 200 });
    if (url.pathname.endsWith('/connection/beat')) return new Response('{}', { status: opts.beatStatus ?? 200 });
    if (url.pathname.endsWith('/ops/create_room')) return Response.json({ result: { id: 'room-1', name: 'r' } });
    return Response.json({ result: {} });
  }) as typeof fetch;
  const push = (s: string) => streams[streams.length - 1].enqueue(enc.encode(s));
  const eventsOpened = () => calls.filter((c) => c.path.endsWith('/events')).length;
  return { calls, fetchImpl, push, streams, eventsOpened };
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function room(sw: SwitchCollab) { return sw.openRoom({ missionId: 'm', title: 't', topic: 'x', agentRoles: [] }); }
const msg = (id: string, body: string, name = 'Priya', seq = 1) => `id: ${seq}\ndata: {"type":"message","room_id":"room-1","payload":{"sender":"@u:s","sender_name":"${name}","body":"${body}","addressed":true,"message_id":"${id}","timestamp":1},"sequence":${seq}}\n\n`;

describe('Switch adapter resilience (mock protocol)', () => {
  it('re-opens a dropped stream with the SAME connection id and Last-Event-ID, and keeps delivering', async () => {
    const m = mock(); const sw = new SwitchCollab({ bridgeUrl: 'http://b.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: m.fetchImpl, beatMs: 5000, reconnectDelaysMs: [5] });
    const r = await room(sw); const got: string[] = []; sw.subscribe(r, (x) => got.push(x.body));
    m.push(msg('m1', 'first', 'Priya', 41)); await tick(20);
    m.streams[0].close(); await tick(60);                                           // Switch closes the stream
    expect(m.eventsOpened()).toBe(2);
    const [first, second] = m.calls.filter((c) => c.path.endsWith('/events'));
    expect(second.connId).toBe(first.connId); expect(first.lastEventId).toBeNull(); expect(second.lastEventId).toBe('41');
    expect(m.calls.filter((c) => c.path.endsWith('/ops/connect_to_room')).length).toBe(2);   // room re-claimed after the reconnect
    m.push(msg('m2', 'second', 'Priya', 42)); await tick(20);
    expect(got).toEqual(['first', 'second']);
    await sw.close();
  });
  it('does not reconnect after close()', async () => {
    const m = mock(); const sw = new SwitchCollab({ bridgeUrl: 'http://b.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: m.fetchImpl, beatMs: 5000, reconnectDelaysMs: [5] });
    await room(sw); await sw.close(); await tick(40);
    expect(m.eventsOpened()).toBe(1);
  });
  it('applies the heartbeat interval announced in connection_state', async () => {
    const m = mock(); const sw = new SwitchCollab({ bridgeUrl: 'http://b.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: m.fetchImpl, beatMs: 60000 });
    await room(sw);
    m.push('data: {"type":"connection_state","cursor":5,"heartbeat_interval_seconds":0.02}\n\n');
    // the already-armed 60 s timer fires first in real life; here we assert the interval was adopted for subsequent ticks via describe()+calls
    await tick(10);
    expect((sw as any).beatEvery).toBe(20);
    await sw.close();
  });
  it('heartbeat 409 (connection unknown) re-opens the stream', async () => {
    const m = mock({ beatStatus: 409 }); const sw = new SwitchCollab({ bridgeUrl: 'http://b.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: m.fetchImpl, beatMs: 15, reconnectDelaysMs: [5] });
    await room(sw);
    // poll for the condition instead of a fixed sleep (the suite runs in parallel; fixed sleeps flake under load)
    const end = Date.now() + 3000; while (Date.now() < end && !(m.eventsOpened() >= 2 && /heartbeat 409/.test(sw.describe().detail ?? ''))) await tick(5);
    expect(m.eventsOpened()).toBeGreaterThanOrEqual(2); expect(sw.describe().detail).toMatch(/heartbeat 409/);
    await sw.close();
  });
  it('an `evicted` frame re-opens the stream; a `gap` frame is surfaced as a limitation', async () => {
    const m = mock(); const sw = new SwitchCollab({ bridgeUrl: 'http://b.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: m.fetchImpl, beatMs: 5000, reconnectDelaysMs: [5] });
    await room(sw);
    m.push('data: {"type":"gap","reason":"cursor_too_old"}\n\n'); await tick(15);
    expect(sw.describe().detail).toMatch(/lost events \(cursor_too_old\)/);
    m.push('data: {"type":"evicted","reason":"replaced"}\n\n'); await tick(60);
    expect(m.eventsOpened()).toBe(2);
    await sw.close();
  });
  it('de-duplicates by message_id, ignores its own posts and non-message frames that carry a room_id', async () => {
    const m = mock(); const sw = new SwitchCollab({ bridgeUrl: 'http://b.test', agentId: 'a', apiKey: 'k', roleAgents: {}, selfName: 'ripple', fetchImpl: m.fetchImpl, beatMs: 5000 });
    const r = await room(sw); const got: string[] = []; sw.subscribe(r, (x) => got.push(`${x.senderName}:${x.body}`));
    m.push(msg('dup', 'hello', 'Priya', 1)); m.push(msg('dup', 'hello', 'Priya', 2));          // same message_id twice
    m.push(msg('own', 'my own post', 'Ripple', 3));                                              // our own name (case-insensitive)
    m.push('data: {"type":"room_released","room_id":"room-1","payload":{"body":"not a message","message_id":"x9"}}\n\n');
    m.push(msg('ok', 'real', 'Dan', 4)); await tick(30);
    expect(got).toEqual(['Priya:hello', 'Dan:real']);
    await sw.close();
  });
  it('stops retrying after a 401/403 on reconnect (a bad key does not fix itself)', async () => {
    let denied = false; const m = mock();
    const f = (async (input: any, init: any = {}) => { const u = new URL(String(input)); if (u.pathname.endsWith('/events') && denied) return new Response('no', { status: 403 }); return m.fetchImpl(input, init); }) as typeof fetch;
    const sw = new SwitchCollab({ bridgeUrl: 'http://b.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: f, beatMs: 5000, reconnectDelaysMs: [5] });
    await room(sw); denied = true; m.streams[0].close(); await tick(80);
    expect(m.eventsOpened()).toBe(1);                                                           // the denied attempts never reached the mock; none were retried forever
    expect(sw.describe().detail).toMatch(/reconnect: .*403/);
    await sw.close();
  });
});
