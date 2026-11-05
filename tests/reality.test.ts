import { describe, it, expect } from 'vitest';
import { rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, row, rows, fullFlow, toAwaitingApproval } from './helpers.js';
import { RealityEngine } from '../src/server/reality/rge.js';
import { Lab, LabError } from '../src/server/reality/lab.js';
import { assertMove, canMove } from '../src/server/reality/states.js';

const setup = () => { const env = makeEnv(); return { env, rge: new RealityEngine(env.engine) }; };
async function splitBrainToGap() {
  const { env, rge } = setup();
  const w = await rge.create(env.maya, 'split-brain');
  rge.recordApproval(env.maya, w, 'plan', { strict: true });
  const d: any = await rge.run(env.maya, w.id);
  return { env, rge, id: w.id as string, d };
}

describe('Reality state machine', () => {
  it('never lets tool success jump to VERIFIED; VERIFIED only after VERIFICATION_PENDING', () => {
    expect(canMove('EXECUTING', 'VERIFIED')).toBe(false);
    expect(canMove('PLANNED', 'VERIFIED')).toBe(false);
    expect(canMove('OBSERVATION_PENDING', 'VERIFIED')).toBe(false);
    expect(canMove('VERIFICATION_PENDING', 'VERIFIED')).toBe(true);
    expect(canMove('EXECUTING', 'EXECUTION_UNKNOWN')).toBe(true);
    expect(canMove('VERIFIED', 'RECONCILIATION_REQUIRED')).toBe(true); // stale completion
    expect(canMove('CANCELLED', 'EXECUTING')).toBe(false);
    expect(() => assertMove('EXECUTING', 'VERIFIED')).toThrow(/Invalid reality transition/);
  });
});

describe('Reality Lab boundaries', () => {
  it('enforces agent capabilities: verifiers cannot write, executors write only their own system', async () => {
    const { env, rge } = setup();
    const w = await rge.create(env.maya, 'split-brain');
    const lab = new Lab(env.db, env.maya.workspaceId, w.id);
    expect(() => lab.mutate('verifier', 'x', 'payments', 'pay-1', { set: { status: 'x' } }, null)).toThrow(LabError);
    expect(() => lab.mutate('exec.payments', 'x', 'bookings', 'bk-1', { set: { status: 'x' } }, null)).toThrow(/no write capability/);
    expect(() => lab.observe('exec.payments', 'payments', 'pay-1')).toThrow(/no read capability/);
    expect(lab.observe('verifier', 'payments', 'pay-1').state.status).toBe('authorized');
  });
});

describe('THE SPLIT-BRAIN INCIDENT (showcase)', () => {
  it('detects the partial commit and invalidates the agent claim of completion', async () => {
    const { d } = await splitBrainToGap();
    expect(d.workflow.state).toBe('RECONCILIATION_REQUIRED');
    expect(d.workflow.observed_status).toBe('partially_completed');
    expect(d.declaredVsObserved.claims[0].claim).toMatch(/COMPLETED/);
    const cls = d.gaps.map((g: any) => `${g.class}:${g.status}`);
    expect(cls).toContain('partial_commit:open');
    expect(cls).toContain('conflicting_completion:open');
    expect(cls).toContain('unknown_outcome:resolved'); // timed out, unreadable once, then settled ABSENT by reconciliation
    const book = d.operations.find((o: any) => o.step_key === 'book');
    expect(book.state).toBe('FAILED'); expect(book.declared.settled).toBe('absent');
    // the customer confirmation is held back, not sent
    expect(d.operations.some((o: any) => o.step_key === 'notify')).toBe(false);
    expect(d.sandbox.resources.find((r: any) => r.system === 'notifications').state.deliveries).toBe(0);
  });

  it('plans counterfactual options; blind retry is rejected by policy because it would double-charge', async () => {
    const { env, rge, id, d } = await splitBrainToGap();
    const plan = d.recoveryPlans.at(-1);
    expect(plan.recommended).toBe('resume');
    const blind = plan.options.find((o: any) => o.id === 'blind_retry');
    expect(blind.policy).toBe('rejected');
    expect(blind.predicted.invariants.find((i: any) => i.id.startsWith('no_dup_payments')).ok).toBe(false);
    expect(plan.objections.some((o: any) => o.option === 'blind_retry')).toBe(true);
    expect(() => rge.chooseRecovery(env.maya, id, 'blind_retry')).toThrow(/rejected by policy/);
  });

  it('requires a recovery approval bound to the chosen plan hash, then recovers without repeating the payment', async () => {
    const { env, rge, id } = await splitBrainToGap();
    expect(() => rge.recordApproval(env.maya, rge.wf(env.maya.workspaceId, id), 'recovery', { strict: true })).toThrow(/Choose a recovery option/);
    rge.chooseRecovery(env.maya, id, 'resume');
    await expect(rge.executeRecovery(env.maya, id)).rejects.toThrow(/not authorized/i);
    expect(() => rge.recordApproval(env.luis, rge.wf(env.maya.workspaceId, id), 'recovery', { strict: true })).toThrow(/manager or owner/);
    rge.recordApproval(env.maya, rge.wf(env.maya.workspaceId, id), 'recovery', { strict: true });
    const d: any = await rge.executeRecovery(env.maya, id);
    expect(d.workflow.state).toBe('RECOVERED'); expect(d.workflow.declared_status).toBe('RECOVERED');
    const applied = d.sandbox.effectLog.filter((e: any) => e.applied);
    expect(applied.filter((e: any) => e.op === 'pay')).toHaveLength(1);    // payment never repeated
    expect(applied.filter((e: any) => e.op === 'book')).toHaveLength(1);   // booking landed once, same idempotency key
    expect(applied.filter((e: any) => e.op === 'notify')).toHaveLength(1); // confirmation only after invariants verified
    expect(d.gaps.filter((g: any) => g.status === 'open')).toHaveLength(0);
    const fwdBook = d.operations.find((o: any) => o.step_key === 'book' && o.kind === 'forward');
    const resume = d.operations.find((o: any) => o.kind === 'recovery');
    expect(resume.parent_op_id).toBe(fwdBook.id);
    expect(resume.idempotency_key).toBe(fwdBook.idempotency_key);
  });

  it('issues machine-verifiable passports; tampering is detected', async () => {
    const { env, rge, id } = await splitBrainToGap();
    rge.chooseRecovery(env.maya, id, 'resume'); rge.recordApproval(env.maya, rge.wf(env.maya.workspaceId, id), 'recovery', { strict: true });
    await rge.executeRecovery(env.maya, id);
    const pps = rge.passports(env.maya.workspaceId, id);
    const wfp = pps.find((p: any) => !p.operation_id)!;
    expect(wfp.body.workflowState).toBe('RECOVERED');
    const pay = pps.find((p: any) => p.body.executionContract?.step === 'pay' && p.body.executionContract.kind === 'forward')!;
    expect(pay.body.finalStatus).toBe('VERIFIED');
    expect(pay.body.approvals[0].boundToHash).toBe(rge.wf(env.maya.workspaceId, id).plan_hash);
    expect(pay.body.afterState.available).toBe(true);
    expect(pay.body.toolInvocation.idempotencyKey).toMatch(/^idem_/);
    expect(rge.verifyPassport(env.maya.workspaceId, pay.id).intact).toBe(true);
    env.db.exec("UPDATE rw_passports SET body=replace(body, 'VERIFIED', 'FORGED') WHERE id=?", pay.id);
    expect(rge.verifyPassport(env.maya.workspaceId, pay.id).intact).toBe(false);
  });

  it('refuses to execute a recovery whose simulated basis changed (stale plan) and re-plans', async () => {
    const { env, rge, id } = await splitBrainToGap();
    rge.chooseRecovery(env.maya, id, 'resume'); rge.recordApproval(env.maya, rge.wf(env.maya.workspaceId, id), 'recovery', { strict: true });
    new Lab(env.db, env.maya.workspaceId, id).external('inventory', 'room-12', { set: { available: false } }, 'provider:hotel', 'test');
    await expect(rge.executeRecovery(env.maya, id)).rejects.toThrow(/State changed since the plan was simulated/);
    const plans = rows(env, 'SELECT status, recommended FROM rw_recovery_plans WHERE workflow_id=? ORDER BY created_at, rowid', id);
    expect(plans.at(-2).status).toBe('stale');
    expect(plans.at(-1).recommended).not.toBe('resume'); // room no longer available → resume infeasible
    expect(row(env, 'SELECT count(*) n FROM lab_effects WHERE workflow_id=? AND op_key=? AND applied=1', id, 'book').n).toBe(0);
  });

  it('records a causal chain in the existing causal ledger', async () => {
    const { env, id } = await splitBrainToGap();
    const ev = rows(env, 'SELECT * FROM causal_events WHERE mission_id=? ORDER BY created_at, rowid', id);
    expect(ev.some((e) => e.cause_type === 'reality_gap')).toBe(true);
    expect(ev.some((e) => e.lifecycle_state === 'EXECUTION_UNKNOWN')).toBe(true);
    const gapEv = ev.find((e) => e.cause_type === 'reality_gap' && /Partial commit/.test(e.summary));
    expect(gapEv).toBeTruthy();
  });
});

describe('Governance', () => {
  it('a plan approval of v1 does not authorize v2 (live run refused, nothing written)', async () => {
    const { env, rge } = setup();
    const w = await rge.create(env.maya, 'brief-edited-after-approval');
    rge.recordApproval(env.maya, w, 'plan', { strict: true });
    await expect(rge.run(env.maya, w.id)).rejects.toThrow(/plan is now v2/);
    expect(row(env, 'SELECT count(*) n FROM lab_effects WHERE workflow_id=? AND applied=1', w.id).n).toBe(0);
  });
  it('members and viewers cannot approve or start live workflows', async () => {
    const { env, rge } = setup();
    await expect(rge.create(env.vera, 'split-brain')).rejects.toThrow(/Viewers/);
    await expect(rge.create(env.luis, 'split-brain')).rejects.toThrow(/requires owner or manager/);
    const w = await rge.create(env.maya, 'split-brain');
    expect(() => rge.recordApproval(env.luis, w, 'plan', { strict: true })).toThrow(/manager or owner/);
  });
  it('owner-level policy: a manager cannot approve an owner-only payout; injected text is flagged as data', async () => {
    const { env, rge } = setup();
    const w = await rge.create(env.maya, 'injected-approval-message');
    expect(() => rge.recordApproval(env.maya, w, 'plan', { strict: true })).toThrow(/workspace owner/);
    const d: any = rge.detail(env.maya.workspaceId, w.id);
    expect(d.workflow.contract.messages[0].flags.length).toBeGreaterThan(0);
    await expect(rge.run(env.maya, w.id)).rejects.toThrow(/Not authorized/);
  });
});

describe('Reconciliation over time', () => {
  it('re-audit turns a verified outcome that drifted into a stale completion', async () => {
    const { env, rge } = setup();
    const w = await rge.create(env.maya, 'rollback-ok');
    rge.recordApproval(env.maya, w, 'plan', { strict: true });
    const d: any = await rge.run(env.maya, w.id);
    expect(d.workflow.state).toBe('VERIFIED');
    new Lab(env.db, env.maya.workspaceId, w.id).external('deploy', 'checkout', { set: { version: 'v2.14' } }, 'provider:ci-autodeploy', 'test');
    const after: any = rge.reaudit(env.maya, w.id);
    expect(after.workflow.state).toBe('RECONCILIATION_REQUIRED');
    expect(after.gaps.some((g: any) => g.class === 'stale_completion' && g.status === 'open')).toBe(true);
  });
});

describe('Cross-system reality graph', () => {
  it('answers "what depends on this approval" and "which approval permitted this write" by traversal', async () => {
    const { env, rge, id } = await splitBrainToGap();
    const g = rge.graph(env.maya.workspaceId, id);
    const ap = g.nodes.find((n: any) => n.type === 'approval');
    const down = rge.traverse(env.maya.workspaceId, id, ap.id, 'down');
    expect(down.nodes.some((n: any) => n.type === 'operation')).toBe(true);
    expect(down.nodes.some((n: any) => n.type === 'resource' && n.label === 'payments/pay-1')).toBe(true);
    const payOp = g.nodes.find((n: any) => n.type === 'operation' && /Capture payment/.test(n.label));
    const up = rge.traverse(env.maya.workspaceId, id, payOp.id, 'up');
    expect(up.nodes.some((n: any) => n.type === 'approval')).toBe(true);
    expect(up.nodes.some((n: any) => n.type === 'agent')).toBe(true);
    expect(g.nodes.some((n: any) => n.type === 'invariant' && /violated/.test(n.label))).toBe(true);
  });
});

describe('Reality audit of the existing mission ledger', () => {
  it('flags a verified mission action whose effect has disappeared as a stale completion', async () => {
    const env = makeEnv(); const rge = new RealityEngine(env.engine);
    const id = await toAwaitingApproval(env); await fullFlow(env, id);
    const before = rge.auditMissionActions(env.maya.workspaceId);
    expect(before.actions.length).toBeGreaterThan(0); expect(before.gaps).toBe(0);
    const dir = join(env.outbox, env.maya.workspaceId.replace(/[^a-zA-Z0-9._-]/g, '_'), id.replace(/[^a-zA-Z0-9._-]/g, '_'), 'documents');
    for (const f of readdirSync(dir)) rmSync(join(dir, f));
    const after = rge.auditMissionActions(env.maya.workspaceId);
    expect(after.actions.some((x: any) => x.gap === 'stale_completion')).toBe(true);
  });
});
