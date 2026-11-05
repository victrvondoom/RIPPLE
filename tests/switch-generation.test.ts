import { describe, it, expect } from 'vitest';
import { SwitchCollab } from '../src/server/collab/switch.js';

/**
 * Switch 0.31.0 announces the stream `generation` on `connection_state` and fences heartbeats with it
 * (switch-core bridges/agent/api/schemas.py ConnectionBeatRequest.generation). This is a MOCK of that subset.
 */
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls until the condition holds (robust under load) instead of relying on fixed sleeps. */
async function waitFor(cond: () => boolean, ms = 3000) { const end = Date.now() + ms; while (!cond() && Date.now() < end) await tick(5); }
function mock() {
  const beats: any[] = [];
  const enc = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/events')) return new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c; } }), { status: 200 });
    if (url.pathname.endsWith('/connection/beat')) { beats.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }); }
    if (url.pathname.endsWith('/ops/create_room')) return Response.json({ result: { id: 'room-1', name: 'r' } });
    return Response.json({ result: {} });
  }) as typeof fetch;
  const announce = (payload: object) => stream!.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'connection_state', ...payload })}\n\n`));
  return { beats, fetchImpl, announce };
}

describe('Switch adapter heartbeat fencing (mock of Switch 0.31 protocol)', () => {
  it('echoes the stream generation Switch announced on connection_state on every later heartbeat', async () => {
    const m = mock();
    const sw = new SwitchCollab({ bridgeUrl: 'http://b.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: m.fetchImpl, beatMs: 15 });
    await sw.openRoom({ missionId: 'm', title: 't', topic: 'x', agentRoles: [] });
    await tick(5);
    const before = m.beats.length;
    m.announce({ connection_id: 'c1', generation: 7, cursor: 0, heartbeat_interval_seconds: 0.015 });
    await waitFor(() => m.beats.length > before + 2);
    const after = m.beats.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((b) => b.generation === 7)).toBe(true);
    expect(after[0].connection_id).toBeTruthy();
    await sw.close();
  });

  it('does not send a generation at all when the server never announced one (older servers keep working)', async () => {
    const m = mock();
    const sw = new SwitchCollab({ bridgeUrl: 'http://b.test', agentId: 'a', apiKey: 'k', roleAgents: {}, fetchImpl: m.fetchImpl, beatMs: 15 });
    await sw.openRoom({ missionId: 'm', title: 't', topic: 'x', agentRoles: [] });
    await waitFor(() => m.beats.length > 2);
    expect(m.beats.length).toBeGreaterThan(0);
    expect(m.beats.every((b) => !('generation' in b))).toBe(true);
    await sw.close();
  });
});
