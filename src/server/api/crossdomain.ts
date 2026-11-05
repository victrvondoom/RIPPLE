import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Actor, Engine } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { CrossDomainEngine, CAMPAIGN_STATES } from '../reality/crossdomain/engine.js';
import { CrossDomainBench, cdBenchDefinitions } from '../reality/crossdomain/bench.js';
import { CD_PACKS } from '../reality/crossdomain/packs.js';
import { CD_SCENARIOS } from '../reality/crossdomain/scenarios.js';
import { INVARIANT_TYPE_LABELS, PATTERN_LABELS } from '../reality/crossdomain/types.js';
import { LAB_LABEL } from '../reality/lab.js';
import { BASELINES } from '../reality/types.js';

type Env = { Variables: { actor: Actor } };

/** Cross-Domain Invariant Intelligence routes. Every query is scoped to the caller's workspace (the engine filters by workspace_id). */
export function registerCrossDomainRoutes(app: Hono<Env>, engine: Engine) {
  const cd = new CrossDomainEngine(engine);
  const bench = new CrossDomainBench(cd);
  const A = (c: Context<Env>) => c.get('actor');
  const body = async <T extends z.ZodTypeAny>(c: Context<Env>, s: T): Promise<z.infer<T>> => s.parse(await c.req.json().catch(() => ({})));
  const id = (c: Context<Env>) => c.req.param('id') as string;
  const short = z.string().min(1).max(120);

  app.get('/api/crossdomain/meta', (c) => c.json({
    packs: CD_PACKS.map((p) => ({ id: p.id, label: p.label, domain: p.domain, description: p.description, systems: p.systems, resourceTypes: p.resourceTypes, evaluators: Object.keys(p.evaluators ?? {}), proposesAlternatives: !!p.alternatives, proposesRecoveries: !!p.recoveries })),
    scenarios: CD_SCENARIOS.map((s) => ({ id: s.id, title: s.title, story: s.story, packs: s.packs, workflows: s.workflows.map((w) => ({ key: w.key, pack: w.pack, title: w.title })), events: (s.events ?? []).map((e) => e.label), faults: (s.faults ?? []).map((f) => f.label) })),
    invariantTypes: INVARIANT_TYPE_LABELS, patterns: PATTERN_LABELS, campaignStates: CAMPAIGN_STATES, baselines: Object.entries(BASELINES).map(([k, b]) => ({ id: k, label: b.label })),
    sandbox: LAB_LABEL, collab: engine.collab.describe(),
  }));
  app.get('/api/crossdomain/campaigns', (c) => { const src = c.req.query('source'); return c.json({ campaigns: cd.list(A(c).workspaceId, src === 'benchmark' || src === 'all' ? src : 'live') }); });
  app.post('/api/crossdomain/campaigns', async (c) => {
    const b = await body(c, z.object({ scenario: short }));
    const camp = await cd.create(A(c), b.scenario, { source: 'live' });
    return c.json(cd.detail(A(c).workspaceId, camp.id), 201);
  });
  app.get('/api/crossdomain/campaigns/:id', (c) => c.json(cd.detail(A(c).workspaceId, id(c))));
  app.post('/api/crossdomain/campaigns/:id/analyze', async (c) => c.json(await cd.analyze(A(c), id(c))));
  app.post('/api/crossdomain/campaigns/:id/workflows/:wf/approve', (c) => c.json(cd.approveWorkflow(A(c), id(c), c.req.param('wf') as string)));
  app.post('/api/crossdomain/campaigns/:id/workflows/:wf/execute', async (c) => c.json(await cd.executeWorkflow(A(c), id(c), c.req.param('wf') as string)));
  app.post('/api/crossdomain/campaigns/:id/arbitrate', (c) => c.json(cd.arbitrate(A(c), id(c))));
  app.post('/api/crossdomain/campaigns/:id/choose', async (c) => { const b = await body(c, z.object({ optionId: short })); return c.json(cd.choose(A(c), id(c), b.optionId)); });
  app.post('/api/crossdomain/campaigns/:id/approve', (c) => c.json(cd.approveResolution(A(c), id(c))));
  app.post('/api/crossdomain/campaigns/:id/resolve', async (c) => { const r = await cd.resolve(A(c), id(c)); return c.json({ outcome: r.outcome, drift: r.drift, ...r.detail }); });
  app.post('/api/crossdomain/campaigns/:id/passport', (c) => c.json(cd.passportNow(A(c), id(c))));
  app.get('/api/crossdomain/campaigns/:id/passports/:pid', (c) => c.json(cd.passport(A(c).workspaceId, id(c), c.req.param('pid') as string)));
  app.get('/api/crossdomain/campaigns/:id/graph', (c) => c.json(cd.graph(A(c).workspaceId, id(c))));
  app.get('/api/crossdomain/campaigns/:id/impact', (c) => {
    const node = c.req.query('node'); if (!node || node.length > 300) throw new EngineError(422, 'node_required', 'Query parameter "node" is required.');
    return c.json(cd.impact(A(c).workspaceId, id(c), node));
  });
  app.get('/api/crossdomain/campaigns/:id/findings/:fid/evidence', (c) => c.json(cd.evidenceChain(A(c).workspaceId, id(c), c.req.param('fid') as string)));
  app.get('/api/crossdomain/findings', (c) => c.json({ findings: cd.inbox(A(c).workspaceId, { severity: c.req.query('severity') || undefined, domain: c.req.query('domain') || undefined, status: c.req.query('status') || undefined, pattern: c.req.query('pattern') || undefined, campaign: c.req.query('campaign') || undefined, source: c.req.query('source') || undefined }) }));

  // ---- RIGOR · cross-domain category ----
  app.get('/api/crossdomain/bench/definitions', (c) => c.json(cdBenchDefinitions()));
  app.get('/api/crossdomain/bench/runs', (c) => c.json({ runs: bench.list(A(c).workspaceId) }));
  app.post('/api/crossdomain/bench/runs', async (c) => {
    const a = A(c);
    const b = await body(c, z.object({ seed: z.string().max(80).optional(), seeds: z.number().int().min(1).max(4).optional(), baselines: z.array(z.string().max(60)).max(10).optional(), scenarios: z.array(z.string().max(80)).max(20).optional(), wait: z.boolean().optional() }));
    if (engine.db.get("SELECT 1 x FROM bench_runs WHERE workspace_id=? AND status='running'", a.workspaceId)) throw new EngineError(409, 'busy', 'A RIGOR, Arena or cross-domain run is already in progress in this workspace.');
    const s = bench.start(a, b);
    if (b.wait) { await bench.execute(a, s.id, s.cases); return c.json(bench.report(a.workspaceId, s.id), 201); }
    void bench.execute(a, s.id, s.cases).catch((e) => console.error('Cross-domain benchmark run failed', e));
    return c.json({ id: s.id, seed: s.seed, seeds: s.seeds, total: s.cases.length, status: 'running' }, 202);
  });
  app.get('/api/crossdomain/bench/runs/:id', (c) => c.json(bench.report(A(c).workspaceId, id(c))));
  app.get('/api/crossdomain/bench/runs/:id/export.json', (c) => { c.header('Content-Disposition', `attachment; filename="rigor-crossdomain-${id(c)}.json"`); return c.json(bench.report(A(c).workspaceId, id(c))); });
  app.get('/api/crossdomain/bench/runs/:id/export.csv', (c) => c.body(bench.csv(A(c).workspaceId, id(c)), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="rigor-crossdomain-${id(c)}.csv"` }));
  return { cd, bench };
}
