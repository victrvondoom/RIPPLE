import { describe, it, expect } from 'vitest';
import { makeEnv, row, rows } from './helpers.js';
import { CrossDomainEngine } from '../src/server/reality/crossdomain/engine.js';
import { CrossDomainBench } from '../src/server/reality/crossdomain/bench.js';
import { evaluate, evaluateAll, type EvalCtx } from '../src/server/reality/crossdomain/invariants.js';
import { CD_PACKS } from '../src/server/reality/crossdomain/packs.js';
import { CD_SCENARIOS } from '../src/server/reality/crossdomain/scenarios.js';
import type { InvariantDef, InvariantSpec } from '../src/server/reality/crossdomain/types.js';
import { RealityEngine } from '../src/server/reality/rge.js';
import { EngineError } from '../src/server/engine/types.js';

// ------------------------------------------------------------------ helpers
const def = (spec: InvariantSpec, o: Partial<InvariantDef> = {}): InvariantDef => ({ key: 'k', name: 'n', explanation: 'e', scope: 'cross-domain', spec, severity: 'high', impact: 'i', resolutionPolicy: 'p', approvalLevel: 'manager', strength: 'hard', autoRestorable: false, provenance: { source: 'policy', by: 'test' }, ...o });
const ctx = (world: Record<string, any>, o: Partial<EvalCtx> = {}): EvalCtx => ({
  read: (k) => world[k], commitments: [], touching: () => [], isActive: () => true, opStatus: () => undefined, opSeq: () => undefined, declaredComplete: () => false,
  authority: () => ({ ok: true, detail: 'ok' }), freshness: () => undefined, claims: () => [], packEvaluator: (p, n) => CD_PACKS.find((x) => x.id === p)?.evaluators?.[n], ...o,
});
const R = (s: string, r: string) => ({ system: s, resource: r });
const setup = () => { const env = makeEnv(); return { env, cd: new CrossDomainEngine(env.engine), ws: env.maya.workspaceId }; };
const effects = (env: any, cid: string) => rows(env, 'SELECT * FROM lab_effects WHERE workflow_id=? ORDER BY seq', cid);
const truth = (env: any, cid: string, ref: string) => JSON.parse(row(env, 'SELECT state FROM lab_resources WHERE workflow_id=? AND system=? AND resource=?', cid, ref.split('/')[0], ref.split('/')[1]).state);
async function resolveRecommended(cd: CrossDomainEngine, env: any, cid: string, approver = env.maya) {
  const d: any = cd.detail(env.maya.workspaceId, cid); const plan = d.plans[d.plans.length - 1];
  cd.choose(env.maya, cid, plan.recommended); cd.approveResolution(approver, cid);
  return cd.resolve(env.maya, cid);
}

// ------------------------------------------------------------------ 1. every invariant type (typed evaluator, no eval)
describe('CDII typed invariant evaluator', () => {
  it('uniqueness: one observed holder plus a planned claim by someone else is a collision; unreadable is unknown', () => {
    const d = def({ type: 'uniqueness', ref: R('inventory', 'u'), holderField: 'holder' });
    expect(evaluate(d, ctx({ 'inventory/u': { holder: 'a' } })).result).toBe('satisfied');
    expect(evaluate(d, ctx({ 'inventory/u': { holder: 'a' } }, { commitments: [{ workflow: 'b', op: 'x', ref: 'inventory/u', kind: 'reserve', amount: 1, holder: 'b' }] })).result).toBe('violated');
    expect(evaluate(d, ctx({ 'inventory/u': { holder: 'a' } }, { commitments: [{ workflow: 'a', op: 'r', ref: 'inventory/u', kind: 'release', amount: 1, holder: 'a' }, { workflow: 'b', op: 'x', ref: 'inventory/u', kind: 'reserve', amount: 1, holder: 'b' }] })).result).toBe('satisfied');
    expect(evaluate(d, ctx({})).result).toBe('unknown');
  });
  it('capacity and budget: individually within, collectively over', () => {
    const cap = def({ type: 'capacity', ref: R('bookings', 'h'), capacityField: 'capacity', usedField: 'used' });
    const w = { 'bookings/h': { capacity: 120, used: 0 } };
    const a = { workflow: 'a', op: '1', ref: 'bookings/h', kind: 'reserve' as const, amount: 80 }; const b = { workflow: 'b', op: '1', ref: 'bookings/h', kind: 'reserve' as const, amount: 60 };
    expect(evaluate(cap, ctx(w, { commitments: [a] })).result).toBe('satisfied');
    expect(evaluate(cap, ctx(w, { commitments: [b] })).result).toBe('satisfied');
    expect(evaluate(cap, ctx(w, { commitments: [a, b] })).result).toBe('violated');
    const bud = def({ type: 'budget', ref: R('budget', 'q4'), limitField: 'limit_cents', spentField: 'spent_cents' });
    const bw = { 'budget/q4': { limit_cents: 5000, spent_cents: 2000 } };
    expect(evaluate(bud, ctx(bw, { commitments: [{ workflow: 'a', op: '1', ref: 'budget/q4', kind: 'spend', amount: 2500 }] })).result).toBe('satisfied');
    expect(evaluate(bud, ctx(bw, { commitments: [{ workflow: 'a', op: '1', ref: 'budget/q4', kind: 'spend', amount: 2500 }, { workflow: 'b', op: '1', ref: 'budget/q4', kind: 'spend', amount: 1000 }] })).result).toBe('violated');
  });
  it('authorization, temporal ordering, freshness, completeness and provenance read recorded state, not claims', () => {
    expect(evaluate(def({ type: 'authorization', workflow: 'w', role: 'manager' }), ctx({}, { authority: () => ({ ok: false, detail: 'expired' }) })).result).toBe('violated');
    const tor = def({ type: 'temporal_order', before: { workflow: 'a', op: 'x' }, after: { workflow: 'b', op: 'y' } });
    expect(evaluate(tor, ctx({}, { opStatus: (w) => (w === 'b' ? 'verified' : 'pending') })).result).toBe('violated');
    expect(evaluate(tor, ctx({}, { opStatus: () => 'verified', opSeq: (w) => (w === 'a' ? 1 : 2) })).result).toBe('satisfied');
    expect(evaluate(tor, ctx({}, { opStatus: () => 'verified', opSeq: (w) => (w === 'a' ? 3 : 2) })).result).toBe('violated');
    const fr = def({ type: 'freshness', workflow: 'w', ref: R('s', 'r') });
    expect(evaluate(fr, ctx({}, { freshness: () => ({ basisHash: 'aa', currentHash: 'aa', readable: true }) })).result).toBe('satisfied');
    expect(evaluate(fr, ctx({}, { freshness: () => ({ basisHash: 'aa', currentHash: 'bb', readable: true }) })).result).toBe('violated');
    expect(evaluate(fr, ctx({}, { freshness: () => ({ basisHash: 'aa', currentHash: null, readable: false }) })).result).toBe('unknown');
    const cpl = def({ type: 'completeness', workflow: 'w', ops: ['a', 'b'] });
    expect(evaluate(cpl, ctx({}, { opStatus: () => 'verified' })).result).toBe('satisfied');
    expect(evaluate(cpl, ctx({}, { opStatus: (_w, o) => (o === 'a' ? 'verified' : 'failed') })).result).toBe('violated');
    expect(evaluate(cpl, ctx({}, { opStatus: (_w, o) => (o === 'a' ? 'verified' : 'pending'), declaredComplete: () => true })).result).toBe('violated');
    expect(evaluate(def({ type: 'provenance', workflow: 'w' }), ctx({}, { claims: () => [{ op: 'a', evidence: 'ob_1' }, { op: 'b', evidence: null }] })).result).toBe('violated');
  });
  it('consistency (implies and pointer), lineage and mutual exclusion', () => {
    const imp = def({ type: 'consistency', rule: 'implies', if: { ...R('payments', 'p'), field: 'status', equals: 'captured' }, then: { ...R('shipping', 's'), field: 'status', equals: 'shipped' } });
    expect(evaluate(imp, ctx({ 'payments/p': { status: 'captured' }, 'shipping/s': { status: 'none' } })).result).toBe('violated');
    expect(evaluate(imp, ctx({ 'payments/p': { status: 'refunded' }, 'shipping/s': { status: 'none' } })).result).toBe('satisfied');
    const ptr = def({ type: 'consistency', rule: 'pointer', if: { ...R('payments', 'd'), field: 'status', equals: 'captured' }, pointer: { ...R('payments', 'd'), field: 'for' }, targetSystem: 'inventory', targetField: 'holder', equals: 'wedding' });
    expect(evaluate(ptr, ctx({ 'payments/d': { status: 'captured', for: 'suite-301' }, 'inventory/suite-301': { holder: 'retreat' } })).result).toBe('violated');
    expect(evaluate(ptr, ctx({ 'payments/d': { status: 'captured', for: 'suite-305' }, 'inventory/suite-305': { holder: 'wedding' } })).result).toBe('satisfied');
    const lin = def({ type: 'lineage', upstream: R('warehouse', 'c'), compatField: 'compatible_with', downstream: R('analytics', 'd'), expectsField: 'expects_schema' });
    expect(evaluate(lin, ctx({ 'warehouse/c': { compatible_with: ['v2'] }, 'analytics/d': { expects_schema: 'v1' } })).result).toBe('violated');
    expect(evaluate(lin, ctx({ 'warehouse/c': { compatible_with: ['v1', 'v2'] }, 'analytics/d': { expects_schema: 'v1' } })).result).toBe('satisfied');
    const mx = def({ type: 'mutual_exclusion', ref: R('scheduling', 'cal'), slotsField: 'slots' });
    expect(evaluate(mx, ctx({ 'scheduling/cal': { slots: [{ holder: 'a', start: 0, end: 60 }] } }, { commitments: [{ workflow: 'b', op: 'x', ref: 'scheduling/cal', kind: 'schedule', amount: 0, holder: 'b', window: [30, 90] }] })).result).toBe('violated');
    expect(evaluate(mx, ctx({ 'scheduling/cal': { slots: [{ holder: 'a', start: 0, end: 60 }] } }, { commitments: [{ workflow: 'b', op: 'x', ref: 'scheduling/cal', kind: 'schedule', amount: 0, holder: 'b', window: [60, 90] }] })).result).toBe('satisfied');
  });
  it('recovery safety compares against the state before the plan; pack evaluators are typed functions, unknown when missing', () => {
    const base = def({ type: 'uniqueness', ref: R('inventory', 'u'), holderField: 'holder' }, { key: 'u' });
    const rs = def({ type: 'recovery_safety', protects: ['u'] }, { key: 'rs' });
    const after = evaluateAll([base, rs], ctx({ 'inventory/u': { holder: 'a' } }, { commitments: [{ workflow: 'b', op: 'x', ref: 'inventory/u', kind: 'reserve', amount: 1, holder: 'b' }], before: new Map([['u', 'satisfied']]) }));
    expect(after.get('rs')!.result).toBe('violated');
    expect(evaluateAll([base, rs], ctx({ 'inventory/u': { holder: 'a' } })).get('rs')!.result).toBe('not_applicable');
    const health = def({ type: 'pack', pack: 'release', evaluator: 'health_ok', params: { ref: 'health/x', max: 0.02 }, reads: [R('health', 'x')] });
    expect(evaluate(health, ctx({ 'health/x': { error_rate: 0.001 } })).result).toBe('satisfied');
    expect(evaluate(health, ctx({ 'health/x': { error_rate: 0.5 } })).result).toBe('violated');
    expect(evaluate(def({ type: 'pack', pack: 'release', evaluator: 'does_not_exist', params: {}, reads: [] }), ctx({})).result).toBe('unknown');
  });
});

// ------------------------------------------------------------------ 2. scenario 1: booking × payment × inventory
describe('CDII scenario 1 — locally valid, globally unsafe', () => {
  it('every workflow is valid on its own evidence; the combination is blocked with evidence-backed findings A, B, F, G, H, I, J', async () => {
    const { env, cd, ws } = setup();
    const c = await cd.create(env.maya, 'cd-booking-payment-inventory');
    let d: any = cd.detail(ws, c.id);
    expect(d.workflows.map((w: any) => w.local.valid)).toEqual([true, true, true]);
    d = await cd.analyze(env.maya, c.id);
    expect(d.campaign.state).toBe('CONFLICTED');
    const patterns = new Set(d.findings.map((f: any) => f.pattern));
    for (const p of ['resource_collision', 'constraint_collision', 'split_authority', 'cross_domain_partial_commit', 'hidden_shared_constraint', 'contradictory_declarations', 'temporal_evidence_invalidation']) expect(patterns.has(p)).toBe(true);
    // every finding is backed by persisted independent observations
    for (const f of d.findings) { expect(f.evidence.length).toBeGreaterThan(0); for (const e of f.evidence) expect(row(env, 'SELECT id FROM rw_observations WHERE id=? AND workspace_id=?', e, ws)).toBeTruthy(); expect(f.hypothesis).toBe(false); }
    const b = d.findings.find((f: any) => f.pattern === 'constraint_collision');
    expect(b.explanation).toMatch(/within the limit on its own/);
    // the wedding's evidence was taken before the retreat held the suite → its planning read is invalidated
    const wed = d.workflows.find((w: any) => w.key === 'wedding');
    expect(row(env, 'SELECT invalidated_reason FROM rw_observations WHERE id=?', wed.basis['inventory/suite-301'].planObs).invalidated_reason).toMatch(/superseded|changed/);
  });

  it('the intersection gate refuses unsafe continuation: nothing is written', async () => {
    const { env, cd, ws } = setup();
    const c = await cd.create(env.maya, 'cd-booking-payment-inventory');
    const before = effects(env, c.id).length;
    await expect(cd.executeWorkflow(env.maya, c.id, 'wedding')).rejects.toMatchObject({ status: 409, code: 'intersection_blocked' });
    expect(effects(env, c.id).length).toBe(before);
    expect(truth(env, c.id, 'inventory/suite-301').holder).toBe('retreat');
    expect(rows(env, "SELECT * FROM audit_events WHERE workspace_id=? AND type='cdii_gate_refused'", ws).length).toBe(1);
  });

  it('arbitration rejects hard violators even for an owner, recommends a repair, and the verified result holds in ground truth', async () => {
    const { env, cd, ws } = setup();
    const c = await cd.create(env.maya, 'cd-booking-payment-inventory');
    await cd.analyze(env.maya, c.id);
    let d: any = cd.arbitrate(env.maya, c.id);
    const plan = d.plans[d.plans.length - 1];
    const proceed = plan.options.find((o: any) => o.id === 'proceed');
    expect(proceed.status).toBe('rejected');
    expect(proceed.violated.map((v: any) => v.key)).toEqual(expect.arrayContaining(['uniq-suite-301', 'cap-grand-hall', 'deposit-points-to-held-unit']));
    expect(() => cd.choose(env.sam, c.id, 'proceed')).toThrow(/hard constraints/);
    const rec = plan.options.find((o: any) => o.id === plan.recommended);
    expect(rec.status).toBe('feasible'); expect(rec.kind).toBe('repair');
    expect(plan.objections.length).toBeGreaterThan(0);
    cd.choose(env.maya, c.id, rec.id);
    expect(() => cd.approveResolution(env.luis, c.id)).toThrow(/manager or owner/);
    await expect(cd.resolve(env.maya, c.id)).rejects.toMatchObject({ code: 'authorization_required' });
    cd.approveResolution(env.maya, c.id);
    const r = await cd.resolve(env.maya, c.id);
    expect(r.outcome).toBe('verified');
    d = cd.detail(ws, c.id);
    expect(d.campaign.state).toBe('RESOLVED');
    // ground truth (sandbox), not the engine's claim
    expect(truth(env, c.id, 'inventory/suite-301').holder).toBe('retreat');
    expect(truth(env, c.id, 'inventory/suite-305').holder).toBe('wedding');
    expect(truth(env, c.id, 'inventory/av-kit-4').holder).toBe('wedding');
    expect(truth(env, c.id, 'bookings/grand-hall').used).toBe(80);
    expect(truth(env, c.id, 'bookings/terrace').used).toBe(60);
    expect(truth(env, c.id, 'payments/dep-wedding')).toMatchObject({ status: 'captured', captured_cents: 240000, for: 'suite-305' });
    // each consequential effect exactly once; idempotency keys bound to the approved plan hash
    const applied = effects(env, c.id).filter((e: any) => e.applied);
    const keys = applied.map((e: any) => e.op_key); expect(new Set(keys).size).toBe(keys.length);
    const wOps = d.workflows.find((w: any) => w.key === 'wedding').operations;
    for (const o of wOps) { expect(o.status).toBe('verified'); expect(o.planHash).toBe(rec.hash); expect(o.idempotencyKey).toContain(rec.hash.slice(0, 12)); }
    expect(d.invariants.filter((i: any) => ['hard', 'conditional'].includes(i.strength)).every((i: any) => ['satisfied', 'not_applicable'].includes(i.result))).toBe(true);
  });
});

// ------------------------------------------------------------------ 3. scenario 2: deployment × lineage × analytics
describe('CDII scenario 2 — dependency invalidation and recovery collateral damage', () => {
  it('rejects the roll-back (it would break the backfill), executes expand/contract and verifies downstream consumers', async () => {
    const { env, cd, ws } = setup();
    const c = await cd.create(env.maya, 'cd-deploy-lineage-analytics');
    let d: any = await cd.analyze(env.maya, c.id);
    expect(d.findings.some((f: any) => f.pattern === 'dependency_invalidation' && f.blocks)).toBe(true);
    expect(d.findings.some((f: any) => f.pattern === 'temporal_evidence_invalidation' && f.workflows.includes('revenue-dashboard'))).toBe(true);
    d = cd.arbitrate(env.maya, c.id);
    const plan = d.plans[d.plans.length - 1];
    const rollback = plan.options.find((o: any) => o.kind === 'recovery');
    expect(rollback.status).toBe('rejected');
    expect(rollback.violated.map((v: any) => v.key)).toContain('lineage-backfill');
    const e = d.findings.find((f: any) => f.pattern === 'recovery_collateral' && f.title.includes('roll back'));
    expect(e).toBeTruthy(); expect(e.workflows).toContain('backfill');
    const r = await resolveRecommended(cd, env, c.id);
    expect(r.outcome).toBe('verified');
    expect(truth(env, c.id, 'warehouse/orders-contract').compatible_with).toEqual(['orders.v1', 'orders.v2']);
    expect(truth(env, c.id, 'deploy/orders-api').serves).toEqual(['orders.v2']);
    expect(truth(env, c.id, 'analytics/revenue-dashboard').status).toBe('refreshed');
    // the rejected roll-back never ran: no compensating write exists
    expect(effects(env, c.id).some((x: any) => String(x.op_key).endsWith(':compensate'))).toBe(false);
    expect((cd.detail(ws, c.id).findings as any[]).find((f: any) => f.id === e.id).status).toBe('resolved');
  });
});

// ------------------------------------------------------------------ 4. scenario 3: budget × procurement × scheduling
describe('CDII scenario 3 — hidden shared budget and calendar', () => {
  it('needs an owner, finds the hidden constraint, and re-checks it after execution', async () => {
    const { env, cd, ws } = setup();
    const c = await cd.create(env.maya, 'cd-budget-procurement-scheduling');
    let d: any = await cd.analyze(env.maya, c.id);
    expect(d.findings.filter((f: any) => f.pattern === 'hidden_shared_constraint').length).toBe(3);
    expect(d.findings.some((f: any) => f.pattern === 'temporal_collision')).toBe(true);
    d = cd.arbitrate(env.maya, c.id);
    const plan = d.plans[d.plans.length - 1]; const rec = plan.options.find((o: any) => o.id === plan.recommended);
    expect(rec.approvalLevel).toBe('owner');
    cd.choose(env.maya, c.id, rec.id);
    expect(() => cd.approveResolution(env.maya, c.id)).toThrow(/workspace owner/);
    cd.approveResolution(env.sam, c.id);
    const r = await cd.resolve(env.maya, c.id);
    expect(r.outcome).toBe('verified');
    const q4 = truth(env, c.id, 'budget/ops-q4'); expect(q4.spent_cents).toBeLessThanOrEqual(q4.limit_cents);
    const slots = truth(env, c.id, 'scheduling/crew-lead').slots as any[];
    expect(slots).toHaveLength(2);
    expect(slots[0].end <= slots[1].start || slots[1].end <= slots[0].start).toBe(true);
    expect((cd.detail(ws, c.id).invariants as any[]).find((i: any) => i.key === 'budget-ops-q4').result).toBe('satisfied');
  });
});

// ------------------------------------------------------------------ 5. scenario 4: recovery × concurrent workflow
describe('CDII scenario 4 — stale approval after a concurrent change', () => {
  it('invalidates the old basis, rejects the stale approval, re-plans and protects the other workflow', async () => {
    const { env, cd, ws } = setup();
    const c = await cd.create(env.maya, 'cd-recovery-concurrent');
    await cd.analyze(env.maya, c.id);
    let d: any = cd.arbitrate(env.maya, c.id);
    const first = d.plans[d.plans.length - 1];
    expect(first.recommended).toBe('proceed'); // the failed workflow's own compensation is safe at this moment
    cd.choose(env.maya, c.id, 'proceed'); cd.approveResolution(env.maya, c.id);
    const firstApproval = row(env, "SELECT * FROM rw_approvals WHERE workflow_id=? AND subject='resolution' ORDER BY rowid DESC", c.id);
    const r1 = await cd.resolve(env.maya, c.id);
    expect(r1.outcome).toBe('replanned');
    expect(r1.drift).toEqual(expect.arrayContaining(['inventory/unit-9']));
    expect(row(env, 'SELECT status, invalid_reason FROM rw_approvals WHERE id=?', firstApproval.id)).toMatchObject({ status: 'invalidated' });
    // the old compensation was NOT executed
    expect(effects(env, c.id).some((e: any) => e.op_key === 'order-41:c1')).toBe(false);
    d = cd.detail(ws, c.id);
    const second = d.plans[d.plans.length - 1];
    expect(second.id).not.toBe(first.id);
    const old = second.options.find((o: any) => o.id === 'proceed');
    expect(old.status).toBe('rejected'); expect(old.violated.map((v: any) => v.key)).toContain('exchange-holds-unit');
    expect(d.findings.some((f: any) => f.pattern === 'recovery_collateral' && f.workflows.includes('exchange-77'))).toBe(true);
    // a fresh approval is required for the re-made plan
    cd.choose(env.maya, c.id, second.recommended);
    await expect(cd.resolve(env.maya, c.id)).rejects.toMatchObject({ code: 'authorization_required' });
    cd.approveResolution(env.maya, c.id);
    const r2 = await cd.resolve(env.maya, c.id);
    expect(r2.outcome).toBe('verified');
    expect(truth(env, c.id, 'inventory/unit-9').holder).toBe('order-77');
    expect(truth(env, c.id, 'orders/order-77').status).toBe('allocated');
    expect(truth(env, c.id, 'payments/pay-41')).toMatchObject({ status: 'refunded', captured_cents: 0, refunded_cents: 48000 });
    expect(effects(env, c.id).filter((e: any) => e.applied && e.op_key === 'order-41:c2').length).toBe(1);
    d = cd.detail(ws, c.id);
    expect(d.workflows.map((w: any) => w.state)).toEqual(['RECOVERED', 'VERIFIED']);
  });
});

// ------------------------------------------------------------------ 6. control and unknown
describe('CDII control and unknown-state discipline', () => {
  it('raises nothing for workflows that genuinely do not intersect, and lets both run through the gate', async () => {
    const { env, cd, ws } = setup();
    const c = await cd.create(env.maya, 'cd-control-independent');
    const d: any = await cd.analyze(env.maya, c.id);
    expect(d.findings).toHaveLength(0); expect(d.campaign.state).toBe('CONSISTENT');
    await cd.executeWorkflow(env.maya, c.id, 'search-release'); await cd.executeWorkflow(env.maya, c.id, 'gala');
    expect(cd.detail(ws, c.id).workflows.map((w: any) => w.state)).toEqual(['VERIFIED', 'VERIFIED']);
    expect(truth(env, c.id, 'inventory/suite-410').holder).toBe('gala');
  });
  it('treats an unreadable ledger as unknown, never as within budget: nothing feasible, escalation, no spend', async () => {
    const { env, cd } = setup();
    const c = await cd.create(env.maya, 'cd-unknown-ledger');
    let d: any = await cd.analyze(env.maya, c.id);
    expect(d.findings.some((f: any) => f.pattern === 'unknown_state' && f.status === 'unknown' && f.blocks)).toBe(true);
    await expect(cd.executeWorkflow(env.maya, c.id, 'monitors')).rejects.toMatchObject({ code: 'intersection_blocked' });
    d = cd.arbitrate(env.maya, c.id);
    const plan = d.plans[d.plans.length - 1];
    expect(plan.options.filter((o: any) => o.status === 'feasible')).toHaveLength(0);
    expect(plan.recommended).toBe('escalate');
    d = cd.choose(env.maya, c.id, 'escalate');
    expect(d.campaign.state).toBe('REQUIRES_HUMAN');
    expect(effects(env, c.id).filter((e: any) => e.system === 'budget' && e.applied && String(e.actor).startsWith('exec.')).length).toBe(0);
    expect(truth(env, c.id, 'budget/ops-q4').spent_cents).toBe(1_000_000);
  });
});

// ------------------------------------------------------------------ 7. graph provenance, passport integrity, replay, isolation
describe('CDII graph, passports, replay and isolation', () => {
  it('every graph edge has provenance and a causal-ledger source event in the same workspace; graph drives impact', async () => {
    const { env, cd, ws } = setup();
    const c = await cd.create(env.maya, 'cd-booking-payment-inventory');
    await cd.analyze(env.maya, c.id);
    const g = cd.graph(ws, c.id);
    expect(g.edges.length).toBeGreaterThan(40);
    for (const e of g.edges) { expect(e.provenance.source).toBeTruthy(); expect(row(env, 'SELECT id FROM causal_events WHERE id=? AND workspace_id=?', e.causal_id, ws)).toBeTruthy(); }
    const rels = new Set(g.edges.map((e: any) => e.rel));
    for (const r of ['depends_on', 'consumes', 'reserves', 'conflicts_with', 'governed_by', 'derived_from', 'invalidates', 'requires', 'temporally_precedes', 'shares_constraint_with']) expect(rels.has(r)).toBe(true);
    const imp = cd.impact(ws, c.id, 'res:inventory/suite-301');
    expect(imp.workflows).toEqual(expect.arrayContaining(['retreat', 'wedding']));
    expect(imp.invariants).toContain('uniq-suite-301');
    expect(imp.evidence.some((e: any) => e.wouldBeInvalidated)).toBe(true);
    // evidence chain for a finding answers what / which system / when / workflow / invariant / freshness
    const f: any = cd.detail(ws, c.id).findings.find((x: any) => x.pattern === 'resource_collision');
    const chain = cd.evidenceChain(ws, c.id, f.id).chain[0] as any;
    expect(chain).toMatchObject({ system: 'inventory', resource: 'suite-301' });
    expect(chain.observer).toBeTruthy(); expect(chain.at).toBeTruthy(); expect(chain.invariants.length).toBeGreaterThan(0);
  });
  it('passport hash proves body integrity (tampering detected) and reuses the RGE verification', async () => {
    const { env, cd, ws } = setup();
    const c = await cd.create(env.maya, 'cd-control-independent');
    const out: any = cd.passportNow(env.maya, c.id);
    const rge = new RealityEngine(env.engine);
    expect(rge.verifyPassport(ws, out.passportId).intact).toBe(true);
    const p = cd.passport(ws, c.id, out.passportId);
    expect(p.body.integrityNote).toMatch(/does NOT prove/);
    expect(p.body.invariants.every((i: any) => Array.isArray(i.evidence))).toBe(true);
    env.db.exec("UPDATE rw_passports SET body=replace(body, 'CONSISTENT', 'TAMPERED') WHERE id=?", out.passportId);
    expect(rge.verifyPassport(ws, out.passportId).intact).toBe(false);
  });
  it('replays deterministically: same scenario → same findings and the same recommended plan', async () => {
    const run = async () => { const { env, cd } = setup(); const c = await cd.create(env.maya, 'cd-booking-payment-inventory'); await cd.analyze(env.maya, c.id); const d: any = cd.arbitrate(env.maya, c.id); const p = d.plans[d.plans.length - 1]; const rec = p.options.find((o: any) => o.id === p.recommended); return { keys: d.findings.map((f: any) => f.finding_key).sort(), rec: p.recommended, actions: JSON.stringify(rec.actions), statuses: p.options.map((o: any) => `${o.id}:${o.status}`) }; };
    const a = await run(); const b = await run();
    expect(b).toEqual(a);
  });
  it('isolates workspaces: another workspace cannot read or act on a campaign', async () => {
    const { env, cd } = setup();
    const { seedWorkspace } = await import('../src/server/seed.js');
    seedWorkspace(env.db, env.packs, { name: 'Rival', password: 'pw-test-123', emailDomain: 'rival.example' });
    const u = env.db.get("SELECT * FROM users WHERE email='maya@rival.example'")!;
    const rival = { id: u.id, name: u.name, role: u.role, workspaceId: u.workspace_id };
    const c = await cd.create(env.maya, 'cd-control-independent');
    expect(() => cd.detail(rival.workspaceId, c.id)).toThrow(EngineError);
    expect(() => cd.graph(rival.workspaceId, c.id)).toThrow(/not found/);
    await expect(cd.analyze(rival as any, c.id)).rejects.toThrow(/not found/);
    expect(cd.inbox(rival.workspaceId, {})).toHaveLength(0);
    expect(cd.list(rival.workspaceId)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ 8. cross-domain RIGOR
describe('RIGOR cross-domain category', () => {
  it('computes every metric from bench_cases rows with numerator/denominator; B4 beats the controlled baselines; reproducible across seeds', async () => {
    const { env, cd, ws } = setup();
    const bench = new CrossDomainBench(cd);
    const s = bench.start(env.maya, { seed: 'test-seed', seeds: 2, baselines: ['B1-single-agent', 'B4-resolve-full'], scenarios: ['cd-recovery-concurrent', 'cd-control-independent'] });
    await bench.execute(env.maya, s.id, s.cases);
    const r = bench.report(ws, s.id);
    expect(r.cases).toHaveLength(8);
    const m: any = r.metrics;
    // recompute from rows: the stored metric is exactly the sum of per-case counts
    const sum = (b: string, k: string) => r.cases.filter((c) => c.baseline === b).reduce((acc, c) => [acc[0] + c.counts[k][0], acc[1] + c.counts[k][1]], [0, 0]);
    for (const b of ['B1-single-agent', 'B4-resolve-full']) for (const k of Object.keys(m[b]).filter((x) => x !== 'reproducibility')) expect([m[b][k].num, m[b][k].den]).toEqual(sum(b, k));
    expect(m['B4-resolve-full'].collateralDamage.num).toBe(0);
    expect(m['B1-single-agent'].collateralDamage.num).toBeGreaterThan(0);
    expect(m['B4-resolve-full'].unsafePlanAcceptance).toMatchObject({ num: 0, den: 2 });
    expect(m['B1-single-agent'].unsafePlanAcceptance).toMatchObject({ num: 2, den: 2 });
    expect(m['B1-single-agent'].evidenceBackedFindings).toMatchObject({ num: 0, den: 0, rate: null }); // N/A, not 0%
    expect(m['B4-resolve-full'].reproducibility).toMatchObject({ num: 2, den: 2 });
    expect(bench.csv(ws, s.id).split('\n')).toHaveLength(9);
  });
  it('ships six scenarios over at least four domain packs', () => {
    expect(CD_SCENARIOS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(CD_SCENARIOS.flatMap((s) => s.packs)).size).toBeGreaterThanOrEqual(4);
    expect(CD_PACKS.length).toBeGreaterThanOrEqual(4);
  });
});
