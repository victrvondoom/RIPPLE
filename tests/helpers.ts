import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/server/db/db.js';
import { Engine, type Actor, type EngineDeps } from '../src/server/engine/engine.js';
import { defaultRegistry, type PackRegistry } from '../src/server/packs/registry.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { buildConnectors } from '../src/server/connectors/index.js';
import { DeterministicProvider } from '../src/server/agents/provider.js';
import { seedWorkspace } from '../src/server/seed.js';
import type { CollabPort } from '../src/server/collab/port.js';

export function makeEnv(collab: CollabPort = new LocalCollab(), packs: PackRegistry = defaultRegistry(), chatIdentities?: Record<string, string>, extra: Partial<EngineDeps> = {}) {
  const db = new Db(':memory:');
  const outbox = mkdtempSync(join(tmpdir(), 'ripple-'));
  const engine = new Engine({ db, packs, collab, connectors: buildConnectors(outbox), provider: new DeterministicProvider(), today: () => '2026-11-09', chatIdentities, ...extra });
  const seeded = seedWorkspace(db, packs, { name: 'Test Catering', password: 'pw-test-123' });
  const actor = (email: string): Actor => {
    const u = db.get('SELECT * FROM users WHERE email=?', email)!;
    return { id: u.id, name: u.name, role: u.role, workspaceId: u.workspace_id };
  };
  return { db, engine, packs, outbox, seeded, maya: actor('maya@harborvine.example'), luis: actor('luis@harborvine.example'), priya: actor('priya@harborvine.example'), dan: actor('dan@harborvine.example'), vera: actor('vera@harborvine.example'), sam: actor('sam@harborvine.example'), actor };
}
export type Env = ReturnType<typeof makeEnv>;

export async function newBaselinedMission(env: Env, packId = 'beo-rescue') {
  const pack = env.packs.get(packId)!;
  const s = pack.sample();
  const m = await env.engine.createMission(env.maya, { packId, title: s.title, plan: s.plan });
  env.engine.approveBaseline(env.maya, m.id, 'test');
  return { mission: m, sample: s };
}
export const row = (env: Env, sql: string, ...p: any[]) => env.db.get(sql, ...p) as any;
export const rows = (env: Env, sql: string, ...p: any[]) => env.db.all(sql, ...p) as any[];

/** Drives BEO from sample change to awaiting_approval (vegan count answered). */
export async function toAwaitingApproval(env: Env, veganCount = 18) {
  const { mission, sample } = await newBaselinedMission(env);
  await env.engine.submitChange(env.maya, mission.id, sample.change);
  const q = row(env, "SELECT * FROM questions WHERE mission_id=? AND key='vegan_count'", mission.id);
  await env.engine.answerQuestion(env.maya, mission.id, q.id, String(veganCount));
  return mission.id as string;
}

// ---------- generic journey helpers shared by every pack's tests ----------
export const actorById = (env: Env, userId: string): Actor => { const u = env.db.get('SELECT * FROM users WHERE id=?', userId)!; return { id: u.id, name: u.name, role: u.role, workspaceId: u.workspace_id }; };
export async function startPack(env: Env, packId: string, changeOverride?: (c: any) => any) {
  const { mission, sample } = await newBaselinedMission(env, packId);
  const change = changeOverride ? changeOverride(structuredClone(sample.change)) : sample.change;
  await env.engine.submitChange(env.maya, mission.id, change);
  return { id: mission.id as string, sample, state: () => row(env, 'SELECT state FROM missions WHERE id=?', mission.id).state as string };
}
export async function answer(env: Env, id: string, key: string, text: string) {
  const q = row(env, 'SELECT * FROM questions WHERE mission_id=? AND key=?', id, key);
  return env.engine.answerQuestion(env.maya, id, q.id, text);
}
export async function approveAll(env: Env, id: string) {
  for (const ap of rows(env, "SELECT * FROM approvals WHERE mission_id=? AND status='pending'", id)) await env.engine.decideApproval(ap.required_role === 'owner' ? env.sam : env.maya, id, ap.id, 'approved', 'approved in test');
}
export async function executeAll(env: Env, id: string) {
  for (const a of rows(env, "SELECT * FROM actions WHERE mission_id=? AND status='approved'", id)) await env.engine.executeAction(env.maya, id, a.id);
}
export function ackAll(env: Env, id: string) {
  for (const k of rows(env, "SELECT k.*, a.status AS astatus FROM acknowledgements k JOIN actions a ON a.id=k.action_id WHERE k.mission_id=? AND k.status='pending' AND a.status='verified'", id)) env.engine.acknowledge(actorById(env, k.user_id), id, k.action_id, 'ack in test');
}
export function finishReviews(env: Env, id: string) {
  for (let pass = 0; pass < 6; pass++) for (const w of rows(env, "SELECT * FROM work_items WHERE mission_id=? AND kind='review' AND status!='done' AND analysis_rev=(SELECT analysis_rev FROM missions WHERE id=?)", id, id)) { try { env.engine.updateWorkItem(env.maya, id, w.id, 'done'); } catch { /* prerequisite open; next pass */ } }
}
export async function fullFlow(env: Env, id: string) { await approveAll(env, id); await executeAll(env, id); ackAll(env, id); finishReviews(env, id); }
export const missionRow = (env: Env, id: string) => row(env, 'SELECT * FROM missions WHERE id=?', id);
export const kinds = (env: Env, id: string) => rows(env, 'SELECT key FROM graph_nodes WHERE mission_id=? AND analysis_rev=(SELECT analysis_rev FROM missions WHERE id=?)', id, id).map((n) => n.key as string);
export const artifact = (env: Env, id: string, kind: string) => row(env, "SELECT * FROM artifacts WHERE mission_id=? AND kind=? AND status IN ('draft','provisional') ORDER BY created_at DESC", id, kind)?.content as string;
