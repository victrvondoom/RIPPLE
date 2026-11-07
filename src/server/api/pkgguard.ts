import type { Context, Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Actor, Engine } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { nowIso, uid } from '../db/db.js';
import { parseInstalls, type PackageRef } from '../capabilities/pkgguard/installs.js';
import { httpFetcher, observe, type Fetcher, type Observation } from '../capabilities/pkgguard/observe.js';
import { referenceProvenance } from '../capabilities/pkgguard/reference.js';
import { assess, changeSchema, planSchema, type PkgAssessment } from '../packs/pkggate/pack.js';

/**
 * Package Gate, live (session 19). Everything here is computed from recorded rows or read from the registries now:
 *  - POST /api/pkgguard/check   reads an install line, observes every package on npm/PyPI (metadata + in-memory code
 *                               reading), and opens a package-gate mission on that real data.
 *  - The room's policy is DERIVED, not stored by hand: the approval ledger comes from answered `approve_*` questions
 *    (with the person who answered and when), invented names and their counts from earlier checks' observations,
 *    review health from the same decisions.
 *  - Squat Watch re-reads every invented name on a timer and records when one becomes registered (pkg_watch rows,
 *    audit event, a room message on the mission that last asked for it).
 *  - GET /api/pkgguard/benchmark serves the measured numbers from bench/pkgguard/results/metrics-heldout.json; when the
 *    file is missing the answer is null and the UI shows "—".
 */
type Env = { Variables: { actor: Actor } };
const PACK = 'package-gate';
const MAX_PACKAGES = 20;
const norm = (eco: string, n: string) => (eco === 'pypi' ? n.toLowerCase().replace(/[-_.]+/g, '-') : n.toLowerCase());

/** Squat Watch rows live in pkg_watch (db/schema.ts). */
export const PKG_TABLES = ['pkg_watch'];

export interface RoomMemory {
  room: string;
  ledger: { ecosystem: 'npm' | 'pypi'; name: string; version: string; approvedBy: string; at: string; missionId: string }[];
  denied: { ecosystem: string; name: string; version: string; deniedBy: string; at: string; missionId: string }[];
  invented: { ecosystem: 'npm' | 'pypi'; name: string; count: number; firstSeen: string; lastMissionId: string }[];
  review: { asked: number; approved: number; ratio: number | null; reflex: boolean };
  checks: number;
}

export class PackageGateService {
  constructor(private engine: Engine, private fetcher: Fetcher = httpFetcher) {}
  private get db() { return this.engine.db; }

  /** The security lead is whoever the workspace maps to the pack's pg_security_lead role (never a hardcoded email). */
  securityLead(ws: string): { email: string; name: string } | null {
    const r = this.db.get("SELECT u.email, u.name FROM agent_roles r JOIN users u ON u.id = r.user_id WHERE r.workspace_id=? AND r.pack_id=? AND r.key='pg_security_lead'", ws, PACK);
    return r ? { email: r.email, name: r.name } : null;
  }

  /** Re-derives the room's memory from every recorded package-gate check in the workspace. */
  roomMemory(ws: string, room: string): RoomMemory {
    const mem: RoomMemory = { room, ledger: [], denied: [], invented: [], review: { asked: 0, approved: 0, ratio: null, reflex: false }, checks: 0 };
    const missions = this.db.all("SELECT id, created_at FROM missions WHERE workspace_id=? AND pack_id=? ORDER BY created_at", ws, PACK);
    const inv = new Map<string, RoomMemory['invented'][number]>();
    for (const m of missions) {
      const bl = this.db.get('SELECT plan FROM baselines WHERE workspace_id=? AND mission_id=? ORDER BY version LIMIT 1', ws, m.id);
      if (!bl || JSON.parse(bl.plan).room !== room) continue;
      for (const ch of this.db.all('SELECT input, created_at FROM change_events WHERE workspace_id=? AND mission_id=? ORDER BY seq', ws, m.id)) {
        const plan = planSchema.safeParse(JSON.parse(bl.plan)); const change = changeSchema.safeParse(JSON.parse(ch.input));
        if (!plan.success || !change.success) continue;
        mem.checks++;
        const as: PkgAssessment[] = assess(plan.data, change.data);
        for (const a of as) {
          if (a.status === 'invented') {
            const k = `${a.ref.ecosystem}:${norm(a.ref.ecosystem, a.ref.name)}`;
            const e = inv.get(k) ?? { ecosystem: a.ref.ecosystem, name: a.ref.name, count: 0, firstSeen: change.data.postedAt, lastMissionId: m.id };
            e.count++; e.lastMissionId = m.id; inv.set(k, e);
          }
          const q = this.db.get("SELECT q.answer_value, q.answered_at, u.name FROM questions q LEFT JOIN users u ON u.id = q.answered_by WHERE q.workspace_id=? AND q.mission_id=? AND q.key=? AND q.status='answered'", ws, m.id, a.key);
          if (!q || !a.obs?.resolvedVersion) continue;
          const value = JSON.parse(q.answer_value ?? 'null');
          mem.review.asked++;
          if (value === 'approve') { mem.review.approved++; mem.ledger.push({ ecosystem: a.ref.ecosystem, name: a.ref.name, version: a.obs.resolvedVersion, approvedBy: q.name ?? 'unknown', at: q.answered_at, missionId: m.id }); }
          if (value === 'deny') mem.denied.push({ ecosystem: a.ref.ecosystem, name: a.ref.name, version: a.obs.resolvedVersion, deniedBy: q.name ?? 'unknown', at: q.answered_at, missionId: m.id });
        }
      }
    }
    mem.invented = [...inv.values()].sort((x, y) => y.count - x.count);
    mem.review.ratio = mem.review.asked ? mem.review.approved / mem.review.asked : null;
    mem.review.reflex = mem.review.asked >= 10 && (mem.review.ratio ?? 0) >= 0.9;
    return mem;
  }

  /** Observes every package in the message (live), then opens a mission on that data. */
  async check(a: Actor, input: { message: string; room: string; requestedBy: { name: string; kind: 'human' | 'agent' } }) {
    if (a.role !== 'manager' && a.role !== 'owner') throw new EngineError(403, 'forbidden', 'Only a manager or owner can open an install check (the same rule as opening any mission).');
    const lead = this.securityLead(a.workspaceId);
    if (!lead) throw new EngineError(409, 'no_security_lead', 'Nobody in this workspace is mapped to the Package Gate security lead role; map one first.');
    const parsed = parseInstalls(input.message);
    if (parsed.packages.length === 0) throw new EngineError(422, 'no_packages', parsed.commands.length ? 'The install command names no registry package (only URLs, paths or requirement files).' : 'No npm/yarn/pnpm/bun/npx or pip/uv/poetry/pipenv install command was found in the message.');
    if (parsed.packages.length > MAX_PACKAGES) throw new EngineError(422, 'too_many_packages', `At most ${MAX_PACKAGES} packages per check.`);
    const observations: Observation[] = [];
    for (let i = 0; i < parsed.packages.length; i += 4) {
      observations.push(...await Promise.all(parsed.packages.slice(i, i + 4).map((ref: PackageRef) => observe(ref, { fetcher: this.fetcher }))));
    }
    const mem = this.roomMemory(a.workspaceId, input.room);
    const plan = {
      room: input.room, securityLead: lead.email,
      approvalLedger: mem.ledger.map((l) => ({ ecosystem: l.ecosystem, name: l.name, version: l.version, approvedBy: l.approvedBy, at: l.at })),
      inventedNames: mem.invented.map((i) => ({ ecosystem: i.ecosystem, name: i.name, count: i.count, firstSeen: i.firstSeen })),
      reviewHistory: { asked: mem.review.asked, approved: mem.review.approved },
    };
    const change = { message: input.message, requestedBy: input.requestedBy, postedAt: nowIso(), observations };
    const names = parsed.packages.map((p) => p.name).slice(0, 4).join(', ');
    const m = await this.engine.createMission(a, { packId: PACK, title: `Install check in ${input.room}: ${names}${parsed.packages.length > 4 ? ', …' : ''}`, plan, source: 'pkgguard-live' });
    this.engine.approveBaseline(a, m.id, `Room policy derived from ${mem.checks} earlier check(s) and ${mem.review.asked} recorded decision(s).`);
    await this.engine.submitChange(a, m.id, change, 'pkgguard-live');
    return { mission: this.engine.mission(a.workspaceId, m.id), observations: observations.map((o) => ({ ecosystem: o.ecosystem, name: o.name, version: o.resolvedVersion, existence: o.existence, code: o.code?.verdict ?? null, observedAt: o.observedAt })), skipped: parsed.skipped };
  }

  /** Squat Watch: re-reads every invented name of every room in the workspace; records a registration once. */
  async watch(ws: string) {
    const rooms = [...new Set(this.db.all('SELECT b.plan FROM baselines b JOIN missions m ON m.id = b.mission_id WHERE b.workspace_id=? AND m.pack_id=?', ws, PACK).map((r) => JSON.parse(r.plan).room as string))];
    const results: { room: string; ecosystem: string; name: string; status: string; newlyRegistered: boolean }[] = [];
    for (const room of rooms) {
      for (const inv of this.roomMemory(ws, room).invented) {
        const o = await observe({ ecosystem: inv.ecosystem, name: inv.name, raw: inv.name, tool: 'watch' }, { fetcher: this.fetcher });
        const prev = this.db.get('SELECT * FROM pkg_watch WHERE workspace_id=? AND room=? AND ecosystem=? AND name=?', ws, room, inv.ecosystem, inv.name);
        const registered = o.existence === 'exists' || o.existence === 'version-not-found';
        const newly = registered && !prev?.registered_seen_at;
        const row = { status: o.existence, observed_version: o.resolvedVersion, checked_at: o.observedAt, registered_seen_at: prev?.registered_seen_at ?? (registered ? o.observedAt : null), last_mission_id: inv.lastMissionId };
        if (prev) this.db.exec('UPDATE pkg_watch SET status=?, observed_version=?, checked_at=?, registered_seen_at=?, last_mission_id=? WHERE id=?', row.status, row.observed_version, row.checked_at, row.registered_seen_at, row.last_mission_id, prev.id);
        else this.db.insert('pkg_watch', { id: uid('pkw'), workspace_id: ws, room, ecosystem: inv.ecosystem, name: inv.name, ...row });
        if (newly) {
          const summary = `Squat Watch: ${inv.ecosystem} ${inv.name} was invented ${inv.count} time(s) in ${room} and is now registered (${o.resolvedVersion ?? 'no version'}, code reading: ${o.code?.verdict ?? 'not inspected'}). Treat it as hostile until a person decides.`;
          this.engine.audit(ws, inv.lastMissionId, 'agent', 'Squat Watch', 'invented_name_registered', summary, { ecosystem: inv.ecosystem, name: inv.name, version: o.resolvedVersion, code: o.code?.verdict ?? null });
          const m = this.db.get('SELECT * FROM missions WHERE workspace_id=? AND id=?', ws, inv.lastMissionId);
          if (m) await this.engine.say(m, { kind: 'escalation', senderKind: 'agent', senderKey: 'pg_squat_watch', senderName: 'Squat Watch', body: summary });
        }
        results.push({ room, ecosystem: inv.ecosystem, name: inv.name, status: o.existence, newlyRegistered: newly });
      }
    }
    return results;
  }

  watchRows(ws: string) { return this.db.all('SELECT room, ecosystem, name, status, observed_version, checked_at, registered_seen_at, last_mission_id FROM pkg_watch WHERE workspace_id=? ORDER BY checked_at DESC', ws); }
}

/** Headline numbers read from the benchmark's metrics file; null when it is absent. Nothing is typed in by hand. */
export function benchmarkSummary(file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bench', 'pkgguard', 'results', 'metrics-heldout.json')) {
  if (!existsSync(file)) return null;
  const M = JSON.parse(readFileSync(file, 'utf8'));
  const c = (x: any) => (x ? { recall: x.recall, fpr: x.fpr, recallCI95: x.recallCI95, fprCI95: x.fprCI95, tp: x.TP, fn: x.FN, fp: x.FP, tn: x.TN } : null);
  const e2 = M.E2_npm_metadata;
  return {
    generatedAt: M.generatedAt, split: M.split, rules: M.rules.INSPECT_RULES_VERSION,
    npm: {
      metadataAtPublish: c(e2?.confusion?.atPublish_vs_allControls), metadataAtReport: c(e2?.confusion?.atReport_vs_allControls),
      liveWindowMean: e2?.liveWindow?.meanDetection ?? null,
      freshFalseAlarm: c(e2?.confusion?.atPublish_vs_fresh), popularFalseAlarm: c(e2?.confusion?.atPublish_vs_popular),
      code: c(M.E3_code?.npm?.atReview?.vsAllBenign), either: c(M.E4_npm_combined?.atReview?.either),
      lookalike: c(M.E1_names?.npm?.lookalike), malicious: e2?.sample?.placedWithTimestamps ?? null,
    },
    pypi: { code: c(M.E3_code?.pypi?.atReview?.vsAllBenign), lookalike: c(M.E1_names?.pypi?.lookalike), metadataLive: c(M.E2b_pypi_metadata?.confusion_liveMalicious_vs_allControls) },
    reference: referenceProvenance(),
  };
}

export function registerPkgGuardRoutes(app: Hono<Env>, engine: Engine, svc: PackageGateService) {
  const A = (c: Context<Env>) => c.get('actor');
  const body = z.object({
    message: z.string().min(3).max(4000),
    room: z.string().min(1).max(80).default('#general'),
    requestedBy: z.object({ name: z.string().min(1).max(80), kind: z.enum(['human', 'agent']) }).optional(),
  });
  app.post('/api/pkgguard/check', async (c) => {
    const a = A(c); const b = body.parse(await c.req.json());
    return c.json(await svc.check(a, { message: b.message, room: b.room, requestedBy: b.requestedBy ?? { name: a.name, kind: 'human' } }), 201);
  });
  app.get('/api/pkgguard/overview', (c) => {
    const ws = A(c).workspaceId;
    const rooms = [...new Set(engine.db.all('SELECT b.plan FROM baselines b JOIN missions m ON m.id = b.mission_id WHERE b.workspace_id=? AND m.pack_id=?', ws, PACK).map((r) => JSON.parse(r.plan).room as string))];
    const missions = engine.db.all('SELECT id, title, state, created_at FROM missions WHERE workspace_id=? AND pack_id=? ORDER BY created_at DESC LIMIT 25', ws, PACK);
    return c.json({ securityLead: svc.securityLead(ws), rooms: rooms.map((r) => svc.roomMemory(ws, r)), missions, watch: svc.watchRows(ws), watchIntervalMinutes: watchMinutes(), benchmark: benchmarkSummary() });
  });
  app.post('/api/pkgguard/watch/run', async (c) => {
    const a = A(c); if (a.role === 'viewer' || a.role === 'member') throw new EngineError(403, 'forbidden', 'Only a manager or owner can run Squat Watch on demand.');
    return c.json({ results: await svc.watch(a.workspaceId) });
  });
}

/** Squat Watch interval from PKGGUARD_WATCH_MINUTES (default 5; 0 turns the timer off). */
export const watchMinutes = () => { const n = Number(process.env.PKGGUARD_WATCH_MINUTES ?? 5); return Number.isFinite(n) && n >= 0 ? n : 5; };
