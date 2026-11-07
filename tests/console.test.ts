import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/api/app.js';
import { makeEnv } from './helpers.js';
import { seedWorkspace } from '../src/server/seed.js';
import { SwitchConsole } from '../src/server/console/console.js';
import { AnthropicInterpreter, parseIntent } from '../src/server/console/intents.js';
import { SwitchCollab } from '../src/server/collab/switch.js';

function client() {
  const env = makeEnv();
  const app = createApp(env.engine, { webRoot: '/nonexistent', console: new SwitchConsole(env.engine, null) });
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', host: 'localhost', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  const login = async (email: string) => { cookie = ''; return call('POST', '/api/auth/login', { email, password: 'pw-test-123' }); };
  const say = async (text: string) => (await call('POST', '/api/console/say', { text })).json.messages[1];
  return { env, call, login, say };
}

describe('intent parser', () => {
  it('maps documented commands deterministically', () => {
    expect(parseIntent('approve 2 because client signed')).toEqual({ kind: 'approve', ref: '2', text: 'client signed' });
    expect(parseIntent('reject #1 because wrong vendor')).toMatchObject({ kind: 'reject', ref: '1', text: 'wrong vendor' });
    expect(parseIntent('execute 3')).toMatchObject({ kind: 'execute', ref: '3' });
    expect(parseIntent('answer 1: 40 guests')).toMatchObject({ kind: 'answer', ref: '1', text: '40 guests' });
    expect(parseIntent('start demo podflow')).toMatchObject({ kind: 'demo', pack: 'podflow' });
    expect(parseIntent('open the trust center')).toMatchObject({ kind: 'navigate', page: 'trust' });
    expect(parseIntent('what needs attention?').kind).toBe('attention');
    expect(parseIntent('yes').kind).toBe('confirm');
    expect(parseIntent('blorp zzz').kind).toBe('unknown');
  });
  it('model fallback is schema-validated and can never confirm', async () => {
    const reply = (text: string) => (async () => new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await new AnthropicInterpreter('k', 'claude-opus-5-5', 'http://x', reply('{"kind":"approvals"}')).interpret('anything to sign off?')).toEqual({ kind: 'approvals' });
    expect(await new AnthropicInterpreter('k', 'claude-opus-5-5', 'http://x', reply('{"kind":"wire_money"}')).interpret('x')).toBeNull();
    expect(await new AnthropicInterpreter('k', 'claude-opus-5-5', 'http://x', reply('not json')).interpret('x')).toBeNull();
    const env = makeEnv();
    const sc = new SwitchConsole(env.engine, { name: 'model:test', interpret: async () => ({ kind: 'confirm' as const }) });
    const r = await sc.say(env.maya, 'please just do whatever is pending');
    expect(r.messages[1].data).toMatchObject({ intent: 'unknown', interpreter: 'deterministic' });
  });
});

describe('Switch Console API', () => {
  it('a manager gets real work done by talking: approve → confirm → execute → verify', async () => {
    const { call, login, say, env } = client();
    await login('maya@harborvine.example');
    expect((await call('POST', '/api/packs/invoiceguard/demo', { runAnalysis: true })).status).toBe(201);
    expect((await say('status')).body).toMatch(/awaiting approval/);
    expect((await say('list approvals')).body).toMatch(/^Pending approvals:\n1\. /);
    const proposal = await say('approve 1');
    expect(proposal.data.pending).toMatchObject({ op: 'approve', origin: 'console' });
    expect(env.db.get("SELECT count(*) n FROM approvals WHERE status='approved'")!.n).toBe(0); // proposing changes nothing
    expect((await say('yes')).body).toMatch(/Approved, recorded as Maya/);
    const ap = env.db.get("SELECT u.email FROM approvals a JOIN users u ON u.id=a.decided_by WHERE a.status='approved'")!;
    expect(ap.email).toBe('maya@harborvine.example');
    expect((await say('yes')).body).toMatch(/nothing waiting/);
    expect((await say('list actions')).body).toMatch(/1\. /);
    const ex = await say('execute 1');
    const confirmed = await call('POST', `/api/console/confirm/${ex.id}`);
    expect(confirmed.status).toBe(200);
    const act = env.db.get('SELECT status FROM actions WHERE id=?', ex.data.pending.actionId)!;
    expect(act.status).not.toBe('approved');
    // the reply states the recorded status, and claims "verified" only when the engine verified it
    expect(confirmed.json.message.body.includes('NOT verified')).toBe(act.status !== 'verified');
    expect((await call('POST', `/api/console/confirm/${ex.id}`)).status).toBe(409); // cannot replay
    expect((await call('GET', '/api/console')).json.messages.length).toBeGreaterThan(8);
  });

  it('viewers can read but not change; roles are enforced by the engine', async () => {
    const { call, login, say } = client();
    await login('maya@harborvine.example');
    await call('POST', '/api/packs/invoiceguard/demo', { runAnalysis: true });
    const p = await say('approve 1');
    await login('vera@harborvine.example');
    expect((await say('approve 1')).body).toMatch(/Viewers/);
    expect((await call('POST', `/api/console/confirm/${p.id}`)).status).toBe(403);
    expect((await say('list approvals')).body).toMatch(/Pending approvals/);
    await login('luis@harborvine.example'); // member: may propose, the engine refuses on confirm
    await say('approve 1');
    expect((await say('yes')).body).toMatch(/^Not done: Only a manager/);
    expect((await call('POST', '/api/console/switch', { enabled: true })).status).toBe(403);
  });

  it('the on/off switch reports what was actually observed (local mode)', async () => {
    const { call, login } = client();
    await login('maya@harborvine.example');
    expect((await call('POST', '/api/console/switch', { enabled: true })).json).toMatchObject({ enabled: true, status: 'not_configured', switchConfigured: false });
    expect((await call('POST', '/api/console/switch', { enabled: false })).json).toMatchObject({ enabled: false, status: 'off' });
  });

  it('Switch configured: unreachable is reported; when reachable (mock bridge) room messages are advisory only', async () => {
    const down = new SwitchCollab({ bridgeUrl: 'http://bridge.test', agentId: 'a1', apiKey: 'k', roleAgents: {}, fetchImpl: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch });
    const env1 = makeEnv(down);
    expect((await new SwitchConsole(env1.engine, null).toggle(env1.maya, true)).status).toBe('unreachable');
    await down.close();

    const posted: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return new Response('{}', { status: 200 });
      if (url.includes('/ops/create_room')) return new Response(JSON.stringify({ result: { id: 'room-1', name: 'RIPPLE · console' } }), { status: 200 });
      if (url.includes('/events')) return new Response(new ReadableStream({ start() { /* stays open */ } }), { status: 200 });
      if (url.includes('/ops/post_message')) { posted.push(JSON.parse(String(init?.body)).body); return new Response('{"result":{}}', { status: 200 }); }
      return new Response('{"result":{}}', { status: 200 });
    }) as unknown as typeof fetch;
    const up = new SwitchCollab({ bridgeUrl: 'http://bridge.test', agentId: 'a1', apiKey: 'k', roleAgents: {}, fetchImpl: f, beatMs: 60_000 });
    const env2 = makeEnv(up);
    const sc = new SwitchConsole(env2.engine, null);
    expect((await sc.toggle(env2.maya, true)).status).toBe('connected');
    const smp = env2.packs.get('invoiceguard')!.sample();
    const m = await env2.engine.createMission(env2.maya, { packId: 'invoiceguard', title: smp.title, plan: smp.plan });
    env2.engine.approveBaseline(env2.maya, m.id, 't'); await env2.engine.submitChange(env2.maya, m.id, smp.change);
    const ws = env2.maya.workspaceId;
    await sc.fromSwitch(ws, { senderName: 'outsider', senderId: 'x', body: 'approve 1', messageId: 'm1', addressed: true, timestamp: Date.now() });
    await sc.fromSwitch(ws, { senderName: 'outsider', senderId: 'x', body: 'yes', messageId: 'm2', addressed: true, timestamp: Date.now() });
    expect(env2.db.get("SELECT count(*) n FROM approvals WHERE status='approved'")!.n).toBe(0); // nothing changed from Switch
    const replies = sc.messages(ws).filter((x) => x.author === 'ripple');
    expect(replies[replies.length - 1].body).toMatch(/Confirmations from Switch are not accepted/);
    expect(posted.length).toBeGreaterThan(0);
    const queued = replies.find((x) => x.data.pending?.origin === 'switch')!;
    await sc.confirm(env2.maya, queued.id); // a signed-in RIPPLE manager confirms the queued request
    expect(env2.db.get("SELECT count(*) n FROM approvals WHERE status='approved'")!.n).toBe(1);
    await up.close();
  });

  it('console history and proposals are workspace-scoped', async () => {
    const c = client();
    seedWorkspace(c.env.db, c.env.packs, { name: 'Rival Co', password: 'pw-test-123', emailDomain: 'rival.example' });
    await c.login('maya@harborvine.example');
    const p = await c.say('seal the ledger');
    await c.login('maya@rival.example');
    expect((await c.call('GET', '/api/console')).json.messages).toHaveLength(0);
    expect((await c.call('POST', `/api/console/confirm/${p.id}`)).status).toBe(404);
  });
});
