import { describe, it, expect } from 'vitest';
import { makeEnv, rows } from './helpers.js';
import { RealityEngine } from '../src/server/reality/rge.js';
import { Arena, CAMPAIGNS, campaignById, evaluate } from '../src/server/reality/arena.js';
import { Lab } from '../src/server/reality/lab.js';
import { createApp } from '../src/server/api/app.js';
import { seedWorkspace } from '../src/server/seed.js';

const setup = () => { const env = makeEnv(); const rge = new RealityEngine(env.engine); return { env, rge, arena: new Arena(rge) }; };
async function one(campaign: string, baseline = 'B4-resolve-full') {
  const s = setup();
  const r = await s.arena.run(s.env.maya, { seed: 'test', campaigns: [campaign], baselines: [baseline] });
  const c: any = r.cases.find((x: any) => !x.counts.replayed);
  const effects = (op: string) => rows(s.env, 'SELECT * FROM lab_effects WHERE workflow_id=? AND op_key=? AND applied=1 ORDER BY seq', c.workflow_id, op);
  return { ...s, r, c, effects, prop: (id: string) => c.evaluation.properties.find((p: any) => p.id === id) };
}

describe('Compound Failure Arena — campaigns under the full layer (B4)', () => {
  it('defines at least six multi-stage campaigns', () => {
    expect(CAMPAIGNS.length).toBeGreaterThanOrEqual(6);
    expect(CAMPAIGNS.filter((c) => c.stages.length >= 2).length).toBeGreaterThanOrEqual(6);
  });

  it('A · Acknowledged Ghost: lost ack + stale reads + redelivery → one payment, same key, not called a failure', async () => {
    const { c, effects, prop } = await one('acknowledged-ghost');
    expect(c.evaluation.verdict).toBe('PASS');
    expect(effects('pay')).toHaveLength(1);
    expect(prop('same_key').pass).toBe(true);
    expect(prop('ghost_not_failure').detail).toMatch(/settled "present"/);
    expect(prop('ghost_not_failure').detail).toMatch(/absent.*absent.*present/); // stale, stale, then visible
    expect(c.evaluation.chain.map((x: any) => x.activated)).toEqual([true, true, true]);
    expect(prop('passport_records_ghost').pass).toBe(true);
  });

  it('B · Approval Rot: amended plan + revoked authority + replayed approval are refused; a fresh approval is required', async () => {
    const { c, effects, prop, env } = await one('approval-rot');
    expect(c.evaluation.verdict).toBe('PASS');
    expect(c.evaluation.harness.find((h: any) => h.step === 'run with rotten approvals').detail).toMatch(/REQUIRES_HUMAN/);
    expect(prop('refusal_reasons').pass).toBe(true);
    expect(effects('payout')).toHaveLength(1);
    const op = rows(env, "SELECT * FROM rw_operations WHERE workflow_id=? AND step_key='payout' AND attempts>0", c.workflow_id)[0];
    const ap = rows(env, 'SELECT * FROM rw_approvals WHERE id IN (SELECT value FROM json_each(?))', op.approval_ids);
    expect(ap.length).toBeGreaterThan(0);
    expect(ap.every((a: any) => /Sam/.test(a.user_name) && a.channel === 'structured')).toBe(true);
  });

  it('C · Split-Brain Chain: partial commit detected, false claim retained, payment never repeated', async () => {
    const { c, effects, prop } = await one('split-brain-chain');
    expect(c.evaluation.verdict).toBe('PASS');
    expect(c.declared.declaredStatus).toBe('RECOVERED');
    expect(prop('claim_retained').pass).toBe(true);
    expect(effects('pay')).toHaveLength(1); expect(effects('book')).toHaveLength(1); expect(effects('notify')).toHaveLength(1);
    expect(effects('book')[0].seq).toBeLessThan(effects('notify')[0].seq);
  });

  it('D · Delayed Truth: unreadable + stale verification reads stay pending (no no-op); verified only once visible', async () => {
    const { c, prop } = await one('delayed-truth');
    expect(c.evaluation.verdict).toBe('PASS');
    expect(c.declared.gapsRaised).toContain('delayed_consistency');
    expect(c.declared.gapsRaised).not.toContain('no_op');
    expect(prop('sequence_recorded').detail).toMatch(/unreadable/);
  });

  it('E · Recovery Basis Collapse: stale plan refused, old approval rejected, re-planned with a fresh approval, no booking', async () => {
    const { c, effects, env } = await one('basis-collapse');
    expect(c.evaluation.verdict).toBe('PASS');
    const h = (s: string) => c.evaluation.harness.find((x: any) => x.step === s);
    expect(h('execute the approved (now stale) plan').ok).toBe(false);
    expect(h('execute the approved (now stale) plan').effectsAfter).toBe(h('execute the approved (now stale) plan').effectsBefore);
    expect(h('execute new plan with the OLD approval').detail).toMatch(/not authorized/i);
    expect(effects('book')).toHaveLength(0);
    expect(effects('pay:compensate')).toHaveLength(1);
    expect(rows(env, 'SELECT status FROM rw_recovery_plans WHERE workflow_id=? ORDER BY created_at, rowid', c.workflow_id).map((p: any) => p.status)).toContain('stale');
  });

  it('F · Poisoned Compensation: refund "succeeds" with no effect → compensation failure, not recovered, passport shows it', async () => {
    const { c, prop, env } = await one('poisoned-compensation');
    expect(c.evaluation.verdict).toBe('PASS');
    expect(c.declared.state).toBe('REQUIRES_HUMAN');
    expect(c.declared.gapsRaised).toContain('compensation_failure');
    const comp = rows(env, "SELECT * FROM rw_operations WHERE workflow_id=? AND kind='compensation'", c.workflow_id)[0];
    expect(comp.state).toBe('FAILED'); // regression: a compensation is verified against its own expected effect
    expect(prop('passport_shows_failed_comp').pass).toBe(true);
  });

  it('G · Lost Hand-off After Restart: completed task deduped, uncompleted task redelivered and run once', async () => {
    const { c, effects, env } = await one('redelivery-after-restart');
    expect(c.evaluation.verdict).toBe('PASS');
    expect(effects('reserve')).toHaveLength(1); expect(effects('invoice')).toHaveLength(1);
    const ho = rows(env, 'SELECT * FROM rw_handoffs WHERE workflow_id=?', c.workflow_id);
    expect(ho.length).toBe(2);
    expect(ho.every((h: any) => h.deliveries >= 2 && h.acked_at)).toBe(true);
  });

  it('H · Verified, Then Drift: re-audit detects the stale completion; a corrective write with a new key restores reality', async () => {
    const { c, effects, prop } = await one('verified-then-drift');
    expect(c.evaluation.verdict).toBe('PASS');
    expect(c.declared.gapsRaised).toContain('stale_completion');
    expect(prop('corrective_key').pass).toBe(true);
    expect(effects('rollback')).toHaveLength(1); expect(effects('rollback:corrective')).toHaveLength(1);
  });
});

describe('Independent evaluator', () => {
  it('rejects an engine-reported success that ground truth contradicts (baseline B1 on the split-brain chain)', async () => {
    const { c, prop } = await one('split-brain-chain', 'B1-single-agent');
    expect(c.declared.declaredStatus).toBe('COMPLETED');
    expect(c.truth.status).toBe('inconsistent');
    expect(prop('claim_matches_truth').pass).toBe(false);
    expect(c.evaluation.verdict).toBe('FAIL');
    expect(c.counts.falseVerified).toBe(1);
  });
  it('re-reads ground truth: tampering with the sandbox after a VERIFIED run flips the verdict', async () => {
    const { c, rge, env } = await one('acknowledged-ghost');
    expect(c.evaluation.verdict).toBe('PASS');
    new Lab(env.db, env.maya.workspaceId, c.workflow_id).external('payments', 'pay-7', { inc: { captured_cents: 60000 } }, 'test:tamper', 'tamper');
    const again = evaluate(rge, campaignById('acknowledged-ghost')!, rge.wf(env.maya.workspaceId, c.workflow_id), c.evaluation.harness);
    expect(again.engine.declaredStatus).toBe('VERIFIED');
    expect(again.evaluation.verdict).toBe('FAIL');
    expect(again.evaluation.properties.find((p: any) => p.id === 'claim_matches_truth')!.pass).toBe(false);
  });
  it('a stale/replayed approval that a weak baseline accepts is scored as accepted', async () => {
    const { c } = await one('approval-rot', 'B1-single-agent');
    expect(c.counts.invalidApprovalAccepted).toBe(1);
    expect(c.evaluation.verdict).toBe('FAIL');
  });
});

describe('Arena runs: ordering, replay, metrics, persistence, export', () => {
  it('reconstructs every fault chain in order, replays deterministically and computes metrics from rows', async () => {
    const { arena, env } = setup();
    const r = await arena.run(env.maya, { seed: 'full', baselines: ['B1-single-agent', 'B4-resolve-full'] });
    const m = r.run.metrics.byBaseline; const b4 = m['B4-resolve-full'];
    expect(b4.temporalOrdering.num).toBe(b4.temporalOrdering.den);
    expect(b4.reproducibility.den).toBe(CAMPAIGNS.length); expect(b4.reproducibility.num).toBe(CAMPAIGNS.length);
    for (const k of ['falseVerified', 'duplicateEffects', 'approvalIntegrity', 'unknownDiscipline']) expect(b4[k].num, k).toBe(0);
    expect(b4.verdictPass.num).toBe(CAMPAIGNS.length);
    expect(m['B1-single-agent'].falseVerified.num).toBeGreaterThan(0);
    expect(m['B1-single-agent'].reproducibility.den).toBe(0);
    expect(m['B1-single-agent'].reproducibility.rate).toBeNull(); // N/A — never shown as a fake percentage
    const row = env.db.get("SELECT declared, truth, evaluation FROM bench_cases WHERE run_id=? AND baseline='B4-resolve-full' LIMIT 1", r.run.id)!;
    expect(JSON.parse(row.declared).declaredStatus).toBeDefined(); expect(JSON.parse(row.truth).status).toBeDefined(); expect(JSON.parse(row.evaluation).verdict).toBeDefined();
    const csv = arena.csv(env.maya.workspaceId, r.run.id).split('\n');
    expect(csv[0]).toMatch(/engine_reported,final_state,ground_truth,evaluator_verdict/);
    expect(csv).toHaveLength(1 + r.cases.length);
    const rr = await arena.run(env.maya, { replayOf: r.run.id });
    const fp = (x: any) => x.cases.filter((k: any) => !k.counts.replayed).map((k: any) => `${k.scenario}|${k.baseline}|${k.evaluation.fingerprint}`).sort();
    expect(fp(rr)).toEqual(fp(r));
    expect(rr.run.seed).toBe(r.run.seed);
  });
  it('does not change the existing RIGOR catalogue', async () => {
    const { SCENARIOS } = await import('../src/server/reality/scenarios.js');
    expect(SCENARIOS.some((s) => s.id.startsWith('arena-'))).toBe(false);
  });
});

describe('Arena HTTP API', () => {
  function client() {
    const env = makeEnv();
    seedWorkspace(env.db, env.packs, { name: 'Rival Co', password: 'pw-test-123', emailDomain: 'rival.example' });
    const app = createApp(env.engine, { webRoot: '/nonexistent' }); let cookie = '';
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { 'content-type': 'application/json', host: 'localhost', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* csv */ }
      return { status: res.status, json, text, res };
    };
    const login = (email: string) => { cookie = ''; return call('POST', '/api/auth/login', { email, password: 'pw-test-123' }); };
    return { env, call, login };
  }
  it('runs, validates, authorizes, exports and isolates tenants', async () => {
    const { call, login } = client();
    await login('luis@harborvine.example');
    expect((await call('POST', '/api/arena/runs', { campaigns: ['acknowledged-ghost'], wait: true })).status).toBe(403);
    await login('vera@harborvine.example');
    expect((await call('POST', '/api/arena/runs', { campaigns: ['acknowledged-ghost'], wait: true })).status).toBe(403);
    await login('maya@harborvine.example');
    expect((await call('POST', '/api/arena/runs', { campaigns: ['no-such-campaign'], wait: true })).status).toBe(422);
    expect((await call('POST', '/api/arena/runs', { campaigns: [123] })).status).toBe(422);
    const r = await call('POST', '/api/arena/runs', { seed: 'api', campaigns: ['acknowledged-ghost', 'basis-collapse'], baselines: ['B4-resolve-full'], wait: true });
    expect(r.status).toBe(201); expect(r.json.cases).toHaveLength(4);
    const lib = await call('GET', '/api/arena/campaigns');
    expect(lib.json.campaigns.find((x: any) => x.id === 'acknowledged-ghost').lastResult.verdict).toBe('PASS');
    const caseId = r.json.cases[0].id;
    const det = await call('GET', `/api/arena/cases/${caseId}`);
    expect(det.json.timeline.some((e: any) => e.kind === 'fault')).toBe(true);
    expect(det.json.timeline.some((e: any) => e.source === 'sandbox effect log (ground truth)')).toBe(true);
    const csv = await call('GET', `/api/arena/runs/${r.json.run.id}/export.csv`);
    expect(csv.res.headers.get('content-type')).toMatch(/text\/csv/); expect(csv.text.split('\n')).toHaveLength(5);
    expect((await call('GET', `/api/arena/runs/${r.json.run.id}/export.json`)).json.cases).toHaveLength(4);
    expect((await call('GET', '/api/rigor/runs')).json.runs).toHaveLength(0); // RIGOR's list stays scenario-only
    await login('maya@rival.example');
    for (const p of [`/api/arena/runs/${r.json.run.id}`, `/api/arena/cases/${caseId}`, `/api/arena/runs/${r.json.run.id}/export.csv`]) expect((await call('GET', p)).status, p).toBe(404);
    expect((await call('GET', '/api/arena/runs')).json.runs).toHaveLength(0);
    expect((await call('GET', '/api/arena/campaigns')).json.campaigns.every((x: any) => x.lastResult === null)).toBe(true);
    expect((await call('POST', '/api/arena/runs', { replayOf: r.json.run.id, wait: true })).status).toBe(404);
  });
});
