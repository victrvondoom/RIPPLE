import { describe, it, expect } from 'vitest';
import { parseProbes, twoSided } from '../src/server/capabilities/verify/twosided.js';
import { sentinelPack } from '../src/server/packs/sentinel/pack.js';

/** Session 16 (fourth group): two-sided verification. */

describe('two-sided probes (pure)', () => {
  it('parses both expectation kinds and reports lines it cannot parse instead of guessing', () => {
    const { probes, unparsed } = parseProbes('must-block GET /admin: blocked\nmust-allow GET /checkout: allowed\nlooks fine to me');
    expect(probes).toEqual([
      { name: 'GET /admin', expect: 'must-block', observed: 'blocked' },
      { name: 'GET /checkout', expect: 'must-allow', observed: 'allowed' },
    ]);
    expect(unparsed).toEqual(['looks fine to me']);
  });

  it('passes only when each probe shows the expected side; unknown fails closed', () => {
    const checks = twoSided([
      { name: 'GET /admin', expect: 'must-block', observed: 'allowed' },
      { name: 'GET /checkout', expect: 'must-allow', observed: 'allowed' },
      { name: 'POST /pay', expect: 'must-allow', observed: 'unknown' },
    ]);
    expect(checks.map((c) => c.passed)).toEqual([false, true, false]);
    expect(checks[2].detail).toMatch(/fails closed/);
  });

  it('never passes when nothing was recorded', () => {
    expect(twoSided([])).toEqual([expect.objectContaining({ passed: false })]);
  });
});

describe('two-sided probes in the sentinel pack', () => {
  const plan = sentinelPack.sample().plan;

  it('refuses an answer that is not in probe form, and accepts one that is', () => {
    expect(sentinelPack.parseAnswer!('post_rollback_probes', 'it looks fine', plan)).toMatchObject({ error: expect.stringMatching(/not probe results/) });
    expect(sentinelPack.parseAnswer!('post_rollback_probes', 'must-block GET /admin: blocked', plan)).toEqual({ value: 'must-block GET /admin: blocked' });
  });

  it('adds a completion check only when probes are recorded, and fails it when a must-allow was not served', () => {
    const base = { baselinePlan: plan, revisedPlan: plan, change: {}, answers: {}, today: '2026-11-07' } as any;
    expect(sentinelPack.completionChecks!(base).map((c) => c.key)).not.toContain('two_sided_verified');
    const withProbes = { ...base, answers: { post_rollback_probes: { value: 'must-block GET /admin: blocked\nmust-allow GET /checkout: blocked' } } };
    const check = sentinelPack.completionChecks!(withProbes).find((c) => c.key === 'two_sided_verified');
    expect(check?.passed).toBe(false);
    const ok = { ...base, answers: { post_rollback_probes: { value: 'must-block GET /admin: blocked\nmust-allow GET /checkout: allowed' } } };
    expect(sentinelPack.completionChecks!(ok).find((c) => c.key === 'two_sided_verified')?.passed).toBe(true);
  });
});
