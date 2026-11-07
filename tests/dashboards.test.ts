import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/api/app.js';
import { makeEnv } from './helpers.js';
import { seedWorkspace } from '../src/server/seed.js';
import { SwitchConsole } from '../src/server/console/console.js';
import { PROJECTS, SYSTEMS, PACK_SYSTEM } from '../src/server/capabilities/catalog.js';
import { extendedRegistry } from '../src/server/packs/registry.js';

function client() {
  const env = makeEnv();
  seedWorkspace(env.db, env.packs, { name: 'Rival Co', password: 'pw-test-123', emailDomain: 'rival.example' });
  const app = createApp(env.engine, { webRoot: '/nonexistent', console: new SwitchConsole(env.engine, null) });
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', host: 'localhost', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) as any, res };
  };
  const login = async (email: string) => { cookie = ''; return call('POST', '/api/auth/login', { email, password: 'pw-test-123' }); };
  return { env, call, login };
}

describe('capability catalog', () => {
  it('accounts for all 37 source projects (34 + RECLAIM, RESOLVE, REDEEM) across 7 systems, and every implemented pack has a system', () => {
    expect(PROJECTS).toHaveLength(37);
    expect(new Set(PROJECTS.map((p) => p.id)).size).toBe(37);
    expect(SYSTEMS).toHaveLength(7);
    for (const p of PROJECTS) expect(SYSTEMS.map((s) => s.id)).toContain(p.system);
    for (const p of extendedRegistry().all()) expect(PACK_SYSTEM[p.id], p.id).toBeDefined();
    expect(PROJECTS.filter((p) => p.integration === 'pending').map((p) => p.id)).toEqual(['rupiverse']);
  });
});

describe('dashboard read models', () => {
  it('Mission Control, Workbench and Knowledge reflect recorded state only', async () => {
    const { call, login } = client();
    await login('maya@harborvine.example');
    const empty = (await call('GET', '/api/dash/mission-control')).json;
    expect(empty.kpis).toMatchObject({ total: 0, verifiedRate: null, checksPassedRate: null });
    expect(empty.trend.every((d: any) => d.rate === null)).toBe(true);
    await call('POST', '/api/packs/invoiceguard/demo', { runAnalysis: true });
    await call('POST', '/api/packs/beo-rescue/demo', { runAnalysis: true });
    const mc = (await call('GET', '/api/dash/mission-control')).json;
    expect(mc.kpis).toMatchObject({ total: 2, awaitingApproval: 2, blocked: 1 });
    expect(mc.attention.some((a: any) => a.priority === 'info' && a.action === 'Approve')).toBe(true);
    expect(mc.coverage).toHaveLength(7);
    expect(mc.coverage.find((c: any) => c.id === 'commerce').missions).toBe(2);
    const wb = (await call('GET', '/api/dash/workbench')).json;
    expect(wb.cases).toHaveLength(2);
    const blocked = wb.cases.find((c: any) => c.state === 'blocked');
    expect(blocked.priority).toBe('medium');
    const detail = (await call('GET', `/api/dash/workbench/${blocked.id}`)).json;
    expect(detail.next.kind).toBe('question');
    expect(detail.timeline.length).toBeGreaterThan(0);
    const ap = (await call('GET', '/api/approvals')).json.pending[0];
    await call('POST', `/api/missions/${ap.mission_id}/approvals/${ap.id}/decide`, { decision: 'approved', note: 'Matches the PO' });
    const k = (await call('GET', '/api/dash/knowledge')).json;
    expect(k.history.find((h: any) => h.id === ap.id)).toMatchObject({ decision: 'approved', by: 'Maya Chen', validity: 'valid', rationale: 'Matches the PO' });
    expect(k.briefing.generator).toBe('deterministic');
    expect(k.graph.edges.some((e: any) => e.to === `d:${ap.id}`)).toBe(true);
    expect((await call('GET', '/api/capabilities')).json.totals).toMatchObject({ projects: 37, systems: 7, dashboards: 4 });
  });

  it('Trust: receipts are tied to the action, seals detect tampering, tenants are isolated', async () => {
    const { call, login, env } = client();
    await login('maya@harborvine.example');
    await call('POST', '/api/packs/invoiceguard/demo', { runAnalysis: true });
    const ap = (await call('GET', '/api/approvals')).json.pending[0];
    await call('POST', `/api/missions/${ap.mission_id}/approvals/${ap.id}/decide`, { decision: 'approved', note: 'ok' });
    await call('POST', `/api/missions/${ap.mission_id}/actions/${ap.subject_id}/execute`);
    const t = (await call('GET', '/api/dash/trust')).json;
    const r = t.receipts.find((x: any) => x.action_id === ap.subject_id);
    expect(r.approval).toMatchObject({ status: 'approved', decided_by: 'Maya Chen' });
    expect(r.receipt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.separation.violations).toBe(0);
    const dl = await call('GET', `/api/dash/trust/receipts/${r.evidence_id}`);
    expect(dl.res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(dl.json.receipt_hash).toBe(r.receipt_hash);

    expect((await call('POST', '/api/dash/trust/seal')).json.intact).toBe(true);
    expect((await call('POST', '/api/dash/trust/verify')).json.intact).toBe(true); // later events do not break earlier seals
    env.db.exec("UPDATE audit_events SET summary='rewritten history' WHERE rowid=(SELECT min(rowid) FROM audit_events WHERE workspace_id=?)", env.maya.workspaceId);
    expect((await call('POST', '/api/dash/trust/verify')).json.intact).toBe(false);

    await login('vera@harborvine.example');
    expect((await call('POST', '/api/dash/trust/seal')).status).toBe(403);
    await login('maya@rival.example');
    expect((await call('GET', '/api/dash/mission-control')).json.kpis.total).toBe(0);
    expect((await call('GET', '/api/dash/trust')).json.receipts).toHaveLength(0);
    expect((await call('GET', `/api/dash/trust/receipts/${r.evidence_id}`)).status).toBe(404);
    expect((await call('GET', `/api/dash/workbench/${ap.mission_id}`)).status).toBe(404);
  });
});
