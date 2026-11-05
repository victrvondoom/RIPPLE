import type { Patch } from '../types.js';
import { refKey, type AltContext, type Alternative, type DomainPack, type OpDef, type PlanAction } from './types.js';

/**
 * Cross-domain DOMAIN PACKS. A pack contributes sandbox systems, typed resource types, typed evaluators and
 * alternative generators. Packs are configuration: the CDII engine never branches on a pack id. A pack may only
 * propose actions on workflows that belong to it (the engine enforces this).
 * All systems are Reality Lab sandbox systems — not production integrations.
 */

// ------------------------------------------------------------------ op builders used by scenarios
export const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
export function reserve(key: string, label: string, system: string, resource: string, holder: string, extra: Partial<OpDef> = {}): OpDef {
  return { key, label, system, resource, patch: { set: { holder }, expect: { holder: null } }, effect: { kind: 'reserve', holder, amount: 1 }, reversibility: 'compensable', compensate: { label: `Release ${resource}`, patch: { set: { holder: null } } }, expect: [{ field: 'holder', equals: holder }], ...extra };
}
export function seats(key: string, label: string, system: string, resource: string, n: number, holder: string, extra: Partial<OpDef> = {}): OpDef {
  return { key, label, system, resource, patch: { inc: { used: n } }, effect: { kind: 'reserve', amount: n, holder, field: 'used' }, reversibility: 'compensable', compensate: { label: `Release ${n} seats`, patch: { inc: { used: -n } } }, expect: [], ...extra };
}
export function spend(key: string, label: string, budget: string, cents: number, extra: Partial<OpDef> = {}): OpDef {
  return { key, label, system: 'budget', resource: budget, patch: { inc: { spent_cents: cents } }, effect: { kind: 'spend', amount: cents, field: 'spent_cents' }, reversibility: 'compensable', compensate: { label: `Return ${usd(cents)} to ${budget}`, patch: { inc: { spent_cents: -cents } } }, expect: [], approvalLevel: 'owner', ...extra };
}
export function capture(key: string, label: string, resource: string, cents: number, forUnit: string, extra: Partial<OpDef> = {}): OpDef {
  return { key, label, system: 'payments', resource, patch: { set: { status: 'captured', for: forUnit }, inc: { captured_cents: cents } }, effect: { kind: 'consume', amount: cents }, reversibility: 'compensable', compensate: { label: `Refund ${usd(cents)}`, patch: { set: { status: 'refunded' }, inc: { captured_cents: -cents, refunded_cents: cents } } }, expect: [{ field: 'status', equals: 'captured' }], ...extra };
}
export function setState(key: string, label: string, system: string, resource: string, set: Record<string, unknown>, extra: Partial<OpDef> = {}): OpDef {
  return { key, label, system, resource, patch: { set }, effect: { kind: 'modify' }, reversibility: 'reversible', expect: Object.entries(set).map(([field, equals]) => ({ field, equals })), ...extra };
}
/** Calendar commitment. The executor materializes the slot list from a fresh read (see engine `materialize`). */
export function schedule(key: string, label: string, resource: string, holder: string, window: [number, number], extra: Partial<OpDef> = {}): OpDef {
  return { key, label, system: 'scheduling', resource, patch: { inc: { slot_count: 1 } }, effect: { kind: 'schedule', holder, window, field: 'slots' }, reversibility: 'compensable', expect: [], ...extra };
}
export const dayMin = (day: number, h: number, m = 0) => (day - 1) * 1440 + h * 60 + m;

// ------------------------------------------------------------------ shared alternative helpers (used by packs for THEIR workflows)
/** The op as the plan currently has it (after earlier modifications). */
export function effective(ctx: Pick<AltContext, 'actions' | 'workflows'>, wf: string, op: string): OpDef | undefined {
  const base = ctx.workflows.find((w) => w.key === wf)?.ops.find((o) => o.key === op)
    ?? ctx.actions.find((a) => a.workflow === wf && a.op === op && a.kind === 'add')?.newOp;
  if (!base) return undefined;
  const mod = ctx.actions.find((a) => a.workflow === wf && a.op === op && a.kind === 'modify');
  if (!mod?.override) return base;
  const r = mod.override.resource;
  const [s, res] = r ? [r.slice(0, r.indexOf('/')), r.slice(r.indexOf('/') + 1)] : [base.system, base.resource];
  return { ...base, system: s, resource: res, patch: mod.override.patch ?? base.patch, label: mod.override.label ?? base.label, expect: mod.override.expect ?? base.expect, effect: mod.override.effect ?? base.effect };
}
/** Ops of this pack's workflows that the plan still executes. */
function liveOps(ctx: AltContext, packId: string) {
  const out: { wf: string; op: OpDef }[] = [];
  for (const w of ctx.workflows.filter((x) => x.pack === packId)) {
    for (const a of ctx.actions.filter((x) => x.workflow === w.key && ['execute', 'modify', 'add'].includes(x.kind))) {
      const op = effective(ctx, w.key, a.op); if (op) out.push({ wf: w.key, op });
    }
  }
  return out;
}
const modify = (wf: string, op: OpDef, over: PlanAction['override'], note: string): PlanAction => ({ workflow: wf, op: op.key, kind: 'modify', override: over, note });
const targetRef = (ctx: AltContext): string | null => { const s = ctx.invariant.spec as { ref?: { system: string; resource: string } }; return s.ref ? refKey(s.ref) : null; };
const hm = (m: number) => `day ${Math.floor(m / 1440) + 1} ${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function flexAlternatives(packId: string, ctx: AltContext): Alternative[] {
  const out: Alternative[] = []; const t = targetRef(ctx); const sp = ctx.invariant.spec;
  if (!t) return out;
  for (const { wf, op } of liveOps(ctx, packId)) {
    if (refKey(op) !== t) continue;
    // Uniqueness: substitute an equivalent free unit of the same class (searched in the observed world).
    if (sp.type === 'uniqueness' && ['reserve', 'consume'].includes(op.effect.kind)) {
      const cls = ctx.read(t)?.class;
      const taken = new Set(ctx.actions.map((a) => { const e = effective(ctx, a.workflow, a.op); return e ? refKey(e) : ''; }));
      const sub = ctx.world.find((k) => k !== t && k.startsWith(`${op.system}/`) && cls !== undefined && ctx.read(k)?.class === cls && (ctx.read(k)?.holder ?? null) === null && !taken.has(k));
      if (sub) {
        const res = sub.slice(sub.indexOf('/') + 1);
        out.push({ id: `${packId}.substitute.${wf}.${op.key}`, label: `${wf}: use ${sub} instead of ${t}`, rationale: `${t} is already claimed; ${sub} is an equivalent free unit (class "${String(cls)}") in the observed world.`, actions: [modify(wf, op, { resource: sub, label: `${op.label} → ${res}`, patch: { ...op.patch, expect: { holder: null } }, expect: op.expect }, `substitute ${op.resource} → ${res}`)] });
      }
    }
    // Capacity / budget: move the commitment to a declared alternate pool, or shrink it to its declared minimum.
    if (sp.type === 'capacity' || sp.type === 'budget') {
      for (const alt of op.flex?.alternates ?? []) {
        const st = ctx.read(alt); if (!st) continue;
        const room = sp.type === 'capacity' ? Number(st.capacity ?? 0) - Number(st.used ?? 0) : Number(st.limit_cents ?? 0) - Number(st.spent_cents ?? 0);
        if (room >= Number(op.effect.amount ?? 0)) out.push({ id: `${packId}.move.${wf}.${op.key}.${alt}`, label: `${wf}: move "${op.label}" to ${alt}`, rationale: `${alt} has room (${sp.type === 'budget' ? usd(room) : room}) for the full ${sp.type === 'budget' ? usd(Number(op.effect.amount)) : op.effect.amount}.`, actions: [modify(wf, op, { resource: alt, label: `${op.label} → ${alt}` }, `move to ${alt}`)] });
      }
      if (op.flex?.minAmount !== undefined && op.flex.minAmount < Number(op.effect.amount ?? 0) && op.effect.field) {
        const m = op.flex.minAmount; const patch: Patch = { ...op.patch, inc: { ...(op.patch.inc ?? {}), [op.effect.field]: m } };
        out.push({ id: `${packId}.shrink.${wf}.${op.key}`, label: `${wf}: reduce "${op.label}" to ${sp.type === 'budget' ? usd(m) : m}`, rationale: `The plan declares ${sp.type === 'budget' ? usd(m) : m} as its minimum acceptable amount.`, actions: [modify(wf, op, { patch, effect: { ...op.effect, amount: m }, label: `${op.label} (reduced to ${sp.type === 'budget' ? usd(m) : m})` }, 'shrink to declared minimum')] });
      }
    }
    // Mutual exclusion: move a calendar commitment to a declared alternative window.
    if (sp.type === 'mutual_exclusion' && op.effect.kind === 'schedule') {
      for (const w of op.flex?.windows ?? []) out.push({ id: `${packId}.reschedule.${wf}.${op.key}.${w[0]}`, label: `${wf}: reschedule "${op.label}" to ${hm(w[0])}–${hm(w[1]).slice(-5)}`, rationale: 'The plan declares this alternative window; the simulation checks it against every other commitment.', actions: [modify(wf, op, { effect: { ...op.effect, window: w }, label: `${op.label} → ${hm(w[0])}` }, 'reschedule')] });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the packs
const travel: DomainPack = {
  id: 'travel', label: 'Travel & Bookings', domain: 'Booking',
  description: 'Guest bookings and event-space capacity. Proposes alternate event spaces declared by the plan.',
  systems: [{ system: 'bookings', label: 'Booking system (sandbox)', agent: 'exec.bookings' }],
  resourceTypes: [{ type: 'event-space', system: 'bookings', fields: ['capacity', 'used'], description: 'A hall or terrace with seat capacity' }, { type: 'booking', system: 'bookings', fields: ['status', 'guest'], description: 'A guest booking record' }],
  alternatives: (ctx) => flexAlternatives('travel', ctx),
};

const inventory: DomainPack = {
  id: 'inventory', label: 'Inventory & Fulfilment', domain: 'Inventory',
  description: 'Room-night and equipment units, stock holds, shipments. Proposes unit substitution and refuses releases of units that moved to another holder.',
  systems: [{ system: 'inventory', label: 'Inventory system (sandbox)', agent: 'exec.inventory' }, { system: 'shipping', label: 'Shipping carrier (sandbox)', agent: 'exec.shipping' }],
  resourceTypes: [{ type: 'unit', system: 'inventory', fields: ['holder', 'class'], description: 'One reservable unit (room-night, AV kit, stock item)' }, { type: 'shipment', system: 'shipping', fields: ['status'], description: 'A carrier shipment' }],
  alternatives: (ctx) => {
    const out = flexAlternatives('inventory', ctx);
    // A compensation that releases a unit which another workflow now holds would take it from that workflow: cancel it.
    const sp = ctx.invariant.spec;
    const units: string[] = sp.type === 'consistency' && sp.rule === 'implies' ? [refKey(sp.then)] : sp.type === 'uniqueness' ? [refKey(sp.ref)] : [];
    for (const { wf, op } of liveOps(ctx, 'inventory')) {
      if (op.effect.kind !== 'release' || !units.includes(refKey(op))) continue;
      const holder = ctx.read(refKey(op))?.holder;
      // `read` is the simulated plan state; the release already ran there, so look at what the release found (recorded by the engine).
      const found = ctx.read(`${refKey(op)}#before:${wf}:${op.key}`)?.holder;
      const prior = found !== undefined ? found : holder;
      if (prior !== undefined && prior !== null && prior !== op.effect.holder) out.push({ id: `inventory.skip-release.${wf}.${op.key}`, label: `${wf}: do not release ${refKey(op)} (now held by ${String(prior)})`, rationale: `The release was planned when ${op.effect.holder} held the unit. It is now held by ${String(prior)}; releasing it would take it from another workflow. The unit is no longer ${op.effect.holder}'s, so this compensation step is moot.`, actions: [{ workflow: wf, op: op.key, kind: 'cancel', note: 'release is moot: unit transferred to another holder' }] });
    }
    return out;
  },
};

const payments: DomainPack = {
  id: 'payments', label: 'Payments & Ledger', domain: 'Payments',
  description: 'Captures, refunds and ledger postings. Proposes re-pointing a captured deposit to the unit its party actually holds, or a refund when nothing can be delivered. Never moves real money (sandbox).',
  systems: [{ system: 'payments', label: 'Payment processor (sandbox)', agent: 'exec.payments' }, { system: 'ledger', label: 'General ledger (sandbox)', agent: 'exec.ledger' }],
  resourceTypes: [{ type: 'payment', system: 'payments', fields: ['status', 'captured_cents', 'for'], description: 'A captured or authorized payment for a unit' }],
  alternatives: (ctx) => {
    const out: Alternative[] = []; const sp = ctx.invariant.spec;
    if (sp.type !== 'consistency') return out;
    const pk = refKey(sp.if);
    for (const w of ctx.workflows.filter((x) => x.pack === 'payments')) {
      const cap = w.ops.find((o) => refKey(o) === pk && o.effect.kind === 'consume');
      if (!cap) continue;
      if (sp.rule === 'pointer') {
        const current = ctx.read(refKey(sp.pointer))?.[sp.pointer.field];
        const cls = current ? ctx.read(`${sp.targetSystem}/${String(current)}`)?.class : undefined;
        // same class as the unit the deposit was taken for (a suite deposit stays a suite deposit)
        const unit = ctx.world.find((k) => k.startsWith(`${sp.targetSystem}/`) && ctx.read(k)?.[sp.targetField] === sp.equals && (cls === undefined || ctx.read(k)?.class === cls));
        if (unit) {
          const res = unit.slice(unit.indexOf('/') + 1);
          out.push({ id: `payments.repoint.${w.key}.${res}`, label: `${w.key}: re-point the captured deposit to ${unit}`, rationale: `In the simulated plan "${String(sp.equals)}" holds ${unit}; the deposit must reference the unit actually held. No money moves.`, actions: [{ workflow: w.key, op: `repoint-${res}`, kind: 'add', newOp: { key: `repoint-${res}`, label: `Re-point deposit ${sp.if.resource} to ${res}`, system: 'payments', resource: sp.if.resource, patch: { set: { [sp.pointer.field]: res } }, effect: { kind: 'modify' }, reversibility: 'reversible', expect: [{ field: sp.pointer.field, equals: res }] } }] });
        }
      }
      if (cap.compensate && ['applied', 'verified'].includes(w.status[cap.key])) out.push({ id: `payments.refund.${w.key}`, label: `${w.key}: refund the capture (${cap.compensate.label})`, rationale: 'Nothing can be delivered for this payment; a refund restores consistency. A refund is a compensating write, not an undo.', actions: [{ workflow: w.key, op: cap.key, kind: 'compensate', note: cap.compensate.label }] });
    }
    return out;
  },
};

const release: DomainPack = {
  id: 'release', label: 'Release & Deployment', domain: 'Deployment',
  description: 'Service deploys and published data contracts in the sandbox. Contributes a health evaluator, an expand/contract (backward-compatible) alternative and a roll-back recovery whose consequences are simulated, never assumed.',
  systems: [{ system: 'deploy', label: 'Deploy controller (sandbox)', agent: 'exec.deploy' }, { system: 'warehouse', label: 'Contract registry (sandbox)', agent: 'exec.warehouse' }],
  resourceTypes: [{ type: 'service', system: 'deploy', fields: ['version', 'serves'], description: 'A deployed service and the schema versions it serves' }, { type: 'contract', system: 'warehouse', fields: ['schema_version', 'compatible_with'], description: 'A published data contract' }],
  evaluators: {
    health_ok: (p, read) => { const st = read(String(p.ref)); const e = Number(st?.error_rate ?? 1); return { ok: e < Number(p.max ?? 0.02), detail: `${String(p.ref)} error rate ${(e * 100).toFixed(2)}% (limit ${(Number(p.max ?? 0.02) * 100).toFixed(1)}%)` }; },
  },
  alternatives: (ctx) => {
    const out: Alternative[] = []; const sp = ctx.invariant.spec;
    if (sp.type !== 'lineage') return out;
    const up = refKey(sp.upstream); const expected = ctx.read(refKey(sp.downstream))?.[sp.expectsField];
    for (const { wf, op } of liveOps(ctx, 'release')) {
      if (refKey(op) !== up || op.effect.kind !== 'publish') continue;
      const planned = op.patch.set?.[sp.compatField]; const list = Array.isArray(planned) ? planned as unknown[] : [planned];
      if (expected === undefined || list.includes(expected)) continue;
      const compat = [...new Set([expected, ...list])];
      const svc = op.flex?.alternates?.[0];
      const acts: PlanAction[] = [modify(wf, op, { patch: { ...op.patch, set: { ...(op.patch.set ?? {}), [sp.compatField]: compat } }, expect: [{ field: sp.compatField, equals: compat }], label: `${op.label} (expand/contract: keep ${String(expected)} compatible)` }, 'expand/contract')];
      if (svc) acts.push({ workflow: wf, op: `compat-view-${String(expected)}`, kind: 'add', newOp: { key: `compat-view-${String(expected)}`, label: `Enable ${String(expected)} compatibility view on ${svc}`, system: svc.slice(0, svc.indexOf('/')), resource: svc.slice(svc.indexOf('/') + 1), patch: { set: { compat_view: expected } }, effect: { kind: 'modify' }, reversibility: 'reversible', expect: [{ field: 'compat_view', equals: expected }] } });
      out.push({ id: `release.expand-contract.${wf}.${op.key}`, label: `${wf}: publish the new contract as backward compatible (${compat.join(' + ')})`, rationale: `${refKey(sp.downstream)} still expects ${String(expected)}. Publishing ${compat.join(' + ')} with a compatibility view keeps every consumer valid while the new schema rolls out.`, actions: acts });
    }
    return out;
  },
  recoveries: (ctx) => {
    const out: Alternative[] = [];
    for (const w of ctx.workflows.filter((x) => x.pack === 'release')) {
      const applied = w.ops.filter((o) => ['applied', 'verified'].includes(w.status[o.key]) && o.compensate);
      if (!applied.length) continue;
      out.push({ id: `release.rollback.${w.key}`, label: `${w.key}: roll back the deployment (${applied.map((o) => o.compensate!.label).join(', ')})`, rationale: 'The conventional recovery for a breaking release. It is simulated against every protected invariant before it can be offered.', actions: [...applied.map((o) => ({ workflow: w.key, op: o.key, kind: 'compensate' as const, note: o.compensate!.label })), ...w.ops.filter((o) => w.status[o.key] === 'pending').map((o) => ({ workflow: w.key, op: o.key, kind: 'cancel' as const, note: 'cancelled by rollback' }))] });
    }
    return out;
  },
};

const data: DomainPack = {
  id: 'data', label: 'Data Lineage & Analytics', domain: 'Analytics',
  description: 'Downstream analytics consumers, dashboards and backfills. Declares which contract version each consumer expects.',
  systems: [{ system: 'analytics', label: 'Analytics platform (sandbox)', agent: 'exec.analytics' }],
  resourceTypes: [{ type: 'consumer', system: 'analytics', fields: ['expects_schema', 'status'], description: 'A dashboard or job consuming a data contract' }],
  alternatives: (ctx) => flexAlternatives('data', ctx),
};

const finance: DomainPack = {
  id: 'finance', label: 'Budget & Procurement', domain: 'Finance',
  description: 'Budget lines, purchase orders and spend commitments. Proposes deferring a commitment to a declared alternate budget line or shrinking it to its declared minimum.',
  systems: [{ system: 'budget', label: 'Budget ledger (sandbox)', agent: 'exec.budget' }, { system: 'procurement', label: 'Procurement system (sandbox)', agent: 'exec.procurement' }],
  resourceTypes: [{ type: 'budget-line', system: 'budget', fields: ['limit_cents', 'spent_cents'], description: 'An authorized spending limit' }, { type: 'purchase-order', system: 'procurement', fields: ['status', 'amount_cents'], description: 'A purchase order' }],
  alternatives: (ctx) => flexAlternatives('finance', ctx),
};

const scheduling: DomainPack = {
  id: 'scheduling', label: 'People & Scheduling', domain: 'Scheduling',
  description: 'Crew calendars and contractor hours. Proposes declared alternative windows for calendar commitments and declared minimum hours.',
  systems: [{ system: 'scheduling', label: 'Scheduling system (sandbox)', agent: 'exec.scheduling' }],
  resourceTypes: [{ type: 'calendar', system: 'scheduling', fields: ['slots', 'slot_count'], description: "A person's or crew's calendar" }],
  alternatives: (ctx) => flexAlternatives('scheduling', ctx),
};

export const CD_PACKS: DomainPack[] = [travel, inventory, payments, release, data, finance, scheduling];
export const cdPack = (id: string) => CD_PACKS.find((p) => p.id === id);
