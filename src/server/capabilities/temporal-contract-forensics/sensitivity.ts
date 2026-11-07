/**
 * Minimum Decisive Evidence (MDE): which additional evidence would settle the contractual decision, ranked by its
 * actual effect on the decision (never by age or a fixed importance list).
 *
 * For an undecided analysis, every candidate request is turned into its possible OUTCOMES, each outcome is applied
 * to the analysis as a hypothetical change, and the decision is recomputed exactly:
 *   RESOLVE_TIMESTAMP     fix one endpoint to the two extremes of its uncertainty. Bounds are monotone in a single
 *                         endpoint, so the extremes cover every value in between (EXACT_EXTREMES).
 *   RESOLVE_CLOCK_OFFSET  fix one clock's offset; not monotone, so a 5-point sample is evaluated (SAMPLED).
 *   CONFIRM_EXCLUSION     maintenance valid / not valid (ENUMERATED).
 *   RESOLVE_CONFLICT      either side of an unresolved contradiction is right (ENUMERATED).
 *   OBSERVE_INTERVAL      an authoritative observation of an uncertain segment showing it uniformly down or
 *                         uniformly not down (ENUMERATED over those two outcomes; a mixed observation is not
 *                         evaluated), plus the SHORTEST anchored observation that alone would decide (exact
 *                         boundary search, verified by evaluation).
 * Guarantee: ALWAYS_DECISIVE (every evaluated outcome decides; only for exact evaluations), DECISIVE_IN_SOME_OUTCOMES,
 * NARROWS_ONLY (reduces the decision-sensitive width), NO_EFFECT. Ranked by guarantee, exactness, worst-case residual
 * width, best-case residual, then the amount of observation requested. When no single request is always decisive,
 * pairs of exact requests are searched for decisive combinations.
 */
import { decide, stage1, type Combo, type Decision, type Stage1 } from './analysis.js';
import { envelopeSets } from './bounds.js';
import type { NormRecord } from './evidence.js';
import { clip, normalize, subtract, type Interval } from './intervals.js';
import { activeEvidence, inactiveEvidence } from './revisions.js';
import { formatDuration, formatInstant } from './time.js';
import type {
  AnalysisRevision, Classification, DecisiveGuarantee, EvidenceRequirement, MinimumDecisiveEvidenceReport, RequirementOutcome,
} from './types.js';

interface VState { records: NormRecord[]; clockU: Map<string, number>; combos: Combo[]; setAside: Map<string, string> }
type Mod = (s: VState) => VState;
interface Cand { id: string; kind: EvidenceRequirement['kind']; request: string; target: Record<string, unknown>; evaluation: EvidenceRequirement['evaluation']; outcomes: { label: string; mod: Mod }[]; span: number; why: (o: RequirementOutcome[]) => string; capSome?: boolean }

const decisive = (c: Classification) => c === 'BREACH_CONFIRMED' || c === 'NO_BREACH';
const GUARANTEE_ORDER: Record<DecisiveGuarantee, number> = { ALWAYS_DECISIVE: 0, DECISIVE_IN_SOME_OUTCOMES: 1, NARROWS_ONLY: 2, NO_EFFECT: 3 };
const EVAL_ORDER: Record<EvidenceRequirement['evaluation'], number> = { EXACT_EXTREMES: 0, ENUMERATED: 0, SAMPLED: 1, NOT_EVALUATED: 2 };
const t = formatInstant; const d = formatDuration;

/** evaluationBudget: branch-and-bound nodes per what-if evaluation (bounds stay proven; smaller = more conservative). */
export interface MdeOptions { boundarySearch?: boolean; maxPairs?: number; maxCandidates?: number; maxBoundarySegments?: number; evaluationBudget?: number }

export function mdeFromStage(s1: Stage1, base: Decision, opts: MdeOptions = {}): MinimumDecisiveEvidenceReport {
  let evaluations = 0;
  if (base.classification === 'NOT_APPLICABLE' || decisive(base.classification)) {
    return { conclusive: true, classification: base.classification, statement: base.classification === 'NOT_APPLICABLE' ? 'The contract does not apply; no evidence about the incident can change that.' : `Conclusive (${base.classification}). Additional consistent evidence only narrows the bounds, so no further evidence is needed; only retracting or correcting existing evidence could change it.`, requirements: [], decisiveCombinations: [], blockers: { toConfirm: [], toRuleOut: [] }, evaluations };
  }
  if (!base.perCombo.length) {
    const reqs: EvidenceRequirement[] = s1.review.filter((r) => r.blocking).map((r, i) => ({ id: `R${i + 1}`, kind: 'CONTRACT_CLARIFICATION', request: `Resolve contract review item ${r.code}${r.field ? ` (${r.field})` : ''}${r.clauseId ? ` (clause ${r.clauseId})` : ''}: ${r.detail}`, target: { code: r.code, field: r.field ?? null, clauseId: r.clauseId ?? null }, guarantee: 'NARROWS_ONLY', evaluation: 'NOT_EVALUATED', outcomes: [], worstCaseResidualMs: 0, bestCaseResidualMs: 0, requestedSpanMs: 0, whyItMatters: 'No valid bound can be computed until the contract terms are determined; evidence alone cannot decide this.', rank: i + 1 }));
    if (!reqs.length && s1.measured) reqs.push({ id: 'R1', kind: 'OBSERVE_INTERVAL', request: `Any attributable observation of ${s1.target?.service ?? 'the service'} state between ${t(s1.measured.start)} and ${t(s1.measured.end)}`, target: { start: t(s1.measured.start), end: t(s1.measured.end) }, guarantee: 'NARROWS_ONLY', evaluation: 'NOT_EVALUATED', outcomes: [], worstCaseResidualMs: 0, bestCaseResidualMs: 0, requestedSpanMs: s1.measured.end - s1.measured.start, whyItMatters: base.reasons.join(' '), rank: 1 });
    return { conclusive: false, classification: base.classification, statement: `No valid bound: ${base.rule}`, requirements: reqs, decisiveCombinations: [], blockers: { toConfirm: [], toRuleOut: [] }, evaluations };
  }

  const start: VState = { records: s1.norm!.records, clockU: s1.norm!.clockU, combos: s1.combos, setAside: new Map() };
  const run = (st: VState): { o: Omit<RequirementOutcome, 'outcome'>; residual: number; contradicts: string[] } => {
    evaluations++;
    const r = decide(s1, { records: st.records, clockU: st.clockU, combos: st.combos, setAside: st.setAside, refine: false, budget: opts.evaluationBudget ?? 200 });
    // An outcome that contradicts evidence currently in use (forcing new set-asides) is not a possible outcome
    // while that evidence stands; it is reported but marked inconsistent and ignored for the guarantee.
    const newlyAside = [...r.setAside.keys()].filter((k) => !base.setAside.has(k) && !st.setAside.has(k));
    const consistent = r.perCombo.length > 0 && newlyAside.length === 0;
    const contradicts = [...new Set(st.records.filter((x) => newlyAside.includes(x.key)).flatMap((x) => x.evidenceIds))];
    return { o: { classification: r.classification, minMs: r.lo, maxMs: r.hi, consistent }, residual: decisive(r.classification) ? 0 : r.residualMs, contradicts };
  };
  const baseResidual = base.residualMs;
  const maxRank = Math.max(0, ...start.records.map((r) => r.rank));
  let hypN = 0;
  const hyp = (polarity: 'Q' | 'N', s: number, e: number): NormRecord => ({ key: `hyp:${++hypN}`, evidenceIds: [], system: 'hypothetical', clockId: '__hypothetical__', authority: 'SIGNED_MONITORING', rank: maxRank + 10, polarity, kind: 'INTERVAL', sLo: s, sHi: s, eLo: e, eHi: e, hypothetical: true });
  const addRec = (r: () => NormRecord): Mod => (st) => ({ ...st, records: [...st.records, r()] });

  const cands: Cand[] = [];
  const W: Interval = { s: s1.measured!.start, e: s1.measured!.end };
  const env = envelopeSets(base.used, base.clockU);
  const uncertainSet = subtract(subtract([W], clip(env.nonQualifying, W)), clip(env.certain, W));
  const relevant = (lo: number, hi: number) => uncertainSet.some((p) => p.s < hi && lo < p.e);

  // A. timestamp resolution
  const endpoints = new Map<string, { id: string; ep: 'start' | 'end' | 'at'; lo: number; hi: number; u: number; sys: string }>();
  for (const r of base.used) {
    if (r.kind !== 'INTERVAL' || r.hypothetical) continue;
    const u = base.clockU.get(r.clockId) ?? 0; const derived = r.key.includes('→');
    const sOwner = derived ? { id: r.evidenceIds[0]!, ep: 'at' as const } : { id: r.key, ep: 'start' as const };
    const eOwner = derived ? (r.key.endsWith('→holdsUntil') ? null : { id: r.evidenceIds[1]!, ep: 'at' as const }) : { id: r.key, ep: 'end' as const };
    if (r.sHi > r.sLo) endpoints.set(`${sOwner.id}|${sOwner.ep}`, { ...sOwner, lo: r.sLo, hi: r.sHi, u, sys: r.system });
    if (eOwner && r.eHi > r.eLo) endpoints.set(`${eOwner.id}|${eOwner.ep}`, { ...eOwner, lo: r.eLo, hi: r.eHi, u, sys: r.system });
  }
  for (const [k, ep] of [...endpoints].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!relevant(ep.lo - ep.u, ep.hi + ep.u + 1)) continue;
    const fix = (v: number): Mod => (st) => ({ ...st, records: st.records.map((r) => {
      const derived = r.key.includes('→');
      if (!derived && r.key === ep.id) return ep.ep === 'start' ? { ...r, sLo: v, sHi: v } : ep.ep === 'end' ? { ...r, eLo: v, eHi: v } : r;
      if (derived && r.evidenceIds[0] === ep.id) return { ...r, sLo: v, sHi: v };
      if (derived && r.evidenceIds[1] === ep.id) return { ...r, eLo: v, eHi: v };
      return r;
    }) });
    cands.push({ id: `TS:${k}`, kind: 'RESOLVE_TIMESTAMP', evaluation: 'EXACT_EXTREMES', span: 0,
      request: `Obtain the exact original timestamp for the ${ep.ep === 'at' ? 'time' : ep.ep} of ${ep.id} (${ep.sys}); it is currently known only within ${t(ep.lo)} – ${t(ep.hi)} (clock-corrected).`,
      target: { evidenceId: ep.id, endpoint: ep.ep, earliest: t(ep.lo), latest: t(ep.hi) },
      outcomes: [{ label: `exact time ${t(ep.lo)}`, mod: fix(ep.lo) }, { label: `exact time ${t(ep.hi)}`, mod: fix(ep.hi) }],
      why: (o) => `Its ${ep.ep === 'at' ? 'time' : ep.ep} spans ${d(ep.hi - ep.lo)} of uncertainty that overlaps the undecided period: at the earliest it gives ${o[0]!.classification}, at the latest ${o[1]!.classification} (every value in between lies between these).` });
  }
  // B. clock offsets
  const clocks = [...new Set(base.used.map((r) => r.clockId))].filter((c) => (base.clockU.get(c) ?? 0) > 0).sort();
  for (const c of clocks) {
    const u = base.clockU.get(c)!;
    const pts = [...new Set([-u, -Math.floor(u / 2), 0, Math.floor(u / 2), u])];
    const at = (dlt: number): Mod => (st) => { const cu = new Map(st.clockU); cu.set(c, 0); return { ...st, clockU: cu, records: st.records.map((r) => (r.clockId === c ? { ...r, sLo: r.sLo + dlt, sHi: r.sHi + dlt, eLo: r.eLo + dlt, eHi: r.eHi + dlt } : r)) }; };
    cands.push({ id: `CLK:${c}`, kind: 'RESOLVE_CLOCK_OFFSET', evaluation: 'SAMPLED', span: 0,
      request: `Establish the actual offset of clock "${c}" (currently ±${d(u)} after correction), e.g. from an NTP/PTP sync log covering the incident.`,
      target: { clockId: c, uncertaintyMs: u },
      outcomes: pts.map((p) => ({ label: `offset ${p >= 0 ? '+' : ''}${d(p)}`, mod: at(p) })),
      why: (o) => `All records from this clock move together; across the sampled offsets the decision is ${[...new Set(o.filter((x) => x.consistent).map((x) => x.classification))].join(' / ')}. The offset is not monotone in its effect, so this is a sample, not a proof.` });
  }
  // C. exclusions
  for (const x of s1.exclusions.filter((e) => e.a.status === 'POSSIBLE')) {
    const id = x.a.maintenanceId;
    cands.push({ id: `EXC:${id}`, kind: 'CONFIRM_EXCLUSION', evaluation: 'ENUMERATED', span: 0,
      request: `Confirm or reject maintenance window ${id} (${x.a.segment?.start} – ${x.a.segment?.end}) as a valid exclusion: show the announcement time and its notice period.`,
      target: { maintenanceId: id },
      outcomes: [{ label: 'exclusion valid', mod: (st) => ({ ...st, combos: st.combos.filter((cb) => cb.possibleApplied.includes(id)) }) }, { label: 'exclusion not valid', mod: (st) => ({ ...st, combos: st.combos.filter((cb) => !cb.possibleApplied.includes(id)) }) }],
      why: (o) => `${d(x.a.segment?.durationMs ?? 0)} of the window may or may not be excluded: if valid → ${o[0]!.classification}, if not → ${o[1]!.classification}.` });
  }
  // D. unresolved conflicts
  for (const c of base.conflicts.filter((k) => k.resolution === 'UNRESOLVED')) {
    if (c.type !== 'STATE_CONTRADICTION') {
      cands.push({ id: `CF:${c.id}`, kind: 'RESOLVE_CONFLICT', evaluation: 'NOT_EVALUATED', span: 0, request: `Resolve ${c.type} ${c.id} between ${c.evidenceIds.join(', ')}: ${c.explanation}`, target: { conflictId: c.id, evidenceIds: c.evidenceIds }, outcomes: [], why: () => 'These records are set aside until the contradiction is resolved; the effect of each resolution is not evaluated automatically.' });
      continue;
    }
    const keys = [...base.setAside].filter(([, v]) => v.conflictId === c.id).map(([k]) => k);
    const q = start.records.find((r) => keys.includes(r.key) && r.polarity === 'Q'); const n = start.records.find((r) => keys.includes(r.key) && r.polarity === 'N');
    if (!q || !n) continue;
    const keep = (drop: string): Mod => (st) => { const sa = new Map(st.setAside); sa.set(drop, `${c.id}-resolved`); return { ...st, setAside: sa }; };
    cands.push({ id: `CF:${c.id}`, kind: 'RESOLVE_CONFLICT', evaluation: 'ENUMERATED', span: 0,
      request: `Resolve contradiction ${c.id}: ${q.key} (${q.authority}) reports a qualifying state, ${n.key} (${n.authority}) does not, over ${c.overlap?.start} – ${c.overlap?.end}. Obtain a higher-authority record or the original raw data for either.`,
      target: { conflictId: c.id, evidenceIds: c.evidenceIds },
      outcomes: [{ label: `${q.key} correct`, mod: keep(n.key) }, { label: `${n.key} correct`, mod: keep(q.key) }],
      why: (o) => `Both records are set aside today. If ${q.key} is right → ${o[0]!.classification}; if ${n.key} is right → ${o[1]!.classification}.` });
  }
  // E. observations of uncertain segments
  const pieces = normalize(uncertainSet);
  pieces.forEach((p, i) => {
    cands.push({ id: `OBS:${i + 1}`, kind: 'OBSERVE_INTERVAL', evaluation: 'ENUMERATED', span: p.e - p.s, capSome: true,
      request: `An authoritative observation of the contracted scope covering ${t(p.s)} – ${t(p.e)} (${d(p.e - p.s)}), e.g. a regional probe or load-balancer log for that period.`,
      target: { start: t(p.s), end: t(p.e) },
      outcomes: [{ label: 'uniformly down', mod: addRec(() => hyp('Q', p.s, p.e)) }, { label: 'uniformly not down', mod: addRec(() => hyp('N', p.s, p.e)) }],
      why: (o) => `This ${d(p.e - p.s)} is possible but not established downtime: if observed down → ${o[0]!.classification}; if observed healthy → ${o[1]!.classification}. A mixed observation lies between and is not evaluated.` });
  });

  // Blockers: if a whole undecided segment were observed down (healthy) and that would decide the case but
  // contradict evidence in use, that evidence is what stands in the way of confirming (ruling out) the breach.
  const blockers = { toConfirm: new Set<string>(), toRuleOut: new Set<string>() };
  const reqs: EvidenceRequirement[] = [];
  const evalCand = (c: Cand): EvidenceRequirement => {
    const outs: RequirementOutcome[] = []; const res: number[] = [];
    for (const o of c.outcomes) {
      const r = run(o.mod(start)); outs.push({ outcome: o.label, ...r.o }); if (r.o.consistent) res.push(r.residual);
      if (c.kind === 'OBSERVE_INTERVAL' && !r.o.consistent && decisive(r.o.classification)) for (const id of r.contradicts) (r.o.classification === 'BREACH_CONFIRMED' ? blockers.toConfirm : blockers.toRuleOut).add(id);
    }
    const cons = outs.filter((o) => o.consistent);
    let g: DecisiveGuarantee;
    if (c.evaluation === 'NOT_EVALUATED') g = 'NARROWS_ONLY';
    else if (cons.length && cons.every((o) => decisive(o.classification)) && !c.capSome && c.evaluation !== 'SAMPLED') g = 'ALWAYS_DECISIVE';
    else if (cons.some((o) => decisive(o.classification))) g = 'DECISIVE_IN_SOME_OUTCOMES';
    else if (res.length && Math.max(...res) < baseResidual) g = 'NARROWS_ONLY';
    else g = 'NO_EFFECT';
    return { id: c.id, kind: c.kind, request: c.request, target: c.target, guarantee: g, evaluation: c.evaluation, outcomes: outs, worstCaseResidualMs: res.length ? Math.max(...res) : baseResidual, bestCaseResidualMs: res.length ? Math.min(...res) : baseResidual, requestedSpanMs: c.span, whyItMatters: c.outcomes.length ? c.why(outs) : c.why([]), rank: 0 };
  };
  // The whole undecided region at once, in each direction (used for blockers only).
  if (pieces.length > 1) for (const pol of ['Q', 'N'] as const) {
    const r = run(pieces.reduce<VState>((st, p) => addRec(() => hyp(pol, p.s, p.e))(st), start));
    if (!r.o.consistent && decisive(r.o.classification)) for (const id of r.contradicts) (pol === 'Q' ? blockers.toConfirm : blockers.toRuleOut).add(id);
  }
  for (const c of cands.slice(0, opts.maxCandidates ?? 200)) { const r = evalCand(c); if (r.evaluation === 'NOT_EVALUATED' || r.outcomes.some((o) => o.consistent)) reqs.push(r); }

  // Shortest anchored observation that alone decides (exact boundary search over integer ms, verified).
  if (opts.boundarySearch !== false) {
    // Bounded effort: the four longest undecided segments (boundaries in shorter ones are found by the uniform test).
    const longest = new Set([...pieces].sort((a, b) => b.e - b.s - (a.e - a.s) || a.s - b.s).slice(0, opts.maxBoundarySegments ?? 4));
    pieces.forEach((p, i) => {
      if (!longest.has(p)) return;
      const tries: { pol: 'Q' | 'N'; anchor: 'left' | 'right'; want: Classification }[] = [
        { pol: 'Q', anchor: 'left', want: 'BREACH_CONFIRMED' }, { pol: 'Q', anchor: 'right', want: 'BREACH_CONFIRMED' },
        { pol: 'N', anchor: 'right', want: 'NO_BREACH' }, { pol: 'N', anchor: 'left', want: 'NO_BREACH' },
      ];
      for (const tr of tries) {
        const iv = (len: number): [number, number] => (tr.anchor === 'left' ? [p.s, p.s + len] : [p.e - len, p.e]);
        const ok = (len: number) => { const [a, b] = iv(len); const r = run(addRec(() => hyp(tr.pol, a, b))(start)); return r.o.consistent && r.o.classification === tr.want ? r : null; };
        // Longer observations decide more often but can also contradict existing evidence, so the decisive lengths
        // form a range, not a suffix. Scan a 16-step grid for the first decisive length, then binary-search the
        // boundary below it (decisiveness is monotone in length among consistent outcomes) and verify it.
        const len = p.e - p.s; let prev = 0; let hit = 0;
        for (let k = 1; k <= 16; k++) { const L = Math.ceil((len * k) / 16); if (L <= prev) continue; if (ok(L)) { hit = L; break; } prev = L; }
        if (!hit) continue;
        let lo = prev + 1; let hi = hit;
        while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (ok(mid)) hi = mid; else lo = mid + 1; }
        const v = ok(lo); if (!v) continue;
        const [a, b] = iv(lo);
        const state = tr.pol === 'Q' ? 'down (a qualifying state)' : 'healthy (non-qualifying)';
        reqs.push({ id: `OBS:${i + 1}:${tr.pol}:${tr.anchor}`, kind: 'OBSERVE_INTERVAL',
          request: `A verified observation showing the service ${state} throughout ${t(a)} – ${t(b)} (${d(lo)}).`,
          target: { start: t(a), end: t(b), state: tr.pol === 'Q' ? 'QUALIFYING' : 'NON_QUALIFYING' },
          guarantee: 'DECISIVE_IN_SOME_OUTCOMES', evaluation: 'EXACT_EXTREMES', outcomes: [{ outcome: `${state} throughout`, ...v.o }],
          worstCaseResidualMs: baseResidual, bestCaseResidualMs: 0, requestedSpanMs: lo,
          whyItMatters: tr.pol === 'N'
            ? `A valid observation that the service was healthy ${tr.anchor === 'right' ? `from ${t(a)} (recovery before then)` : `until ${t(b)}`} would establish NO_BREACH; no shorter healthy span anchored there decides (boundary ${d(lo)}, found by search and verified).`
            : `Establishing downtime ${tr.anchor === 'left' ? `continuing until ${t(b)}` : `starting from ${t(a)}`} would confirm the breach; no shorter span anchored there decides (boundary ${d(lo)}, found by search and verified).`,
          rank: 0 });
      }
    });
  }

  reqs.sort((a, b) => GUARANTEE_ORDER[a.guarantee] - GUARANTEE_ORDER[b.guarantee] || EVAL_ORDER[a.evaluation] - EVAL_ORDER[b.evaluation] || a.worstCaseResidualMs - b.worstCaseResidualMs || a.bestCaseResidualMs - b.bestCaseResidualMs || a.requestedSpanMs - b.requestedSpanMs || (a.id < b.id ? -1 : 1));
  reqs.forEach((r, i) => { r.rank = i + 1; });

  // Pairs of exact requests that decide under every outcome combination.
  const combos: MinimumDecisiveEvidenceReport['decisiveCombinations'] = [];
  if (!reqs.some((r) => r.guarantee === 'ALWAYS_DECISIVE')) {
    const pool = cands.filter((c) => (c.evaluation === 'EXACT_EXTREMES' || c.evaluation === 'ENUMERATED') && !c.capSome && c.outcomes.length && reqs.find((r) => r.id === c.id && r.guarantee !== 'NO_EFFECT')).slice(0, opts.maxPairs ?? 6);
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      const outs: RequirementOutcome[] = []; let all = true;
      for (const oa of pool[i]!.outcomes) for (const ob of pool[j]!.outcomes) {
        const r = run(ob.mod(oa.mod(start)));
        outs.push({ outcome: `${oa.label} & ${ob.label}`, ...r.o });
        if (r.o.consistent && !decisive(r.o.classification)) all = false;
      }
      if (all && outs.some((o) => o.consistent)) combos.push({ requirementIds: [pool[i]!.id, pool[j]!.id], outcomes: outs });
    }
  }
  const top = reqs[0];
  const canConfirm = reqs.some((r) => r.outcomes.some((o) => o.consistent && o.classification === 'BREACH_CONFIRMED'));
  const canRuleOut = reqs.some((r) => r.outcomes.some((o) => o.consistent && o.classification === 'NO_BREACH'));
  const block = { toConfirm: [...blockers.toConfirm].sort(), toRuleOut: [...blockers.toRuleOut].sort() };
  let statement = top
    ? `${base.classification}: ${d(baseResidual)} of decision-sensitive uncertainty. ${reqs.filter((r) => r.guarantee === 'ALWAYS_DECISIVE').length} request(s) decide the outcome whatever they show; ${reqs.filter((r) => r.guarantee === 'DECISIVE_IN_SOME_OUTCOMES').length} decide it for some results. Most useful first: ${top.request}`
    : `${base.classification}: no single evaluated request changes the decision.`;
  if (!canRuleOut && block.toRuleOut.length) statement += ` No evaluated observation consistent with the evidence in use can rule the breach out; doing so would contradict ${block.toRuleOut.join(', ')}.`;
  if (!canConfirm && block.toConfirm.length) statement += ` No evaluated observation consistent with the evidence in use can confirm the breach; doing so would contradict ${block.toConfirm.join(', ')}.`;
  return { conclusive: false, classification: base.classification, statement, requirements: reqs, decisiveCombinations: combos, blockers: block, evaluations };
}

export function minimumDecisiveEvidenceReport(rev: AnalysisRevision, opts: MdeOptions = {}): MinimumDecisiveEvidenceReport {
  const s1 = stage1(rev.context, activeEvidence(rev.ledger), inactiveEvidence(rev.ledger));
  return mdeFromStage(s1, decide(s1), opts);
}
