import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/api/app.js';
import { makeEnv } from './helpers.js';
import { seedWorkspace } from '../src/server/seed.js';

function client() {
  const env = makeEnv();
  seedWorkspace(env.db, env.packs, { name: 'Rival Co', password: 'pw-test-123', emailDomain: 'rival.example' });
  const app = createApp(env.engine, { webRoot: '/nonexistent' });
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', host: 'localhost', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, json, text, res };
  };
  const login = async (email: string) => { cookie = ''; return call('POST', '/api/auth/login', { email, password: 'pw-test-123' }); };
  return { env, call, login };
}

describe('Reality Gap Engine HTTP API', () => {
  it('drives the split-brain showcase end to end through the API', async () => {
    const { call, login } = client();
    await login('maya@harborvine.example');
    const created = await call('POST', '/api/reality/workflows', { scenario: 'split-brain' });
    expect(created.status).toBe(201); const id = created.json.workflow.id;
    expect(created.json.workflow.state).toBe('AUTHORIZATION_PENDING');
    expect((await call('POST', `/api/reality/workflows/${id}/run`)).status).toBe(409); // not approved yet
    expect((await call('POST', `/api/reality/workflows/${id}/approve`, { subject: 'plan' })).status).toBe(200);
    const ran = await call('POST', `/api/reality/workflows/${id}/run`);
    expect(ran.json.workflow.state).toBe('RECONCILIATION_REQUIRED');
    expect(ran.json.gaps.some((g: any) => g.class === 'partial_commit')).toBe(true);
    expect((await call('POST', `/api/reality/workflows/${id}/recovery/choose`, { optionId: 'blind_retry' })).status).toBe(422);
    expect((await call('POST', `/api/reality/workflows/${id}/recovery/choose`, { optionId: 'resume' })).status).toBe(200);
    expect((await call('POST', `/api/reality/workflows/${id}/approve`, { subject: 'recovery' })).status).toBe(200);
    const rec = await call('POST', `/api/reality/workflows/${id}/recovery/execute`);
    expect(rec.json.workflow.state).toBe('RECOVERED');
    const pp = await call('GET', `/api/reality/workflows/${id}/passport.json`);
    expect(pp.res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(pp.json.passports.length).toBeGreaterThan(3);
    const v = await call('GET', `/api/reality/passports/${pp.json.passports[0].id}/verify`);
    expect(v.json.intact).toBe(true);
    const ov = await call('GET', '/api/reality/overview');
    expect(ov.json.workflows.verified).toBe(1);
    const tr = await call('GET', `/api/reality/workflows/${id}/traverse?node=intent:${id}&dir=down`);
    expect(tr.json.nodes.length).toBeGreaterThan(3);
  });

  it('enforces roles: viewers cannot start or approve; members cannot approve or run RIGOR', async () => {
    const { call, login } = client();
    await login('maya@harborvine.example');
    const id = (await call('POST', '/api/reality/workflows', { scenario: 'split-brain' })).json.workflow.id;
    await login('vera@harborvine.example');
    expect((await call('POST', '/api/reality/workflows', { scenario: 'split-brain' })).status).toBe(403);
    expect((await call('POST', `/api/reality/workflows/${id}/approve`, { subject: 'plan' })).status).toBe(403);
    await login('luis@harborvine.example');
    expect((await call('POST', `/api/reality/workflows/${id}/approve`, { subject: 'plan' })).status).toBe(403);
    expect((await call('POST', '/api/rigor/runs', { seed: 'x', scenarios: ['split-brain'] })).status).toBe(403);
  });

  it('isolates tenants: another workspace cannot see or touch workflows, gaps, passports or benchmark runs', async () => {
    const { call, login, env } = client();
    await login('maya@harborvine.example');
    const id = (await call('POST', '/api/reality/workflows', { scenario: 'split-brain' })).json.workflow.id;
    await call('POST', `/api/reality/workflows/${id}/approve`, { subject: 'plan' });
    await call('POST', `/api/reality/workflows/${id}/run`);
    const run = await call('POST', '/api/rigor/runs', { seed: 'iso', scenarios: ['split-brain'], wait: true });
    expect(run.status).toBe(201); const runId = run.json.run.id;
    const ppId = env.db.get('SELECT id FROM rw_passports WHERE workflow_id=?', id)!.id;

    await login('maya@rival.example');
    for (const p of [`/api/reality/workflows/${id}`, `/api/reality/workflows/${id}/graph`, `/api/reality/workflows/${id}/passport.json`, `/api/reality/passports/${ppId}/verify`, `/api/rigor/runs/${runId}`, `/api/rigor/runs/${runId}/export.csv`]) {
      expect((await call('GET', p)).status, p).toBe(404);
    }
    for (const [p, b] of [[`/api/reality/workflows/${id}/approve`, { subject: 'plan' }], [`/api/reality/workflows/${id}/run`, undefined], [`/api/reality/workflows/${id}/recovery/execute`, undefined], [`/api/reality/workflows/${id}/cancel`, { reason: 'x' }]] as const) {
      expect((await call('POST', p, b)).status, p).toBe(404);
    }
    expect((await call('GET', '/api/reality/gaps')).json.gaps).toHaveLength(0);
    expect((await call('GET', '/api/reality/workflows?source=all')).json.workflows).toHaveLength(0);
    expect((await call('GET', '/api/rigor/runs')).json.runs).toHaveLength(0);
    expect((await call('GET', '/api/reality/overview')).json.workflows.total).toBe(0);
    const own = await call('POST', '/api/reality/workflows', { scenario: 'rollback-ok' });
    expect(own.status).toBe(201);
    await login('maya@harborvine.example');
    expect((await call('GET', `/api/reality/workflows/${own.json.workflow.id}`)).status).toBe(404);
  });

  it('benchmark runs are exportable (JSON/CSV) and included in workspace export and deletion', async () => {
    const { call, login, env } = client();
    await login('sam@harborvine.example');
    const r = await call('POST', '/api/rigor/runs', { seed: 'api', scenarios: ['duplicate-webhook', 'split-brain'], wait: true });
    expect(r.json.run.status).toBe('completed'); expect(r.json.cases).toHaveLength(8);
    const csv = await call('GET', `/api/rigor/runs/${r.json.run.id}/export.csv`);
    expect(csv.res.headers.get('content-type')).toMatch(/text\/csv/); expect(csv.text.split('\n')).toHaveLength(9);
    const exp = await call('GET', `/api/rigor/runs/${r.json.run.id}/export.json`);
    expect(exp.json.definitions.metrics.length).toBeGreaterThan(10);
    const ws = await call('GET', '/api/workspace/export');
    expect(ws.json.bench_cases).toHaveLength(8); expect(ws.json.rw_workflows).toHaveLength(8);
    const wsId = env.db.get("SELECT workspace_id FROM users WHERE email='sam@harborvine.example'")!.workspace_id;
    const name = env.db.get('SELECT name FROM workspaces WHERE id=?', wsId)!.name;
    expect((await call('DELETE', '/api/workspace', { confirmName: name })).status).toBe(200);
    for (const t of ['rw_workflows', 'rw_operations', 'lab_effects', 'bench_cases', 'rw_passports', 'causal_events']) expect(env.db.get(`SELECT count(*) n FROM ${t} WHERE workspace_id=?`, wsId)!.n, t).toBe(0);
    expect(env.db.get("SELECT count(*) n FROM users WHERE email='maya@rival.example'")!.n).toBe(1);
  });
});
