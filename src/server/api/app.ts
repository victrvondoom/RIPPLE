import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { Engine, type Actor } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { nowIso, uid } from '../db/db.js';
import { hashPassword, verifyPassword } from '../seed.js';
import { nextStep, seedDemoActivity } from '../demo/activity.js';
import { missionDetail, overview } from './snapshot.js';
import { registerStudioRoutes } from './studio.js';
import { getCausalGraph } from '../engine/causal.js';
import { registerRealityRoutes, REALITY_TABLES } from './reality.js';
import { registerCrossDomainRoutes } from './crossdomain.js';
import { registerDashboardRoutes, DASH_TABLES } from './dashboards.js';
import { registerFlipsideRoutes } from './flipside.js';
import { PackageGateService, PKG_TABLES, registerPkgGuardRoutes } from './pkgguard.js';
import { registerMemoryRoutes } from './memory.js';
import { issueReceipt, verifyReceipt, type LedgerReceipt } from './receipt.js';
import { SwitchConsole, registerConsoleRoutes } from '../console/console.js';

const COOKIE = 'ripple_session';
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
type Env = { Variables: { actor: Actor } };

export function createApp(engine: Engine, opts: { production?: boolean; webRoot?: string; console?: SwitchConsole; packageGate?: PackageGateService } = {}) {
  const app = new Hono<Env>();
  const db = engine.db;
  const attempts = new Map<string, { n: number; t: number }>();

  app.onError((err, c) => {
    if (err instanceof EngineError) return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
    if (err instanceof ZodError) return c.json({ error: { code: 'invalid_input', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } }, 422);
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });

  // CSRF defence in depth: cookies are SameSite=Lax; mutating requests must be same-origin (when Origin is sent) and JSON.
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && new URL(origin).host !== c.req.header('host')) return c.json({ error: { code: 'csrf', message: 'Cross-origin request rejected.' } }, 403);
      const ct = c.req.header('content-type') ?? '';
      if (c.req.header('content-length') !== '0' && c.req.header('content-length') !== undefined && !ct.includes('application/json')) return c.json({ error: { code: 'content_type', message: 'JSON required.' } }, 415);
    }
    await next();
  });

  // Public: the landing page reads the collaboration mode from here (no workspace data).
  app.get('/api/health', (c) => { const d = engine.collab.describe(); return c.json({ ok: true, collab: { mode: d.mode, connected: d.connected, label: engine.collab.label } }); });
  app.post('/api/auth/login', async (c) => {
    const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(await c.req.json());
    const key = `${c.req.header('x-forwarded-for') ?? 'local'}|${body.email.toLowerCase()}`;
    const a = attempts.get(key); const now = Date.now();
    if (a && now - a.t < 60_000 && a.n >= 10) throw new EngineError(429, 'rate_limited', 'Too many login attempts. Wait a minute.');
    const u = db.get('SELECT * FROM users WHERE lower(email)=?', body.email.toLowerCase());
    if (!u || !verifyPassword(body.password, u.password_hash)) {
      attempts.set(key, { n: (a && now - a.t < 60_000 ? a.n : 0) + 1, t: a && now - a.t < 60_000 ? a.t : now });
      throw new EngineError(401, 'bad_credentials', 'Invalid email or password.');
    }
    const token = randomBytes(32).toString('hex');
    db.insert('sessions', { token_hash: hashToken(token), user_id: u.id, expires_at: new Date(Date.now() + 12 * 3600_000).toISOString() });
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: !!opts.production, maxAge: 12 * 3600 });
    engine.audit(u.workspace_id, null, 'user', u.name, 'login', `${u.name} signed in`);
    return c.json({ user: pub(u) });
  });
  // Session 20: self-service sign-up. A new account gets its OWN workspace (it never joins the demo company), with the new
  // person as owner and mapped to every human role of every pack, so one person can run any workflow end to end.
  // Optionally the workspace is filled with labelled demo activity driven through the engine (see demo/activity.ts).
  const signups = new Map<string, { n: number; t: number }>();
  app.post('/api/auth/signup', async (c) => {
    const body = z.object({
      name: z.string().trim().min(2).max(80), email: z.string().trim().email().max(200),
      password: z.string().min(8, 'Use at least 8 characters.').max(200), workspace: z.string().trim().min(2).max(80).optional(),
      demoData: z.boolean().default(true),
    }).parse(await c.req.json());
    const ip = c.req.header('x-forwarded-for') ?? 'local'; const now = Date.now(); const s = signups.get(ip);
    if (s && now - s.t < 3600_000 && s.n >= 20) throw new EngineError(429, 'rate_limited', 'Too many sign-ups from this address. Try again later.');
    signups.set(ip, { n: (s && now - s.t < 3600_000 ? s.n : 0) + 1, t: s && now - s.t < 3600_000 ? s.t : now });
    const email = body.email.toLowerCase();
    if (db.get('SELECT 1 x FROM users WHERE lower(email)=?', email)) throw new EngineError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
    const ws = uid('ws'); const uidv = uid('usr'); const at = nowIso();
    db.insert('workspaces', { id: ws, name: body.workspace ?? `${body.name.split(' ')[0]}'s workspace`, created_at: at });
    db.insert('users', { id: uidv, workspace_id: ws, email, name: body.name, role: 'owner', department: 'Operations', title: 'Workspace owner', password_hash: hashPassword(body.password), created_at: at });
    for (const pack of engine.packs.all()) for (const r of pack.roles) db.insert('agent_roles', { id: uid('role'), workspace_id: ws, pack_id: pack.id, key: r.key, name: r.name, kind: r.kind, responsibility: r.responsibility, user_id: r.kind === 'human' ? uidv : null });
    for (const [key, name, mode] of [['document_store', 'Document store', 'local-filesystem'], ['internal_notify', 'Internal notification', 'local-outbox'], ['email_outbox', 'Email outbox (dry-run)', 'dry-run'], ['warehouse_sandbox', 'Warehouse sandbox (Reality Lab)', 'sandbox'], ['billing_sandbox', 'Billing sandbox (test ledger)', 'sandbox']]) db.insert('connectors', { id: uid('con'), workspace_id: ws, key, name, mode, config: '{}', fail_next: 0 });
    engine.audit(ws, null, 'user', body.name, 'signup', `${body.name} created the workspace`);
    if (body.demoData) await seedDemoActivity(engine, ws);
    const token = randomBytes(32).toString('hex');
    db.insert('sessions', { token_hash: hashToken(token), user_id: uidv, expires_at: new Date(Date.now() + 12 * 3600_000).toISOString() });
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: !!opts.production, maxAge: 12 * 3600 });
    return c.json({ user: pub(db.get('SELECT * FROM users WHERE id=?', uidv)) }, 201);
  });

  app.post('/api/auth/logout', (c) => {
    const t = getCookie(c, COOKIE); if (t) db.exec('DELETE FROM sessions WHERE token_hash=?', hashToken(t));
    deleteCookie(c, COOKIE, { path: '/' }); return c.json({ ok: true });
  });

  const sessionUser = (c: Context<Env>) => {
    const t = getCookie(c, COOKIE);
    const row = t ? db.get("SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?", hashToken(t)) : undefined;
    return !row || row.expires_at < nowIso() ? null : row;
  };
  const mePayload = (userId: string, workspaceId: string) => {
    const u = db.get('SELECT * FROM users WHERE id=?', userId)!;
    const ws = db.get('SELECT * FROM workspaces WHERE id=?', workspaceId)!;
    return { user: pub(u), workspace: { id: ws.id, name: ws.name }, collab: engine.collab.describe(), provider: { name: engine.provider.name, kind: engine.provider.kind } };
  };
  // Session 19: the web app's start-up probe. Signed out is a normal state, so it answers 200 {user: null} instead of a
  // 401 that every browser logs as a console error. /api/auth/me keeps its 401 contract for API clients.
  app.get('/api/auth/session', (c) => { const row = sessionUser(c); return c.json(row ? mePayload(row.id, row.workspace_id) : { user: null }); });

  // ---- everything below requires a session ----
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path.startsWith('/api/auth/login') || c.req.path === '/api/auth/logout' || c.req.path === '/api/auth/session' || c.req.path === '/api/auth/signup') return next();
    const row = sessionUser(c);
    if (!row) return c.json({ error: { code: 'unauthenticated', message: 'Sign in required.' } }, 401);
    c.set('actor', { id: row.id, name: row.name, role: row.role, workspaceId: row.workspace_id });
    await next();
  });
  const A = (c: Context<Env>) => c.get('actor');
  const json = async <T extends z.ZodTypeAny>(c: Context<Env>, s: T): Promise<z.infer<T>> => s.parse(await c.req.json());

  app.get('/api/auth/me', (c) => c.json(mePayload(A(c).id, A(c).workspaceId)));
  app.post('/api/auth/password', async (c) => {
    const a = A(c); const b = z.object({ current: z.string().min(1).max(200), next: z.string().min(8, 'Use at least 8 characters.').max(200) }).parse(await c.req.json());
    const u = db.get('SELECT * FROM users WHERE id=? AND workspace_id=?', a.id, a.workspaceId)!;
    if (!verifyPassword(b.current, u.password_hash)) throw new EngineError(403, 'bad_credentials', 'The current password is not correct.');
    db.exec('UPDATE users SET password_hash=? WHERE id=? AND workspace_id=?', hashPassword(b.next), a.id, a.workspaceId);
    // Every other session of this person ends; this one stays.
    const t = getCookie(c, COOKIE); db.exec('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', a.id, t ? hashToken(t) : '');
    engine.audit(a.workspaceId, null, 'user', a.name, 'password_changed', `${a.name} changed their password`);
    return c.json({ ok: true });
  });
  // "How it works" live sandbox: one press = one real engine step, performed as the person the rules name. Only on
  // missions started from labelled sample data (plan_source demo-*), so it never acts for anyone on real work.
  app.post('/api/demo/step/:id', async (c) => {
    const a = A(c); if (a.role !== 'manager' && a.role !== 'owner') throw new EngineError(403, 'forbidden', 'Only a manager or owner can step a walkthrough.');
    const m = db.get('SELECT * FROM missions WHERE id=? AND workspace_id=?', c.req.param('id'), a.workspaceId);
    if (!m) throw new EngineError(404, 'not_found', 'Mission not found.');
    if (!String(m.plan_source).startsWith('demo')) throw new EngineError(409, 'not_demo', 'The walkthrough only steps missions started from labelled sample data.');
    const step = await nextStep(engine, m.id, a.workspaceId);
    return c.json({ step, mission: engine.mission(a.workspaceId, m.id) });
  });
  // Fill this workspace with labelled demo activity (manager/owner). Real engine calls only; safe to run more than once.
  app.post('/api/demo/activity', async (c) => {
    const a = A(c); if (a.role !== 'manager' && a.role !== 'owner') throw new EngineError(403, 'forbidden', 'Only a manager or owner can load demo activity.');
    const logs = await seedDemoActivity(engine, a.workspaceId);
    return c.json({ missions: logs.length, completed: logs.filter((l) => l.state === 'completed').length, logs });
  });
  app.get('/api/overview', (c) => c.json(overview(engine, A(c).workspaceId)));
  app.get('/api/packs', (c) => c.json({ packs: engine.packs.listings() }));
  app.get('/api/packs/:id', (c) => {
    const p = engine.packs.get(c.req.param('id'));
    if (!p) throw new EngineError(404, 'not_found', 'Pack not found or not implemented.');
    return c.json({ id: p.id, name: p.name, domain: p.domain, version: p.version, description: p.description, labels: p.labels ?? { baseline: 'Approved baseline', change: 'Change', changeVerb: 'Submit change', plan: 'plan', mission: 'Mission', blurb: '' }, roles: p.roles, roleOrder: p.roleOrder, artifacts: p.artifacts, rules: p.rules.map((r) => ({ id: r.id, to: r.to, relation: r.relation, why: r.why })), artifactEdges: p.artifactEdges, decisions: p.decisions, sample: p.sample() });
  });
  /** Creates a clearly-labelled DEMO mission from the pack's sample scenario (baseline approved; optionally the sample change is analysed). */
  app.post('/api/packs/:id/demo', async (c) => {
    const a = A(c); const pack = engine.packs.get(c.req.param('id')); if (!pack) throw new EngineError(404, 'not_found', 'Pack not found or not implemented.');
    const b = await json(c, z.object({ runAnalysis: z.boolean().default(false) })); const s = pack.sample();
    const m = await engine.createMission(a, { packId: pack.id, title: `${s.title} [demo]`, plan: s.plan, source: 'demo-sample' });
    engine.approveBaseline(a, m.id, 'Demo baseline from labelled sample data');
    if (b.runAnalysis) await engine.submitChange(a, m.id, s.change, 'demo-sample');
    return c.json({ mission: engine.mission(a.workspaceId, m.id) }, 201);
  });
  app.get('/api/people', (c) => {
    const ws = A(c).workspaceId;
    const users = db.all('SELECT id,name,email,role,department,title FROM users WHERE workspace_id=?', ws);
    const roles = db.all('SELECT * FROM agent_roles WHERE workspace_id=?', ws);
    const open = db.all("SELECT owner_user_id AS uid, count(*) n FROM work_items WHERE workspace_id=? AND status!='done' GROUP BY owner_user_id", ws);
    const runStats = db.all("SELECT role_key, status, count(*) n FROM agent_runs WHERE workspace_id=? GROUP BY role_key, status", ws);
    // Session 19: what each agent reads and writes comes from its pack declaration and from recorded actions, not a fixed list.
    const used = db.all('SELECT m.pack_id, a.owner_role, a.connector, count(*) n FROM actions a JOIN missions m ON m.id = a.mission_id WHERE a.workspace_id=? GROUP BY m.pack_id, a.owner_role, a.connector', ws);
    const conName = new Map(db.all('SELECT key, name FROM connectors WHERE workspace_id=?', ws).map((x) => [x.key, x.name]));
    const access = (packId: string, key: string) => {
      const pack = engine.packs.get(packId); const role = pack?.roles.find((r) => r.key === key);
      const deps = pack?.roleDeps?.[key] ?? pack?.roleOrder.slice(0, Math.max(0, pack.roleOrder.indexOf(key))) ?? [];
      return {
        scope: role?.scope ?? 'act',
        reads: ['plan baseline', 'change request', 'human answers', ...deps.map((d) => `${pack?.roles.find((r) => r.key === d)?.name ?? d} output`)],
        writes: used.filter((u) => u.pack_id === packId && u.owner_role === key).map((u) => ({ key: u.connector, name: conName.get(u.connector) ?? u.connector, actions: u.n })),
      };
    };
    return c.json({
      users: users.map((u) => ({ ...u, openWork: open.find((o) => o.uid === u.id)?.n ?? 0, roles: roles.filter((r) => r.user_id === u.id).map((r) => ({ pack: r.pack_id, key: r.key, name: r.name })) })),
      agents: roles.filter((r) => r.kind === 'agent').map((a) => ({
        ...a,
        limit: engine.packs.get(a.pack_id)?.agentLimit ?? null,
        ...access(a.pack_id, a.key),
        runs: runStats.filter((s) => s.role_key === a.key)
      }))
    });
  });

  app.get('/api/missions', (c) => c.json({ missions: overview(engine, A(c).workspaceId).missions }));
  app.post('/api/missions', async (c) => {
    const b = await json(c, z.object({ packId: z.string(), title: z.string(), plan: z.unknown(), source: z.string().max(200).optional() }));
    const m = await engine.createMission(A(c), b);
    return c.json({ mission: m }, 201);
  });
  app.post('/api/uploads/plan', async (c) => {
    const b = await json(c, z.object({ packId: z.string(), filename: z.string().max(200), content: z.string().max(300_000) }));
    if (!/\.json$/i.test(b.filename)) throw new EngineError(415, 'unsupported_file', 'Only .json plan files are accepted.');
    let data: unknown; try { data = JSON.parse(b.content); } catch { throw new EngineError(422, 'invalid_json', 'File is not valid JSON.'); }
    const pack = engine.packs.get(b.packId); if (!pack) throw new EngineError(404, 'not_found', 'Unknown pack.');
    const r = pack.planSchema.safeParse(data);
    if (!r.success) throw new EngineError(422, 'invalid_plan', 'Plan failed validation: ' + r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return c.json({ plan: r.data, filename: b.filename.replace(/[^\w.\- ]/g, '_') });
  });
  app.get('/api/missions/:id', (c) => c.json(missionDetail(engine, A(c).workspaceId, c.req.param('id'))));
  app.get('/api/missions/:id/causal-graph', (c) => c.json(getCausalGraph(engine.db, A(c).workspaceId, c.req.param('id'))));
  app.delete('/api/missions/:id', (c) => {
    const a = A(c); engine.require(a, 'owner', 'manager'); const m = engine.mission(a.workspaceId, c.req.param('id'));
    deleteMission(engine, a.workspaceId, m.id);
    engine.audit(a.workspaceId, null, 'user', a.name, 'mission_deleted', `Mission "${m.title}" deleted`);
    return c.json({ ok: true });
  });
  const mid = (c: Context<Env>) => c.req.param('id') as string;
  const after = (c: Context<Env>) => c.json(missionDetail(engine, A(c).workspaceId, mid(c)));
  app.post('/api/missions/:id/baseline', async (c) => { const b = await json(c, z.object({ note: z.string().max(500).default('') })); engine.approveBaseline(A(c), mid(c), b.note); return after(c); });
  app.post('/api/missions/:id/changes', async (c) => { await engine.submitChange(A(c), mid(c), await c.req.json()); return after(c); });
  app.post('/api/missions/:id/questions/:qid/answer', async (c) => { const b = await json(c, z.object({ answer: z.string().min(1).max(1000) })); await engine.answerQuestion(A(c), mid(c), c.req.param('qid'), b.answer); return after(c); });
  app.post('/api/missions/:id/approvals/:aid/decide', async (c) => { const b = await json(c, z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(1000).default('') })); await engine.decideApproval(A(c), mid(c), c.req.param('aid'), b.decision, b.note); return after(c); });
  app.post('/api/missions/:id/actions/:aid/execute', async (c) => { await engine.executeAction(A(c), mid(c), c.req.param('aid')); return after(c); });
  app.post('/api/missions/:id/actions/:aid/acknowledge', async (c) => { const b = await json(c, z.object({ note: z.string().max(500).default('') })); engine.acknowledge(A(c), mid(c), c.req.param('aid'), b.note); return after(c); });
  app.patch('/api/missions/:id/work-items/:wid', async (c) => { const b = await json(c, z.object({ status: z.enum(['open', 'done']) })); engine.updateWorkItem(A(c), mid(c), c.req.param('wid'), b.status); return after(c); });
  app.post('/api/missions/:id/messages', async (c) => {
    const a = A(c); if (a.role === 'viewer') throw new EngineError(403, 'forbidden', 'Viewers cannot post.');
    const b = await json(c, z.object({ body: z.string().min(1).max(2000), toKey: z.string().max(60).optional() }));
    const m = engine.mission(a.workspaceId, mid(c));
    await engine.say(m, { kind: 'status', senderKey: 'human', senderName: a.name, senderKind: 'human', toKey: b.toKey, body: b.body });
    return after(c);
  });
  app.get('/api/missions/:id/completion', (c) => c.json(engine.completionPreview(A(c), mid(c))));
  app.post('/api/missions/:id/complete', async (c) => { await engine.completeMission(A(c), mid(c)); return after(c); });
  // Centralized human control of the orchestrator (managers/owners only; every call is audited).
  app.post('/api/missions/:id/pause', async (c) => { const b = await json(c, z.object({ reason: z.string().max(500).default('') })); engine.pauseMission(A(c), mid(c), b.reason); return after(c); });
  app.post('/api/missions/:id/resume', async (c) => { await engine.resumeMission(A(c), mid(c)); return after(c); });
  app.post('/api/missions/:id/retry-analysis', async (c) => { await engine.retryAnalysis(A(c), mid(c)); return after(c); });
  app.post('/api/missions/:id/work-items/:wid/reassign', async (c) => { const b = await json(c, z.object({ userId: z.string().min(1).max(80) })); engine.reassignWorkItem(A(c), mid(c), c.req.param('wid'), b.userId); return after(c); });
  app.post('/api/missions/:id/cancel', async (c) => { const b = await json(c, z.object({ reason: z.string().max(500) })); engine.cancelMission(A(c), mid(c), b.reason); return after(c); });

  app.get('/api/approvals', (c) => {
    const ws = A(c).workspaceId; const o = overview(engine, ws);
    const decided = db.all("SELECT a.*, m.title AS mission_title, u.name AS decided_by_name FROM approvals a JOIN missions m ON m.id=a.mission_id LEFT JOIN users u ON u.id=a.decided_by WHERE a.workspace_id=? AND a.status!='pending' ORDER BY a.created_at DESC LIMIT 50", ws);
    return c.json({ pending: o.pendingApprovals, decided, openQuestions: o.openQuestions });
  });
  app.get('/api/evidence', (c) => {
    const ws = A(c).workspaceId;
    const evidence = db.all('SELECT e.*, m.title AS mission_title, a.title AS action_title FROM evidence e JOIN missions m ON m.id=e.mission_id LEFT JOIN actions a ON a.id=e.action_id WHERE e.workspace_id=? ORDER BY e.created_at DESC LIMIT 300', ws).map((x) => ({ ...x, passed: !!x.passed }));
    const outcomes = db.all('SELECT o.*, m.title AS mission_title FROM outcomes o JOIN missions m ON m.id=o.mission_id WHERE o.workspace_id=? ORDER BY o.created_at DESC', ws).map((o) => ({ ...o, criteria: JSON.parse(o.criteria), unresolved: JSON.parse(o.unresolved), completed: JSON.parse(o.completed ?? '[]') }));
    return c.json({ evidence, outcomes });
  });
  app.get('/api/graph', (c) => {
    const ws = A(c).workspaceId;
    return c.json({ missions: db.all("SELECT id,title,state FROM missions WHERE workspace_id=? AND analysis_rev>0 ORDER BY updated_at DESC", ws) });
  });

  // register multi-agent studio routes
  registerStudioRoutes(app, engine);
  // Reality Gap Engine + RIGOR benchmark (session 7)
  registerRealityRoutes(app, engine);
  // Cross-Domain Invariant Intelligence (session 9)
  registerCrossDomainRoutes(app, engine);
  // Four dashboards (Mission Control, Operations Workbench, Trust & Evidence, Knowledge & Decisions) + capability catalog (session 10)
  registerDashboardRoutes(app, engine);
  registerFlipsideRoutes(app, engine);
  registerPkgGuardRoutes(app, engine, opts.packageGate ?? new PackageGateService(engine));
  registerMemoryRoutes(app, engine);
  // Portable signed ledger receipts (session 16; inherited from switch-notary/Shipyard). Issue: manager/owner. Verify: any member.
  app.post('/api/dash/trust/receipt', (c) => c.json(issueReceipt(engine, A(c))));
  app.post('/api/dash/trust/receipt/verify', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { receipt?: LedgerReceipt; publicKey?: string };
    return c.json(verifyReceipt(engine, A(c).workspaceId, b.receipt as LedgerReceipt, b.publicKey));
  });
  // Switch Console: one conversational room on every page, with an on/off Switch connection (session 10)
  registerConsoleRoutes(app, opts.console ?? SwitchConsole.fromEnv(engine, process.env));

  // settings / data governance
  app.get('/api/workspace/audit', (c) => {
    const ws = A(c).workspaceId;
    const events = db.all('SELECT * FROM audit_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100', ws);
    return c.json({ events });
  });
  app.get('/api/settings', (c) => {
    const a = A(c);
    return c.json({ collab: engine.collab.describe(), provider: { name: engine.provider.name, kind: engine.provider.kind }, connectors: db.all('SELECT key,name,mode,fail_next FROM connectors WHERE workspace_id=?', a.workspaceId).map((x) => ({ ...x, fail_next: !!x.fail_next, description: engine.connectors[x.key]?.description })), role: a.role });
  });
  app.post('/api/settings/connectors/:key/fail-next', async (c) => {
    const a = A(c); engine.require(a, 'owner'); const b = await json(c, z.object({ enabled: z.boolean() }));
    db.exec('UPDATE connectors SET fail_next=? WHERE workspace_id=? AND key=?', b.enabled ? 1 : 0, a.workspaceId, c.req.param('key'));
    engine.audit(a.workspaceId, null, 'user', a.name, 'fault_injection', `Dev fault injection ${b.enabled ? 'ARMED' : 'cleared'} for connector ${c.req.param('key')}`);
    return c.json({ ok: true });
  });
  app.get('/api/workspace/export', (c) => {
    const a = A(c); engine.require(a, 'owner');
    const tables = ['workspaces', 'users', 'missions', 'artifacts', 'baselines', 'change_events', 'graph_nodes', 'dependencies', 'work_items', 'agent_roles', 'agent_runs', 'rooms', 'messages', 'questions', 'approvals', 'actions', 'acknowledgements', 'evidence', 'outcomes', 'connectors', 'audit_events', 'causal_events', 'workflow_tasks', ...REALITY_TABLES, ...DASH_TABLES, ...PKG_TABLES];
    const out: Record<string, unknown> = { exportedAt: nowIso(), note: 'Password hashes are excluded.' };
    for (const t of tables) out[t] = db.all(`SELECT * FROM ${t} WHERE ${t === 'workspaces' ? 'id' : 'workspace_id'}=?`, a.workspaceId).map((r) => { const { password_hash, ...rest } = r as any; void password_hash; return rest; });
    engine.audit(a.workspaceId, null, 'user', a.name, 'workspace_export', 'Workspace data exported');
    c.header('Content-Disposition', 'attachment; filename="ripple-export.json"');
    return c.json(out);
  });
  app.delete('/api/workspace', async (c) => {
    const a = A(c); engine.require(a, 'owner');
    const b = await json(c, z.object({ confirmName: z.string() }));
    const ws = db.get('SELECT name FROM workspaces WHERE id=?', a.workspaceId)!;
    if (b.confirmName !== ws.name) throw new EngineError(422, 'confirm_mismatch', 'Type the exact workspace name to confirm deletion.');
    db.tx(() => {
      for (const t of ['acknowledgements', 'evidence', 'outcomes', 'actions', 'approvals', 'questions', 'messages', 'rooms', 'agent_runs', 'agent_roles', 'work_items', 'dependencies', 'graph_nodes', 'change_events', 'baselines', 'artifacts', 'missions', 'connectors', 'audit_events', 'causal_events', 'workflow_tasks', ...REALITY_TABLES, ...DASH_TABLES, ...PKG_TABLES]) db.exec(`DELETE FROM ${t} WHERE workspace_id=?`, a.workspaceId);
      db.exec('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE workspace_id=?)', a.workspaceId);
      db.exec('DELETE FROM users WHERE workspace_id=?', a.workspaceId);
      db.exec('DELETE FROM workspaces WHERE id=?', a.workspaceId);
    });
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // static web app
  const root = opts.webRoot ?? 'dist/web';
  if (existsSync(root)) {
    app.use('/assets/*', serveStatic({ root }));
    app.get('*', (c) => c.html(readFileSync(`${root}/index.html`, 'utf8')));
  }
  return app;
}

function deleteMission(engine: Engine, ws: string, id: string) {
  engine.db.tx(() => {
    for (const t of ['acknowledgements', 'evidence', 'outcomes', 'actions', 'approvals', 'questions', 'messages', 'rooms', 'agent_runs', 'work_items', 'dependencies', 'graph_nodes', 'change_events', 'baselines', 'artifacts'])
      engine.db.exec(`DELETE FROM ${t} WHERE mission_id=? AND workspace_id=?`, id, ws);
    engine.db.exec('DELETE FROM missions WHERE id=? AND workspace_id=?', id, ws);
  });
}
const pub = (u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, department: u.department, title: u.title });
void uid;
