import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Actor, Engine } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { RealityEngine } from '../reality/rge.js';
import { definitions, Rigor } from '../reality/benchmark.js';
import { SCENARIOS } from '../reality/scenarios.js';
import { AGENTS, LAB_LABEL } from '../reality/lab.js';
import { R_STATES } from '../reality/states.js';
import { BASELINES, CONTROL_LABELS, GAP_LABELS } from '../reality/types.js';
import { Arena, ARENA_METRICS, ARENA_VERSION } from '../reality/arena.js';

type Env = { Variables: { actor: Actor } };

/** Reality Gap Engine + RIGOR routes. Every query is scoped to the caller's workspace. */
export function registerRealityRoutes(app: Hono<Env>, engine: Engine) {
  const rge = new RealityEngine(engine);
  const rigor = new Rigor(rge);
  const A = (c: Context<Env>) => c.get('actor');
  const body = async <T extends z.ZodTypeAny>(c: Context<Env>, s: T): Promise<z.infer<T>> => s.parse(await c.req.json().catch(() => ({})));
  const id = (c: Context<Env>) => c.req.param('id') as string;

  app.get('/api/reality/meta', (c) => c.json({
    scenarios: SCENARIOS.map((s) => ({ id: s.id, family: s.family, familyLabel: s.familyLabel, title: s.title, intent: s.intent, showcase: !!s.showcase, approval: s.approval, steps: s.steps.map((x) => ({ key: x.key, label: x.label, system: x.system, agent: x.agent })) })),
    baselines: Object.entries(BASELINES).map(([k, b]) => ({ id: k, label: b.label, description: b.description, controls: b.controls })),
    agents: AGENTS, states: R_STATES, gapClasses: GAP_LABELS, sandbox: LAB_LABEL, collab: engine.collab.describe(),
  }));
  app.get('/api/reality/overview', (c) => c.json(rge.commandCenter(A(c).workspaceId)));
  app.get('/api/reality/mission-audit', (c) => c.json(rge.auditMissionActions(A(c).workspaceId)));
  app.get('/api/reality/gaps', (c) => c.json({ gaps: rge.gaps(A(c).workspaceId, { status: c.req.query('status') || undefined, source: c.req.query('source') || undefined }) }));
  app.get('/api/reality/workflows', (c) => c.json({ workflows: rge.list(A(c).workspaceId, c.req.query('source') ?? 'live') }));
  app.post('/api/reality/workflows', async (c) => {
    const b = await body(c, z.object({ scenario: z.string().max(80), baseline: z.string().max(60).optional() }));
    const w = await rge.create(A(c), b.scenario, { baseline: b.baseline, source: 'live' });
    return c.json(rge.detail(A(c).workspaceId, w.id), 201);
  });
  app.get('/api/reality/workflows/:id', (c) => c.json(rge.detail(A(c).workspaceId, id(c))));
  app.post('/api/reality/workflows/:id/approve', async (c) => {
    const b = await body(c, z.object({ subject: z.enum(['plan', 'recovery']) }));
    const a = A(c); if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot approve.');
    rge.recordApproval(a, rge.wf(a.workspaceId, id(c)), b.subject, { strict: true });
    return c.json(rge.detail(a.workspaceId, id(c)));
  });
  app.post('/api/reality/workflows/:id/run', async (c) => c.json(await rge.run(A(c), id(c))));
  app.post('/api/reality/workflows/:id/recovery/choose', async (c) => { const b = await body(c, z.object({ optionId: z.string().max(40) })); return c.json(rge.chooseRecovery(A(c), id(c), b.optionId)); });
  app.post('/api/reality/workflows/:id/recovery/execute', async (c) => c.json(await rge.executeRecovery(A(c), id(c))));
  app.post('/api/reality/workflows/:id/reaudit', (c) => c.json(rge.reaudit(A(c), id(c))));
  app.post('/api/reality/workflows/:id/cancel', async (c) => { const b = await body(c, z.object({ reason: z.string().max(500) })); return c.json(rge.cancel(A(c), id(c), b.reason)); });
  app.get('/api/reality/workflows/:id/graph', (c) => c.json(rge.graph(A(c).workspaceId, id(c))));
  app.get('/api/reality/workflows/:id/traverse', (c) => {
    const node = c.req.query('node'); const dir = c.req.query('dir') === 'up' ? 'up' : 'down';
    if (!node) throw new EngineError(422, 'node_required', 'Query parameter "node" is required.');
    return c.json(rge.traverse(A(c).workspaceId, id(c), node, dir));
  });
  app.get('/api/reality/workflows/:id/passports', (c) => c.json({ passports: rge.passports(A(c).workspaceId, id(c)) }));
  app.get('/api/reality/workflows/:id/passport.json', (c) => {
    const a = A(c); const pps = rge.passports(a.workspaceId, id(c));
    engine.audit(a.workspaceId, id(c), 'user', a.name, 'rge_passport_export', `Proof-of-Outcome passports exported (${pps.length})`);
    c.header('Content-Disposition', `attachment; filename="passport-${id(c)}.json"`);
    return c.json({ exportedAt: new Date().toISOString(), workflowId: id(c), passports: pps.map((p) => ({ id: p.id, operationId: p.operation_id, status: p.status, bodyHash: p.body_hash, body: p.body })) });
  });
  app.get('/api/reality/passports/:pid/verify', (c) => c.json(rge.verifyPassport(A(c).workspaceId, c.req.param('pid') as string)));

  // ---- RIGOR benchmark ----
  app.get('/api/rigor/definitions', (c) => c.json(definitions()));
  app.get('/api/rigor/runs', (c) => c.json({ runs: rigor.list(A(c).workspaceId) }));
  app.post('/api/rigor/runs', async (c) => {
    const a = A(c);
    const b = await body(c, z.object({ seed: z.string().max(80).optional(), baselines: z.array(z.string().max(60)).max(10).optional(), scenarios: z.array(z.string().max(80)).max(100).optional(), wait: z.boolean().optional() }));
    if (engine.db.get("SELECT 1 x FROM bench_runs WHERE workspace_id=? AND status='running'", a.workspaceId)) throw new EngineError(409, 'busy', 'A RIGOR run is already in progress in this workspace.');
    const s = rigor.start(a, b);
    if (b.wait) { await rigor.execute(a, s.id, s.cases); return c.json(rigor.report(a.workspaceId, s.id), 201); }
    void rigor.execute(a, s.id, s.cases).catch((e) => console.error('RIGOR run failed', e));
    return c.json({ id: s.id, seed: s.seed, total: s.cases.length, status: 'running' }, 202);
  });
  app.get('/api/rigor/runs/:id', (c) => c.json(rigor.report(A(c).workspaceId, id(c))));
  app.get('/api/rigor/runs/:id/export.json', (c) => { c.header('Content-Disposition', `attachment; filename="rigor-${id(c)}.json"`); return c.json({ definitions: definitions(), ...rigor.report(A(c).workspaceId, id(c)) }); });
  app.get('/api/rigor/runs/:id/export.csv', (c) => {
    const csv = rigor.csv(A(c).workspaceId, id(c));
    return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="rigor-${id(c)}.csv"` });
  });
  // ---- Compound Failure Arena ----
  const arena = new Arena(rge);
  app.get('/api/arena/campaigns', (c) => c.json({ campaigns: arena.library(A(c).workspaceId), metrics: ARENA_METRICS, baselines: Object.entries(BASELINES).map(([k, b]) => ({ id: k, label: b.label, description: b.description, disabled: Object.entries(b.controls).filter(([, on]) => !on).map(([key]) => CONTROL_LABELS[key as keyof typeof CONTROL_LABELS]) })), version: ARENA_VERSION, sandbox: LAB_LABEL, collab: engine.collab.describe() }));
  app.get('/api/arena/runs', (c) => c.json({ runs: arena.list(A(c).workspaceId) }));
  app.post('/api/arena/runs', async (c) => {
    const a = A(c);
    const b = await body(c, z.object({ seed: z.string().max(80).optional(), campaigns: z.array(z.string().max(80)).max(20).optional(), baselines: z.array(z.string().max(60)).max(10).optional(), replayOf: z.string().max(80).optional(), wait: z.boolean().optional() }));
    if (engine.db.get("SELECT 1 x FROM bench_runs WHERE workspace_id=? AND status='running'", a.workspaceId)) throw new EngineError(409, 'busy', 'A RIGOR or Arena run is already in progress in this workspace.');
    const s = arena.start(a, b);
    if (b.wait) { await arena.execute(a, s.id, s.cases); return c.json(arena.report(a.workspaceId, s.id), 201); }
    void arena.execute(a, s.id, s.cases).catch((e) => console.error('Arena run failed', e));
    return c.json({ id: s.id, seed: s.seed, total: s.cases.length, status: 'running' }, 202);
  });
  app.get('/api/arena/runs/:id', (c) => c.json(arena.report(A(c).workspaceId, id(c))));
  app.get('/api/arena/runs/:id/export.json', (c) => { c.header('Content-Disposition', `attachment; filename="arena-${id(c)}.json"`); return c.json({ metrics: ARENA_METRICS, version: ARENA_VERSION, ...arena.report(A(c).workspaceId, id(c)) }); });
  app.get('/api/arena/runs/:id/export.csv', (c) => c.body(arena.csv(A(c).workspaceId, id(c)), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="arena-${id(c)}.csv"` }));
  app.get('/api/arena/cases/:id', (c) => c.json(arena.caseDetail(A(c).workspaceId, id(c))));
  return { rge, rigor, arena };
}

/** Tables owned by the Reality Gap Engine / RIGOR (for workspace export and deletion). */
export const REALITY_TABLES = ['rw_workflows', 'rw_operations', 'rw_handoffs', 'rw_observations', 'rw_approvals', 'rw_gaps', 'rw_recovery_plans', 'rw_passports', 'lab_resources', 'lab_effects', 'bench_runs', 'bench_cases', 'cd_campaigns', 'cd_workflows', 'cd_ops', 'cd_invariants', 'cd_findings', 'cd_nodes', 'cd_edges'];
