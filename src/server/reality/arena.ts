import { performance } from 'node:perf_hooks';
import { j, nowIso, sha256, stable, uid, type Row } from '../db/db.js';
import type { Actor } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { Lab, LAB_LABEL } from './lab.js';
import type { RealityEngine } from './rge.js';
import { registerScenarios, scenarioById } from './scenarios.js';
import { BASELINES, type GapClass, type InvariantDef, type Reader, type Scenario, type StepDef } from './types.js';

/**
 * RIGOR COMPOUND FAILURE ARENA.
 * A campaign = a scenario + an ORDERED chain of faults that activate at named lifecycle points, plus harness actions
 * (approval replay, authority revocation, plan amendment, basis drift, post-verification drift) that go through the
 * REAL engine paths (no bypass). Each case is scored by an evaluator that reads the sandbox ground truth directly
 * (lab_effects + lab_resources) and never uses the engine's own final status as evidence.
 * Stored separately: engine-reported outcome (bench_cases.declared), ground truth (truth), evaluator verdict (evaluation).
 */

// ------------------------------------------------------------------ campaign scenarios (registered; not part of RIGOR's catalogue)
const v = (r: Reader, s: string, res: string, f: string) => r(s, res)?.[f];
const inv = (id: string, label: string, fn: (r: Reader) => [boolean, string]): InvariantDef => ({ id, label, eval: (r) => { const [ok, detail] = fn(r); return { ok, detail }; } });
const ARENA_SCENARIOS: Scenario[] = [
  {
    id: 'arena-ghost', family: 'ARENA', familyLabel: 'Compound Failure Arena', title: 'The Acknowledged Ghost', intent: 'Capture $600.00 once and send the receipt.',
    initial: [{ system: 'payments', resource: 'pay-7', state: { status: 'authorized', captured_cents: 0 } }, { system: 'notifications', resource: 'receipt', state: { deliveries: 0 } }],
    steps: [
      { key: 'pay', label: 'Capture payment $600.00', system: 'payments', resource: 'pay-7', agent: 'exec.payments', patch: { set: { status: 'captured' }, inc: { captured_cents: 60000 } }, consequential: true, reversibility: 'compensable', compensate: { label: 'Refund $600.00', patch: { set: { status: 'refunded' }, inc: { captured_cents: -60000, refunded_cents: 60000 } } }, expect: [{ field: 'captured_cents', equals: 60000, label: 'exactly one capture of $600.00' }] },
      { key: 'notify', label: 'Send payment receipt', system: 'notifications', resource: 'receipt', agent: 'exec.notifications', patch: { set: { status: 'sent' }, inc: { deliveries: 1 } }, consequential: true, reversibility: 'irreversible', expect: [{ field: 'deliveries', equals: 1, label: 'receipt delivered once' }], afterInvariants: true },
    ],
    invariants: [
      inv('no_double_charge', 'The client is charged at most once', (r) => { const n = Number(v(r, 'payments', 'pay-7', 'captured_cents') ?? 0); return [n <= 60000, `captured ${n}`]; }),
      inv('receipt_only_if_paid', 'A receipt exists only for a captured payment', (r) => { const sent = Number(v(r, 'notifications', 'receipt', 'deliveries') ?? 0) > 0; const paid = Number(v(r, 'payments', 'pay-7', 'captured_cents') ?? 0) > 0; return [!sent || paid, `receipt ${sent ? 'sent' : 'not sent'}, payment ${paid ? 'captured' : 'not captured'}`]; }),
    ],
    approval: { role: 'manager' },
    faults: [
      { kind: 'timeout_after_commit', step: 'pay', reads: 2, label: 'payment committed, acknowledgement lost (replicas stale for 2 reads)' },
      { kind: 'handoff_duplicate', step: 'pay', label: 'payment task redelivered after the timeout' },
    ],
    approvals: [{ user: 'maya', subject: 'plan' }, { user: 'maya', subject: 'recovery' }],
    truth: { achievable: true, expectedGaps: [] },
  },
  {
    id: 'arena-approval-rot', family: 'ARENA', familyLabel: 'Compound Failure Arena', title: 'Approval Rot', intent: 'Release the approved $2,500.00 vendor payout once.',
    initial: [{ system: 'payments', resource: 'payout-9', state: { status: 'held', paid_cents: 0 } }],
    steps: [{ key: 'payout', label: 'Release vendor payout', system: 'payments', resource: 'payout-9', agent: 'exec.payments', patch: { set: { status: 'paid' }, inc: { paid_cents: 250000 } }, consequential: true, reversibility: 'irreversible', expect: [{ field: 'paid_cents', equals: 250000, label: 'paid once' }] }],
    invariants: [inv('payout_once', 'Payout released at most once', (r) => { const n = Number(v(r, 'payments', 'payout-9', 'paid_cents') ?? 0); return [n <= 250000, `paid ${n}`]; })],
    approval: { role: 'manager' }, faults: [], approvals: [], truth: { achievable: true, expectedGaps: ['authorization_invalid'] },
  },
  {
    id: 'arena-delayed-truth', family: 'ARENA', familyLabel: 'Compound Failure Arena', title: 'Delayed Truth', intent: 'Refresh the revenue view to $10,000.00, then tell finance.',
    initial: [{ system: 'warehouse', resource: 'orders', state: { total_cents: 1000000 } }, { system: 'warehouse', resource: 'revenue_mv', state: { total_cents: 1180000 } }, { system: 'notifications', resource: 'finance', state: { deliveries: 0 } }],
    steps: [
      { key: 'refresh', label: 'Refresh revenue_mv', system: 'warehouse', resource: 'revenue_mv', agent: 'exec.warehouse', patch: { set: { total_cents: 1000000 }, inc: { writes: 1 } }, consequential: true, reversibility: 'reversible', claim: 'Revenue RESTATED.', expect: [{ field: 'total_cents', equals: 1000000, label: 'view total = $10,000.00' }, { field: 'writes', equals: 1, label: 'refreshed once' }] },
      { key: 'notify', label: 'Tell finance: revenue restated', system: 'notifications', resource: 'finance', agent: 'exec.notifications', patch: { set: { status: 'sent' }, inc: { deliveries: 1 } }, consequential: true, reversibility: 'irreversible', expect: [{ field: 'deliveries', equals: 1, label: 'finance told once' }], afterInvariants: true },
    ],
    invariants: [
      inv('view_matches_source', 'Revenue view total equals source total', (r) => [v(r, 'warehouse', 'revenue_mv', 'total_cents') === v(r, 'warehouse', 'orders', 'total_cents'), `view ${String(v(r, 'warehouse', 'revenue_mv', 'total_cents'))} vs source ${String(v(r, 'warehouse', 'orders', 'total_cents'))}`]),
      inv('finance_after_truth', 'Finance is told only when the view really matches', (r) => { const told = Number(v(r, 'notifications', 'finance', 'deliveries') ?? 0) > 0; return [!told || v(r, 'warehouse', 'revenue_mv', 'total_cents') === v(r, 'warehouse', 'orders', 'total_cents'), `finance ${told ? 'told' : 'not told'}`]; }),
    ],
    approval: { role: 'manager' },
    faults: [
      { kind: 'delayed_consistency', step: 'refresh', reads: 2, label: 'refresh committed; replicas lag for 2 reads' },
      { kind: 'observe_unavailable', system: 'warehouse', reads: 1, afterWrite: true, label: 'warehouse read API unreadable once during verification' },
    ],
    approvals: [{ user: 'maya', subject: 'plan' }, { user: 'maya', subject: 'recovery' }],
    truth: { achievable: true, expectedGaps: ['delayed_consistency'] },
  },
  {
    id: 'arena-redelivery', family: 'ARENA', familyLabel: 'Compound Failure Arena', title: 'Lost Hand-off After Restart', intent: 'Reserve SKU-4, then invoice INV-4.',
    initial: [{ system: 'inventory', resource: 'sku-4', state: { reserved: 0 } }, { system: 'ledger', resource: 'inv-4', state: { invoiced: false } }],
    steps: [
      { key: 'reserve', label: 'Reserve 1 × SKU-4', system: 'inventory', resource: 'sku-4', agent: 'exec.inventory', patch: { inc: { reserved: 1 } }, consequential: true, reversibility: 'compensable', compensate: { label: 'Release SKU-4', patch: { inc: { reserved: -1 } } }, expect: [{ field: 'reserved', equals: 1, label: 'one unit reserved' }] },
      { key: 'invoice', label: 'Issue invoice INV-4', system: 'ledger', resource: 'inv-4', agent: 'exec.ledger', patch: { set: { invoiced: true }, inc: { writes: 1 } }, consequential: true, reversibility: 'reversible', expect: [{ field: 'invoiced', equals: true, label: 'invoiced' }, { field: 'writes', equals: 1, label: 'invoiced once' }] },
    ],
    invariants: [
      inv('reserved_once', 'Stock reserved at most once', (r) => { const n = Number(v(r, 'inventory', 'sku-4', 'reserved') ?? 0); return [n <= 1, `reserved ${n}`]; }),
      inv('invoice_iff_reserved', 'Invoiced if and only if reserved', (r) => { const res = Number(v(r, 'inventory', 'sku-4', 'reserved') ?? 0) > 0; const inv4 = v(r, 'ledger', 'inv-4', 'invoiced') === true; return [res === inv4, `reserved ${res}, invoiced ${inv4}`]; }),
    ],
    approval: { role: 'manager' },
    faults: [
      { kind: 'handoff_duplicate', step: 'reserve', label: 'reserve task redelivered after the agent restarted (already completed)' },
      { kind: 'handoff_lost', step: 'invoice', label: 'invoice hand-off acknowledgement lost on restart (not yet executed)' },
    ],
    approvals: [{ user: 'maya', subject: 'plan' }, { user: 'maya', subject: 'recovery' }],
    truth: { achievable: true, expectedGaps: ['lost_handoff'] },
  },
  {
    id: 'arena-rollback', family: 'ARENA', familyLabel: 'Compound Failure Arena', title: 'Verified, Then Drift', intent: 'Roll checkout back to v2.13 and keep it there.',
    initial: [{ system: 'deploy', resource: 'checkout', state: { version: 'v2.14' } }, { system: 'health', resource: 'checkout', state: { error_rate: 0.11 } }],
    steps: [{ key: 'rollback', label: 'Roll checkout back to v2.13', system: 'deploy', resource: 'checkout', agent: 'exec.deploy', patch: { set: { version: 'v2.13' } }, consequential: true, reversibility: 'reversible', expect: [{ field: 'version', equals: 'v2.13', label: 'v2.13 live' }] }],
    invariants: [inv('healthy', 'Checkout error rate below 2%', (r) => { const e = Number(v(r, 'health', 'checkout', 'error_rate') ?? 1); return [e < 0.02, `error rate ${(e * 100).toFixed(1)}%`]; })],
    approval: { role: 'manager' }, faults: [],
    events: [{ after: 'rollback', kind: 'mutate', system: 'health', resource: 'checkout', patch: { set: { error_rate: 0.004 } }, actor: 'provider:monitoring', label: 'monitoring reports recovery after the rollback' }],
    approvals: [{ user: 'maya', subject: 'plan' }, { user: 'maya', subject: 'recovery' }],
    truth: { achievable: true, expectedGaps: ['stale_completion'] },
  },
];
registerScenarios(ARENA_SCENARIOS);

// ------------------------------------------------------------------ campaign definitions
export interface Bundle {
  s: Scenario; w: Row; effects: Row[]; truth: Reader; ops: Row[]; gaps: Row[]; approvals: Row[]; plans: Row[];
  passports: Row[]; handoffs: Row[]; causal: Row[]; harness: HarnessEntry[]; baseline: string;
}
export interface HarnessEntry { step: string; ok: boolean; detail: string; at: string; effectsBefore?: number; effectsAfter?: number }
type Check = { applicable?: boolean; pass: boolean; detail: string };
interface Property { id: string; label: string; check: (b: Bundle) => Check }
interface Stage { id: string; label: string; trigger: string; target: string; match: RegExp }
interface Ctx { rge: RealityEngine; a: Actor; id: string; log: HarnessEntry[]; lab: Lab }
export interface Campaign {
  id: string; code: string; name: string; summary: string; scenario: string; systems: string[];
  stages: Stage[]; signature: GapClass[]; expectedRecovery: string; properties: Property[];
  harness: (ctx: Ctx) => Promise<void>; authViolation?: boolean; basisDrift?: boolean;
}

const appliedFor = (b: Bundle, op: string) => b.effects.filter((e) => e.applied && e.op_key === op);
const fwd = (b: Bundle, key: string) => b.ops.find((o) => o.step_key === key && o.kind === 'forward');
const gap = (b: Bundle, cls: string) => b.gaps.filter((g) => g.class === cls);
const harnessStep = (b: Bundle, name: string) => b.harness.find((h) => h.step === name);
const ENGINE_POSITIVE = ['VERIFIED', 'RECOVERED', 'COMPLETED'];
const stepTruthOk = (b: Bundle, x: StepDef) => { const st = b.truth(x.system, x.resource); return !!st && x.expect.every((e) => st[e.field] === e.equals); };

async function act(ctx: Ctx, step: string, fn: () => unknown | Promise<unknown>) {
  const count = () => ctx.lab.effects().filter((e) => e.applied).length;
  const before = count(); const at = nowIso();
  try { const r = await fn(); ctx.log.push({ step, ok: true, detail: typeof r === 'string' ? r : 'ok', at, effectsBefore: before, effectsAfter: count() }); return true; }
  catch (e) { ctx.log.push({ step, ok: false, detail: String((e as Error).message), at, effectsBefore: before, effectsAfter: count() }); return false; }
}
const wfRow = (ctx: Ctx) => ctx.rge.wf(ctx.a.workspaceId, ctx.id);
const latestPlan = (ctx: Ctx) => ctx.rge.db.get('SELECT * FROM rw_recovery_plans WHERE workflow_id=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC', ctx.id, ctx.a.workspaceId);
const approve = (ctx: Ctx, handle: string, subject: 'plan' | 'recovery' = 'plan') => act(ctx, `${subject} approval by ${handle}`, () => ctx.rge.recordApproval(null, wfRow(ctx), subject, { userHandle: handle }));
const runWf = (ctx: Ctx, label = 'run workflow') => act(ctx, label, async () => { const d: any = await ctx.rge.run(ctx.a, ctx.id); return `state ${d.workflow.state}`; });
async function recoverRecommended(ctx: Ctx) {
  if (wfRow(ctx).state !== 'RECONCILIATION_REQUIRED') { ctx.log.push({ step: 'recovery', ok: false, detail: `skipped: workflow is ${wfRow(ctx).state} (no recovery plan in this configuration)`, at: nowIso() }); return; }
  const plan = latestPlan(ctx)!;
  await act(ctx, `choose recovery "${plan.recommended}"`, () => { ctx.rge.chooseRecovery(ctx.a, ctx.id, plan.recommended, { lenient: true }); return plan.recommended; });
  await approve(ctx, 'maya', 'recovery');
  await act(ctx, 'execute recovery', async () => { const d: any = await ctx.rge.executeRecovery(ctx.a, ctx.id, { lenient: true }); return `state ${d.workflow.state}`; });
}

const GENERIC: Property[] = [
  { id: 'no_duplicate_effects', label: 'No consequential effect landed twice (ground truth)', check: (b) => { const d = b.s.steps.filter((x) => appliedFor(b, x.key).length > 1).map((x) => `${x.key}×${appliedFor(b, x.key).length}`); return { pass: !d.length, detail: d.length ? `duplicated: ${d.join(', ')}` : 'every forward operation applied at most once' }; } },
  { id: 'claim_matches_truth', label: 'Engine-reported outcome matches ground truth', check: (b) => {
    const st = String(b.w.declared_status); const invOk = b.s.invariants.every((i) => i.eval(b.truth).ok); const intent = b.s.steps.every((x) => stepTruthOk(b, x));
    if (ENGINE_POSITIVE.includes(st)) return { pass: invOk && intent, detail: `engine "${st}"; ground truth: intent ${intent ? 'met' : 'NOT met'}, invariants ${invOk ? 'hold' : 'VIOLATED'}` };
    if (st === 'RECOVERED_COMPENSATED') return { pass: invOk, detail: `engine "compensated"; invariants ${invOk ? 'hold' : 'VIOLATED'}` };
    return { pass: true, detail: `engine did not claim success ("${st}")` };
  } },
  { id: 'passports_accurate', label: 'Passports match the evidence and are untampered', check: (b) => {
    const bad: string[] = [];
    for (const p of b.passports) {
      if (sha256(stable(p.body)) !== p.body_hash) bad.push(`${p.id} hash mismatch`);
      const body = p.body; if (!p.operation_id || body.finalStatus !== 'VERIFIED') continue;
      const step = b.s.steps.find((x) => x.key === body.executionContract.step);
      if (!body.afterState?.available) { bad.push(`${body.executionContract.label}: VERIFIED without an available after-state`); continue; }
      if (body.executionContract.kind === 'compensation') { if (!appliedFor(b, `${body.executionContract.step}:compensate`).length) bad.push(`${body.executionContract.label}: VERIFIED but no compensation effect exists`); continue; }
      if (step && !step.expect.every((e) => body.afterState.state?.[e.field] === e.equals)) bad.push(`${body.executionContract.label}: VERIFIED but its after-state does not show the post-condition`);
    }
    return { pass: !bad.length, detail: bad.length ? bad.join('; ') : `${b.passports.length} passport(s) consistent with the observations` };
  } },
  { id: 'no_confirmed_wrong_outcome', label: 'No uncertain outcome was confirmed wrongly', check: (b) => {
    const wrong: string[] = []; let n = 0;
    for (const f of b.s.faults.filter((x) => x.step && ['timeout_after_commit', 'timeout_before_commit', 'false_success', 'unavailable'].includes(x.kind))) {
      const op = fwd(b, f.step!); const first = b.effects.find((e) => e.op_key === f.step); if (!op || !first) continue; n++;
      const settled = j<any>(op.declared, {}).settled ?? 'unknown';
      if (settled !== 'unknown' && settled !== (first.applied ? 'present' : 'absent')) wrong.push(`${f.step}: settled "${settled}", truth ${first.applied ? 'present' : 'absent'}`);
    }
    return { applicable: n > 0, pass: !wrong.length, detail: wrong.length ? wrong.join('; ') : `${n} faulted operation(s) settled consistently with ground truth` };
  } },
];

export const CAMPAIGNS: Campaign[] = [
  {
    id: 'acknowledged-ghost', code: 'A', name: 'The Acknowledged Ghost', scenario: 'arena-ghost', systems: ['payments', 'notifications'],
    summary: 'The payment commits, the acknowledgement is lost, stale replica reads say "nothing happened", then the task is redelivered.',
    stages: [
      { id: 'ack_lost', label: 'Payment committed, acknowledgement lost', trigger: 'system accepted the write, before acknowledgement', target: 'exec.payments · pay', match: /acknowledgement lost/ },
      { id: 'stale_read', label: 'Stale replica read', trigger: 'read-back after the timeout', target: 'observer · payments/pay-7', match: /stale replica read/ },
      { id: 'redelivery', label: 'Task redelivered', trigger: 'during retry / redelivery', target: 'planner → exec.payments', match: /redelivered after the timeout/ },
    ],
    signature: [], expectedRecovery: 'none — read-back settles the outcome; the redelivery is deduplicated',
    properties: [
      { id: 'one_payment', label: 'Exactly one payment capture exists', check: (b) => ({ pass: appliedFor(b, 'pay').length === 1, detail: `${appliedFor(b, 'pay').length} applied capture(s)` }) },
      { id: 'same_key', label: 'Original idempotency key preserved on every attempt', check: (b) => { const keys = new Set(b.effects.filter((e) => e.op_key === 'pay').map((e) => e.idem_key)); const op = fwd(b, 'pay'); return { pass: keys.size === 1 && !!op?.idempotency_key && keys.has(op.idempotency_key), detail: `keys used: ${[...keys].map((k) => k ?? 'none').join(', ')}` }; } },
      { id: 'ghost_not_failure', label: 'The lost acknowledgement was not classified as a failure', check: (b) => { const d = j<any>(fwd(b, 'pay')?.declared, {}); return { pass: d.settled === 'present' || d.settled === 'unknown', detail: `settled "${d.settled ?? 'none'}"; read-back sequence ${JSON.stringify(d.readBack ?? 'no read-back')}` }; } },
      { id: 'passport_records_ghost', label: 'Passport records the missing response and the independent observation', check: (b) => { const p = b.passports.find((x) => x.body.operationId === fwd(b, 'pay')?.id); return { pass: !!p && p.body.toolInvocation.response === null && !!p.body.afterState?.available, detail: p ? `tool response ${p.body.toolInvocation.response === null ? 'missing (recorded as missing)' : 'present'}, after-state ${p.body.afterState?.available ? 'observed' : 'absent'}` : 'no passport' }; } },
    ],
    harness: async (ctx) => { await approve(ctx, 'maya'); await runWf(ctx); await recoverRecommended(ctx); },
  },
  {
    id: 'approval-rot', code: 'B', name: 'Approval Rot', scenario: 'arena-approval-rot', systems: ['payments'], authViolation: true,
    summary: 'Approved v1 → plan amended to v2 → approver demoted → the old approval is replayed → the executor tries to pay.',
    stages: [
      { id: 'amend', label: 'Plan amended after approval', trigger: 'immediately after approval', target: 'planner · contract', match: /payout raised/ },
      { id: 'revoke', label: 'Approver authority revoked', trigger: 'after approval, before execution', target: 'governance · maya', match: /authority revoked/ },
      { id: 'replay', label: 'Stale approval replayed', trigger: 'before execution', target: 'governance · approval record', match: /replay of approval/ },
    ],
    signature: ['authorization_invalid'], expectedRecovery: 'refuse, then require a fresh approval of plan v2',
    properties: [
      { id: 'no_effect_under_stale_authority', label: 'No payout under the stale, revoked or replayed approval', check: (b) => {
        const fresh = b.approvals.find((a) => a.channel === 'structured' && /Sam/i.test(a.user_name) && a.subject === 'plan');
        const early = appliedFor(b, 'payout').filter((e) => !fresh || e.created_at < fresh.created_at);
        return { pass: !early.length, detail: early.length ? `${early.length} payout(s) applied before any fresh approval` : 'no payout applied before the fresh approval' };
      } },
      { id: 'refusal_reasons', label: 'Refusal records the plan-hash mismatch and the authority change', check: (b) => { const g = gap(b, 'authorization_invalid'); const txt = JSON.stringify(g.map((x) => j(x.observed, null))); return { pass: g.length > 0 && /hash/.test(txt) && /member/.test(txt), detail: g.length ? txt.slice(0, 300) : 'no authorization gap recorded' }; } },
      { id: 'fresh_approval_used', label: 'The payout ran only under a fresh approval bound to the current plan', check: (b) => {
        const op = fwd(b, 'payout'); if (!appliedFor(b, 'payout').length) return { applicable: false, pass: true, detail: 'no payout executed' };
        const ids = j<string[]>(op?.approval_ids, []); const rows = b.approvals.filter((a) => ids.includes(a.id));
        const ok = rows.length > 0 && rows.every((a) => a.channel === 'structured' && a.subject_hash === b.w.plan_hash && /Sam/i.test(a.user_name));
        return { pass: ok, detail: rows.map((a) => `${a.user_name} via ${a.channel}, hash ${String(a.subject_hash).slice(0, 8)} (current ${String(b.w.plan_hash).slice(0, 8)})`).join('; ') || 'payout ran with no approval link' };
      } },
      { id: 'payout_once', label: 'Payout released at most once', check: (b) => ({ pass: appliedFor(b, 'payout').length <= 1, detail: `${appliedFor(b, 'payout').length} payout effect(s)` }) },
    ],
    harness: async (ctx) => {
      const ok = await approve(ctx, 'maya');
      const first = ok ? ctx.rge.db.get('SELECT id FROM rw_approvals WHERE workflow_id=? AND workspace_id=? ORDER BY created_at, rowid LIMIT 1', ctx.id, ctx.a.workspaceId)?.id : null;
      await act(ctx, 'amend plan (payout raised to $3,100)', () => { ctx.rge.amendPlan(wfRow(ctx), { payout_cents: 310000 }, 'payout raised to $3,100 after approval (plan v2)'); return 'plan v2'; });
      await act(ctx, 'revoke Maya (manager → member)', () => { ctx.rge.revokeAuthority(wfRow(ctx), 'maya', 'member', 'Maya moved to member (authority revoked)'); return 'revoked'; });
      if (first) await act(ctx, 'replay the v1 approval', () => ctx.rge.replayApproval(wfRow(ctx), first));
      await runWf(ctx, 'run with rotten approvals');
      if (wfRow(ctx).state === 'REQUIRES_HUMAN') {
        await act(ctx, 're-authorize (fresh approval required)', () => { ctx.rge.reauthorize(ctx.a, ctx.id, { lenient: true }); return 'AUTHORIZATION_PENDING'; });
        await approve(ctx, 'sam');
        await runWf(ctx, 'run with fresh approval');
      }
    },
  },
  {
    id: 'split-brain-chain', code: 'C', name: 'The Split-Brain Chain', scenario: 'split-brain', systems: ['payments', 'bookings', 'inventory', 'notifications'],
    summary: 'The payment commits; the booking times out inside an outage window; its status is unreadable once; the payments agent claims completion.',
    stages: [
      { id: 'timeout_1', label: 'Booking write times out (outage window)', trigger: 'between two dependent system writes', target: 'exec.bookings · book', match: /outage window/ },
      { id: 'unreadable', label: 'Booking status unreadable', trigger: 'read-back after the timeout', target: 'observer · bookings/bk-1', match: /unreadable once/ },
      { id: 'timeout_2', label: 'Booking times out again in guarded recovery', trigger: 'during retry', target: 'exec.bookings · book (recovery)', match: /outage window/ },
    ],
    signature: ['partial_commit', 'conflicting_completion', 'unknown_outcome'], expectedRecovery: 'resume the booking with the original idempotency key, then confirm',
    properties: [
      { id: 'partial_detected', label: 'Partial commit detected', check: (b) => ({ pass: gap(b, 'partial_commit').length > 0, detail: gap(b, 'partial_commit')[0]?.title ?? 'no partial_commit gap raised' }) },
      { id: 'claim_retained', label: 'The false completion claim is retained as evidence', check: (b) => { const g = gap(b, 'conflicting_completion').find((x) => /COMPLETED/.test(String(x.declared))); return { pass: !!g, detail: g ? `kept: ${String(j(g.declared, '')).slice(0, 80)}` : 'claim not recorded as a gap' }; } },
      { id: 'pay_once', label: 'Payment never repeated', check: (b) => ({ pass: appliedFor(b, 'pay').length === 1, detail: `${appliedFor(b, 'pay').length} capture(s)` }) },
      { id: 'confirm_after_booking', label: 'Confirmation only after the booking really exists', check: (b) => { const n = appliedFor(b, 'notify')[0]; const bk = b.effects.find((e) => e.applied && e.op_key === 'book'); return { pass: !n || (!!bk && bk.seq < n.seq), detail: n ? (bk ? `booking effect #${bk.seq} before confirmation #${n.seq}` : 'confirmation sent with NO booking') : 'no confirmation sent' }; } },
    ],
    harness: async (ctx) => { await approve(ctx, 'maya'); await runWf(ctx); await recoverRecommended(ctx); },
  },
  {
    id: 'delayed-truth', code: 'D', name: 'Delayed Truth', scenario: 'arena-delayed-truth', systems: ['warehouse', 'notifications'],
    summary: 'The refresh commits, the verification read is unreadable, then two stale replica reads; the data agent already claims "restated".',
    stages: [
      { id: 'lag', label: 'Write committed with replication lag', trigger: 'after commit, during read-after-write', target: 'exec.warehouse · refresh', match: /replicas lag/ },
      { id: 'unreadable', label: 'Verification read unreadable', trigger: 'during independent verification', target: 'verifier · warehouse', match: /unreadable once during verification/ },
      { id: 'stale', label: 'Stale replica read', trigger: 'during independent verification', target: 'verifier · warehouse/revenue_mv', match: /stale replica read/ },
    ],
    signature: ['delayed_consistency'], expectedRecovery: 'none — stays pending until reconciliation sees the write',
    properties: [
      { id: 'not_premature', label: 'Success was not declared before an independent read confirmed it', check: (b) => {
        const op = fwd(b, 'refresh'); const log = j<any[]>(op?.verifier, []);
        if (!ENGINE_POSITIVE.includes(String(b.w.declared_status))) return { pass: true, detail: `engine did not claim success ("${b.w.declared_status}")` };
        const p = b.passports.find((x) => x.body.operationId === op?.id);
        const after = p?.body.afterState;
        const step = b.s.steps.find((x) => x.key === 'refresh')!;
        const confirmed = op?.state === 'VERIFIED' && !!after?.available && step.expect.every((e) => after.state?.[e.field] === e.equals);
        return { pass: confirmed, detail: confirmed ? `verify window: ${log.map((r) => (r.available ? (r.checks.every((c: any) => c.ok) ? 'visible' : 'not visible') : 'unreadable')).join(', ') || 'n/a'}; confirmed by a later independent read` : `engine "${b.w.declared_status}" with no independent confirmation of the refresh` };
      } },
      { id: 'sequence_recorded', label: 'The unreadable / stale observation sequence is recorded', check: (b) => { const log = j<any[]>(fwd(b, 'refresh')?.verifier, []); return { pass: log.length >= 3 && log.some((r) => !r.available), detail: `${log.length} verification read(s) recorded: ${log.map((r) => (r.available ? 'read' : 'unreadable')).join(', ') || 'none'}` }; } },
      { id: 'delayed_not_failure', label: 'Delayed consistency is classified as delayed, not as a failure', check: (b) => ({ pass: !gap(b, 'no_op').length && gap(b, 'delayed_consistency').length > 0, detail: `no_op gaps ${gap(b, 'no_op').length}, delayed_consistency gaps ${gap(b, 'delayed_consistency').length}` }) },
    ],
    harness: async (ctx) => { await approve(ctx, 'maya'); await runWf(ctx); await recoverRecommended(ctx); },
  },
  {
    id: 'basis-collapse', code: 'E', name: 'Recovery Basis Collapse', scenario: 'split-brain', systems: ['payments', 'bookings', 'inventory'], basisDrift: true,
    summary: 'A resume plan is approved, then the room is sold before execution; the old approval is then tried against the re-planned recovery.',
    stages: [
      { id: 'timeout', label: 'Booking write times out', trigger: 'between two dependent system writes', target: 'exec.bookings · book', match: /outage window/ },
      { id: 'unreadable', label: 'Booking status unreadable', trigger: 'read-back after the timeout', target: 'observer · bookings/bk-1', match: /unreadable once/ },
      { id: 'drift', label: 'Recovery basis changes', trigger: 'between recovery approval and recovery execution', target: 'inventory/room-12', match: /sold to another guest/ },
      { id: 'replay', label: 'Old recovery approval replayed', trigger: 'before the re-planned recovery executes', target: 'governance · approval record', match: /replay of approval/ },
    ],
    signature: ['partial_commit', 'conflicting_completion'], expectedRecovery: 'block the stale plan, re-plan (compensate), require a fresh approval',
    properties: [
      { id: 'stale_plan_blocked', label: 'The approved plan was refused once its basis changed', check: (b) => { const drift = harnessStep(b, 'inject: room 12 sold'); if (!drift?.ok) return { applicable: false, pass: true, detail: 'drift not injected (no recovery plan in this configuration)' }; const ex = harnessStep(b, 'execute the approved (now stale) plan'); return { pass: b.plans.some((p) => p.status === 'stale') && !!ex && !ex.ok && ex.effectsAfter === ex.effectsBefore, detail: ex ? `${ex.ok ? 'EXECUTED' : 'refused'}: ${ex.detail.slice(0, 140)}` : 'stale plan execution not attempted' }; } },
      { id: 'old_approval_rejected', label: 'The original approval cannot authorize the changed plan', check: (b) => { const t = harnessStep(b, 'execute new plan with the OLD approval'); if (!t) return { applicable: false, pass: true, detail: 'not reached' }; return { pass: !t.ok && /not authorized/i.test(t.detail) && t.effectsAfter === t.effectsBefore, detail: t.detail.slice(0, 160) }; } },
      { id: 'no_booking_on_sold_room', label: 'No booking was written for the sold room', check: (b) => ({ pass: !appliedFor(b, 'book').length, detail: `${appliedFor(b, 'book').length} booking effect(s)` }) },
      { id: 'final_bound_to_new_plan', label: 'The executed recovery carries an approval bound to the new plan', check: (b) => { const last = b.plans[b.plans.length - 1]; const rec = b.ops.filter((o) => o.kind !== 'forward'); if (!rec.length || !last) return { applicable: false, pass: true, detail: 'no recovery executed' }; const ids = rec.flatMap((o) => j<string[]>(o.approval_ids, [])); const rows = b.approvals.filter((a) => ids.includes(a.id)); return { pass: rows.length > 0 && rows.every((a) => a.subject_hash === last.plan_hash && a.channel === 'structured'), detail: `recovery approval ${rows.map((a) => `${a.channel}:${String(a.subject_hash).slice(0, 8)}`).join(',')} vs plan ${String(last.plan_hash).slice(0, 8)}` }; } },
    ],
    harness: async (ctx) => {
      await approve(ctx, 'maya'); await runWf(ctx);
      if (wfRow(ctx).state !== 'RECONCILIATION_REQUIRED') { ctx.log.push({ step: 'recovery', ok: false, detail: `skipped: workflow is ${wfRow(ctx).state} (no recovery plan in this configuration)`, at: nowIso() }); return; }
      const plan = latestPlan(ctx)!;
      await act(ctx, `choose recovery "${plan.recommended}"`, () => { ctx.rge.chooseRecovery(ctx.a, ctx.id, plan.recommended, { lenient: true }); return plan.recommended; });
      await approve(ctx, 'maya', 'recovery');
      await act(ctx, 'inject: room 12 sold', () => { ctx.rge.injectExternal(wfRow(ctx), 'inventory', 'room-12', { set: { available: false } }, 'provider:hotel', 'room 12 sold to another guest between recovery approval and execution', 'between recovery approval and recovery execution'); return 'room-12 available=false'; });
      await act(ctx, 'execute the approved (now stale) plan', async () => { await ctx.rge.executeRecovery(ctx.a, ctx.id, { lenient: true }); return 'executed'; });
      const next = latestPlan(ctx)!;
      if (next.status !== 'proposed') return;
      const old = ctx.rge.db.get("SELECT id FROM rw_approvals WHERE workflow_id=? AND workspace_id=? AND subject='recovery' ORDER BY created_at, rowid LIMIT 1", ctx.id, ctx.a.workspaceId);
      await act(ctx, `choose re-planned recovery "${next.recommended}"`, () => { ctx.rge.chooseRecovery(ctx.a, ctx.id, next.recommended, { lenient: true }); return next.recommended; });
      if (old) await act(ctx, 'replay the old recovery approval', () => ctx.rge.replayApproval(wfRow(ctx), old.id));
      await act(ctx, 'execute new plan with the OLD approval', async () => { await ctx.rge.executeRecovery(ctx.a, ctx.id, { lenient: true }); return 'executed'; });
      await approve(ctx, 'maya', 'recovery');
      await act(ctx, 'execute new plan with a fresh approval', async () => { const d: any = await ctx.rge.executeRecovery(ctx.a, ctx.id, { lenient: true }); return `state ${d.workflow.state}`; });
    },
  },
  {
    id: 'poisoned-compensation', code: 'F', name: 'The Poisoned Compensation', scenario: 'invoice-compensation-fails', systems: ['ledger', 'payments', 'inventory'],
    summary: 'The vendor is paid, goods are rejected at the dock, and the refund tool reports success without booking anything.',
    stages: [
      { id: 'dock', label: 'Goods rejected at the dock', trigger: 'between two dependent system writes', target: 'inventory/dock-2', match: /rejected at the dock/ },
      { id: 'poison', label: 'Refund accepted, nothing booked', trigger: 'compensation write', target: 'exec.payments · pay:compensate', match: /books nothing/ },
    ],
    signature: ['partial_commit', 'stale_evidence', 'compensation_failure'], expectedRecovery: 'compensation fails → REQUIRES_HUMAN',
    properties: [
      { id: 'no_receive_of_rejected_goods', label: 'Rejected goods were never received into inventory (stale evidence not acted on)', check: (b) => { const dock = b.truth('inventory', 'dock-2'); const rec = appliedFor(b, 'receive').length; return { pass: !(dock?.accepted === false && rec > 0), detail: `dock accepted=${String(dock?.accepted)}, receive effects ${rec}` }; } },
      { id: 'comp_failure_detected', label: 'Compensation failure detected from observed reality', check: (b) => ({ applicable: b.plans.length > 0, pass: gap(b, 'compensation_failure').length > 0, detail: gap(b, 'compensation_failure')[0]?.title ?? 'not detected' }) },
      { id: 'not_recovered', label: 'The workflow is not declared recovered or consistent', check: (b) => { const truthOk = b.s.invariants.every((i) => i.eval(b.truth).ok); return { pass: truthOk || !['RECOVERED', 'RECOVERED_COMPENSATED', 'VERIFIED', 'COMPLETED'].includes(String(b.w.declared_status)), detail: `engine "${b.w.declared_status}", invariants ${truthOk ? 'hold' : 'violated'}` }; } },
      { id: 'escalated', label: 'Escalated to REQUIRES_HUMAN', check: (b) => ({ applicable: b.plans.length > 0, pass: b.w.state === 'REQUIRES_HUMAN', detail: `state ${b.w.state}` }) },
      { id: 'passport_shows_failed_comp', label: 'The passport carries the failed compensation evidence', check: (b) => { const p = b.passports.find((x) => x.body.executionContract?.kind === 'compensation'); if (!p) return { applicable: b.plans.length > 0, pass: false, detail: 'no compensation passport' }; return { pass: p.body.finalStatus !== 'VERIFIED' && p.body.failedConditions.length > 0, detail: `status ${p.body.finalStatus}; ${p.body.failedConditions.join('; ').slice(0, 160)}` }; } },
    ],
    harness: async (ctx) => { await approve(ctx, 'maya'); await runWf(ctx); await recoverRecommended(ctx); },
  },
  {
    id: 'redelivery-after-restart', code: 'G', name: 'Lost Hand-off After Restart', scenario: 'arena-redelivery', systems: ['inventory', 'ledger'],
    summary: "A completed reservation task is redelivered after a restart; the next task's acknowledgement is lost before it ran.",
    stages: [
      { id: 'dup', label: 'Completed task redelivered', trigger: 'during retry / redelivery', target: 'planner → exec.inventory', match: /redelivered after the agent restarted/ },
      { id: 'lost', label: 'Acknowledgement lost before execution', trigger: 'hand-off delivered, before acknowledgement', target: 'planner → exec.ledger', match: /acknowledgement lost on restart/ },
    ],
    signature: ['lost_handoff'], expectedRecovery: 'dedupe the completed task; redeliver the uncompleted one',
    properties: [
      { id: 'completed_not_rerun', label: 'The completed task did not run again', check: (b) => ({ pass: appliedFor(b, 'reserve').length === 1, detail: `${appliedFor(b, 'reserve').length} reservation effect(s)` }) },
      { id: 'uncompleted_recovered', label: 'The uncompleted task still ran exactly once', check: (b) => ({ pass: appliedFor(b, 'invoice').length === 1, detail: `${appliedFor(b, 'invoice').length} invoice effect(s)` }) },
      { id: 'handoff_history', label: 'Hand-off history explains delivery, acknowledgement and redelivery', check: (b) => { const r = b.handoffs.find((h) => h.to_agent === 'exec.inventory'); const i = b.handoffs.find((h) => h.to_agent === 'exec.ledger'); return { pass: !!r && r.deliveries >= 2 && !!r.acked_at && !!i && i.deliveries >= 2 && !!i.acked_at, detail: `reserve: ${r?.deliveries ?? 0} deliveries / ${r?.status ?? 'none'}; invoice: ${i?.deliveries ?? 0} deliveries / ${i?.status ?? 'none'}` }; } },
    ],
    harness: async (ctx) => { await approve(ctx, 'maya'); await runWf(ctx); await recoverRecommended(ctx); },
  },
  {
    id: 'verified-then-drift', code: 'H', name: 'Verified, Then Drift', scenario: 'arena-rollback', systems: ['deploy', 'health'],
    summary: 'The rollback is verified, then an auto-deploy silently reverts it; the verified result must not stay "true".',
    stages: [{ id: 'drift', label: 'Watched resource reverted after VERIFIED', trigger: 'after the workflow was marked verified', target: 'deploy/checkout', match: /reverts the rollback/ }],
    signature: ['stale_completion'], expectedRecovery: 'corrective rollback with a new idempotency key',
    properties: [
      { id: 'stale_detected', label: 'The stale completion is detected', check: (b) => ({ pass: gap(b, 'stale_completion').length > 0, detail: gap(b, 'stale_completion')[0]?.title ?? 'not detected' }) },
      { id: 'corrective_key', label: 'The corrective write used a new idempotency key', check: (b) => { const rec = b.ops.find((o) => o.kind === 'recovery'); const f = fwd(b, 'rollback'); if (!rec) return { applicable: false, pass: true, detail: 'no corrective write' }; return { pass: rec.idempotency_key !== f?.idempotency_key, detail: `forward ${String(f?.idempotency_key).slice(0, 14)} vs corrective ${String(rec.idempotency_key).slice(0, 14)}` }; } },
      { id: 'restored', label: 'Ground truth ends with the rollback in place', check: (b) => ({ pass: v(b.truth, 'deploy', 'checkout', 'version') === 'v2.13', detail: `deploy/checkout = ${String(v(b.truth, 'deploy', 'checkout', 'version'))}` }) },
    ],
    harness: async (ctx) => {
      await approve(ctx, 'maya'); await runWf(ctx);
      await act(ctx, 'inject: auto-deploy reverts the rollback', () => { ctx.rge.injectExternal(wfRow(ctx), 'deploy', 'checkout', { set: { version: 'v2.14' } }, 'provider:ci-autodeploy', 'auto-deploy reverts the rollback after it was verified', 'after the workflow was marked verified'); return 'deploy/checkout = v2.14'; });
      if (['VERIFIED', 'RECOVERED'].includes(wfRow(ctx).state)) await act(ctx, 're-audit against reality', () => { const d: any = ctx.rge.reaudit(ctx.a, ctx.id); return `state ${d.workflow.state}`; });
      else ctx.log.push({ step: 're-audit against reality', ok: false, detail: `skipped: workflow is ${wfRow(ctx).state} (no re-audit in this configuration)`, at: nowIso() });
      await recoverRecommended(ctx);
    },
  },
];
export const campaignById = (id: string) => CAMPAIGNS.find((c) => c.id === id);

// ------------------------------------------------------------------ evaluator (independent of the engine's verdict)
export function evaluate(rge: RealityEngine, c: Campaign, w: Row, harness: HarnessEntry[]) {
  const ws = w.workspace_id; const lab = new Lab(rge.db, ws, w.id); const s = scenarioById(c.scenario)!;
  const q = (t: string, order = 'created_at, rowid') => rge.db.all(`SELECT * FROM ${t} WHERE workflow_id=? AND workspace_id=? ORDER BY ${order}`, w.id, ws);
  const b: Bundle = {
    s, w, effects: lab.effects(), truth: (sys, res) => lab.truth(sys, res), ops: q('rw_operations'), gaps: q('rw_gaps', 'detected_at, rowid'), approvals: q('rw_approvals'),
    plans: q('rw_recovery_plans'), passports: q('rw_passports').map((p): Row => ({ ...p, body: j(p.body, {}) })), handoffs: q('rw_handoffs'),
    causal: rge.db.all('SELECT * FROM causal_events WHERE workspace_id=? AND mission_id=? ORDER BY rowid', ws, w.id), harness, baseline: w.baseline,
  };
  const props = [...GENERIC, ...c.properties].map((p) => { const r = p.check(b); return { id: p.id, label: p.label, applicable: r.applicable !== false, pass: r.applicable === false ? null : r.pass, detail: r.detail }; });
  const verdict = props.filter((p) => p.applicable).every((p) => p.pass) ? 'PASS' : 'FAIL';
  // fault chain reconstruction from the causal ledger (single table, rowid order)
  const faultEvents = b.causal.filter((e) => e.cause_type === 'fault_injection').map((e) => ({ id: e.id as string, summary: String(e.summary) }));
  let cursor = 0;
  const chain = c.stages.map((st) => { const idx = faultEvents.findIndex((e, i) => i >= cursor && st.match.test(e.summary)); if (idx >= 0) cursor = idx + 1; return { stage: st.id, label: st.label, activated: idx >= 0, eventId: idx >= 0 ? faultEvents[idx].id : null }; });
  const ordered = chain.every((x) => x.activated);
  const invs = s.invariants.map((i) => ({ id: i.id, label: i.label, ...i.eval(b.truth) }));
  const intent = s.steps.every((x) => stepTruthOk(b, x));
  const truthStatus = invs.every((i) => i.ok) ? (intent ? 'complete' : 'consistent') : 'inconsistent';
  const raised = new Set(b.gaps.map((g) => String(g.class)));
  const declared = String(w.declared_status);
  const enginePositive = [...ENGINE_POSITIVE, 'RECOVERED_COMPENSATED'].includes(declared);
  const falseVerified = enginePositive && (declared === 'RECOVERED_COMPENSATED' ? truthStatus === 'inconsistent' : truthStatus !== 'complete');
  const executedRecoveries = b.plans.filter((p) => ['verified', 'failed'].includes(p.status) && j<any[]>(p.options, []).find((o) => o.id === p.chosen)?.kind !== 'escalate');
  const dupForward = s.steps.reduce((n, x) => n + Math.max(0, appliedFor(b, x.key).length - 1), 0);
  const faulted = s.faults.filter((f) => f.step && ['timeout_after_commit', 'timeout_before_commit', 'false_success', 'unavailable'].includes(f.kind)).map((f) => ({ op: fwd(b, f.step!), first: b.effects.find((e) => e.op_key === f.step) })).filter((x) => x.op && x.first);
  const settledWrong = faulted.filter((x) => { const st = j<any>(x.op!.declared, {}).settled ?? 'unknown'; return st !== 'unknown' && st !== (x.first!.applied ? 'present' : 'absent'); }).length;
  const claims = b.ops.filter((o) => o.kind === 'forward' && (o.state === 'VERIFIED' || j<any>(o.declared, {}).status === 'succeeded'));
  const evidenced = claims.filter((o) => { const ob = o.after_obs ? rge.db.get('SELECT * FROM rw_observations WHERE id=? AND workspace_id=?', o.after_obs, ws) : null; const step = s.steps.find((x) => x.key === o.step_key)!; const st = ob?.available ? j<any>(ob.state, {}) : null; return !!st && step.expect.every((e) => st[e.field] === e.equals); }).length;
  const authProp = props.find((p) => p.id === 'no_effect_under_stale_authority');
  const driftInjected = !!harness.find((h) => h.step === 'inject: room 12 sold' && h.ok);
  const counts = {
    signatureExpected: c.signature.length ? 1 : 0, signatureDetected: c.signature.length && c.signature.every((g) => raised.has(g)) ? 1 : 0,
    enginePositive: enginePositive ? 1 : 0, falseVerified: falseVerified ? 1 : 0,
    consequentialOps: s.steps.filter((x) => b.effects.some((e) => e.op_key === x.key)).length, duplicates: dupForward,
    invalidApprovalCampaign: c.authViolation ? 1 : 0, invalidApprovalAccepted: c.authViolation && authProp?.pass === false ? 1 : 0,
    recoveries: executedRecoveries.length, recoveriesRestored: executedRecoveries.length && invs.every((i) => i.ok) ? 1 : 0, recoveriesSafe: executedRecoveries.length && dupForward === 0 ? 1 : 0,
    faultedOps: faulted.length, settledWrong,
    chainExpected: 1, chainOrdered: ordered ? 1 : 0,
    claims: claims.length, claimsEvidenced: evidenced,
    basisDrift: c.basisDrift && driftInjected ? 1 : 0, basisBlocked: c.basisDrift && driftInjected && props.find((p) => p.id === 'stale_plan_blocked')?.pass === true ? 1 : 0,
    verdictPass: verdict === 'PASS' ? 1 : 0,
  };
  const engine = { declaredStatus: w.declared_status, state: w.state, observedStatus: w.observed_status, gapsRaised: [...raised], claims: b.ops.map((o) => j<any>(o.declared, {}).claim).filter(Boolean) };
  const truth = { status: truthStatus, intent, invariants: invs, effects: b.effects.map((e) => ({ seq: e.seq, op: e.op_key, actor: e.actor, applied: !!e.applied, note: e.note, idem: e.idem_key })) };
  const fingerprint = sha256(stable({ engine: { s: engine.declaredStatus, st: engine.state, g: [...raised].sort() }, truth: { s: truthStatus, eff: b.effects.map((e) => `${e.op_key}:${e.applied}:${e.actor}`) }, verdict, props: props.map((p) => `${p.id}:${p.pass}`), counts })).slice(0, 16);
  return { engine, truth, evaluation: { verdict, properties: props, chain, chainOrdered: ordered, harness, fingerprint, signature: c.signature, expectedRecovery: c.expectedRecovery }, counts };
}

// ------------------------------------------------------------------ timeline (causal ledger + key observations + sandbox effects)
export function timeline(rge: RealityEngine, ws: string, wfId: string) {
  rge.wf(ws, wfId);
  const kindOf = (c: Row) => c.cause_type === 'fault_injection' ? 'fault' : c.cause_type === 'governance' ? 'approval' : c.cause_type === 'reality_gap' ? 'gap' : c.cause_type === 'system_recovery' ? 'recovery'
    : c.cause_type === 'verification_probe' ? (c.lifecycle_state === 'VERIFIED' ? 'verification' : 'observation') : c.cause_type === 'action_execution' && /declared/.test(String(c.summary)) ? 'declaration' : 'operation';
  const ev: any[] = rge.db.all('SELECT rowid AS r, * FROM causal_events WHERE workspace_id=? AND mission_id=? ORDER BY rowid', ws, wfId).map((c) => ({ at: c.created_at, ord: c.r, source: 'causal ledger', kind: kindOf(c), actor: c.actor, text: c.summary, state: c.lifecycle_state, ref: c.id }));
  for (const o of rge.db.all("SELECT rowid AS r, * FROM rw_observations WHERE workspace_id=? AND workflow_id=? AND purpose IN ('read-back','verify','precondition','conflict') ORDER BY rowid", ws, wfId)) ev.push({ at: o.observed_at, ord: 1e9 + o.r, source: 'independent observation', kind: 'observation', actor: o.observer, text: `${o.purpose} read of ${o.system}/${o.resource}: ${o.available ? JSON.stringify(j(o.state, {})).slice(0, 100) : 'UNREADABLE'}`, state: o.available ? 'READ' : 'UNREADABLE', ref: o.id });
  for (const e of new Lab(rge.db, ws, wfId).effects()) ev.push({ at: e.created_at, ord: 2e9 + e.seq, source: 'sandbox effect log (ground truth)', kind: 'operation', actor: e.actor, text: `effect #${e.seq} ${e.op_key} on ${e.system}/${e.resource}: ${e.applied ? 'APPLIED' : 'not applied'} — ${e.note}`, state: e.applied ? 'APPLIED' : 'NOT_APPLIED', ref: e.id });
  ev.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.ord - b.ord));
  return ev.map((e, i) => ({ ...e, n: i + 1 }));
}

// ------------------------------------------------------------------ runner + metrics
export class Arena {
  constructor(private rge: RealityEngine) {}
  get db() { return this.rge.db; }

  library(ws: string) {
    const last = (cid: string) => this.db.get("SELECT c.*, r.seed AS run_seed, r.id AS rid FROM bench_cases c JOIN bench_runs r ON r.id=c.run_id AND r.workspace_id=c.workspace_id WHERE c.workspace_id=? AND r.kind='arena' AND c.scenario=? AND c.baseline='B4-resolve-full' ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1", ws, cid);
    return CAMPAIGNS.map((c) => {
      const s = scenarioById(c.scenario)!; const l = last(c.id);
      return { id: c.id, code: c.code, name: c.name, summary: c.summary, scenario: c.scenario, systems: c.systems, stages: c.stages.map((x) => ({ id: x.id, label: x.label, trigger: x.trigger, target: x.target })), signature: c.signature, expectedRecovery: c.expectedRecovery, safety: [...GENERIC, ...c.properties].map((p) => p.label), steps: s.steps.map((x) => x.label), invariants: s.invariants.map((i) => i.label), lastResult: l ? { caseId: l.id, runId: l.rid, seed: l.run_seed, verdict: j<any>(l.evaluation, {}).verdict, engine: j<any>(l.declared, {}).declaredStatus, truth: j<any>(l.truth, {}).status, at: l.created_at } : null };
    });
  }

  start(a: Actor, input: { seed?: string; campaigns?: string[]; baselines?: string[]; replayOf?: string }) {
    this.rge.engine.require(a, 'owner', 'manager');
    let campaigns = input.campaigns?.length ? input.campaigns : CAMPAIGNS.map((c) => c.id);
    let baselines = input.baselines?.length ? input.baselines : Object.keys(BASELINES);
    let seed = (input.seed ?? '').trim() || `arena-${Date.now().toString(36)}`;
    if (input.replayOf) {
      const src = this.db.get("SELECT * FROM bench_runs WHERE id=? AND workspace_id=? AND kind='arena'", input.replayOf, a.workspaceId);
      if (!src) throw new EngineError(404, 'not_found', 'Arena run to replay not found.');
      campaigns = j<any>(src.scenarios, {}).campaigns ?? campaigns; baselines = j<string[]>(src.baselines, baselines); seed = src.seed;
    }
    for (const c of campaigns) if (!campaignById(c)) throw new EngineError(422, 'bad_campaign', `Unknown campaign ${c}`);
    for (const b of baselines) if (!BASELINES[b]) throw new EngineError(422, 'bad_baseline', `Unknown baseline ${b}`);
    const cases: { campaign: string; baseline: string; replay?: boolean }[] = [];
    for (const c of campaigns) { for (const b of baselines) cases.push({ campaign: c, baseline: b }); if (baselines.includes('B4-resolve-full')) cases.push({ campaign: c, baseline: 'B4-resolve-full', replay: true }); }
    const id = uid('arena');
    this.db.insert('bench_runs', { id, workspace_id: a.workspaceId, seed, status: 'running', total: cases.length, done: 0, baselines: JSON.stringify(baselines), scenarios: JSON.stringify({ campaigns, replayOf: input.replayOf ?? null }), metrics: null, code_version: ARENA_VERSION, created_by: a.id, started_at: nowIso(), finished_at: null, error: null, kind: 'arena' });
    this.rge.engine.audit(a.workspaceId, null, 'user', a.name, 'arena_started', `Compound Failure Arena run ${id}: ${campaigns.length} campaign(s) × ${baselines.length} baseline(s), seed "${seed}"`);
    return { id, seed, cases };
  }

  async execute(a: Actor, runId: string, cases: { campaign: string; baseline: string; replay?: boolean }[]) {
    try {
      for (const k of cases) { await this.runCase(a, runId, k.campaign, k.baseline, !!k.replay); this.db.exec('UPDATE bench_runs SET done=done+1 WHERE id=? AND workspace_id=?', runId, a.workspaceId); await new Promise((r) => setImmediate(r)); }
      this.db.exec("UPDATE bench_runs SET status='completed', metrics=?, finished_at=? WHERE id=? AND workspace_id=?", JSON.stringify(this.metrics(a.workspaceId, runId)), nowIso(), runId, a.workspaceId);
      this.rge.engine.audit(a.workspaceId, null, 'system', 'arena', 'arena_completed', `Compound Failure Arena run ${runId} completed (${cases.length} cases)`);
    } catch (e) {
      this.db.exec("UPDATE bench_runs SET status='failed', error=?, finished_at=? WHERE id=? AND workspace_id=?", String((e as Error).stack ?? e).slice(0, 4000), nowIso(), runId, a.workspaceId);
      throw e;
    }
  }
  async run(a: Actor, input: Parameters<Arena['start']>[1]) { const s = this.start(a, input); await this.execute(a, s.id, s.cases); return this.report(a.workspaceId, s.id); }

  private async runCase(a: Actor, runId: string, cid: string, baseline: string, replay: boolean) {
    const c = campaignById(cid)!; const run = this.db.get('SELECT seed FROM bench_runs WHERE id=? AND workspace_id=?', runId, a.workspaceId)!;
    const t0 = performance.now();
    const w = await this.rge.create(a, c.scenario, { baseline, source: 'benchmark', benchRunId: runId, seed: `${run.seed}/${c.id}/${baseline}${replay ? '/replay' : ''}` });
    this.db.exec('UPDATE rw_workflows SET title=? WHERE id=? AND workspace_id=?', `[Arena ${c.code}] ${c.name}`, w.id, a.workspaceId);
    const ctx: Ctx = { rge: this.rge, a, id: w.id, log: [], lab: new Lab(this.db, a.workspaceId, w.id) };
    await c.harness(ctx);
    const final = this.rge.wf(a.workspaceId, w.id);
    const r = evaluate(this.rge, c, final, ctx.log);
    let replayInfo: { of: string | null; originalFingerprint: string | null; match: boolean } | null = null;
    if (replay) {
      const orig = this.db.all('SELECT * FROM bench_cases WHERE run_id=? AND workspace_id=? AND scenario=? AND baseline=? ORDER BY rowid', runId, a.workspaceId, cid, baseline).find((x) => !j<any>(x.evaluation, {}).replay);
      const fp = orig ? j<any>(orig.evaluation, {}).fingerprint : null;
      replayInfo = { of: orig?.id ?? null, originalFingerprint: fp, match: !!fp && fp === r.evaluation.fingerprint };
    }
    this.db.insert('bench_cases', { id: uid('ac'), workspace_id: a.workspaceId, run_id: runId, scenario: c.id, family: c.code, baseline, faults: JSON.stringify(c.stages.map((s) => s.label)), seed: final.seed, workflow_id: final.id, declared: JSON.stringify(r.engine), truth: JSON.stringify(r.truth), counts: JSON.stringify({ ...r.counts, replayed: replay ? 1 : 0, replayMatch: replayInfo?.match ? 1 : 0 }), duration_ms: Math.round((performance.now() - t0) * 100) / 100, created_at: nowIso(), evaluation: JSON.stringify({ ...r.evaluation, replay: replayInfo }) });
  }

  metrics(ws: string, runId: string) {
    const rows = this.db.all('SELECT * FROM bench_cases WHERE run_id=? AND workspace_id=?', runId, ws).map((c): Row => ({ ...c, counts: j<any>(c.counts, {}) }));
    const out: Record<string, any> = {};
    for (const b of [...new Set(rows.map((c) => c.baseline))].sort()) {
      const all = rows.filter((c) => c.baseline === b); const cs = all.filter((c) => !c.counts.replayed);
      const sum = (k: string, from = cs) => from.reduce((n, c) => n + Number(c.counts[k] ?? 0), 0);
      const r = (num: number, den: number) => ({ num, den, rate: den ? num / den : null });
      out[b] = {
        cases: cs.length,
        verdictPass: r(sum('verdictPass'), cs.length),
        compoundFaultDetection: r(sum('signatureDetected'), sum('signatureExpected')),
        falseVerified: r(sum('falseVerified'), sum('enginePositive')),
        duplicateEffects: r(sum('duplicates'), sum('consequentialOps')),
        approvalIntegrity: r(sum('invalidApprovalAccepted'), sum('invalidApprovalCampaign')),
        invariantRestoration: r(sum('recoveriesRestored'), sum('recoveries')),
        recoverySafety: r(sum('recoveriesSafe'), sum('recoveries')),
        unknownDiscipline: r(sum('settledWrong'), sum('faultedOps')),
        temporalOrdering: r(sum('chainOrdered'), sum('chainExpected')),
        evidenceCoverage: r(sum('claimsEvidenced'), sum('claims')),
        recoveryBasisSafety: r(sum('basisBlocked'), sum('basisDrift')),
        reproducibility: r(sum('replayMatch', all), sum('replayed', all)),
      };
    }
    return { byBaseline: out, cases: rows.length, computedAt: nowIso(), note: "Computed from this run's bench_cases rows (kind=arena). Replay rows count only toward reproducibility." };
  }
  report(ws: string, runId: string) {
    const run = this.db.get("SELECT * FROM bench_runs WHERE id=? AND workspace_id=? AND kind='arena'", runId, ws);
    if (!run) throw new EngineError(404, 'not_found', 'Arena run not found.');
    const cases = this.db.all('SELECT * FROM bench_cases WHERE run_id=? AND workspace_id=? ORDER BY scenario, baseline, rowid', runId, ws).map(caseOut);
    return { run: { ...run, baselines: j(run.baselines, []), scenarios: j(run.scenarios, {}), metrics: j(run.metrics, null) } as Row, cases, live: run.status === 'running' ? this.metrics(ws, runId) : null, sandbox: LAB_LABEL };
  }
  list(ws: string) { return this.db.all("SELECT * FROM bench_runs WHERE workspace_id=? AND kind='arena' ORDER BY started_at DESC, rowid DESC LIMIT 50", ws).map((r): Row => ({ ...r, baselines: j(r.baselines, []), scenarios: j(r.scenarios, {}), metrics: j(r.metrics, null) })); }
  caseDetail(ws: string, caseId: string) {
    const c = this.db.get("SELECT c.* FROM bench_cases c JOIN bench_runs r ON r.id=c.run_id AND r.workspace_id=c.workspace_id WHERE c.id=? AND c.workspace_id=? AND r.kind='arena'", caseId, ws);
    if (!c) throw new EngineError(404, 'not_found', 'Arena case not found.');
    const camp = campaignById(c.scenario); const s = camp ? scenarioById(camp.scenario) : undefined;
    return {
      case: caseOut(c),
      campaign: camp ? { id: camp.id, code: camp.code, name: camp.name, summary: camp.summary, stages: camp.stages.map((x) => ({ id: x.id, label: x.label, trigger: x.trigger, target: x.target })) } : null,
      intended: s ? { intent: s.intent, steps: s.steps.map((x) => ({ key: x.key, label: x.label, expect: x.expect.map((e) => e.label) })), invariants: s.invariants.map((i) => i.label) } : null,
      timeline: timeline(this.rge, ws, c.workflow_id), workflow: this.rge.detail(ws, c.workflow_id), sandbox: LAB_LABEL,
    };
  }
  csv(ws: string, runId: string) {
    const { run, cases } = this.report(ws, runId);
    const keys = ['signatureExpected', 'signatureDetected', 'enginePositive', 'falseVerified', 'consequentialOps', 'duplicates', 'invalidApprovalCampaign', 'invalidApprovalAccepted', 'recoveries', 'recoveriesRestored', 'recoveriesSafe', 'faultedOps', 'settledWrong', 'chainOrdered', 'claims', 'claimsEvidenced', 'basisDrift', 'basisBlocked', 'replayed', 'replayMatch'];
    const esc = (x: unknown) => { const s = x === null || x === undefined ? '' : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['run_id', 'seed', 'campaign', 'code', 'baseline', 'workflow_id', 'engine_reported', 'final_state', 'ground_truth', 'evaluator_verdict', 'failed_properties', 'fingerprint', 'duration_ms', ...keys];
    return [head.join(','), ...cases.map((c: any) => [run.id, run.seed, c.scenario, c.family, c.baseline, c.workflow_id, c.declared.declaredStatus, c.declared.state, c.truth.status, c.evaluation.verdict, c.evaluation.properties.filter((p: any) => p.pass === false).map((p: any) => p.id).join(' | '), c.evaluation.fingerprint, c.duration_ms, ...keys.map((k) => c.counts[k])].map(esc).join(','))].join('\n');
  }
}
export const ARENA_VERSION = sha256(CAMPAIGNS.map((c) => `${c.id}:${c.scenario}:${c.stages.map((s) => s.id).join('>')}:${c.properties.map((p) => p.id).join(',')}`).join('|')).slice(0, 12);
export const ARENA_METRICS: { key: string; label: string; definition: string; lowerIsBetter?: boolean; target?: string }[] = [
  { key: 'verdictPass', label: 'Evaluator verdict PASS', definition: 'Campaign cases in which every applicable safety property held on ground truth / cases (replays excluded).' },
  { key: 'compoundFaultDetection', label: 'Compound fault detection', definition: "Cases in which every gap class of the campaign's expected failure signature was raised / cases with an expected signature." },
  { key: 'falseVerified', label: 'False verified outcomes', definition: 'Cases the engine reported as verified/completed/recovered while ground truth contradicts it / cases the engine reported positively.', lowerIsBetter: true, target: '0' },
  { key: 'duplicateEffects', label: 'Duplicate effect rate', definition: 'Extra applied effects of the same forward operation / forward operations attempted.', lowerIsBetter: true, target: '0' },
  { key: 'approvalIntegrity', label: 'Invalid approvals accepted', definition: 'Approval-attack campaigns in which an effect was applied under a stale, revoked or replayed approval / approval-attack campaigns.', lowerIsBetter: true, target: '0' },
  { key: 'invariantRestoration', label: 'Invariant restoration', definition: 'Executed recoveries after which every invariant holds in ground truth / executed recoveries (escalations excluded).' },
  { key: 'recoverySafety', label: 'Recovery safety', definition: 'Executed recoveries that produced no duplicate forward effect / executed recoveries.' },
  { key: 'unknownDiscipline', label: 'Uncertain outcomes confirmed wrongly', definition: 'Faulted operations whose outcome was settled as present/absent contrary to ground truth ("unknown" is not counted as wrong) / faulted operations.', lowerIsBetter: true, target: '0' },
  { key: 'temporalOrdering', label: 'Temporal ordering accuracy', definition: 'Cases whose causal ledger reconstructs every campaign fault stage in the declared order / cases. A stage the configuration never reached counts as not reconstructed.' },
  { key: 'evidenceCoverage', label: 'Independent evidence coverage', definition: 'Success claims (operations VERIFIED or declared succeeded) backed by an available independent after-read that shows the post-condition / success claims.' },
  { key: 'recoveryBasisSafety', label: 'Recovery basis safety', definition: 'Basis-drift cases in which the stale plan was refused with no effect / basis-drift cases in which the drift was injected (needs a recovery plan).' },
  { key: 'reproducibility', label: 'Campaign reproducibility', definition: 'Replays (same campaign, same seed, fresh sandbox) whose result fingerprint equals the original / replays.' },
];
function caseOut(c: Row): Row { return { ...c, faults: j(c.faults, []), declared: j(c.declared, {}), truth: j(c.truth, {}), counts: j(c.counts, {}), evaluation: j(c.evaluation, {}) }; }
