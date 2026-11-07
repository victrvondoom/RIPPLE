import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/api/app.js';
import { makeEnv } from './helpers.js';
import { seedWorkspace } from '../src/server/seed.js';

function client() {
  const env = makeEnv();
  const app = createApp(env.engine, { webRoot: '/nonexistent' });
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', host: 'localhost', ...(cookie ? { cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, json: (await res.json().catch(() => null)) as any, res };
  };
  const login = async (email: string, password = 'pw-test-123') => { cookie = ''; return call('POST', '/api/auth/login', { email, password }); };
  return { env, call, login };
}

describe('HTTP API', () => {
  it('requires authentication and rejects bad credentials', async () => {
    const { call, login } = client();
    expect((await call('GET', '/api/overview')).status).toBe(401);
    expect((await login('maya@harborvine.example', 'wrong')).status).toBe(401);
    const ok = await login('maya@harborvine.example');
    expect(ok.status).toBe(200); expect(ok.json.user.role).toBe('manager');
    expect(ok.res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(JSON.stringify(ok.json)).not.toMatch(/scrypt|password/);
    expect((await call('GET', '/api/overview')).status).toBe(200);
  });
  it('the start-up session probe answers 200 when signed out (no console 401), and the signed-in payload when signed in', async () => {
    const { call, login } = client();
    const out = await call('GET', '/api/auth/session');
    expect(out.status).toBe(200); expect(out.json).toEqual({ user: null });
    await login('maya@harborvine.example');
    const inn = await call('GET', '/api/auth/session');
    expect(inn.status).toBe(200); expect(inn.json.user.email).toBe('maya@harborvine.example');
    expect((await call('GET', '/api/auth/me')).json).toEqual(inn.json);
  });
  it('sign-up creates the person\'s own workspace (owner of every role), signs them in, and refuses a taken email', async () => {
    const { env, call } = client();
    const r = await call('POST', '/api/auth/signup', { name: 'Ada Lovelace', email: 'ada@example.com', password: 'longenough1', workspace: 'Analytical Ops', demoData: false });
    expect(r.status).toBe(201); expect(r.json.user.role).toBe('owner');
    const me = await call('GET', '/api/auth/session');
    expect(me.json.user.email).toBe('ada@example.com'); expect(me.json.workspace.name).toBe('Analytical Ops');
    const ws = env.db.get('SELECT workspace_id w FROM users WHERE email=?', 'ada@example.com')!.w;
    expect(env.db.get("SELECT count(*) n FROM agent_roles WHERE workspace_id=? AND kind='human' AND user_id IS NULL", ws)!.n).toBe(0);
    expect((await call('GET', '/api/overview')).json.missions).toEqual([]); // nothing leaks from the demo workspace
    expect((await call('POST', '/api/auth/signup', { name: 'Again', email: 'ADA@example.com', password: 'longenough1' })).status).toBe(409);
    expect((await call('POST', '/api/auth/signup', { name: 'Short', email: 'short@example.com', password: 'short' })).status).toBe(422);
  });
  it('a signed-in person changes their password (current password required) and can sign in with the new one', async () => {
    const { call, login } = client();
    await login('dan@harborvine.example');
    expect((await call('POST', '/api/auth/password', { current: 'wrong', next: 'newpassword1' })).status).toBe(403);
    expect((await call('POST', '/api/auth/password', { current: 'pw-test-123', next: 'newpassword1' })).status).toBe(200);
    expect((await login('dan@harborvine.example', 'pw-test-123')).status).toBe(401);
    expect((await login('dan@harborvine.example', 'newpassword1')).status).toBe(200);
  });
  it('demo activity is manager/owner-only and fills the workspace through the engine', async () => {
    const { call, login } = client();
    await login('dan@harborvine.example');
    expect((await call('POST', '/api/demo/activity', {})).status).toBe(403);
    await login('maya@harborvine.example');
    const r = await call('POST', '/api/demo/activity', {});
    expect(r.status).toBe(200); expect(r.json.missions).toBeGreaterThan(0); expect(r.json.completed).toBeGreaterThan(0);
    expect((await call('GET', '/api/overview')).json.missions.length).toBe(r.json.missions);
  }, 60000);
  it('rejects cross-origin mutating requests (CSRF) and non-JSON bodies', async () => {
    const { call, login } = client(); await login('maya@harborvine.example');
    expect((await call('POST', '/api/missions', {}, { origin: 'https://evil.example' })).status).toBe(403);
    const res = await (createApp(client().env.engine).request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '5' }, body: 'hello' }));
    expect(res.status).toBe(415);
  });
  it('runs the BEO flow over HTTP with role-based authorization', async () => {
    const { call, login, env } = client();
    await login('maya@harborvine.example');
    const sample = (await call('GET', '/api/packs/beo-rescue')).json.sample;
    const created = await call('POST', '/api/missions', { packId: 'beo-rescue', title: sample.title, plan: sample.plan });
    expect(created.status).toBe(201);
    const id = created.json.mission.id;
    expect((await call('POST', `/api/missions/${id}/changes`, sample.change)).status).toBe(409);    // no baseline yet
    expect((await call('POST', `/api/missions/${id}/baseline`, { note: 'ok' })).json.mission.state).toBe('baseline_ready');
    const d = await call('POST', `/api/missions/${id}/changes`, sample.change);
    expect(d.json.mission).toMatchObject({ state: 'blocked' });
    expect(d.json.mission.state_reason).toMatch(/vegan/);
    expect((await call('POST', `/api/missions/${id}/changes`, { receivedOn: 'bad' })).status).toBe(422);
    // viewer cannot mutate; chef cannot approve
    await login('vera@harborvine.example');
    expect((await call('POST', `/api/missions/${id}/baseline`, {})).status).toBe(403);
    expect((await call('GET', `/api/missions/${id}`)).status).toBe(200);
    await login('luis@harborvine.example');
    const q = d.json.questions.find((x: any) => x.key === 'vegan_count');
    expect((await call('POST', `/api/missions/${id}/questions/${q.id}/answer`, { answer: '18' })).status).toBe(403);   // not the assignee
    await login('maya@harborvine.example');
    const a = await call('POST', `/api/missions/${id}/questions/${q.id}/answer`, { answer: '18' });
    expect(a.json.mission.state).toBe('awaiting_approval');
    expect(a.json.graph.nodes.length).toBeGreaterThan(20); expect(a.json.agents.every((x: any) => x.status === 'done' || x.status === 'waiting_on_human')).toBe(true);
    await login('luis@harborvine.example');
    const ap = a.json.approvals.find((x: any) => x.status === 'pending');
    expect((await call('POST', `/api/missions/${id}/approvals/${ap.id}/decide`, { decision: 'approved' })).status).toBe(403);
    // data export is owner only and has no password hashes
    expect((await call('GET', '/api/workspace/export')).status).toBe(403);
    await login('sam@harborvine.example');
    const ex = await call('GET', '/api/workspace/export');
    expect(ex.status).toBe(200); expect(JSON.stringify(ex.json)).not.toContain('scrypt$'); expect(ex.json.missions).toHaveLength(1);
    expect(env.db.get("SELECT 1 x FROM audit_events WHERE type='workspace_export'")).toBeTruthy();
  });
  it('cannot read another workspace’s missions over HTTP; owner can delete own workspace only with confirmation', async () => {
    const { call, login, env } = client();
    await login('maya@harborvine.example');
    const s = (await call('GET', '/api/packs/beo-rescue')).json.sample;
    const id = (await call('POST', '/api/missions', { packId: 'beo-rescue', title: 't', plan: s.plan })).json.mission.id;
    seedWorkspace(env.db, env.packs, { name: 'Rival Co', password: 'pw-test-123', emailDomain: 'rival.example' });
    await login('maya@rival.example');
    expect((await call('GET', `/api/missions/${id}`)).status).toBe(404);
    expect((await call('GET', '/api/missions')).json.missions).toHaveLength(0);
    expect((await call('DELETE', `/api/missions/${id}`)).status).toBe(404);
    await login('sam@rival.example');
    expect((await call('DELETE', '/api/workspace', { confirmName: 'wrong' })).status).toBe(422);
    expect((await call('DELETE', '/api/workspace', { confirmName: 'Rival Co' })).status).toBe(200);
    expect(env.db.get("SELECT 1 x FROM users WHERE email='maya@rival.example'")).toBeUndefined();
    expect(env.db.get('SELECT 1 x FROM missions WHERE id=?', id)).toBeTruthy();   // the other workspace is untouched
  });
  it('plan upload accepts only valid .json', async () => {
    const { call, login } = client(); await login('maya@harborvine.example');
    const s = (await call('GET', '/api/packs/beo-rescue')).json.sample;
    expect((await call('POST', '/api/uploads/plan', { packId: 'beo-rescue', filename: 'plan.exe', content: '{}' })).status).toBe(415);
    expect((await call('POST', '/api/uploads/plan', { packId: 'beo-rescue', filename: 'plan.json', content: '{bad' })).status).toBe(422);
    expect((await call('POST', '/api/uploads/plan', { packId: 'beo-rescue', filename: 'plan.json', content: '{}' })).status).toBe(422);
    expect((await call('POST', '/api/uploads/plan', { packId: 'beo-rescue', filename: 'plan.json', content: JSON.stringify(s.plan) })).status).toBe(200);
  });
});
