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

describe('Cross-Domain Invariant Intelligence HTTP API', () => {
  it('drives scenario 1 through the API: gate refusal, hard-constraint refusal, hash-bound approval, verified resolution, passport', async () => {
    const { call, login } = client();
    await login('maya@harborvine.example');
    const meta = await call('GET', '/api/crossdomain/meta');
    expect(meta.json.packs.length).toBeGreaterThanOrEqual(4); expect(meta.json.sandbox).toMatch(/sandbox/i);
    const created = await call('POST', '/api/crossdomain/campaigns', { scenario: 'cd-booking-payment-inventory' });
    expect(created.status).toBe(201); const id = created.json.campaign.id;
    const blocked = await call('POST', `/api/crossdomain/campaigns/${id}/workflows/wedding/execute`);
    expect(blocked.status).toBe(409); expect(blocked.json.error.code).toBe('intersection_blocked');
    const inbox = await call('GET', '/api/crossdomain/findings?severity=critical');
    expect(inbox.json.findings.length).toBeGreaterThan(0); expect(inbox.json.findings.every((f: any) => f.severity === 'critical')).toBe(true);
    const byDomain = await call('GET', '/api/crossdomain/findings?domain=Payments');
    expect(byDomain.json.findings.every((f: any) => f.domains.includes('Payments'))).toBe(true);
    const arb = await call('POST', `/api/crossdomain/campaigns/${id}/arbitrate`);
    const plan = arb.json.plans[arb.json.plans.length - 1];
    expect((await call('POST', `/api/crossdomain/campaigns/${id}/choose`, { optionId: 'proceed' })).status).toBe(422);
    expect((await call('POST', `/api/crossdomain/campaigns/${id}/choose`, { optionId: plan.recommended })).status).toBe(200);
    expect((await call('POST', `/api/crossdomain/campaigns/${id}/resolve`)).status).toBe(409); // not approved yet
    expect((await call('POST', `/api/crossdomain/campaigns/${id}/approve`)).status).toBe(200);
    const res = await call('POST', `/api/crossdomain/campaigns/${id}/resolve`);
    expect(res.json.outcome).toBe('verified'); expect(res.json.campaign.state).toBe('RESOLVED');
    const pid = res.json.passports[res.json.passports.length - 1].id;
    const pp = await call('GET', `/api/crossdomain/campaigns/${id}/passports/${pid}`);
    expect(pp.json.body.verdict).toBe('CONSISTENT');
    expect((await call('GET', `/api/reality/passports/${pid}/verify`)).json.intact).toBe(true);
    const g = await call('GET', `/api/crossdomain/campaigns/${id}/graph`);
    expect(g.json.edges.every((e: any) => e.causal_id && e.provenance.source)).toBe(true);
    const imp = await call('GET', `/api/crossdomain/campaigns/${id}/impact?node=${encodeURIComponent('res:inventory/suite-301')}`);
    expect(imp.json.workflows).toEqual(expect.arrayContaining(['retreat', 'wedding']));
    const f = res.json.findings.find((x: any) => x.pattern === 'resource_collision');
    const chain = await call('GET', `/api/crossdomain/campaigns/${id}/findings/${f.id}/evidence`);
    expect(chain.json.chain[0].system).toBe('inventory');
  });

  it('enforces roles: viewers cannot start, members cannot arbitrate or approve', async () => {
    const { call, login } = client();
    await login('vera@harborvine.example');
    expect((await call('POST', '/api/crossdomain/campaigns', { scenario: 'cd-control-independent' })).status).toBe(403);
    await login('maya@harborvine.example');
    const id = (await call('POST', '/api/crossdomain/campaigns', { scenario: 'cd-booking-payment-inventory' })).json.campaign.id;
    await call('POST', `/api/crossdomain/campaigns/${id}/analyze`);
    await login('luis@harborvine.example');
    expect((await call('POST', `/api/crossdomain/campaigns/${id}/arbitrate`)).status).toBe(403);
    expect((await call('POST', `/api/crossdomain/campaigns/${id}/analyze`)).status).toBe(403);
    expect((await call('POST', '/api/crossdomain/bench/runs', { wait: true })).status).toBe(403);
    expect((await call('POST', '/api/crossdomain/campaigns', { scenario: 'nope' })).status).toBe(403);
    await login('maya@harborvine.example');
    expect((await call('POST', '/api/crossdomain/campaigns', { scenario: 'nope' })).status).toBe(404);
    expect((await call('POST', '/api/crossdomain/campaigns', {})).status).toBe(422);
  });

  it('isolates tenants: a second workspace sees none of the campaign, graph, evidence, findings or passports', async () => {
    const { call, login } = client();
    await login('maya@harborvine.example');
    const created = await call('POST', '/api/crossdomain/campaigns', { scenario: 'cd-control-independent' });
    const id = created.json.campaign.id;
    const pp = await call('POST', `/api/crossdomain/campaigns/${id}/passport`);
    const pid = pp.json.passportId;
    await login('maya@rival.example');
    for (const p of [`/api/crossdomain/campaigns/${id}`, `/api/crossdomain/campaigns/${id}/graph`, `/api/crossdomain/campaigns/${id}/impact?node=res:inventory/suite-410`, `/api/crossdomain/campaigns/${id}/passports/${pid}`, `/api/reality/passports/${pid}/verify`]) expect((await call('GET', p)).status).toBe(404);
    for (const p of ['analyze', 'arbitrate', 'approve', 'resolve', 'passport', 'workflows/gala/execute']) expect((await call('POST', `/api/crossdomain/campaigns/${id}/${p}`)).status).toBe(404);
    expect((await call('GET', '/api/crossdomain/campaigns')).json.campaigns).toHaveLength(0);
    expect((await call('GET', '/api/crossdomain/findings')).json.findings).toHaveLength(0);
  });

  it('runs the cross-domain benchmark through the API and exports numerator/denominator CSV', async () => {
    const { call, login } = client();
    await login('maya@harborvine.example');
    const run = await call('POST', '/api/crossdomain/bench/runs', { seed: 'api-seed', seeds: 2, baselines: ['B2-handoffs-no-reconciliation', 'B4-resolve-full'], scenarios: ['cd-deploy-lineage-analytics'], wait: true });
    expect(run.status).toBe(201);
    expect(run.json.cases).toHaveLength(4);
    expect(run.json.metrics['B4-resolve-full'].dependencyInvalidationRecall).toMatchObject({ num: 2, den: 2 });
    expect(run.json.metrics['B2-handoffs-no-reconciliation'].dependencyInvalidationRecall).toMatchObject({ num: 0, den: 2 });
    const csv = await call('GET', `/api/crossdomain/bench/runs/${run.json.run.id}/export.csv`);
    expect(csv.res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(csv.text.split('\n')[0]).toContain('conflictDetection_num,conflictDetection_den');
    // existing RIGOR listings are unaffected by the new run kind
    expect((await call('GET', '/api/rigor/runs')).status).toBe(200);
  });
});
