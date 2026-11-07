import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/server/db/db.js';
import { overview } from '../src/server/api/snapshot.js';
import { seedWorkspace, syncDirectory } from '../src/server/seed.js';
import { makeEnv, startPack, answer, approveAll, executeAll, ackAll, finishReviews, missionRow, row, rows, actorById, type Env } from './helpers.js';

/** The human answers each pack's blocking question needs (dynamic keys are looked up). */
async function startAll(env: Env) {
  const ids: Record<string, string> = {};
  const ans: Record<string, [string, string] | null> = { 'beo-rescue': ['vegan_count', '18'], sceneshift: null, scopeguard: ['classify_6', 'out of scope'], invoiceguard: null, shiftrelay: ['status_J-104', 'open'], movemate: ['owner_ob_keys', 'Leo'], podflow: ['clip_selection_%', '1,4'], submitready: ['owner_d_video', 'Ben'] };
  for (const [pack, a] of Object.entries(ans)) {
    const r = await startPack(env, pack); ids[pack] = r.id;
    if (a) { const q = row(env, 'SELECT key FROM questions WHERE mission_id=? AND key LIKE ? AND status=\'open\' AND blocking=1', r.id, a[0]); await answer(env, r.id, q.key, a[1]); }
  }
  return ids;
}

describe('cross-domain intervention: one engine, one workspace, eight workflow packs', () => {
  it('runs every pack in one workspace and surfaces them together without merging their data', async () => {
    const env = makeEnv(); const ids = await startAll(env);
    expect(Object.keys(ids)).toHaveLength(8);
    const ov = overview(env.engine, env.maya.workspaceId);
    expect(ov.missions).toHaveLength(8); expect(new Set(ov.missions.map((m: any) => m.domain)).size).toBe(8);
    expect(ov.missions.every((m: any) => m.state === 'awaiting_approval')).toBe(true);
    expect(ov.pendingApprovals.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ov.pendingApprovals.map((a: any) => a.mission_id)).size).toBe(8);                  // one shared approvals queue
    const sg = ov.missions.find((m: any) => m.pack_id === 'scopeguard');
    expect(sg.pending_approvals).toBe(3); expect(sg.owners.length).toBeGreaterThanOrEqual(2); expect(sg.last_change_at).toBeTruthy(); expect(typeof sg.overdue).toBe('number');
    // data is NOT merged: each mission only sees its own baseline, changes, artifacts and audit trail
    for (const [pack, id] of Object.entries(ids)) {
      const planPack = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=1', id).plan);
      expect(planPack).toBeTruthy(); expect(rows(env, 'SELECT DISTINCT pack_id FROM missions WHERE id=?', id)[0].pack_id).toBe(pack);
      expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='change_submitted'", id)).toHaveLength(1);
    }
    expect(JSON.stringify(rows(env, 'SELECT content FROM artifacts WHERE mission_id=?', ids.scopeguard))).not.toMatch(/Cedar Court|Pixel Forge|Meridian/);
  });

  it('approval requirements differ by action type, and the right role is enforced', async () => {
    const env = makeEnv(); const ids = await startAll(env);
    const roles = new Set(rows(env, "SELECT required_role FROM approvals WHERE status='pending'").map((a) => a.required_role)); expect(roles).toEqual(new Set(['manager', 'owner']));
    const co = row(env, "SELECT * FROM approvals WHERE mission_id=? AND title LIKE '%change order%'", ids.scopeguard);
    expect(co.required_role).toBe('owner');
    await expect(env.engine.decideApproval(env.maya, ids.scopeguard, co.id, 'approved', '')).rejects.toThrow(/workspace owner/);          // a manager is not enough
    await expect(env.engine.decideApproval(env.sam, ids.scopeguard, co.id, 'approved', 'owner sign-off')).resolves.toBeTruthy();
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='approval_approved'", ids.scopeguard)[0].actor).toBe('Sam Rivera');
  });

  it('one person carries work across several domains; a change in one mission never disturbs the others', async () => {
    const env = makeEnv(); const ids = await startAll(env);
    const maya = rows(env, "SELECT DISTINCT m.pack_id FROM work_items w JOIN missions m ON m.id=w.mission_id WHERE w.owner_user_id=? AND w.status!='done' AND w.analysis_rev=m.analysis_rev", env.maya.id).map((r) => r.pack_id);
    expect(maya.length).toBeGreaterThanOrEqual(3);
    const before = rows(env, "SELECT id,status FROM actions WHERE mission_id!=? AND status='proposed'", ids.scopeguard).length;
    await env.engine.submitChange(env.maya, ids.scopeguard, { receivedOn: '2026-11-10', items: [{ title: 'Loyalty programme', kind: 'feature', clarity: 'clear' }] });
    expect(rows(env, "SELECT * FROM actions WHERE mission_id=? AND status='stale'", ids.scopeguard).length).toBe(3);
    expect(rows(env, "SELECT id FROM actions WHERE mission_id!=? AND status='proposed'", ids.scopeguard)).toHaveLength(before);       // untouched
    expect(rows(env, "SELECT * FROM actions WHERE mission_id!=? AND status='stale'", ids.scopeguard)).toHaveLength(0);
  });

  it('a single change fans out across departments and owners; completion waits on every required acknowledgement', async () => {
    const env = makeEnv(); const id = (await startAll(env)).scopeguard;
    const depts = new Set(rows(env, 'SELECT department FROM work_items WHERE mission_id=? AND analysis_rev=?', id, missionRow(env, id).analysis_rev).map((w) => w.department)); expect(depts.size).toBeGreaterThanOrEqual(3);
    expect(new Set(rows(env, "SELECT user_id FROM acknowledgements WHERE mission_id=?", id).map((a) => a.user_id)).size).toBeGreaterThanOrEqual(2);
    const nodeKinds = new Set(rows(env, 'SELECT kind FROM graph_nodes WHERE mission_id=? AND analysis_rev=?', id, missionRow(env, id).analysis_rev).map((n) => n.kind));
    expect(nodeKinds).toEqual(new Set(['change', 'artifact', 'department', 'owner', 'decision', 'task', 'action']));
    await approveAll(env, id); await executeAll(env, id);
    await expect(env.engine.completeMission(env.maya, id)).rejects.toThrow(/acknowledgements/);                       // blocked while any acknowledgement is missing
    const pending = rows(env, "SELECT user_id FROM acknowledgements WHERE mission_id=? AND status='pending'", id); expect(pending.length).toBeGreaterThanOrEqual(1);
    ackAll(env, id); finishReviews(env, id); await env.engine.completeMission(env.maya, id);
    const out = row(env, 'SELECT * FROM outcomes WHERE mission_id=?', id); const done = JSON.parse(out.completed).join('\n'); const open = JSON.parse(out.unresolved).join('\n');
    expect(done).toMatch(/Executed & independently verified: Publish change order/); expect(done).toMatch(/Acknowledged by Ravi Menon/); expect(done).toMatch(/Human answer recorded/);
    expect(open).toMatch(/Outstanding task/);                                                                   // outcome lists BOTH completed and unresolved work
  });

  it('workspace isolation holds with all packs present', async () => {
    const env = makeEnv(); await startAll(env);
    const other = seedWorkspace(env.db, env.packs, { name: 'Other Org', password: 'x-12345678', emailDomain: 'other.example' });
    expect(overview(env.engine, other.workspaceId).missions).toHaveLength(0); expect(rows(env, 'SELECT * FROM agent_roles WHERE workspace_id=?', other.workspaceId).length).toBeGreaterThan(40);
  });
});

describe('shared-engine regression tests (generic behaviours the packs depend on)', () => {
  it('an action can reference a draft produced by an earlier role in the same analysis (PodFlow publisher exports the copy agent’s kit)', async () => {
    const env = makeEnv(); const r = await startPack(env, 'podflow'); const k = row(env, "SELECT key FROM questions WHERE mission_id=? AND key LIKE 'clip_selection_%'", r.id).key; await answer(env, r.id, k, '1');
    const kit = row(env, "SELECT a.*, ar.owner_role FROM actions a JOIN artifacts ar ON ar.id=a.artifact_id WHERE a.mission_id=? AND a.key='export_kit'", r.id); expect(kit.owner_role).toBe('copy');
  });
  it('legacy databases are migrated (outcomes.completed) and existing workspaces gain new packs’ roles and people', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'rmig-')), 'old.db'); let db = new Db(f); const e = makeEnv();
    seedWorkspace(db, e.packs, { name: 'Legacy', password: 'pw-legacy-12' }); db.raw.exec('ALTER TABLE outcomes DROP COLUMN completed'); db.raw.exec("DELETE FROM agent_roles WHERE pack_id IN ('movemate','podflow')"); db.raw.exec("DELETE FROM users WHERE email='cleo@harborvine.example'");
    db = new Db(f); expect((db.raw.prepare('PRAGMA table_info(outcomes)').all() as any[]).map((c) => c.name)).toContain('completed');
    syncDirectory(db, e.packs); expect(db.get("SELECT 1 x FROM users WHERE email='cleo@harborvine.example'")).toBeTruthy();
    expect(db.get("SELECT user_id FROM agent_roles WHERE pack_id='podflow' AND key='human_creator'")!.user_id).toBeTruthy(); expect(db.all("SELECT 1 FROM agent_roles WHERE pack_id='movemate'").length).toBe(6);
    syncDirectory(db, e.packs); expect(db.all("SELECT 1 FROM agent_roles WHERE pack_id='movemate'").length).toBe(6);      // idempotent
  });
  it('every implemented pack declares labels, roles, decisions and a sample that validates against its own schemas', async () => {
    const env = makeEnv(); expect(env.packs.all().map((p) => p.id).sort()).toEqual(['beo-rescue', 'invoiceguard', 'movemate', 'podflow', 'sceneshift', 'scopeguard', 'shiftrelay', 'submitready']);
    for (const p of env.packs.all()) {
      const s = p.sample(); expect(p.planSchema.safeParse(s.plan).success, `${p.id} plan`).toBe(true); expect(p.changeSchema.safeParse(s.change).success, `${p.id} change`).toBe(true);
      expect(p.roleOrder.every((k) => p.roles.some((r) => r.key === k && r.kind === 'agent')), `${p.id} roleOrder`).toBe(true);
      expect(p.rules.every((r) => p.artifacts.some((a) => a.key === r.to)), `${p.id} rule targets`).toBe(true); expect(p.artifactEdges.every((e) => p.artifacts.some((a) => a.key === e.from) && p.artifacts.some((a) => a.key === e.to)), `${p.id} edges`).toBe(true);
      expect(p.decisions.every((d) => d.gates.every((g) => p.artifacts.some((a) => a.key === g))), `${p.id} decisions`).toBe(true); expect(p.roles.filter((r) => r.kind === 'human').length).toBeGreaterThanOrEqual(1);
      if (p.id !== 'beo-rescue' && p.id !== 'sceneshift') expect(p.labels, `${p.id} labels`).toBeTruthy();
    }
  });
  it('human roles of every pack resolve to real workspace users (no orphan owners)', async () => {
    const env = makeEnv(); for (const r of rows(env, "SELECT pack_id,key,user_id FROM agent_roles WHERE workspace_id=? AND kind='human'", env.maya.workspaceId)) expect(r.user_id, `${r.pack_id}/${r.key}`).toBeTruthy();
    expect(actorById(env, row(env, "SELECT user_id FROM agent_roles WHERE pack_id='shiftrelay' AND key='human_supervisor'", ).user_id).role).toBe('manager');
  });
});
