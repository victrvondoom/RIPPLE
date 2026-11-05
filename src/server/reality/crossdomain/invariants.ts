import type { ResourceState } from '../types.js';
import { refKey, type Commitment, type EvalResult, type Evaluation, type InvariantDef, type PackEvaluator } from './types.js';

/**
 * Safe typed evaluator for cross-domain invariants. A closed `switch` over InvariantSpec['type']: no eval, no dynamic
 * code, no expression strings. Every result is satisfied / violated / unknown / not_applicable, and UNKNOWN is never
 * treated as satisfied by any caller (an unreadable read makes the invariant unknown, which blocks execution).
 */
export interface EvalCtx {
  read(ref: string): ResourceState | undefined;
  commitments: Commitment[];
  /** workflow keys that have an op (applied or pending) on a resource */
  touching(ref: string): string[];
  isActive(workflow: string): boolean;
  opStatus(workflow: string, op: string): string | undefined;   // pending | applied | verified | failed | unknown | rejected | cancelled | compensated
  opSeq(workflow: string, op: string): number | undefined;
  declaredComplete(workflow: string): boolean;
  authority(workflow: string, role: 'manager' | 'owner'): { ok: boolean; detail: string } | undefined;
  freshness(workflow: string, ref: string): { basisHash: string | null; currentHash: string | null; readable: boolean } | undefined;
  claims(workflow: string): { op: string; evidence: string | null }[];
  packEvaluator(pack: string, name: string): PackEvaluator | undefined;
  /** results of the same invariants BEFORE a simulated plan (recovery_safety only) */
  before?: Map<string, EvalResult>;
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const fmt = (v: unknown) => JSON.stringify(v ?? null);
const overlap = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
const hhmm = (m: number) => `d${Math.floor(m / 1440) + 1} ${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function evaluate(def: InvariantDef, ctx: EvalCtx, prior?: Map<string, Evaluation>): Evaluation {
  const reads: string[] = []; const unreadable: string[] = [];
  const rd = (k: string) => { reads.push(k); const s = ctx.read(k); if (s === undefined) unreadable.push(k); return s; };
  const out = (result: EvalResult, detail: string, participants: string[] = []): Evaluation =>
    ({ key: def.key, result: unreadable.length && result !== 'not_applicable' ? 'unknown' : result, detail: unreadable.length && result !== 'not_applicable' ? `cannot evaluate: ${[...new Set(unreadable)].join(', ')} unreadable (unknown is never treated as satisfied)` : detail, reads: [...new Set(reads)], participants: [...new Set(participants)].sort(), unreadable: [...new Set(unreadable)] });
  const sp = def.spec;
  if (def.strength === 'conditional' && def.conditionWorkflow && !ctx.isActive(def.conditionWorkflow)) return out('not_applicable', `condition not met: ${def.conditionWorkflow} is not active`);
  switch (sp.type) {
    case 'uniqueness': {
      const k = refKey(sp.ref); const st = rd(k);
      const holders = new Map<string, string>();
      const h = st?.[sp.holderField];
      if (h !== null && h !== undefined && h !== '') holders.set(String(h), 'observed');
      for (const c of ctx.commitments.filter((x) => x.ref === k)) {
        const who = c.holder ?? c.workflow;
        if (c.kind === 'release' && holders.has(who)) holders.delete(who);
        if (['reserve', 'consume'].includes(c.kind) && !holders.has(who)) holders.set(who, `planned by ${c.workflow}:${c.op}`);
      }
      const list = [...holders.entries()];
      return out(list.length <= 1 ? 'satisfied' : 'violated', list.length ? `${k}.${sp.holderField}: ${list.map(([who, how]) => `${who} (${how})`).join(' + ')}${list.length > 1 ? ` — ${list.length} claimants for one unit` : ''}` : `${k} is unclaimed`, [...list.map(([who]) => who), ...ctx.touching(k)]);
    }
    case 'capacity':
    case 'budget': {
      const k = refKey(sp.ref); const st = rd(k);
      const capF = sp.type === 'capacity' ? sp.capacityField : sp.limitField; const usedF = sp.type === 'capacity' ? sp.usedField : sp.spentField;
      const kinds = sp.type === 'capacity' ? ['reserve', 'consume', 'schedule'] : ['spend'];
      const cap = num(st?.[capF]); const used = num(st?.[usedF]);
      const cs = ctx.commitments.filter((x) => x.ref === k && (kinds.includes(x.kind) || x.kind === 'release'));
      const demand = cs.reduce((n, c) => n + (c.kind === 'release' ? -c.amount : c.amount), 0);
      const total = used + demand;
      const unit = sp.type === 'budget' ? (v: number) => `$${(v / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : (v: number) => String(v);
      return out(total <= cap ? 'satisfied' : 'violated', `${usedF} ${unit(used)} committed + ${unit(demand)} planned (${cs.map((c) => `${c.workflow}:${c.op} ${unit(c.amount)}`).join(', ') || 'none'}) = ${unit(total)} of ${unit(cap)}${total > cap ? ` — exceeds by ${unit(total - cap)}` : ''}`, [...cs.map((c) => c.workflow), ...ctx.touching(k)]);
    }
    case 'authorization': {
      if (!ctx.isActive(sp.workflow)) return out('not_applicable', `${sp.workflow} is not active`);
      const a = ctx.authority(sp.workflow, sp.role);
      if (!a) return out('unknown', 'authority could not be evaluated', [sp.workflow]);
      return out(a.ok ? 'satisfied' : 'violated', a.detail, [sp.workflow]);
    }
    case 'temporal_order': {
      const b = ctx.opStatus(sp.before.workflow, sp.before.op); const a = ctx.opStatus(sp.after.workflow, sp.after.op);
      const done = (s?: string) => ['applied', 'verified'].includes(String(s));
      const parts = [sp.before.workflow, sp.after.workflow];
      if (!done(a)) return out(a === 'pending' && ['failed', 'rejected', 'cancelled'].includes(String(b)) ? 'violated' : 'satisfied', `${sp.after.workflow}:${sp.after.op} is ${a ?? 'absent'}; ${sp.before.workflow}:${sp.before.op} is ${b ?? 'absent'}`, parts);
      if (!done(b)) return out('violated', `${sp.after.workflow}:${sp.after.op} ran but its predecessor ${sp.before.workflow}:${sp.before.op} is ${b ?? 'absent'}`, parts);
      const sb = ctx.opSeq(sp.before.workflow, sp.before.op) ?? 0; const sa = ctx.opSeq(sp.after.workflow, sp.after.op) ?? 0;
      return out(sb <= sa ? 'satisfied' : 'violated', `order: ${sp.before.op}#${sb} then ${sp.after.op}#${sa}`, parts);
    }
    case 'freshness': {
      const k = refKey(sp.ref);
      if (!ctx.isActive(sp.workflow)) return out('not_applicable', `${sp.workflow} is not active`);
      reads.push(k);
      const f = ctx.freshness(sp.workflow, k);
      if (!f || !f.basisHash) return out('not_applicable', `${sp.workflow} recorded no decision evidence for ${k}`);
      if (!f.readable) { unreadable.push(k); return out('unknown', '', [sp.workflow, ...ctx.touching(k)]); }
      return out(f.basisHash === f.currentHash ? 'satisfied' : 'violated', f.basisHash === f.currentHash ? `${sp.workflow}'s evidence for ${k} still matches the current read (${f.basisHash.slice(0, 8)})` : `${sp.workflow} decided on ${k} state ${f.basisHash.slice(0, 8)}; it is now ${String(f.currentHash).slice(0, 8)} — the decision basis is stale`, [sp.workflow, ...ctx.touching(k)]);
    }
    case 'consistency': {
      const ifK = refKey(sp.if); const ifS = rd(ifK);
      const trig = ifS?.[sp.if.field] === sp.if.equals;
      if (sp.rule === 'implies') {
        const thK = refKey(sp.then); const thS = rd(thK);
        const ok = !trig || thS?.[sp.then.field] === sp.then.equals;
        return out(ok ? 'satisfied' : 'violated', `${ifK}.${sp.if.field} = ${fmt(ifS?.[sp.if.field])}${trig ? ` ⇒ requires ${thK}.${sp.then.field} = ${fmt(sp.then.equals)}, observed ${fmt(thS?.[sp.then.field])}` : ' (rule not triggered)'}`, [...ctx.touching(ifK), ...ctx.touching(thK)]);
      }
      const pK = refKey(sp.pointer); const pS = pK === ifK ? ifS : rd(pK);
      if (!trig) return out('satisfied', `${ifK}.${sp.if.field} = ${fmt(ifS?.[sp.if.field])} (rule not triggered)`, ctx.touching(ifK));
      const target = pS?.[sp.pointer.field];
      if (target === undefined || target === null) return out('violated', `${ifK} is ${fmt(sp.if.equals)} but ${pK}.${sp.pointer.field} points nowhere`, ctx.touching(ifK));
      const tK = `${sp.targetSystem}/${String(target)}`; const tS = rd(tK);
      const ok = tS?.[sp.targetField] === sp.equals;
      return out(ok ? 'satisfied' : 'violated', `${ifK}.${sp.if.field} = ${fmt(sp.if.equals)} → points to ${tK}; ${tK}.${sp.targetField} = ${fmt(tS?.[sp.targetField])} (must be ${fmt(sp.equals)})`, [...ctx.touching(ifK), ...ctx.touching(tK)]);
    }
    case 'lineage': {
      const uK = refKey(sp.upstream); const dK = refKey(sp.downstream); const u = rd(uK); const d = rd(dK);
      const raw = u?.[sp.compatField];
      const compat = Array.isArray(raw) ? (raw as unknown[]) : [raw];
      const want = d?.[sp.expectsField];
      const ok = compat.includes(want);
      return out(ok ? 'satisfied' : 'violated', `${dK} expects ${fmt(want)}; ${uK} provides ${fmt(compat)}${ok ? '' : ' — downstream relies on a contract the upstream no longer honours'}`, [...ctx.touching(uK), ...ctx.touching(dK)]);
    }
    case 'mutual_exclusion': {
      const k = refKey(sp.ref); const st = rd(k);
      const slots: { holder: string; window: [number, number]; src: string }[] = ((st?.[sp.slotsField] as any[]) ?? []).map((x) => ({ holder: String(x.holder), window: [num(x.start), num(x.end)] as [number, number], src: 'booked' }));
      for (const c of ctx.commitments.filter((x) => x.ref === k && x.kind === 'schedule' && x.window)) slots.push({ holder: c.holder ?? c.workflow, window: c.window!, src: `planned ${c.workflow}:${c.op}` });
      const clashes: string[] = []; const who = new Set<string>();
      for (let i = 0; i < slots.length; i++) for (let jx = i + 1; jx < slots.length; jx++) {
        const a = slots[i]; const b = slots[jx];
        if (a.holder !== b.holder && overlap(a.window, b.window)) { clashes.push(`${a.holder} ${hhmm(a.window[0])}–${hhmm(a.window[1])} (${a.src}) overlaps ${b.holder} ${hhmm(b.window[0])}–${hhmm(b.window[1])} (${b.src})`); who.add(a.holder); who.add(b.holder); }
      }
      return out(clashes.length ? 'violated' : 'satisfied', clashes.length ? clashes.join('; ') : `${slots.length} commitment(s) on ${k}, none overlapping`, [...who, ...ctx.touching(k)]);
    }
    case 'recovery_safety': {
      if (!ctx.before || !prior) return out('not_applicable', 'evaluated against simulated resolution plans only');
      const unknown = sp.protects.filter((key) => prior.get(key)?.result === 'unknown');
      if (unknown.length) return { key: def.key, result: 'unknown', detail: `protected invariant(s) cannot be evaluated: ${unknown.join(', ')}`, reads: [], participants: [], unreadable: [] };
      const broken = sp.protects.filter((key) => ctx.before!.get(key) === 'satisfied' && prior.get(key)?.result === 'violated');
      return out(broken.length ? 'violated' : 'satisfied', broken.length ? `plan breaks protected invariant(s) that held before: ${broken.join(', ')}` : `all ${sp.protects.length} protected invariant(s) preserved`, broken.flatMap((key) => prior.get(key)?.participants ?? []));
    }
    case 'completeness': {
      if (!ctx.isActive(sp.workflow)) return out('not_applicable', `${sp.workflow} is not active (cancelled)`);
      const st = sp.ops.map((o) => [o, ctx.opStatus(sp.workflow, o) ?? 'absent'] as const);
      const verified = st.filter(([, s]) => s === 'verified').length;
      const bad = st.filter(([, s]) => ['failed', 'rejected', 'unknown', 'absent'].includes(s));
      if (bad.length) return out('violated', `${sp.workflow}: ${bad.map(([o, s]) => `${o} ${s}`).join(', ')} (${verified}/${sp.ops.length} verified)`, [sp.workflow]);
      if (verified === sp.ops.length) return out('satisfied', `${sp.workflow}: all ${sp.ops.length} required operations verified`, [sp.workflow]);
      if (ctx.declaredComplete(sp.workflow)) return out('violated', `${sp.workflow} declared complete with ${verified}/${sp.ops.length} operations verified`, [sp.workflow]);
      return out('not_applicable', `${sp.workflow} in progress: ${verified}/${sp.ops.length} verified`, [sp.workflow]);
    }
    case 'provenance': {
      const cl = ctx.claims(sp.workflow);
      const missing = cl.filter((c) => !c.evidence);
      return out(missing.length ? 'violated' : 'satisfied', cl.length ? `${cl.length - missing.length}/${cl.length} consequential claim(s) backed by an attributable observation${missing.length ? `; unbacked: ${missing.map((m) => m.op).join(', ')}` : ''}` : 'no consequential claims yet', [sp.workflow]);
    }
    case 'pack': {
      const fn = ctx.packEvaluator(sp.pack, sp.evaluator);
      if (!fn) return out('unknown', `evaluator ${sp.pack}.${sp.evaluator} is not installed`);
      const keys = sp.reads.map(refKey); for (const k of keys) rd(k);
      if (unreadable.length) return out('unknown', '');
      const r = fn(sp.params, (k) => ctx.read(k));
      return out(r.ok ? 'satisfied' : 'violated', r.detail, keys.flatMap((k) => ctx.touching(k)));
    }
  }
}

/** Evaluates every invariant; recovery_safety invariants run last so they can compare against the others. */
export function evaluateAll(defs: InvariantDef[], ctx: EvalCtx): Map<string, Evaluation> {
  const res = new Map<string, Evaluation>();
  for (const d of defs.filter((x) => x.spec.type !== 'recovery_safety')) res.set(d.key, evaluate(d, ctx));
  for (const d of defs.filter((x) => x.spec.type === 'recovery_safety')) res.set(d.key, evaluate(d, ctx, res));
  return res;
}

/** Blocking strength: hard always; conditional while its condition holds (otherwise the evaluator returns not_applicable). */
export const isBlockingStrength = (d: InvariantDef) => d.strength === 'hard' || d.strength === 'conditional';
