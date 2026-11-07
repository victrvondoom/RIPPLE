import { describe, it, expect } from 'vitest';
import { makeEnv, row, rows, type Env } from './helpers.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { depgatePack, gate, planSchema, changeSchema } from '../src/server/packs/depgate/pack.js';

/** Session 16 (seventh group): deploy gate (new critical CVEs only). */

const sample = () => depgatePack.sample();
const plan = () => planSchema.parse(sample().plan);
const change = () => changeSchema.parse(sample().change);

describe('gate decision (pure)', () => {
  it('blocks a new critical CVE, but only the new ones', () => {
    const g = gate(plan(), change());
    expect(g.verdict).toBe('blocked');
    expect(g.newCritical.map((c) => c.id)).toEqual(['CVE-2026-2044']); // CVE-2026-1001 is high and already deployed
  });

  it('clears when no new critical CVE exists', () => {
    const c = change(); c.candidateCves = c.candidateCves.filter((x) => x.severity !== 'critical');
    expect(gate(plan(), c).verdict).toBe('clear');
  });

  it('is unverified, never clear, when the SBOM or the scan result is missing', () => {
    const noSbom = { ...change(), sbomSupplied: false };
    expect(gate(plan(), noSbom).verdict).toBe('unverified');
    const noScan = { ...change(), scanRecorded: false, candidateCves: [] };
    expect(gate(plan(), noScan).verdict).toBe('unverified');
  });

  it('lets only an explicit owner override through a block', () => {
    expect(gate(plan(), change(), { owner_override: { value: 'yes' } } as any)).toMatchObject({ verdict: 'blocked', overridden: true });
    expect(gate(plan(), change(), { owner_override: { value: 'no' } } as any).overridden).toBe(false);
  });
});

describe('deploy gate mission', () => {
  const testEnv = (): Env => makeEnv(new LocalCollab(), extendedRegistry());

  it('a blocked candidate proposes no deploy; only the release owner can override, and the override proposes a dry-run request', async () => {
    const e = testEnv();
    const s = sample();
    const m = await e.engine.createMission(e.maya, { packId: 'deploy-gate', title: s.title, plan: s.plan });
    e.engine.approveBaseline(e.maya, m.id, 'test');
    await e.engine.submitChange(e.maya, m.id, s.change);
    const q = row(e, "SELECT * FROM questions WHERE mission_id=? AND key='owner_override' AND status='open'", m.id);
    expect(q).toBeDefined();
    expect(rows(e, "SELECT id FROM actions WHERE mission_id=? AND key='act-deploy-candidate' AND status NOT IN ('stale','superseded')", m.id)).toHaveLength(0);
    await expect(e.engine.answerQuestion(e.maya, m.id, q.id, 'yes')).rejects.toThrow();
    await e.engine.answerQuestion(e.actor('sam@harborvine.example'), m.id, q.id, 'yes');
    const deploy = row(e, "SELECT * FROM actions WHERE mission_id=? AND key='act-deploy-candidate' AND status NOT IN ('stale','superseded')", m.id);
    expect(deploy).toBeDefined();
    expect(deploy.type).toBe('deploy_release');
    expect(row(e, "SELECT content FROM artifacts WHERE mission_id=? AND kind='deploy_request'", m.id)?.content ?? '').toMatch(/DRY-RUN: nothing was deployed/);
  });

  it('verifies the stored request only when its labels are present and the gate permits it', () => {
    const stored = '# Dry-run Deploy Request\n\nGate verdict: **blocked, overridden by the release owner**\n\n**DRY-RUN: nothing was deployed.** This gate is not a security certification of the candidate.';
    const ctx = { baselinePlan: plan(), revisedPlan: plan(), change: change(), answers: { owner_override: { value: 'yes' } }, today: '2026-11-07' } as any;
    expect(depgatePack.verifyAction!({ type: 'deploy_release', payload: {} } as any, { content: stored }, plan(), ctx).every((c) => c.passed)).toBe(true);
    const unlabelled = depgatePack.verifyAction!({ type: 'deploy_release', payload: {} } as any, { content: 'Ship it.' }, plan(), ctx);
    expect(unlabelled.some((c) => !c.passed)).toBe(true);
    const noOverride = { ...ctx, answers: {} };
    expect(depgatePack.verifyAction!({ type: 'deploy_release', payload: {} } as any, { content: stored }, plan(), noOverride).find((c) => /re-computed/.test(c.name))?.passed).toBe(false);
  });

  it('completion is settled only by a clear gate or an owner override', () => {
    const ctx = (answers: any) => ({ baselinePlan: plan(), revisedPlan: plan(), change: change(), answers, today: '2026-11-07' } as any);
    expect(depgatePack.completionChecks!(ctx({}))[0].passed).toBe(false);
    expect(depgatePack.completionChecks!(ctx({ owner_override: { value: 'yes' } }))[0].passed).toBe(true);
  });
});
