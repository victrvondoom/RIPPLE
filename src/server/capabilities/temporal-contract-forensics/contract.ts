/**
 * Contract semantics compiler: validates a structured contract document into typed, hashed rules, selects the
 * version effective for a measurement window, and turns thresholds/credits into exact integer arithmetic.
 *
 * The compiler never interprets free text. A clause it does not understand becomes a structured
 * `ReviewRequirement`; a missing or invalid field the decision depends on blocks the decision (INDETERMINATE)
 * instead of being defaulted.
 */
import { contentHash, omit } from './hash.js';
import type { QualificationRules } from './qualify.js';
import { calendarMonthWindow, assertTimeZone, monthSpanned, parseInstant, TcfInputError, formatInstant } from './time.js';
import { AUTHORITY_CLASSES, type AuthorityClass, type ContractDocument, type MeasurementWindow, type ReviewRequirement, type ThresholdRule } from './types.js';

export interface Decimal { n: bigint; scale: bigint }

export function parseDecimal(s: unknown): Decimal | null {
  if (typeof s !== 'string' || !/^\d{1,6}(\.\d{1,9})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return { n: BigInt(i! + f), scale: 10n ** BigInt(f.length) };
}

export interface CompiledThreshold { rule: ThresholdRule; pct: Decimal | null }

export interface CompiledContract {
  doc: ContractDocument;
  hash: string;
  termsHash: string;
  effFrom: number;
  effTo: number | null;
  period: { type: 'INCIDENT_WINDOW' } | { type: 'CALENDAR_MONTH'; timeZone: string };
  rules: QualificationRules;
  qualifyingStates: Set<'UNAVAILABLE' | 'DEGRADED'>;
  breach: CompiledThreshold;
  credit: { feeMinor: bigint; currency: string; tiers: { when: CompiledThreshold; pct: Decimal }[]; cap: Decimal | null } | null;
  noticeRequiredMs: number | null;
  establishWith: Set<AuthorityClass> | null;
}

export type CompileOutcome =
  | { ok: true; contract: CompiledContract; review: ReviewRequirement[] }
  | { ok: false; hash: string; contractId: string; version: string; review: ReviewRequirement[] };

const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const posInt = (v: unknown): v is number => nonNegInt(v) && v > 0;

export function contractHash(doc: ContractDocument): string {
  return contentHash('tcf.contract', omit(doc, ['contentHash']));
}

function termsHash(doc: ContractDocument): string {
  return contentHash('tcf.contract.terms', omit(doc, ['contentHash', 'contractId', 'version', 'effectiveFrom', 'effectiveTo']));
}

function compileThreshold(rule: unknown, field: string, review: ReviewRequirement[]): CompiledThreshold | null {
  const r = rule as ThresholdRule | undefined;
  if (!r || typeof r !== 'object') { review.push({ code: 'CONTRACT_FIELD_MISSING', blocking: true, field, detail: `${field} is missing: the contract states no threshold, so no breach can be decided` }); return null; }
  if (typeof r.inclusive !== 'boolean') { review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: `${field}.inclusive`, detail: 'whether the threshold itself counts ("exceeds" vs "at least") must be stated' }); return null; }
  if (r.type === 'DOWNTIME_EXCEEDS') {
    if (!nonNegInt(r.thresholdMs)) { review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: `${field}.thresholdMs`, detail: 'thresholdMs must be a non-negative integer number of milliseconds' }); return null; }
    return { rule: r, pct: null };
  }
  if (r.type === 'AVAILABILITY_BELOW') {
    const pct = parseDecimal(r.targetPercent);
    if (!pct || pct.n > 100n * pct.scale) { review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: `${field}.targetPercent`, detail: 'targetPercent must be an exact decimal string between 0 and 100' }); return null; }
    return { rule: r, pct };
  }
  review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: `${field}.type`, detail: `threshold type "${(r as { type?: string }).type}" is not supported` });
  return null;
}

export function compileContract(doc: ContractDocument): CompileOutcome {
  const review: ReviewRequirement[] = [];
  const hash = contractHash(doc);
  const id = typeof doc?.contractId === 'string' ? doc.contractId : '';
  const version = typeof doc?.version === 'string' ? doc.version : '';
  const fail = (): CompileOutcome => ({ ok: false, hash, contractId: id, version, review });
  if (!id) review.push({ code: 'CONTRACT_FIELD_MISSING', blocking: true, field: 'contractId', detail: 'contractId is required' });
  if (!version) review.push({ code: 'CONTRACT_FIELD_MISSING', blocking: true, field: 'version', detail: 'version is required: an unversioned contract cannot be bound to an incident date' });
  if (doc.contentHash !== undefined && doc.contentHash !== hash) review.push({ code: 'CONTRACT_HASH_MISMATCH', blocking: true, field: 'contentHash', detail: `declared ${doc.contentHash} but the document hashes to ${hash}: the terms are not the ones that were signed off` });

  let effFrom = 0; let effTo: number | null = null;
  try { effFrom = parseInstant(doc.effectiveFrom, 'contract.effectiveFrom'); } catch (e) { review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'effectiveFrom', detail: (e as Error).message }); }
  if (doc.effectiveTo !== null) {
    try { effTo = parseInstant(doc.effectiveTo, 'contract.effectiveTo'); if (effTo <= effFrom) review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'effectiveTo', detail: 'effectiveTo must be after effectiveFrom' }); } catch (e) { review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'effectiveTo', detail: (e as Error).message }); }
  }
  if (!doc.scope || typeof doc.scope.service !== 'string' || !doc.scope.service) review.push({ code: 'CONTRACT_FIELD_MISSING', blocking: true, field: 'scope.service', detail: 'the contract must name the covered service' });

  const m = doc.measurement;
  if (!m || typeof m !== 'object') { review.push({ code: 'CONTRACT_FIELD_MISSING', blocking: true, field: 'measurement', detail: 'measurement rules are missing' }); return fail(); }
  let period: CompiledContract['period'] = { type: 'INCIDENT_WINDOW' };
  if (m.period?.type === 'CALENDAR_MONTH') {
    try { assertTimeZone(m.period.timeZone); period = { type: 'CALENDAR_MONTH', timeZone: m.period.timeZone }; } catch (e) { review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'measurement.period.timeZone', detail: (e as Error).message }); }
  } else if (m.period?.type !== 'INCIDENT_WINDOW') review.push({ code: 'CONTRACT_FIELD_MISSING', blocking: true, field: 'measurement.period', detail: 'the measurement period (INCIDENT_WINDOW or CALENDAR_MONTH with time zone) must be stated' });
  if (m.metric !== 'CUMULATIVE_DOWNTIME' && m.metric !== 'LONGEST_CONTINUOUS_DOWNTIME') review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'measurement.metric', detail: 'metric must be CUMULATIVE_DOWNTIME or LONGEST_CONTINUOUS_DOWNTIME' });
  const qs = Array.isArray(m.qualifyingStates) ? m.qualifyingStates.filter((s) => s === 'UNAVAILABLE' || s === 'DEGRADED') : [];
  if (!qs.length || qs.length !== (m.qualifyingStates?.length ?? 0)) review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'measurement.qualifyingStates', detail: 'qualifyingStates must list UNAVAILABLE and/or DEGRADED: what counts as downtime is not defined' });
  if (m.granularity && (!posInt(m.granularity.bucketMs) || !['ANY_DOWNTIME_IN_BUCKET', 'ENTIRE_BUCKET_DOWN'].includes(m.granularity.rule))) review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'measurement.granularity', detail: 'granularity needs a positive bucketMs and a supported rule' });
  for (const f of ['episodeMergeGapMs', 'minimumQualifyingEpisodeMs', 'gracePerEpisodeMs'] as const) if (m[f] !== undefined && !nonNegInt(m[f])) review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: `measurement.${f}`, detail: `${f} must be a non-negative integer (ms)` });
  if (m.rounding && (!posInt(m.rounding.unitMs) || !['FLOOR', 'CEIL', 'NEAREST_HALF_UP'].includes(m.rounding.method))) review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'measurement.rounding', detail: 'rounding needs a positive unitMs and FLOOR, CEIL or NEAREST_HALF_UP' });

  const breach = compileThreshold(doc.breach, 'breach', review);

  let credit: CompiledContract['credit'] = null;
  if (doc.credit) {
    const c = doc.credit; const tiers: { when: CompiledThreshold; pct: Decimal }[] = [];
    if (!nonNegInt(c.monthlyFeeMinor) || typeof c.currency !== 'string' || !Array.isArray(c.tiers)) review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: false, field: 'credit', detail: 'credit terms are malformed; credit exposure is not computed' });
    else {
      c.tiers.forEach((t, i) => { const w = compileThreshold(t.when, `credit.tiers[${i}].when`, review); const p = parseDecimal(t.creditPercent); if (w && p) tiers.push({ when: w, pct: p }); else if (!p) review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: false, field: `credit.tiers[${i}].creditPercent`, detail: 'creditPercent must be an exact decimal string' }); });
      const cap = c.capPercent === undefined ? null : parseDecimal(c.capPercent);
      if (c.capPercent !== undefined && !cap) review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: false, field: 'credit.capPercent', detail: 'capPercent must be an exact decimal string' });
      credit = { feeMinor: BigInt(c.monthlyFeeMinor), currency: c.currency, tiers, cap };
    }
  }
  let noticeRequiredMs: number | null = null;
  if (doc.maintenance) { if (nonNegInt(doc.maintenance.noticeRequiredMs)) noticeRequiredMs = doc.maintenance.noticeRequiredMs; else review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'maintenance.noticeRequiredMs', detail: 'noticeRequiredMs must be a non-negative integer' }); }
  let establishWith: Set<AuthorityClass> | null = null;
  if (doc.evidenceRequirements?.establishDowntimeWith) {
    const list = doc.evidenceRequirements.establishDowntimeWith;
    if (!list.every((a) => AUTHORITY_CLASSES.includes(a))) review.push({ code: 'CONTRACT_FIELD_INVALID', blocking: true, field: 'evidenceRequirements.establishDowntimeWith', detail: 'unknown authority class in evidence requirement' });
    else establishWith = new Set(list);
  }
  for (const c of doc.clauses ?? []) {
    if (c.type !== 'INFORMATIONAL') review.push({ code: 'UNSUPPORTED_CLAUSE', blocking: true, clauseId: c.id, detail: `clause ${c.id} (${c.type}) is not supported by the compiler and may change the measurement: "${String(c.text).slice(0, 200)}". A human must interpret it.` });
  }
  if (review.some((r) => r.blocking) || !breach) return fail();
  return {
    ok: true, review,
    contract: {
      doc, hash, termsHash: termsHash(doc), effFrom, effTo, period, breach, credit, noticeRequiredMs, establishWith,
      qualifyingStates: new Set(qs),
      rules: {
        metric: m.metric,
        granularity: m.granularity ? { bucketMs: m.granularity.bucketMs, rule: m.granularity.rule === 'ANY_DOWNTIME_IN_BUCKET' ? 'ANY' : 'ENTIRE' } : null,
        mergeGapMs: m.episodeMergeGapMs ?? 0, countMergedGaps: m.countMergedGaps ?? false,
        minEpisodeMs: m.minimumQualifyingEpisodeMs ?? 0, graceMs: m.gracePerEpisodeMs ?? 0,
        rounding: m.rounding ?? null,
      },
    },
  };
}

/** Resolve the requested window to [start, end) ms. A calendar month needs the contract's time zone. */
export function resolveWindow(w: MeasurementWindow, period: CompiledContract['period'] | null): { start: number; end: number; review: ReviewRequirement[] } {
  const review: ReviewRequirement[] = [];
  if ('calendarMonth' in w) {
    if (!period || period.type !== 'CALENDAR_MONTH') throw new TcfInputError('WINDOW_PERIOD_MISMATCH', 'a calendarMonth window needs a contract whose measurement period is CALENDAR_MONTH (it defines the time zone)');
    const [start, end] = calendarMonthWindow(w.calendarMonth, period.timeZone);
    return { start, end, review };
  }
  const start = parseInstant(w.start, 'measurementWindow.start'); const end = parseInstant(w.end, 'measurementWindow.end');
  if (end <= start) throw new TcfInputError('EMPTY_WINDOW', 'measurementWindow.end must be after start');
  if (period?.type === 'CALENDAR_MONTH' && !monthSpanned(start, end, period.timeZone)) review.push({ code: 'WINDOW_NOT_CONTRACT_PERIOD', blocking: true, detail: `the contract measures calendar months in ${period.timeZone}; ${formatInstant(start)}–${formatInstant(end)} is not one` });
  return { start, end, review };
}

/** Exact smallest integer downtime (ms) that is a breach, given the measured period length. null if undefined. */
export function breachPoint(t: CompiledThreshold, totalMs: number): number | null {
  if (t.rule.type === 'DOWNTIME_EXCEEDS') return t.rule.inclusive ? t.rule.thresholdMs : t.rule.thresholdMs + 1;
  if (totalMs <= 0) return null;
  const p = t.pct!; const D = 100n * p.scale; const X = BigInt(totalMs) * (D - p.n);
  // strict: availability < p  ⇔ m·D > X ; inclusive: availability ≤ p ⇔ m·D ≥ X
  const v = t.rule.inclusive ? (X + D - 1n) / D : X / D + 1n;
  return Number(v);
}

/** Availability % as an exact decimal string with `digits` decimals, rounded down ('floor') or up ('ceil'). */
export function availabilityString(downMs: number, totalMs: number, dir: 'floor' | 'ceil', digits = 4): string {
  if (totalMs <= 0) return 'undefined';
  const scale = 10n ** BigInt(digits);
  const num = 100n * scale * BigInt(totalMs - downMs); const den = BigInt(totalMs);
  const q = dir === 'floor' ? num / den : (num + den - 1n) / den;
  const s = q.toString().padStart(digits + 1, '0');
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

export function creditMinor(c: NonNullable<CompiledContract['credit']>, downMs: number, totalMs: number): number {
  let best: Decimal | null = null;
  for (const t of c.tiers) {
    const bp = breachPoint(t.when, totalMs);
    if (bp !== null && downMs >= bp && (!best || t.pct.n * best.scale > best.n * t.pct.scale)) best = t.pct;
  }
  if (!best) return 0;
  let amount = (c.feeMinor * best.n) / (100n * best.scale);
  if (c.cap) { const cap = (c.feeMinor * c.cap.n) / (100n * c.cap.scale); if (amount > cap) amount = cap; }
  return Number(amount);
}

export function creditCap(c: NonNullable<CompiledContract['credit']>): number | null {
  return c.cap ? Number((c.feeMinor * c.cap.n) / (100n * c.cap.scale)) : null;
}

export interface ContractSelection {
  contract: CompiledContract | null;
  /** Window clipped to the selected version's effective period. */
  measured: { start: number; end: number } | null;
  review: ReviewRequirement[];
  reason: string;
  notApplicable: boolean;
  failed: Extract<CompileOutcome, { ok: false }> | null;
}

/**
 * Select the version effective over [ws, we). Never "the latest": selection is by effective dates only.
 * - none overlaps → NOT_APPLICABLE;
 * - one overlaps → it, with the window clipped to its effective period (partial coverage disclosed);
 * - several overlap with identical measurement terms → the earliest, window unclipped across them;
 * - several with different terms → blocking review (a version boundary inside the window is not split silently).
 */
export function selectContract(docs: ContractDocument[], resolveFor: (c: CompiledContract | null) => { start: number; end: number; review: ReviewRequirement[] }): ContractSelection {
  if (!docs.length) throw new TcfInputError('NO_CONTRACT', 'at least one contract version is required');
  const ids = new Set(docs.map((d) => d.contractId));
  if (ids.size > 1) throw new TcfInputError('MIXED_CONTRACTS', `versions of exactly one contract are expected, got ${[...ids].join(', ')}`);
  const versions = new Set<string>();
  for (const d of docs) { if (versions.has(d.version)) throw new TcfInputError('DUPLICATE_VERSION', `contract version ${d.version} appears twice`); versions.add(d.version); }
  const compiled = docs.map(compileContract);
  const good = compiled.filter((c): c is Extract<CompileOutcome, { ok: true }> => c.ok);
  const bad = compiled.filter((c): c is Extract<CompileOutcome, { ok: false }> => !c.ok);
  // Use any compiled version to resolve a calendar window; all versions of one contract must share the period type.
  const probe = good[0]?.contract ?? null;
  const w = resolveFor(probe);
  const overlapping = good.filter((g) => g.contract.effFrom < w.end && (g.contract.effTo === null || g.contract.effTo > w.start)).sort((a, b) => a.contract.effFrom - b.contract.effFrom);
  // A failed version whose dates overlap the window blocks: we cannot rule out that it is the effective one.
  const badOverlapping = bad.filter((b) => {
    const d = docs.find((x) => x.version === b.version)!;
    try { const f = parseInstant(d.effectiveFrom, 'f'); const t = d.effectiveTo === null ? null : parseInstant(d.effectiveTo, 't'); return f < w.end && (t === null || t > w.start); } catch { return true; }
  });
  if (badOverlapping.length) return { contract: null, measured: null, review: [...w.review, ...badOverlapping.flatMap((b) => b.review)], reason: `contract version ${badOverlapping.map((b) => b.version).join(', ')} applies to the window but cannot be compiled`, notApplicable: false, failed: badOverlapping[0]! };
  if (!overlapping.length) {
    return { contract: null, measured: null, review: [...w.review, { code: 'CONTRACT_NOT_EFFECTIVE', blocking: false, detail: `no version of ${docs[0]!.contractId} is effective between ${formatInstant(w.start)} and ${formatInstant(w.end)}` }], reason: 'no contract version is effective in the measurement window', notApplicable: true, failed: null };
  }
  const review = [...w.review, ...overlapping.flatMap((o) => o.review)];
  if (overlapping.length > 1 && new Set(overlapping.map((o) => o.contract.termsHash)).size > 1) {
    review.push({ code: 'CONTRACT_VERSION_BOUNDARY_IN_WINDOW', blocking: true, detail: `versions ${overlapping.map((o) => o.contract.doc.version).join(' and ')} have different terms and both apply inside the window; the window must be split by a human-approved rule` });
    return { contract: overlapping[0]!.contract, measured: null, review, reason: 'contract version boundary inside the window', notApplicable: false, failed: null };
  }
  const first = overlapping[0]!.contract; const last = overlapping[overlapping.length - 1]!.contract;
  const start = Math.max(w.start, first.effFrom); const end = last.effTo === null ? w.end : Math.min(w.end, last.effTo);
  if (start !== w.start || end !== w.end) review.push({ code: 'CONTRACT_COVERAGE_PARTIAL', blocking: false, detail: `version ${first.doc.version} covers only ${formatInstant(start)}–${formatInstant(end)} of the requested window; time outside it is not measured` });
  const reason = overlapping.length > 1 ? `versions ${overlapping.map((o) => o.contract.doc.version).join(', ')} apply with identical measurement terms` : `version ${first.doc.version} is effective from ${first.doc.effectiveFrom}${first.doc.effectiveTo ? ` to ${first.doc.effectiveTo}` : ''}, which overlaps the window`;
  return { contract: first, measured: { start, end }, review, reason, notApplicable: false, failed: null };
}
