/**
 * Analysis orchestration: contract selection → evidence normalisation → exclusion scenarios → conflict
 * resolution → evidence-bounded extremes → classification.
 *
 * Classification (per exclusion scenario c with measured period Q_c, breach point M_c = the smallest qualifying
 * downtime that is a breach, and sound bounds lo_c ≤ μ ≤ hi_c over every consistent timeline):
 *   NOT_APPLICABLE    no contract version is effective in the window, or the incident is outside the contract scope.
 *   INDETERMINATE     a blocking contract review requirement; no applicable evidence; no consistent timeline;
 *                     or an unresolved contradiction whose robust envelope still straddles the breach point.
 *   BREACH_CONFIRMED  lo_c ≥ M_c for every scenario c          (every consistent timeline breaches)
 *   NO_BREACH         hi_c < M_c for every scenario c          (no consistent timeline breaches)
 *   BREACH_POSSIBLE   otherwise                                (the evidence admits both)
 */
import { envelopeSets, extremum, forcedSet, prepare, rootBox, type BoundResult } from './bounds.js';
import { possibleOverlap, relativeRange, resolveConflicts, segment } from './conflicts.js';
import { availabilityString, breachPoint, creditCap, creditMinor, resolveWindow, selectContract, type CompiledContract, type ContractSelection } from './contract.js';
import { normalizeEvidence, type NormRecord, type Normalized, type Target } from './evidence.js';
import { contentHash } from './hash.js';
import { clip, intersect, normalize, overlaps, subtract, union, type Interval } from './intervals.js';
import { calendarMonthWindow, formatDuration, formatInstant, parseInstant, TcfInputError } from './time.js';
import {
  TCF_ENGINE, TCF_ENGINE_VERSION, type AnalysisContext, type Classification, type Conflict, type EvidenceAssessment, type ExclusionAssessment,
  type ReviewRequirement, type Segment, type TemporalEvidence, type TemporalExposureResult, type UncertainSegment, type UncertaintyCause,
} from './types.js';

export interface Combo { q: Interval[]; possibleApplied: string[]; totalMs: number }

export interface InactiveEvidence { evidence: TemporalEvidence; code: 'RETRACTED' | 'SUPERSEDED' | 'COUNTERFACTUAL_EXCLUDED'; detail: string }

export interface Stage1 {
  ctx: AnalysisContext;
  evidence: readonly TemporalEvidence[];
  inactive: readonly InactiveEvidence[];
  requested: { start: number; end: number };
  selection: ContractSelection;
  compiled: CompiledContract | null;
  measured: { start: number; end: number } | null;
  target: Target | null;
  norm: Normalized | null;
  exclusions: { a: ExclusionAssessment; interval: Interval | null }[];
  combos: Combo[];
  review: ReviewRequirement[];
  blocking: string | null;
  notApplicable: string | null;
  hashes: TemporalExposureResult['hashes'];
}

export function stage1(ctx: AnalysisContext, evidence: readonly TemporalEvidence[], inactive: readonly InactiveEvidence[] = []): Stage1 {
  const sortedEv = [...evidence].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const evidenceSetHash = contentHash('tcf.evidence-set', sortedEv);
  const policyHash = contentHash('tcf.policy', ctx.policy);
  const inputHash = contentHash('tcf.input', { contracts: ctx.contracts, evidence: sortedEv, window: ctx.measurementWindow, incident: ctx.incident ?? null, clocks: [...ctx.clocks].sort((a, b) => (a.clockId < b.clockId ? -1 : 1)), maintenance: [...ctx.maintenance].sort((a, b) => (a.id < b.id ? -1 : 1)), policy: ctx.policy, inactive: inactive.map((i) => ({ id: i.evidence.id, code: i.code })) });

  const resolveFor = (c: CompiledContract | null) => {
    if (c) return resolveWindow(ctx.measurementWindow, c.period);
    const raw = ctx.contracts.find((d) => d.measurement?.period?.type === 'CALENDAR_MONTH');
    if ('calendarMonth' in ctx.measurementWindow) {
      if (!raw || raw.measurement.period.type !== 'CALENDAR_MONTH') throw new TcfInputError('WINDOW_PERIOD_MISMATCH', 'a calendarMonth window needs a CALENDAR_MONTH contract');
      const [start, end] = calendarMonthWindow(ctx.measurementWindow.calendarMonth, raw.measurement.period.timeZone); return { start, end, review: [] };
    }
    return resolveWindow(ctx.measurementWindow, null);
  };
  const selection = selectContract(ctx.contracts, resolveFor);
  const requestedWin = resolveFor(selection.contract);
  const requested = { start: requestedWin.start, end: requestedWin.end };
  const review = [...selection.review];
  const base: Omit<Stage1, 'blocking' | 'notApplicable'> = {
    ctx, evidence: sortedEv, inactive, requested, selection, compiled: selection.contract, measured: selection.measured, target: null, norm: null, exclusions: [], combos: [], review,
    hashes: { evidenceSetHash, contractHash: selection.contract?.hash ?? selection.failed?.hash ?? null, policyHash, inputHash },
  };
  if (selection.notApplicable) return { ...base, blocking: null, notApplicable: selection.reason };
  if (!selection.contract || !selection.measured || review.some((r) => r.blocking)) return { ...base, blocking: review.filter((r) => r.blocking).map((r) => r.code).join(', ') || selection.reason, notApplicable: null };

  const c = selection.contract;
  const target: Target = { service: c.doc.scope.service, ...(c.doc.scope.region !== undefined ? { region: c.doc.scope.region } : {}), ...(c.doc.scope.customer !== undefined ? { customer: c.doc.scope.customer } : {}) };
  if (ctx.incident) {
    const s = ctx.incident.scope;
    const out = s.service !== target.service ? `service "${s.service}"` : target.region && s.region && s.region !== target.region ? `region "${s.region}"` : target.customer && s.customer && s.customer !== target.customer ? `customer "${s.customer}"` : null;
    if (out) {
      review.push({ code: 'SCOPE_OUTSIDE_CONTRACT', blocking: false, detail: `incident ${ctx.incident.incidentId} concerns ${out}, outside the contract scope (${JSON.stringify(c.doc.scope)})` });
      return { ...base, target, blocking: null, notApplicable: `incident ${ctx.incident.incidentId} concerns ${out}, which the contract does not cover` };
    }
  }
  const measured = selection.measured;
  const norm = normalizeEvidence(evidence, { contract: c, target, window: measured, clocks: ctx.clocks, policy: ctx.policy, incident: ctx.incident });
  for (const i of inactive) {
    norm.assessments.set(i.evidence.id, { evidenceId: i.evidence.id, source: i.evidence.source?.system ?? '', recordId: i.evidence.source?.recordId ?? '', status: 'EXCLUDED', declaredAuthority: i.evidence.source?.authority, effectiveAuthority: i.evidence.source?.authority, rank: ctx.policy.authorityRanks[i.evidence.source?.authority] ?? 0, role: 'NONE', issues: [{ code: i.code, detail: i.detail }] });
  }

  // Maintenance exclusions.
  const exclusions: Stage1['exclusions'] = [];
  for (const m of [...ctx.maintenance].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const s = parseInstant(m.start, `maintenance ${m.id}.start`); const e = parseInstant(m.end, `maintenance ${m.id}.end`);
    if (e <= s) throw new TcfInputError('INVALID_MAINTENANCE', `maintenance ${m.id} ends before it starts`);
    const seg = clip([{ s, e }], { s: measured.start, e: measured.end })[0] ?? null;
    const na = (reason: string) => exclusions.push({ a: { maintenanceId: m.id, status: 'NOT_APPLIED', reason, segment: seg ? segment(seg.s, seg.e) : null }, interval: null });
    if (c.noticeRequiredMs === null) { na('the contract defines no maintenance exclusion'); continue; }
    if (m.regions && (target.region === undefined || !m.regions.includes(target.region))) { na(`applies to regions ${m.regions.join(', ')}, not to the contracted scope`); continue; }
    if (m.status === 'REJECTED') { na('rejected as an exclusion'); continue; }
    if (m.announcedAt) { const notice = s - parseInstant(m.announcedAt, `maintenance ${m.id}.announcedAt`); if (notice < c.noticeRequiredMs) { na(`announced ${formatDuration(notice)} ahead; the contract requires ${formatDuration(c.noticeRequiredMs)}`); continue; } }
    if (!seg) { na('outside the measured window'); continue; }
    if (m.status === 'CONFIRMED') exclusions.push({ a: { maintenanceId: m.id, status: 'APPLIED', reason: 'confirmed maintenance meeting the contract notice rule', segment: segment(seg.s, seg.e) }, interval: seg });
    else exclusions.push({ a: { maintenanceId: m.id, status: 'POSSIBLE', reason: m.announcedAt ? 'claimed maintenance, validity not confirmed' : 'claimed maintenance without a recorded announcement time; notice cannot be checked', segment: segment(seg.s, seg.e) }, interval: seg });
  }
  const applied = normalize(exclusions.filter((x) => x.a.status === 'APPLIED').map((x) => x.interval!));
  const possible = exclusions.filter((x) => x.a.status === 'POSSIBLE');
  const combos: Combo[] = [];
  if (possible.length > ctx.policy.maxUnconfirmedExclusions) {
    review.push({ code: 'TOO_MANY_UNCONFIRMED_EXCLUSIONS', blocking: true, detail: `${possible.length} unconfirmed maintenance windows exceed the exact-enumeration limit (${ctx.policy.maxUnconfirmedExclusions}); confirm or reject some` });
  } else {
    for (let mask = 0; mask < 1 << possible.length; mask++) {
      const chosen = possible.filter((_, i) => mask & (1 << i));
      const q = subtract([{ s: measured.start, e: measured.end }], union(applied, normalize(chosen.map((x) => x.interval!))));
      combos.push({ q, possibleApplied: chosen.map((x) => x.a.maintenanceId), totalMs: q.reduce((t, x) => t + x.e - x.s, 0) });
    }
  }
  const blocking = review.some((r) => r.blocking) ? review.filter((r) => r.blocking).map((r) => r.code).join(', ') : null;
  return { ...base, measured, target, norm, exclusions, combos, review, blocking, notApplicable: null };
}

export interface ComboBounds { combo: Combo; min: BoundResult; max: BoundResult; bp: number | null }

export interface Decision {
  classification: Classification;
  rule: string;
  reasons: string[];
  conflicts: Conflict[];
  setAside: Map<string, { code: 'SET_ASIDE_BY_AUTHORITY' | 'SET_ASIDE_UNRESOLVED_CONFLICT' | 'SET_ASIDE_JOINT_INFEASIBILITY'; conflictId: string }>;
  used: NormRecord[];
  clockU: Map<string, number>;
  perCombo: ComboBounds[];
  lo: number | null; hi: number | null;
  contested: boolean;
  residualMs: number;
  confirmGapMs: number | null;
  eliminateGapMs: number | null;
}

/** `refine: false` skips decision-directed refinement (used by MDE's many what-if evaluations; conservative). */
export interface Variant { records?: NormRecord[]; clockU?: Map<string, number>; combos?: Combo[]; setAside?: Map<string, string>; refine?: boolean; budget?: number }

const NEVER = Number.MAX_SAFE_INTEGER;

function bounds(s1: Stage1, used: NormRecord[], clockU: Map<string, number>, combos: Combo[], refine = true, budget = s1.ctx.policy.maxBranchNodes): ComboBounds[] {
  const pre = prepare(used, clockU);
  return combos.map((combo) => {
    const prob = { records: used, clockU, q: combo.q, origin: s1.measured!.start, rules: s1.compiled!.rules, budget };
    const bp = breachPoint(s1.compiled!.breach, combo.totalMs);
    let min = extremum(prob, 'min', pre); let max = extremum(prob, 'max', pre);
    // Decision-directed refinement: when a bound that is not tight is what leaves the breach question open, search
    // again (10× budget) only until that question is settled. The bound stays proven either way.
    if (refine && bp !== null && min.status !== 'EXACT' && min.feasible && min.value < bp) { const m2 = extremum({ ...prob, budget: prob.budget * 10 }, 'min', pre, bp); if (m2.feasible && m2.value >= min.value) min = m2; }
    if (refine && bp !== null && max.status !== 'EXACT' && max.feasible && max.value >= bp) { const m2 = extremum({ ...prob, budget: prob.budget * 10 }, 'max', pre, bp); if (m2.feasible && m2.value <= max.value) max = m2; }
    return { combo, min, max, bp };
  });
}

export function decide(s1: Stage1, v: Variant = {}): Decision {
  const empty = (classification: Classification, rule: string, reasons: string[]): Decision => ({ classification, rule, reasons, conflicts: [], setAside: new Map(), used: [], clockU: new Map(), perCombo: [], lo: null, hi: null, contested: false, residualMs: 0, confirmGapMs: null, eliminateGapMs: null });
  if (s1.notApplicable) return empty('NOT_APPLICABLE', `NOT_APPLICABLE: ${s1.notApplicable}`, [s1.notApplicable]);
  if (s1.blocking || !s1.norm || !s1.compiled) return empty('INDETERMINATE', `INDETERMINATE: blocking review requirement(s) ${s1.blocking ?? ''}`.trim(), s1.review.filter((r) => r.blocking).map((r) => `${r.code}: ${r.detail}`));
  const policy = s1.ctx.policy;
  const records = v.records ?? s1.norm.records;
  const clockU = v.clockU ?? s1.norm.clockU;
  const combos = v.combos ?? s1.combos;
  if (!records.length) return empty('INDETERMINATE', 'INDETERMINATE: no applicable evidence about the contracted scope', ['NO_APPLICABLE_EVIDENCE: no record speaks for the contracted service scope in the window, so nothing can be bounded except trivially']);

  const res = resolveConflicts(records.filter((r) => !v.setAside?.has(r.key)), clockU, policy);
  const conflicts: Conflict[] = [...s1.norm.collisions, ...res.conflicts];
  const setAside: Decision['setAside'] = new Map(res.setAside);
  for (const [k, why] of v.setAside ?? []) setAside.set(k, { code: 'SET_ASIDE_UNRESOLVED_CONFLICT', conflictId: why });
  let used = records.filter((r) => !setAside.has(r.key));
  let contested = conflicts.some((c) => c.resolution === 'UNRESOLVED');
  let perCombo = bounds(s1, used, clockU, combos, v.refine !== false, v.budget);

  if (perCombo.some((b) => b.min.provenInfeasible || b.max.provenInfeasible)) {
    // No offset assignment makes the remaining evidence consistent, although no PAIR contradicts under every
    // offset. Apply the same authority policy to the jointly inconsistent group: find the lowest-authority record(s)
    // (at least `resolveByAuthorityMinGap` below the group's top authority) whose removal restores consistency.
    const involved = new Set<string>();
    for (const a of used) for (const b of used) if (a.polarity === 'Q' && b.polarity === 'N' && a.clockId !== b.clockId && possibleOverlap(a, b, relativeRange(a, b, clockU))) { involved.add(a.key); involved.add(b.key); }
    if (!involved.size) for (const r of used) involved.add(r.key);
    const group = used.filter((r) => involved.has(r.key));
    const top = Math.max(...group.map((r) => r.rank));
    const cands = group.filter((r) => r.rank <= top - policy.resolveByAuthorityMinGap).sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : 1));
    const feasibleWithout = (drop: Set<string>) => {
      const rest = used.filter((r) => !drop.has(r.key));
      const res = extremum({ records: rest, clockU, q: [], origin: 0, rules: s1.compiled!.rules, budget: policy.maxBranchNodes }, 'min');
      return res.feasible;
    };
    let drop: NormRecord[]; let resolved: boolean;
    const singles = cands.filter((c) => feasibleWithout(new Set([c.key])));
    if (singles.length) {
      const lowest = singles[0]!.rank; drop = singles.filter((c) => c.rank === lowest); resolved = drop.length === 1;
    } else if (cands.length && feasibleWithout(new Set(cands.map((c) => c.key)))) { drop = cands; resolved = true; }
    else { drop = group; resolved = false; }
    const id = `J${conflicts.filter((c) => c.type === 'JOINT_INFEASIBILITY').length + 1}`;
    const dropIds = [...new Set(drop.flatMap((r) => r.evidenceIds))].sort();
    const groupIds = [...new Set(group.flatMap((r) => r.evidenceIds))].sort();
    conflicts.push({
      id, type: 'JOINT_INFEASIBILITY', evidenceIds: groupIds, resolution: resolved ? 'RESOLVED_BY_AUTHORITY' : 'UNRESOLVED',
      ...(resolved ? { kept: groupIds.filter((x) => !dropIds.includes(x)) } : {}), setAside: dropIds,
      explanation: resolved
        ? `No clock offsets within the declared uncertainties make ${groupIds.join(', ')} consistent together, although no single pair contradicts under every offset. Removing ${drop.map((r) => `${r.key} (${r.authority})`).join(', ')} — at least ${policy.resolveByAuthorityMinGap} authority ranks below the group's highest — restores consistency, so ${drop.length > 1 ? 'they are' : 'it is'} set aside. Not deleted.`
        : `No clock offsets within the declared uncertainties make ${groupIds.join(', ')} consistent together, and no lower-authority record alone explains it${singles.length > 1 ? ` (${singles.length} equally ranked candidates)` : ''}. A declared clock uncertainty may be too small or a record is wrong; ${dropIds.join(', ')} are set aside so the conclusion holds without them.`,
    });
    for (const r of drop) setAside.set(r.key, { code: 'SET_ASIDE_JOINT_INFEASIBILITY', conflictId: id });
    used = used.filter((r) => !setAside.has(r.key));
    if (!resolved) contested = true;
    perCombo = bounds(s1, used, clockU, combos, v.refine !== false, v.budget);
    if (perCombo.some((b) => b.min.provenInfeasible || b.max.provenInfeasible)) {
      return { ...empty('INDETERMINATE', 'INDETERMINATE: the evidence admits no consistent timeline', ['no consistent timeline exists even after setting aside the contradicting records']), conflicts, setAside, used, clockU };
    }
  }
  if (perCombo.some((b) => !b.min.feasible || !b.max.feasible)) {
    return { ...empty('INDETERMINATE', 'INDETERMINATE: no consistent timeline was found within the search budget', ['the branch-and-bound budget ran out before a consistent timeline was found; raise policy.maxBranchNodes']), conflicts, setAside, used, clockU };
  }

  const lo = Math.min(...perCombo.map((b) => b.min.value)); const hi = Math.max(...perCombo.map((b) => b.max.value));
  const bpOf = (b: ComboBounds) => b.bp ?? NEVER;
  const confirmed = perCombo.every((b) => b.min.value >= bpOf(b));
  const none = perCombo.every((b) => b.max.value < bpOf(b));
  const scen = perCombo.length > 1 ? ` in all ${perCombo.length} exclusion scenarios` : '';
  const bpTxt = (b: ComboBounds) => (b.bp === null ? 'none (empty measured period)' : formatDuration(b.bp));
  let classification: Classification; let rule: string; const reasons: string[] = [];
  if (confirmed) {
    classification = 'BREACH_CONFIRMED';
    rule = `BREACH_CONFIRMED: minimum qualifying downtime ${perCombo.map((b) => formatDuration(b.min.value)).join(' / ')} ≥ breach point ${perCombo.map(bpTxt).join(' / ')}${scen}`;
  } else if (none) {
    classification = 'NO_BREACH';
    rule = `NO_BREACH: maximum qualifying downtime ${perCombo.map((b) => formatDuration(b.max.value)).join(' / ')} < breach point ${perCombo.map(bpTxt).join(' / ')}${scen}`;
  } else {
    classification = 'BREACH_POSSIBLE';
    rule = `BREACH_POSSIBLE: qualifying downtime lies in [${formatDuration(lo)}, ${formatDuration(hi)}], which straddles the breach point ${[...new Set(perCombo.map(bpTxt))].join(' / ')}`;
  }
  if (contested) {
    if (classification === 'BREACH_POSSIBLE') {
      classification = 'INDETERMINATE';
      rule = `INDETERMINATE: unresolved contradictory evidence; with the contested records set aside, downtime lies in [${formatDuration(lo)}, ${formatDuration(hi)}] and still straddles the breach point`;
      reasons.push('unresolved contradiction between records of similar authority; resolving it is required to decide');
    } else reasons.push(`the ${classification} conclusion holds with every contested record set aside, so it does not depend on which side of the contradiction is right`);
  }
  let residual = 0; let confirmGap: number | null = null; let elimGap: number | null = null;
  for (const b of perCombo) {
    const bp = bpOf(b);
    if (b.min.value < bp && b.max.value >= bp) {
      residual = Math.max(residual, b.max.value - b.min.value);
      confirmGap = Math.max(confirmGap ?? 0, bp - b.min.value);
      elimGap = Math.max(elimGap ?? 0, b.max.value - bp + 1);
    }
  }
  if (perCombo.some((b) => b.min.status !== 'EXACT' || b.max.status !== 'EXACT')) reasons.push('a bound is sound but not tight (search budget exhausted); the classification is still safe');
  return { classification, rule, reasons, conflicts, setAside, used, clockU, perCombo, lo, hi, contested, residualMs: residual, confirmGapMs: confirmGap, eliminateGapMs: elimGap };
}

// ───────────────────────────── result assembly ─────────────────────────────

function segs(list: readonly Interval[]): Segment[] { return list.map((x) => segment(x.s, x.e)); }

function hull(r: NormRecord, u: number): Interval { return r.kind === 'INTERVAL' ? { s: r.sLo - u, e: r.eHi + u } : { s: r.sLo - u, e: r.sHi + u + 1 }; }

export function assemble(s1: Stage1, d: Decision): TemporalExposureResult {
  const c = s1.compiled;
  const disclosures = new Set<string>([
    'Bounds range over every timeline consistent with the evidence used. Time that no record speaks for is treated as possibly down, never assumed healthy.',
    'An INTERVAL record is taken to assert its state continuously over the interval; a failure shorter than a monitor\'s sampling interval cannot be seen in its records.',
    'Instantaneous (POINT) observations have no duration: they constrain timelines and can contradict interval claims, but add no measurable downtime.',
    'Records from one clock share one unknown offset within the declared uncertainty; per-record timestamp uncertainty is independent.',
    `Contradictions are resolved by authority only when ranks differ by at least ${s1.ctx.policy.resolveByAuthorityMinGap}; otherwise both sides are set aside and the conclusion must hold without either.`,
    'No probability is assigned to any outcome: the result is a pair of proven bounds and a classification derived from them.',
  ]);
  for (const x of s1.norm?.disclosures ?? []) disclosures.add(x);
  if (s1.combos.length > 1) disclosures.add(`${s1.exclusions.filter((x) => x.a.status === 'POSSIBLE').length} unconfirmed maintenance window(s): every apply/not-apply combination is evaluated exactly (minimum over all, maximum over all).`);
  if (d.perCombo.some((b) => b.min.status !== 'EXACT' || b.max.status !== 'EXACT')) disclosures.add('A bound is reported as SOUND_NOT_TIGHT: the branch-and-bound budget ran out; the bound is still proven, only possibly loose.');

  const evidence: EvidenceAssessment[] = [];
  const usedIds = new Set(d.used.flatMap((r) => r.evidenceIds));
  const asideByKey = new Map<string, NormRecord>();
  for (const r of s1.norm?.records ?? []) if (d.setAside.has(r.key)) asideByKey.set(r.key, r);
  for (const a of s1.norm?.assessments.values() ?? []) {
    const copy: EvidenceAssessment = { ...a, issues: [...a.issues] };
    for (const [k, why] of d.setAside) {
      const r = asideByKey.get(k);
      if (r && r.evidenceIds.includes(a.evidenceId)) {
        copy.issues.push({ code: why.code, detail: `${r.key} set aside (conflict ${why.conflictId})` });
        if (!usedIds.has(a.evidenceId) && copy.status === 'USED') copy.status = 'SET_ASIDE';
      }
    }
    evidence.push(copy);
  }
  evidence.sort((x, y) => (x.evidenceId < y.evidenceId ? -1 : 1));

  let envelope: TemporalExposureResult['envelope'] = { certainDowntime: [], knownNonQualifying: [], possibleDowntime: [], uncertain: [], evidenceGaps: [], exclusions: s1.exclusions.map((x) => x.a) };
  const m = s1.measured;
  if (m && s1.norm && d.perCombo.length) {
    const W: Interval = { s: m.start, e: m.end };
    const env = envelopeSets(d.used, d.clockU);
    // Stated in QUALIFYING time: certain = established in every exclusion scenario (all possible exclusions
    // applied); possible = in some scenario (none applied). Confirmed exclusions are removed from both.
    const qMin = s1.combos.reduce<Interval[]>((acc, c) => intersect(acc, c.q), [W]);
    const qMax = normalize(s1.combos.flatMap((c) => c.q));
    const certain = intersect(env.certain, qMin); const nonQ = clip(env.nonQualifying, W);
    const possibleSet = subtract(qMax, nonQ);
    const uncertainSet = subtract(possibleSet, certain);
    const covered = normalize(d.used.map((r) => hull(r, d.clockU.get(r.clockId) ?? 0)));
    const gaps = subtract([W], covered);
    const pieces = normalize([...intersect(uncertainSet, gaps), ...subtract(uncertainSet, gaps)]);
    const split: Interval[] = [];
    for (const p of pieces) { const g = intersect([p], gaps); const ng = subtract([p], gaps); split.push(...g, ...ng); }
    split.sort((a, b) => a.s - b.s);
    const asideRecs = [...asideByKey.values()];
    const uncertain: UncertainSegment[] = split.map((p) => {
      const causes: UncertaintyCause[] = [];
      const ts = d.used.filter((r) => { const u = d.clockU.get(r.clockId) ?? 0; return ((r.sHi > r.sLo && overlaps([{ s: r.sLo - u, e: r.sHi + u + 1 }], [p])) || (r.kind === 'INTERVAL' && r.eHi > r.eLo && overlaps([{ s: r.eLo - u, e: r.eHi + u + 1 }], [p]))); });
      if (ts.length) causes.push({ type: 'TIMESTAMP_UNCERTAINTY', evidenceIds: [...new Set(ts.flatMap((r) => r.evidenceIds))].sort() });
      const clocks = new Map<string, Set<string>>();
      for (const r of d.used) {
        const u = d.clockU.get(r.clockId) ?? 0; if (!u) continue;
        const ends = r.kind === 'INTERVAL' ? [{ s: r.sLo - u, e: r.sHi + u + 1 }, { s: r.eLo - u, e: r.eHi + u + 1 }] : [{ s: r.sLo - u, e: r.sHi + u + 1 }];
        if (ends.some((x) => overlaps([x], [p]))) { const set = clocks.get(r.clockId) ?? new Set(); r.evidenceIds.forEach((id) => set.add(id)); clocks.set(r.clockId, set); }
      }
      for (const [clockId, ids] of [...clocks].sort()) causes.push({ type: 'CLOCK_OFFSET', clockId, evidenceIds: [...ids].sort() });
      if (overlaps([p], gaps)) causes.push({ type: 'NO_EVIDENCE', explicitUnknownEvidenceIds: (s1.norm!.unknown.filter((u) => u.lo < p.e && u.hi > p.s).map((u) => u.evidenceId)).sort() });
      const aside = asideRecs.filter((r) => overlaps([hull(r, d.clockU.get(r.clockId) ?? 0)], [p]));
      if (aside.length) causes.push({ type: 'SET_ASIDE_EVIDENCE', evidenceIds: [...new Set(aside.flatMap((r) => r.evidenceIds))].sort() });
      const ex = s1.exclusions.filter((x) => x.a.status === 'POSSIBLE' && x.interval && overlaps([x.interval], [p]));
      if (ex.length) causes.push({ type: 'POSSIBLE_EXCLUSION', maintenanceIds: ex.map((x) => x.a.maintenanceId) });
      return { ...segment(p.s, p.e), causes };
    });
    const pre = prepare(d.used, d.clockU); const root = rootBox(pre);
    const cite = (pieces: Interval[], list: NormRecord[]) => pieces.map((x) => ({ ...segment(x.s, x.e), evidenceIds: [...new Set(list.filter((r) => overlaps(forcedSet(pre, [r], root), [x])).flatMap((r) => r.evidenceIds))].sort() }));
    envelope = { certainDowntime: cite(certain, pre.qi), knownNonQualifying: cite(nonQ, pre.ni), possibleDowntime: segs(possibleSet), uncertain, evidenceGaps: segs(gaps), exclusions: s1.exclusions.map((x) => x.a) };
  }

  let boundsOut: TemporalExposureResult['bounds'] = null; let credit: TemporalExposureResult['credit'] = null;
  if (d.perCombo.length && d.lo !== null && d.hi !== null && c) {
    const bps = d.perCombo.map((b) => b.bp).filter((x): x is number => x !== null);
    const totals = d.perCombo.map((b) => b.combo.totalMs);
    let avMin: string | null = null; let avMax: string | null = null;
    const withTotal = d.perCombo.filter((b) => b.combo.totalMs > 0);
    if (withTotal.length) {
      const key = (s: string) => Number(s.replace('.', ''));
      const mins = withTotal.map((b) => availabilityString(b.max.value, b.combo.totalMs, 'floor')); const maxs = withTotal.map((b) => availabilityString(b.min.value, b.combo.totalMs, 'ceil'));
      avMin = mins.reduce((a, b) => (key(b) < key(a) ? b : a)); avMax = maxs.reduce((a, b) => (key(b) > key(a) ? b : a));
    }
    boundsOut = {
      qualifyingDowntimeMs: { min: d.lo, max: d.hi, minStatus: d.perCombo.every((b) => b.min.status === 'EXACT') ? 'EXACT' : 'SOUND_NOT_TIGHT', maxStatus: d.perCombo.every((b) => b.max.status === 'EXACT') ? 'EXACT' : 'SOUND_NOT_TIGHT' },
      breachPointMs: bps.length ? { min: Math.min(...bps), max: Math.max(...bps) } : null,
      availabilityPercent: avMin !== null && avMax !== null ? { min: avMin, max: avMax } : null,
      measuredPeriodMs: { min: Math.min(...totals), max: Math.max(...totals) },
    };
    if (c.credit) credit = { currency: c.credit.currency, minMinor: Math.min(...d.perCombo.map((b) => creditMinor(c.credit!, b.min.value, b.combo.totalMs))), maxMinor: Math.max(...d.perCombo.map((b) => creditMinor(c.credit!, b.max.value, b.combo.totalMs))), capMinor: creditCap(c.credit) };
  }

  const conclusive = d.classification === 'BREACH_CONFIRMED' || d.classification === 'NO_BREACH';
  let statement: string;
  if (d.classification === 'NOT_APPLICABLE') statement = 'The contract does not apply; no evidence can change that without a different contract or scope.';
  else if (conclusive) statement = `Conclusive: ${d.classification === 'BREACH_CONFIRMED' ? 'every' : 'no'} timeline consistent with the evidence breaches. Additional consistent evidence can only narrow the bounds, so it cannot change this classification; only retracting or correcting evidence (or a contract change) could.`;
  else if (d.classification === 'BREACH_POSSIBLE') statement = `Decision-sensitive uncertainty: ${formatDuration(d.residualMs)}. A breach needs ${formatDuration(d.confirmGapMs ?? 0)} more established qualifying downtime; ruling it out needs ${formatDuration(d.eliminateGapMs ?? 0)} of the possible downtime to be shown non-qualifying.`;
  else statement = d.perCombo.length ? `Undecided because of unresolved contradictions or contract review items; with contested evidence set aside the downtime lies in [${formatDuration(d.lo ?? 0)}, ${formatDuration(d.hi ?? 0)}].` : 'Undecided: a valid bound cannot be computed (see reasons and review requirements).';

  return {
    engine: { name: TCF_ENGINE, version: TCF_ENGINE_VERSION },
    classification: d.classification,
    classificationRule: d.rule,
    reasons: d.reasons,
    contract: c ? { contractId: c.doc.contractId, version: c.doc.version, contentHash: c.hash, effectiveFrom: c.doc.effectiveFrom, effectiveTo: c.doc.effectiveTo, selectedBecause: s1.selection.reason } : null,
    target: s1.target,
    window: { requested: segment(s1.requested.start, s1.requested.end), measured: s1.measured ? segment(s1.measured.start, s1.measured.end) : null },
    bounds: boundsOut,
    envelope,
    sensitivity: { conclusive, decisionSensitiveMs: d.residualMs, additionalDowntimeToConfirmMs: d.classification === 'BREACH_POSSIBLE' || (d.classification === 'INDETERMINATE' && d.confirmGapMs !== null) ? d.confirmGapMs : null, possibleDowntimeToEliminateMs: d.classification === 'BREACH_POSSIBLE' || (d.classification === 'INDETERMINATE' && d.eliminateGapMs !== null) ? d.eliminateGapMs : null, statement },
    credit,
    conflicts: d.conflicts,
    evidence,
    reviewRequirements: s1.review,
    disclosures: [...disclosures],
    hashes: s1.hashes,
  };
}

export function analyseContext(ctx: AnalysisContext, evidence: readonly TemporalEvidence[], inactive: readonly InactiveEvidence[] = []): { s1: Stage1; decision: Decision; result: TemporalExposureResult } {
  const s1 = stage1(ctx, evidence, inactive);
  const decision = decide(s1);
  return { s1, decision, result: assemble(s1, decision) };
}

export function formatResultInstant(ms: number): string { return formatInstant(ms); }
