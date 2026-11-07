import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { SwitchConsole } from '../src/server/console/console.js';
import { readWarehouse } from '../src/server/packs/revenue/lab.js';
import { revenuePack, seedOf } from '../src/server/packs/revenue/pack.js';

describe('Revenue Recovery flagship', () => {
  it('sandbox model: drift under-reports, the hotfix + recompute restores the ledger total', () => {
    const s = revenuePack.sample(); const seed = seedOf(s.plan, s.change);
    const before = readWarehouse(seed, []);
    expect(before.pipelineCents).toBeLessThan(before.ledgerCents);
    expect(before.nullUnderMapping).toBeGreaterThan(0);
    const mapped = readWarehouse(seed, [{ key: 'a', op: 'apply_mapping' }]);
    expect(mapped.pipelineCents).toBe(mapped.ledgerCents);
    expect(mapped.viewFresh).toBe(false); // view not recomputed yet: stale snapshot is detected, not hidden
    const done = readWarehouse(seed, [{ key: 'a', op: 'apply_mapping' }, { key: 'b', op: 'recompute' }]);
    expect(done.viewCents).toBe(done.ledgerCents);
    expect(readWarehouse(seed, [{ key: 'b', op: 'recompute' }]).viewCents).toBeLessThan(done.ledgerCents); // order matters
  });

  it('end to end by talking: hypotheses disagree, evidence decides, the lost response is recovered without repeating, mission completes', async () => {
    const env = makeEnv(new LocalCollab(), extendedRegistry());
    const sc = new SwitchConsole(env.engine, null);
    const say = async (t: string) => (await sc.say(env.maya, t)).messages[1] as any;
    const ws = env.maya.workspaceId;

    expect((await say('start demo revenue-recovery')).data.pending).toBeTruthy();
    expect((await say('yes')).body).toMatch(/Started .*REV-2611/);
    const m = env.db.get("SELECT * FROM missions WHERE pack_id='revenue-recovery'")!;
    expect(m.state).toBe('blocked');

    const runs = env.db.all('SELECT role_key, output FROM agent_runs WHERE mission_id=?', m.id).map((r) => ({ role: r.role_key, out: JSON.parse(r.output) }));
    const reviewer = runs.filter((r) => r.role === 'adversarial_reviewer').pop()!.out;
    expect(reviewer.findings.some((f: any) => /DISAGREEMENT/.test(f.text))).toBe(true);
    expect(reviewer.data.accepted).toEqual(['H1']);
    expect(reviewer.data.judged.filter((h: any) => h.verdict === 'refuted').map((h: any) => h.id).sort()).toEqual(['H2', 'H3']);
    const memory = runs.filter((r) => r.role === 'memory_keeper').pop()!.out;
    expect(memory.findings.some((f: any) => /CONTRADICTION: .*DEC-2026-014/.test(f.text))).toBe(true);

    expect((await say('list questions')).body).toMatch(/Choose the remediation/);
    await say('answer 1: hotfix'); expect((await say('yes')).body).toMatch(/Answer recorded/);
    expect(env.engine.mission(ws, m.id).state).toBe('awaiting_approval');

    for (let i = 0; i < 4; i++) { await say('approve 1 because evidence reviewed'); expect((await say('yes')).body).toMatch(/Approved/); }
    const act = (type: string) => env.db.get('SELECT * FROM actions WHERE mission_id=? AND type=? AND analysis_rev=?', m.id, type, env.engine.mission(ws, m.id).analysis_rev)!;
    const run = async (type: string) => {
      const list: string = (await say('list actions')).body;
      const n = list.split('\n').find((l) => l.includes(act(type).title))!.split('.')[0];
      await say(`execute ${n}`); return (await say('yes')).body as string;
    };
    expect(await run('warehouse_apply_mapping')).toMatch(/independently verified/);
    // scripted fault: committed, response lost, read-back unavailable → UNKNOWN (never success, never repeated)
    expect(await run('warehouse_recompute')).toMatch(/Outcome UNKNOWN.*Nothing was repeated/);
    expect(act('warehouse_recompute').status).toBe('execution_unknown');
    expect(env.engine.mission(ws, m.id).state).toBe('recovery_required');
    // recovery: read back first; the effect is found and verified WITHOUT a second write
    expect(await run('warehouse_recompute')).toMatch(/Recovered: .*NOT repeated/);
    const rec = act('warehouse_recompute');
    expect(rec.status).toBe('verified');
    expect(JSON.parse(rec.result).recoveredBy).toBe('read-back');
    const ev = env.db.all('SELECT check_name, passed FROM evidence WHERE action_id=? AND kind=?', rec.id, 'verification');
    expect(ev.find((e) => String(e.check_name).startsWith('business invariant'))!.passed).toBe(1);
    expect(ev.find((e) => e.check_name === 'exactly one effect (idempotency)')!.passed).toBe(1);

    expect(await run('finance_notice')).toMatch(/independently verified/);
    expect(await run('postmortem')).toMatch(/independently verified/);
    await say('complete mission'); expect((await say('yes')).body).toMatch(/Mission completed/);
    expect(env.engine.mission(ws, m.id).state).toBe('completed');
    const causal = env.db.all('SELECT lifecycle_state FROM causal_events WHERE mission_id=?', m.id).map((x) => x.lifecycle_state);
    expect(causal).toEqual(expect.arrayContaining(['EXECUTION_UNKNOWN', 'OBSERVED', 'VERIFIED']));
  });
});
