import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { seedDemoActivity, nextStep } from '../src/server/demo/activity.js';
import { memoryView } from '../src/server/api/memory.js';

describe('memory graph (built from recorded rows)', () => {
  it('connects people, missions, decisions and actions, and moves to what is typed', async () => {
    const e = makeEnv(new LocalCollab(), extendedRegistry());
    await seedDemoActivity(e.engine, e.maya.workspaceId, { packs: ['package-gate', 'beo-rescue'] });
    const v = memoryView(e.engine, e.maya.workspaceId, null, 'Noor');
    expect(v.matches[0]).toMatchObject({ type: 'person', label: 'Noor Haddad' });
    expect(v.focus).toBe(v.matches[0].id);
    // Noor answered the package question in the demo: the decision is one hop away
    expect(v.edges.some((x) => x.from === v.focus && x.label === 'answered')).toBe(true);
    const mission = v.nodes.find((n) => n.type === 'mission')!;
    const w = memoryView(e.engine, e.maya.workspaceId, mission.id, null);
    expect(w.focus).toBe(mission.id);
    expect(w.nodes.some((n) => n.type === 'workflow' && n.depth === 1)).toBe(true);
    // another workspace sees nothing of this one
    const other = memoryView(e.engine, 'ws_does_not_exist', null, 'Noor');
    expect(other.nodes).toEqual([]);
  }, 60000);

  it('nextStep performs one engine step at a time, as the named person, until nothing is left', async () => {
    const e = makeEnv(new LocalCollab(), extendedRegistry());
    const logs = await seedDemoActivity(e.engine, e.maya.workspaceId, { packs: ['package-gate'], firstStopCopies: true });
    const firstStop = logs.find((l) => l.mode === 'first-stop')!;
    const s1 = await nextStep(e.engine, firstStop.missionId, e.maya.workspaceId);
    expect(s1).toMatchObject({ stage: 'decide', by: 'Noor Haddad' }); // only the security lead may answer
    const stages: string[] = [];
    for (let i = 0; i < 20; i++) { const s = await nextStep(e.engine, firstStop.missionId, e.maya.workspaceId); if (!s) break; stages.push(s.stage); }
    expect(stages.at(-1)).toBe('complete');
    expect(e.db.get('SELECT state FROM missions WHERE id=?', firstStop.missionId)!.state).toBe('completed');
  }, 60000);
});
