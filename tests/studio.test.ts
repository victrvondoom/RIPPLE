import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/server/db/db.js';
import { Engine } from '../src/server/engine/engine.js';
import { defaultRegistry } from '../src/server/packs/registry.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { DeterministicProvider } from '../src/server/agents/provider.js';
import { createApp } from '../src/server/api/app.js';
import { seedWorkspace } from '../src/server/seed.js';

describe('Workflow Studio API & Multi-Agent Collaboration', () => {
  let db: Db;
  let engine: Engine;
  let app: any;
  let cookie: string;

  beforeEach(async () => {
    db = new Db(':memory:');
    engine = new Engine({
      db,
      packs: defaultRegistry(),
      collab: new LocalCollab(),
      connectors: {
        'doc-store': { key: 'doc-store', name: 'DocStore', description: 'desc', mode: 'dry-run', execute: async () => ({ ok: true }) } as any,
        'email-outbox': { key: 'email-outbox', name: 'Email', description: 'desc', mode: 'dry-run', execute: async () => ({ ok: true }) } as any,
        'chat-outbox': { key: 'chat-outbox', name: 'Chat', description: 'desc', mode: 'dry-run', execute: async () => ({ ok: true }) } as any
      },
      provider: new DeterministicProvider()
    });
    seedWorkspace(db, defaultRegistry(), { name: 'Harbor & Vine Catering', password: 'test-password' });
    app = createApp(engine);

    // Login as manager
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'maya@harborvine.example', password: 'test-password' })
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    cookie = setCookie!.split(';')[0];
  });

  it('lists dynamic multi-agent workflows including GPU billing, Invoice Passport, and Healthcare', async () => {
    const res = await app.request('/api/studio/workflows', {
      headers: { cookie }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workflows).toBeDefined();
    expect(data.workflows.length).toBeGreaterThanOrEqual(5);

    const gpu = data.workflows.find((w: any) => w.id === 'gpu-billing');
    expect(gpu).toBeDefined();
    expect(gpu.agents.some((a: any) => a.key === 'gpu_auditor')).toBe(true);
    expect(gpu.agents.some((a: any) => a.key === 'cost_allocator')).toBe(true);
    expect(gpu.agents.some((a: any) => a.key === 'you')).toBe(true);
    expect(gpu.approvalRequest).toBeDefined();
    expect(gpu.approvalRequest.amount).toBe('$1,200.00');

    const health = data.workflows.find((w: any) => w.id === 'healthcare-clinical');
    expect(health).toBeDefined();
    expect(health.badge).toBe('Cold-Chain Integrity Audit');

    const telecom = data.workflows.find((w: any) => w.id === 'telecom-cdr');
    expect(telecom).toBeDefined();
    expect(telecom.badge).toBe('GSMA TAP3 Mediation');
  });

  it('records human demo-scenario decisions via the Studio approve endpoint (and never claims dispatch)', async () => {
    const res = await app.request('/api/studio/workflows/gpu-billing/approve', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'dispute', note: 'Recorded $1,200 dispute decision' })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.action).toBe('dispute');
    // The response must state honestly that nothing was dispatched
    expect(data.message).toMatch(/recorded/i);
    expect(data.message).toMatch(/nothing was sent|no payment was made|no dispute was sent/i);

    // Verify audit event was persisted in database
    const audits = db.all("SELECT * FROM audit_events WHERE type='studio_approval_resolved'");
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0].summary).toContain('dispute decided');
    expect(audits[0].summary).toContain('nothing dispatched');

    // The recorded decision is served back with the workflow
    const wfRes = await app.request('/api/studio/workflows', { headers: { cookie } });
    const wfData = await wfRes.json();
    const gpu = wfData.workflows.find((w: any) => w.id === 'gpu-billing');
    expect(gpu.approvalRequest.resolved).toBe('dispute');

    // Invalid action is rejected
    const bad = await app.request('/api/studio/workflows/gpu-billing/approve', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'wire_money' })
    });
    expect(bad.status).toBe(422);
  });

  it('updates agent guidance instructions dynamically and audits change', async () => {
    const res = await app.request('/api/studio/workflows/gpu-billing/guidance', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        agentKey: 'gpu_auditor',
        guidance: 'Always reference Kubernetes cluster node ID and pod UID in findings.'
      })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.agentKey).toBe('gpu_auditor');

    const audits = db.all("SELECT * FROM audit_events WHERE type='studio_guidance_updated'");
    expect(audits.length).toBeGreaterThan(0);
  });

  it('returns real measured telemetry from the running engine (no fabricated numbers)', async () => {
    const res = await app.request('/api/studio/telemetry', {
      headers: { cookie }
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    // Real uptime and ledger size, measured at request time
    expect(data.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(data.dbBytes).toBeGreaterThan(0);
    expect(data.metricsQueryMs).toBeGreaterThanOrEqual(0);

    // Workspace-scoped counts read from the real ledger
    expect(data.counts).toBeDefined();
    expect(typeof data.counts.missions).toBe('number');
    expect(typeof data.counts.auditEvents).toBe('number');
    expect(data.counts.auditEvents).toBeGreaterThan(0); // the login audit already happened

    // Honest provider labelling
    expect(data.provider.kind).toBe('deterministic');
    expect(data.packs).toBeGreaterThan(0);
  });

  it('returns live infrastructure facts measured from the running server', async () => {
    const res = await app.request('/api/studio/infrastructure', {
      headers: { cookie }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.nodes.length).toBeGreaterThanOrEqual(5);
    expect(typeof data.uptimeSeconds).toBe('number');
    expect(data.dbBytes).toBeGreaterThan(0);

    const apiNode = data.nodes.find((n: any) => n.id === 'hono-api');
    expect(apiNode).toBeDefined();
    expect(apiNode.status).toBe('online');
    // Served-in time is a real measurement, not a fabricated health score
    expect(apiNode.workload).toMatch(/Served this response in [\d.]+ ms/);
    expect(apiNode.health).toBeUndefined();
    expect(apiNode.latency).toBeUndefined();

    const dbNode = data.nodes.find((n: any) => n.id === 'sqlite-ledger');
    expect(dbNode).toBeDefined();
    expect(dbNode.workload).toContain('WAL mode');
    expect(dbNode.workload).toMatch(/\d+ (KB|MB)/);

    const connectorNode = data.nodes.find((n: any) => n.id === 'external-connectors');
    expect(connectorNode).toBeDefined();
    expect(connectorNode.workload).toContain('dry-run');
  });
});

