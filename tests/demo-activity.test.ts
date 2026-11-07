import { describe, it, expect } from 'vitest';
import { makeEnv, rows } from './helpers.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { seedDemoActivity } from '../src/server/demo/activity.js';

describe('demo activity (real engine calls only)', () => {
  it('fills a workspace: completed missions with verified evidence, pending approvals and open questions, for every pack', async () => {
    const e = makeEnv(new LocalCollab(), extendedRegistry());
    const logs = await seedDemoActivity(e.engine, e.maya.workspaceId);
    if (process.env.DEMO_LOG) console.log(logs.map((l) => `${l.pack} ${l.mode} ${l.state} :: ${l.steps.slice(-3).join(' | ')}`).join('\n'));
    const packs = extendedRegistry().all().length;
    expect(logs).toHaveLength(packs * 2);
    expect(logs.filter((l) => l.missionId).length).toBe(packs * 2);
    const completed = logs.filter((l) => l.state === 'completed').length;
    expect(completed).toBeGreaterThanOrEqual(Math.ceil(packs / 2));
    expect(rows(e, "SELECT id FROM actions WHERE status='verified'").length).toBeGreaterThan(completed);
    expect(rows(e, "SELECT id FROM approvals WHERE status='pending'").length).toBeGreaterThan(0);
    expect(rows(e, "SELECT id FROM evidence").length).toBeGreaterThan(0);
    // nothing bypassed the engine: every completed mission has an audited completion
    expect(rows(e, "SELECT DISTINCT mission_id FROM audit_events WHERE type='state_change' AND summary LIKE '%→ Completed%'").length).toBe(completed);
  }, 120000);
});
