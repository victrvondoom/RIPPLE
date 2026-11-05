import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers.js';
import { RealityEngine } from '../src/server/reality/rge.js';
import { Rigor } from '../src/server/reality/benchmark.js';
import { SCENARIOS } from '../src/server/reality/scenarios.js';

const bench = () => { const env = makeEnv(); return { env, rigor: new Rigor(new RealityEngine(env.engine)) }; };

describe('RIGOR benchmark', () => {
  it('covers all ten scenario families with labelled faults', () => {
    expect(new Set(SCENARIOS.map((s) => s.family)).size).toBe(10);
    for (const s of SCENARIOS) for (const f of s.faults) expect(f.label.length).toBeGreaterThan(5);
  });

  it('full run: the full layer (B4) meets the high-risk targets; weaker baselines do not', async () => {
    const { env, rigor } = bench();
    const r = await rigor.run(env.maya, { seed: 'test-seed' });
    expect(r.run.status).toBe('completed');
    expect(r.cases).toHaveLength(SCENARIOS.length * 4);
    const m = r.run.metrics.byBaseline;
    const b4 = m['B4-resolve-full'];
    for (const k of ['falseSuccess', 'duplicateSideEffects', 'unauthorizedMutation', 'approvalBypass', 'staleEvidenceAcceptance']) {
      expect(b4[k].num, k).toBe(0); expect(b4[k].den, k).toBeGreaterThan(0);
    }
    expect(b4.partialCommitDetection.num).toBe(b4.partialCommitDetection.den);
    // weaker baselines really fail (same scenarios, same runner, only controls differ)
    expect(m['B1-single-agent'].falseSuccess.num).toBeGreaterThan(0);
    expect(m['B1-single-agent'].duplicateSideEffects.num).toBeGreaterThan(0);
    expect(m['B1-single-agent'].unauthorizedMutation.num).toBeGreaterThan(0);
    expect(m['B2-handoffs-no-reconciliation'].approvalBypass.num).toBeGreaterThan(0);
    expect(m['B3-approval-no-verification'].falseSuccess.num).toBeGreaterThan(0);
    // honest failure is reported, not hidden: the failed-compensation scenario does not recover
    const inv: any = r.cases.find((c: any) => c.scenario === 'invoice-compensation-fails' && c.baseline === 'B4-resolve-full');
    expect(inv.declared.status).toBe('REQUIRES_HUMAN'); expect(inv.truth.status).toBe('inconsistent');
    expect(b4.recoverySuccess.num).toBeLessThan(b4.recoverySuccess.den);
  });

  it('is reproducible: the same seed gives identical per-case counts', async () => {
    const a = bench(); const b = bench();
    const pick = ['split-brain', 'lost-response-order', 'availability-unknown'];
    const ra = await a.rigor.run(a.env.maya, { seed: 'repro', scenarios: pick });
    const rb = await b.rigor.run(b.env.maya, { seed: 'repro', scenarios: pick });
    const key = (r: any) => r.cases.map((c: any) => `${c.scenario}|${c.baseline}|${JSON.stringify({ ...c.counts, recoveryMs: null })}|${c.declared.status}|${c.truth.status}`).sort();
    expect(key(ra)).toEqual(key(rb));
  });

  it('metrics are computed from the stored case rows (not hardcoded)', async () => {
    const { env, rigor } = bench();
    const r = await rigor.run(env.maya, { seed: 'rows', scenarios: ['duplicate-webhook'], baselines: ['B1-single-agent'] });
    expect(rigor.metrics(env.maya.workspaceId, r.run.id).byBaseline['B1-single-agent'].duplicateSideEffects.num).toBe(1);
    env.db.exec("UPDATE bench_cases SET counts=json_set(counts, '$.duplicates', 0) WHERE run_id=?", r.run.id);
    expect(rigor.metrics(env.maya.workspaceId, r.run.id).byBaseline['B1-single-agent'].duplicateSideEffects.num).toBe(0);
  });

  it('exports CSV with one row per case and raw counts', async () => {
    const { env, rigor } = bench();
    const r = await rigor.run(env.maya, { seed: 'csv', scenarios: ['split-brain'] });
    const csv = rigor.csv(env.maya.workspaceId, r.run.id).split('\n');
    expect(csv[0]).toMatch(/^run_id,seed,code_version,scenario/);
    expect(csv).toHaveLength(1 + 4);
  });
});
