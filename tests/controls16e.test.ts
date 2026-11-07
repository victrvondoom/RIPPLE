import { describe, it, expect } from 'vitest';
import { makeEnv, row, rows, type Env } from './helpers.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { sentinelPack } from '../src/server/packs/sentinel/pack.js';

/** Session 16 (fifth group): interim-then-permanent action pair in the sentinel pack. */

const testEnv = (): Env => makeEnv(new LocalCollab(), extendedRegistry());
async function begin(env: Env) {
  const s = sentinelPack.sample();
  const m = await env.engine.createMission(env.maya, { packId: 'incident-sentinel', title: s.title, plan: s.plan });
  env.engine.approveBaseline(env.maya, m.id, 'test');
  await env.engine.submitChange(env.maya, m.id, s.change);
  return m.id as string;
}

describe('interim-then-permanent (sentinel)', () => {
  it('a recorded TEMPORARY mitigation becomes its own action, and the rollback is blocked until it is verified', async () => {
    const env = testEnv();
    const id = await begin(env);
    const rollback = () => row(env, "SELECT * FROM actions WHERE mission_id=? AND key='act-rollback-k8s' AND status NOT IN ('stale','superseded')", id);
    expect(rollback()).toBeDefined();
    expect(JSON.parse(rollback().payload).blockedUntil).toBeUndefined();
    const q = row(env, "SELECT * FROM questions WHERE mission_id=? AND key='interim_mitigation' AND status='open'", id);
    expect(q).toBeDefined();
    await env.engine.answerQuestion(env.maya, id, q.id, 'switch off the checkout-v2 feature flag');
    const interim = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='act-interim-mitigation' AND status NOT IN ('stale','superseded')", id);
    expect(interim).toBeDefined();
    expect(interim.title).toMatch(/TEMPORARY mitigation \(not a fix\)/);
    expect(JSON.parse(rollback().payload).blockedUntil).toEqual({ actions: ['act-interim-mitigation'] });
    expect(rows(env, "SELECT id FROM actions WHERE mission_id=? AND key='act-interim-mitigation'", id).length).toBeGreaterThan(0);
  });

  it('verifies the interim step only for its TEMPORARY labelling; it never claims the mitigation worked', () => {
    const plan = sentinelPack.sample().plan;
    const good = sentinelPack.verifyAction!({ type: 'interim_mitigation', payload: {} } as any, { content: '# Interim Mitigation (TEMPORARY, not the fix): INC-1\n\nIt is not the permanent fix.' }, plan, undefined as any);
    expect(good.every((c) => c.passed)).toBe(true);
    const bad = sentinelPack.verifyAction!({ type: 'interim_mitigation', payload: {} } as any, { content: 'Switched the flag off.' }, plan, undefined as any);
    expect(bad.some((c) => !c.passed)).toBe(true);
  });
});
