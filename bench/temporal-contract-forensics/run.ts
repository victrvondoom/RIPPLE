/**
 * TCFB runner: generates the benchmark (fixed seed), runs the engine and the independent oracle on every case,
 * scores against the oracle AND the hidden ground truth, and writes machine- and human-readable results.
 *
 *   npx tsx bench/temporal-contract-forensics/run.ts [casesPerCategory=150] [mdeSamplesPerCategory=12]
 *
 * Outputs (bench/temporal-contract-forensics/results/): results.json, cases.csv, confusion.json, failures.json, report.md
 * No number in the report is written by hand: every one is computed here from the per-case rows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createTemporalContractForensics, DEFAULT_POLICY, TCF_ENGINE_VERSION, type AnalysisRevision, type Classification, type CounterfactualChange, type EvidenceRequirement, type TemporalEvidence, type TemporalExposureResult } from '../../src/server/capabilities/temporal-contract-forensics/index.js';
import { generateAll } from './generator.js';
import { CATEGORIES, iso, RANKS, rng, SEED, type BenchCase, type Category } from './lib.js';
import { runOracle, type OracleResult } from './oracle.js';

const PER = Number(process.argv[2] ?? 150);
const MDE_PER = Number(process.argv[3] ?? 12);
const OUT = new URL('./results/', import.meta.url);
const tcf = createTemporalContractForensics();
const CLS: Classification[] = ['BREACH_CONFIRMED', 'BREACH_POSSIBLE', 'NO_BREACH', 'INDETERMINATE', 'NOT_APPLICABLE'];
const decisive = (c: Classification) => c === 'BREACH_CONFIRMED' || c === 'NO_BREACH';

for (const [k, v] of Object.entries(RANKS)) if (DEFAULT_POLICY.authorityRanks[k as keyof typeof RANKS] !== v) throw new Error(`oracle rank table out of date for ${k}`);

interface Row {
  id: string; category: Category; engine: Classification; oracle: Classification; truthBreach: boolean | null; truthMs: number | null; breachPointMs: number | null;
  eMin: number | null; eMax: number | null; eMinStatus: string | null; eMaxStatus: string | null; oMin: number | null; oMax: number | null; oracleExact: boolean;
  liars: number; soundVsTruth: boolean | null; containsOracle: boolean | null; exactMatch: boolean | null; gapRecall: number | null; gapPrecision: number | null;
  deterministic: boolean; orderInvariant: boolean; updateConsistent: boolean | null; ms: number;
  mdeTopKind: string | null; mdeTopGuarantee: string | null; mdeAfter: Classification | null; mdeCorrect: boolean | null; baselineAfter: Classification | null; baselineCorrect: boolean | null;
}

const measure = (xs: [number, number][]) => xs.reduce((t, [a, b]) => t + Math.max(0, b - a), 0);
function interMeasure(a: [number, number][], b: [number, number][]) { let m = 0; for (const [s, e] of a) for (const [x, y] of b) m += Math.max(0, Math.min(e, y) - Math.max(s, x)); return m; }

/** Turn a requested piece of evidence into the change that obtaining it from the hidden truth would make. */
function acquire(c: BenchCase, q: EvidenceRequirement, result: TemporalExposureResult): CounterfactualChange[] | null {
  const t = q.target as Record<string, string | string[] | number | undefined>;
  if (q.kind === 'OBSERVE_INTERVAL') {
    const s = Date.parse(String(t.start)); const e = Date.parse(String(t.end));
    const cuts = [s, e, ...c.truth.down.flat().filter((x) => x > s && x < e)].sort((a, b) => a - b);
    const ch: CounterfactualChange[] = []; let k = 0;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i]!; const b = cuts[i + 1]!; if (a >= b) continue;
      const down = c.truth.down.some(([x, y]) => a >= x && b <= y);
      const ev: TemporalEvidence = { id: `acq-${++k}`, incidentId: 'ACQ', scope: { service: result.target!.service, ...(result.target!.region ? { region: result.target!.region } : {}), ...(result.target!.customer ? { customer: result.target!.customer } : {}) }, source: { system: 'tcfb-acquired', recordId: `acq-${k}`, authority: 'SIGNED_MONITORING', signatureVerified: true }, assertion: { kind: 'INTERVAL', state: down ? 'UNAVAILABLE' : 'HEALTHY', start: { earliest: iso(a), latest: iso(a) }, end: { earliest: iso(b), latest: iso(b) } }, observedAt: iso(b + 60_000), provenance: { reference: 'tcfb://acquired', contentHash: `acq-${q.id}-${k}` } };
      ch.push({ type: 'ADD_EVIDENCE', evidence: ev });
    }
    if (!ch.length) return null;
    ch.push({ type: 'SET_CLOCK', clockId: 'tcfb-acquired', knownOffsetMs: 0, uncertaintyMs: 0 });
    return ch;
  }
  if (q.kind === 'RESOLVE_TIMESTAMP') {
    const id = String(t.evidenceId); const ep = String(t.endpoint) as 'start' | 'end' | 'at'; const read = c.meta.trueReadings[id]?.[ep];
    return read === undefined ? null : [{ type: 'SET_TIME_BOUND', evidenceId: id, endpoint: ep, bound: { earliest: iso(read), latest: iso(read) } }];
  }
  if (q.kind === 'RESOLVE_CLOCK_OFFSET') { const off = c.meta.trueOffsets[String(t.clockId)]; return off === undefined ? null : [{ type: 'SET_CLOCK', clockId: String(t.clockId), knownOffsetMs: off, uncertaintyMs: 0 }]; }
  if (q.kind === 'CONFIRM_EXCLUSION') { const v = c.meta.maintenanceValid[String(t.maintenanceId)]; return v === undefined ? null : [{ type: 'SET_EXCLUSION_STATUS', maintenanceId: String(t.maintenanceId), status: v ? 'CONFIRMED' : 'REJECTED' }]; }
  if (q.kind === 'RESOLVE_CONFLICT') { const liars = (t.evidenceIds as string[]).filter((x) => c.meta.liars.includes(x)); return liars.length ? liars.map((x) => ({ type: 'EXCLUDE_EVIDENCE' as const, evidenceId: x, reason: 'shown false by the acquired raw record' })) : null; }
  return null;
}

function afterAcquiring(c: BenchCase, rev: AnalysisRevision, q: EvidenceRequirement | undefined): { after: Classification | null; correct: boolean | null } {
  if (!q) return { after: null, correct: null };
  const ch = acquire(c, q, rev.result); if (!ch) return { after: rev.result.classification, correct: false };
  const cf = tcf.counterfactual({ analysis: rev, changes: ch });
  if (!cf.result) return { after: null, correct: false };
  const k = cf.result.classification;
  return { after: k, correct: decisive(k) && c.truth.breach !== null ? (k === 'BREACH_CONFIRMED') === c.truth.breach : false };
}

const t0 = Date.now();
const cases = generateAll(PER, SEED);
const rows: Row[] = []; const failures: Record<string, unknown[]> = {};
const fail = (k: string, x: unknown) => { const list = (failures[k] ??= []); if (list.length < 8) list.push(x); };
const mdeTaken: Record<string, number> = {};
const pickRng = rng(SEED ^ 0x5bd1e995);

for (const c of cases) {
  const s = performance.now();
  const rev = tcf.open(c.input, { at: '2027-01-01T00:00:00Z' });
  const ms = performance.now() - s;
  const e = rev.result; const o: OracleResult = runOracle(c.oracle);
  const b = e.bounds?.qualifyingDowntimeMs ?? null;
  const honest = c.meta.liars.length === 0;
  const soundVsTruth = c.truth.metricMs === null || !b || !honest ? null : b.min <= c.truth.metricMs && c.truth.metricMs <= b.max;
  const containsOracle = !b || o.lo === null || !c.oracle.exact ? null : b.min <= o.lo && b.max >= o.hi!;
  const exactMatch = !b || o.lo === null || !c.oracle.exact ? null : (b.minStatus === 'EXACT' ? b.min === o.lo : true) && (b.maxStatus === 'EXACT' ? b.max === o.hi : true) && (b.minStatus === 'EXACT' || b.maxStatus === 'EXACT' ? true : true);
  const eg: [number, number][] = e.envelope.evidenceGaps.map((g) => [g.startMs, g.endMs]);
  const og = o.uncovered; const ogm = measure(og); const egm = measure(eg);
  const gapRecall = o.lo === null || !b ? null : ogm ? interMeasure(eg, og) / ogm : egm ? null : 1;
  const gapPrecision = o.lo === null || !b ? null : egm ? interMeasure(eg, og) / egm : ogm ? null : 1;
  // determinism and evidence-order invariance
  const again = tcf.open(c.input, { at: '2027-01-01T00:00:00Z' });
  const shuffled = [...c.input.evidence]; const sr = rng(c.index + 7);
  for (let i = shuffled.length - 1; i > 0; i--) { const j = sr.int(0, i); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
  const reordered = tcf.open({ ...c.input, evidence: shuffled }, { at: '2027-01-01T00:00:00Z' });
  // late-arriving evidence: incremental revisions must end where one batch analysis is
  let updateConsistent: boolean | null = null;
  if (c.meta.lateIds.length) {
    let inc = tcf.open({ ...c.input, evidence: c.input.evidence.filter((x) => !c.meta.lateIds.includes(x.id)) }, { at: '2027-01-01T00:00:00Z' });
    for (const id of [...c.meta.lateIds].reverse()) inc = tcf.update({ previous: inc, event: { type: 'ADD_EVIDENCE', evidence: c.input.evidence.find((x) => x.id === id)!, receivedAt: '2027-01-02T00:00:00Z' } });
    updateConsistent = inc.outputHash === rev.outputHash && inc.revision === c.meta.lateIds.length + 1 && tcf.verify(inc).ok;
  }
  // MDE usefulness on a sample of undecided cases with an answerable truth
  let mde: Pick<Row, 'mdeTopKind' | 'mdeTopGuarantee' | 'mdeAfter' | 'mdeCorrect' | 'baselineAfter' | 'baselineCorrect'> = { mdeTopKind: null, mdeTopGuarantee: null, mdeAfter: null, mdeCorrect: null, baselineAfter: null, baselineCorrect: null };
  if (e.classification === 'BREACH_POSSIBLE' && c.truth.breach !== null && (mdeTaken[c.category] ?? 0) < MDE_PER) {
    mdeTaken[c.category] = (mdeTaken[c.category] ?? 0) + 1;
    const reqs = tcf.minimumDecisiveEvidence({ analysis: rev });
    const top = reqs[0]; const base = reqs.length ? reqs[pickRng.int(0, reqs.length - 1)] : undefined;
    const a = afterAcquiring(c, rev, top); const bl = afterAcquiring(c, rev, base);
    mde = { mdeTopKind: top?.kind ?? null, mdeTopGuarantee: top?.guarantee ?? null, mdeAfter: a.after, mdeCorrect: a.correct, baselineAfter: bl.after, baselineCorrect: bl.correct };
    if (top?.guarantee === 'ALWAYS_DECISIVE' && a.after && !decisive(a.after)) fail('ALWAYS_DECISIVE_NOT_DECISIVE', { id: c.id, top, after: a.after });
  }
  const row: Row = {
    id: c.id, category: c.category, engine: e.classification, oracle: o.classification, truthBreach: c.truth.breach, truthMs: c.truth.metricMs, breachPointMs: c.truth.breachPointMs,
    eMin: b?.min ?? null, eMax: b?.max ?? null, eMinStatus: b?.minStatus ?? null, eMaxStatus: b?.maxStatus ?? null, oMin: o.lo, oMax: o.hi, oracleExact: c.oracle.exact,
    liars: c.meta.liars.length, soundVsTruth, containsOracle, exactMatch, gapRecall, gapPrecision,
    deterministic: again.outputHash === rev.outputHash && again.revisionHash === rev.revisionHash, orderInvariant: reordered.outputHash === rev.outputHash, updateConsistent, ms, ...mde,
  };
  rows.push(row);
  if (row.engine !== row.oracle) fail('CLASS_MISMATCH_VS_ORACLE', { id: c.id, engine: row.engine, oracle: row.oracle, bounds: [row.eMin, row.eMax], oracleBounds: [row.oMin, row.oMax], reasons: e.reasons });
  if (row.engine === 'BREACH_CONFIRMED' && row.truthBreach === false) fail('FALSE_CONFIRMED_BREACH', { id: c.id, liars: c.meta.liars, truthMs: row.truthMs, breachPointMs: row.breachPointMs, bounds: [row.eMin, row.eMax], conflicts: e.conflicts.map((x) => `${x.type}:${x.resolution}`), rule: e.classificationRule });
  if (row.engine === 'NO_BREACH' && row.truthBreach === true) fail('FALSE_NO_BREACH', { id: c.id, liars: c.meta.liars, truthMs: row.truthMs, breachPointMs: row.breachPointMs, bounds: [row.eMin, row.eMax] });
  if (row.soundVsTruth === false) fail('BOUNDS_EXCLUDE_TRUTH', { id: c.id, truthMs: row.truthMs, bounds: [row.eMin, row.eMax] });
  if (row.containsOracle === false || row.exactMatch === false) fail('BOUNDS_DISAGREE_WITH_ORACLE', { id: c.id, engine: [row.eMin, row.eMax, row.eMinStatus, row.eMaxStatus], oracle: [row.oMin, row.oMax] });
  if (!row.deterministic || !row.orderInvariant) fail('NON_DETERMINISTIC', { id: c.id });
  if (row.updateConsistent === false) fail('UPDATE_INCONSISTENT', { id: c.id });
  if (row.engine !== 'NOT_APPLICABLE' && row.oracle !== 'NOT_APPLICABLE' && decisive(row.oracle) && !decisive(row.engine)) fail('EXCESSIVE_ABSTENTION', { id: c.id, engine: row.engine, oracle: row.oracle, bounds: [row.eMin, row.eMax], oracleBounds: [row.oMin, row.oMax] });
}
const elapsed = Date.now() - t0;

// ───────── metrics ─────────
const rate = (num: number, den: number) => ({ num, den, rate: den ? Number((num / den).toFixed(4)) : null });
const by = (f: (r: Row) => boolean) => rows.filter(f);
const confusion = (key: (r: Row) => string, cols: string[]) => Object.fromEntries(CLS.map((e) => [e, Object.fromEntries(cols.map((c) => [c, rows.filter((r) => r.engine === e && key(r) === c).length]))]));
const truthKey = (r: Row) => (r.truthBreach === null ? 'NOT_DECIDABLE' : r.truthBreach ? 'TRUE_BREACH' : 'TRUE_NO_BREACH');
const truthNo = by((r) => r.truthBreach === false); const truthYes = by((r) => r.truthBreach === true);
const honestRows = (xs: Row[]) => xs.filter((r) => r.liars === 0);
const oracleDecisive = by((r) => decisive(r.oracle));
const mdeRows = by((r) => r.mdeTopKind !== null || r.mdeAfter !== null);
const ruleCats: Category[] = ['MAINTENANCE_EXCLUSIONS', 'CONTRACT_VERSION_CHANGE', 'WINDOW_BOUNDARY', 'TIMEZONE_BOUNDARY', 'THRESHOLD_EQUALITY', 'MISSING_CONTRACT_FIELDS', 'INCORRECT_SERVICE_SCOPE', 'FLAPPING_RECOVERY'];
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const metrics = {
  safety: {
    falseConfirmedBreachRate: rate(truthNo.filter((r) => r.engine === 'BREACH_CONFIRMED').length, truthNo.length),
    falseConfirmedBreachRate_honestEvidence: rate(honestRows(truthNo).filter((r) => r.engine === 'BREACH_CONFIRMED').length, honestRows(truthNo).length),
    falseConfirmedBreachRate_withFalsifiedEvidence: rate(truthNo.filter((r) => r.liars > 0 && r.engine === 'BREACH_CONFIRMED').length, truthNo.filter((r) => r.liars > 0).length),
    precisionOfConfirmedBreach: rate(by((r) => r.engine === 'BREACH_CONFIRMED' && r.truthBreach === true).length, by((r) => r.engine === 'BREACH_CONFIRMED' && r.truthBreach !== null).length),
    falseNoBreachRate: rate(truthYes.filter((r) => r.engine === 'NO_BREACH').length, truthYes.length),
    falseNoBreachRate_honestEvidence: rate(honestRows(truthYes).filter((r) => r.engine === 'NO_BREACH').length, honestRows(truthYes).length),
  },
  classification: {
    agreementWithOracle: rate(by((r) => r.engine === r.oracle).length, rows.length),
    correctConfirmed: rate(by((r) => r.engine === 'BREACH_CONFIRMED' && r.oracle === 'BREACH_CONFIRMED').length, by((r) => r.oracle === 'BREACH_CONFIRMED').length),
    correctNoBreach: rate(by((r) => r.engine === 'NO_BREACH' && r.oracle === 'NO_BREACH').length, by((r) => r.oracle === 'NO_BREACH').length),
    correctPossible: rate(by((r) => r.engine === 'BREACH_POSSIBLE' && r.oracle === 'BREACH_POSSIBLE').length, by((r) => r.oracle === 'BREACH_POSSIBLE').length),
    correctIndeterminate: rate(by((r) => r.engine === 'INDETERMINATE' && r.oracle === 'INDETERMINATE').length, by((r) => r.oracle === 'INDETERMINATE').length),
    correctNotApplicable: rate(by((r) => r.engine === 'NOT_APPLICABLE' && r.oracle === 'NOT_APPLICABLE').length, by((r) => r.oracle === 'NOT_APPLICABLE').length),
    excessiveAbstention: rate(oracleDecisive.filter((r) => !decisive(r.engine)).length, oracleDecisive.length),
    abstentionRateOverall: rate(by((r) => r.engine === 'BREACH_POSSIBLE' || r.engine === 'INDETERMINATE').length, by((r) => r.engine !== 'NOT_APPLICABLE').length),
    decisiveRateOnDecidableTruth: rate(by((r) => r.truthBreach !== null && decisive(r.engine)).length, by((r) => r.truthBreach !== null).length),
  },
  bounds: {
    soundAgainstHiddenTruth: rate(by((r) => r.soundVsTruth === true).length, by((r) => r.soundVsTruth !== null).length),
    containOracleBounds: rate(by((r) => r.containsOracle === true).length, by((r) => r.containsOracle !== null).length),
    exactBoundsEqualOracle: rate(by((r) => r.exactMatch === true).length, by((r) => r.exactMatch !== null).length),
    tightness_bothBoundsExact: rate(by((r) => r.eMinStatus === 'EXACT' && r.eMaxStatus === 'EXACT').length, by((r) => r.eMinStatus !== null).length),
    duplicateDurationPrevention: rate(by((r) => (r.category === 'DUPLICATE_OUTAGE_EVENTS' || r.category === 'MULTIPLE_OVERLAPPING_INTERVALS') && r.soundVsTruth === true).length, by((r) => (r.category === 'DUPLICATE_OUTAGE_EVENTS' || r.category === 'MULTIPLE_OVERLAPPING_INTERVALS') && r.soundVsTruth !== null).length),
  },
  contractRules: { agreementWithOracle_ruleCategories: rate(by((r) => ruleCats.includes(r.category) && r.engine === r.oracle).length, by((r) => ruleCats.includes(r.category)).length) },
  evidenceGaps: {
    meanRecall: Number((by((r) => r.gapRecall !== null).reduce((t, r) => t + r.gapRecall!, 0) / Math.max(1, by((r) => r.gapRecall !== null).length)).toFixed(4)),
    meanPrecision: Number((by((r) => r.gapPrecision !== null).reduce((t, r) => t + r.gapPrecision!, 0) / Math.max(1, by((r) => r.gapPrecision !== null).length)).toFixed(4)),
    casesWithGaps: by((r) => r.gapRecall !== null && r.gapRecall < 1.0001 && r.oracle !== 'NOT_APPLICABLE').length,
  },
  minimumDecisiveEvidence: {
    sampledUndecidedCases: mdeRows.length,
    top1DecisiveAfterAcquisition: rate(mdeRows.filter((r) => r.mdeAfter !== null && decisive(r.mdeAfter)).length, mdeRows.length),
    top1CorrectAfterAcquisition: rate(mdeRows.filter((r) => r.mdeCorrect === true).length, mdeRows.length),
    randomRequestDecisiveAfterAcquisition: rate(mdeRows.filter((r) => r.baselineAfter !== null && decisive(r.baselineAfter)).length, mdeRows.length),
    randomRequestCorrectAfterAcquisition: rate(mdeRows.filter((r) => r.baselineCorrect === true).length, mdeRows.length),
    alwaysDecisiveGuaranteeHeld: rate(mdeRows.filter((r) => r.mdeTopGuarantee === 'ALWAYS_DECISIVE' && r.mdeAfter !== null && decisive(r.mdeAfter)).length, mdeRows.filter((r) => r.mdeTopGuarantee === 'ALWAYS_DECISIVE').length),
    topRequestKinds: Object.fromEntries([...new Set(mdeRows.map((r) => r.mdeTopKind ?? 'none'))].map((k) => [k, mdeRows.filter((r) => (r.mdeTopKind ?? 'none') === k).length])),
  },
  dynamics: {
    updateConsistency: rate(by((r) => r.updateConsistent === true).length, by((r) => r.updateConsistent !== null).length),
    deterministicReproducibility: rate(by((r) => r.deterministic).length, rows.length),
    evidenceOrderInvariance: rate(by((r) => r.orderInvariant).length, rows.length),
  },
  performance: { engineMsMean: Number((ms.reduce((t, x) => t + x, 0) / ms.length).toFixed(2)), engineMsP95: Number(ms[Math.floor(ms.length * 0.95)]!.toFixed(2)), engineMsMax: Number(ms[ms.length - 1]!.toFixed(2)), totalRunMs: elapsed },
};
const perCategory = Object.fromEntries(CATEGORIES.map((cat) => {
  const rs = rows.filter((r) => r.category === cat);
  return [cat, { cases: rs.length, agreementWithOracle: rate(rs.filter((r) => r.engine === r.oracle).length, rs.length).rate, falseConfirmed: rs.filter((r) => r.engine === 'BREACH_CONFIRMED' && r.truthBreach === false).length, falseNoBreach: rs.filter((r) => r.engine === 'NO_BREACH' && r.truthBreach === true).length, classes: Object.fromEntries(CLS.map((k) => [k, rs.filter((r) => r.engine === k).length])), boundsExact: rs.filter((r) => r.eMinStatus === 'EXACT' && r.eMaxStatus === 'EXACT').length, oracleExact: rs.filter((r) => r.oracleExact).length }];
}));
const confusionMatrices = { engineVsOracle: confusion((r) => r.oracle, CLS), engineVsTruth: confusion(truthKey, ['TRUE_BREACH', 'TRUE_NO_BREACH', 'NOT_DECIDABLE']) };
const config = { benchmark: 'TCFB', engine: TCF_ENGINE_VERSION, seed: SEED, casesPerCategory: PER, categories: CATEGORIES.length, totalCases: rows.length, mdeSamplesPerCategory: MDE_PER, policy: { ...DEFAULT_POLICY } };

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL('results.json', OUT), JSON.stringify({ config, metrics, perCategory, failureCounts: Object.fromEntries(Object.entries(failures).map(([k, v]) => [k, v.length])) }, null, 2) + '\n');
writeFileSync(new URL('confusion.json', OUT), JSON.stringify(confusionMatrices, null, 2) + '\n');
writeFileSync(new URL('failures.json', OUT), JSON.stringify(failures, null, 2) + '\n');
const cols = Object.keys(rows[0]!) as (keyof Row)[];
writeFileSync(new URL('cases.csv', OUT), [cols.join(','), ...rows.map((r) => cols.map((k) => (r[k] === null ? '' : typeof r[k] === 'number' ? (k === 'ms' ? (r[k] as number).toFixed(2) : String(r[k])) : String(r[k]))).join(','))].join('\n') + '\n');

const pct = (x: { rate: number | null; num: number; den: number }) => (x.rate === null ? 'n/a' : `${(x.rate * 100).toFixed(2)}% (${x.num}/${x.den})`);
const mt = (m: Record<string, Record<string, number>>, colsOf: string[]) => [`| engine \\ reference | ${colsOf.join(' | ')} |`, `|---|${colsOf.map(() => '---:').join('|')}|`, ...Object.entries(m).map(([k, v]) => `| ${k} | ${colsOf.map((c) => v[c]).join(' | ')} |`)].join('\n');
const report = `# TCFB results (generated — do not edit by hand)

Engine ${TCF_ENGINE_VERSION}, seed ${SEED}, ${rows.length} cases (${PER} × ${CATEGORIES.length} categories), MDE sampled on up to ${MDE_PER} undecided cases per category. Run time ${(elapsed / 1000).toFixed(1)} s.
Regenerate: \`npx tsx bench/temporal-contract-forensics/run.ts ${PER} ${MDE_PER}\`.

## Safety
| metric | value |
|---|---|
| **False confirmed breach rate** (engine CONFIRMED, truth no breach) | **${pct(metrics.safety.falseConfirmedBreachRate)}** |
| … with honest evidence only | ${pct(metrics.safety.falseConfirmedBreachRate_honestEvidence)} |
| … in cases containing deliberately falsified evidence | ${pct(metrics.safety.falseConfirmedBreachRate_withFalsifiedEvidence)} |
| Precision of BREACH_CONFIRMED | ${pct(metrics.safety.precisionOfConfirmedBreach)} |
| False NO_BREACH rate (engine NO_BREACH, truth breach) | ${pct(metrics.safety.falseNoBreachRate)} |
| … with honest evidence only | ${pct(metrics.safety.falseNoBreachRate_honestEvidence)} |

## Classification against the independent oracle
| metric | value |
|---|---|
| Agreement with oracle (all classes) | ${pct(metrics.classification.agreementWithOracle)} |
| Correct BREACH_CONFIRMED | ${pct(metrics.classification.correctConfirmed)} |
| Correct NO_BREACH | ${pct(metrics.classification.correctNoBreach)} |
| Correct BREACH_POSSIBLE | ${pct(metrics.classification.correctPossible)} |
| Correct INDETERMINATE | ${pct(metrics.classification.correctIndeterminate)} |
| Correct NOT_APPLICABLE | ${pct(metrics.classification.correctNotApplicable)} |
| Excessive abstention (oracle decisive, engine not) | ${pct(metrics.classification.excessiveAbstention)} |
| Abstention overall (POSSIBLE or INDETERMINATE) | ${pct(metrics.classification.abstentionRateOverall)} |
| Decisive on cases whose truth is decidable | ${pct(metrics.classification.decisiveRateOnDecidableTruth)} |

## Temporal bounds
| metric | value |
|---|---|
| Bounds contain the hidden true downtime (honest evidence) | ${pct(metrics.bounds.soundAgainstHiddenTruth)} |
| Bounds contain the oracle's exact bounds | ${pct(metrics.bounds.containOracleBounds)} |
| Bounds labelled EXACT equal the oracle | ${pct(metrics.bounds.exactBoundsEqualOracle)} |
| Both bounds proven tight (EXACT) | ${pct(metrics.bounds.tightness_bothBoundsExact)} |
| Duplicate-duration prevention (no inflated minimum, duplicate/overlap categories) | ${pct(metrics.bounds.duplicateDurationPrevention)} |
| Contract-rule categories: agreement with oracle | ${pct(metrics.contractRules.agreementWithOracle_ruleCategories)} |
| Evidence-gap detection: mean recall / precision (measure-weighted) | ${metrics.evidenceGaps.meanRecall} / ${metrics.evidenceGaps.meanPrecision} |

## Minimum decisive evidence (acquired from the hidden truth)
| metric | value |
|---|---|
| Sampled undecided cases | ${metrics.minimumDecisiveEvidence.sampledUndecidedCases} |
| Top-ranked request decides the case | ${pct(metrics.minimumDecisiveEvidence.top1DecisiveAfterAcquisition)} |
| Top-ranked request decides it correctly | ${pct(metrics.minimumDecisiveEvidence.top1CorrectAfterAcquisition)} |
| Baseline: uniformly random listed request decides | ${pct(metrics.minimumDecisiveEvidence.randomRequestDecisiveAfterAcquisition)} |
| Baseline: random request decides correctly | ${pct(metrics.minimumDecisiveEvidence.randomRequestCorrectAfterAcquisition)} |
| ALWAYS_DECISIVE guarantee held | ${pct(metrics.minimumDecisiveEvidence.alwaysDecisiveGuaranteeHeld)} |
| Top request kinds | ${Object.entries(metrics.minimumDecisiveEvidence.topRequestKinds).map(([k, v]) => `${k}: ${v}`).join(', ')} |

## Dynamics and reproducibility
| metric | value |
|---|---|
| Late-arriving evidence: incremental revisions = batch analysis (output hash) | ${pct(metrics.dynamics.updateConsistency)} |
| Identical input → identical output and revision hash | ${pct(metrics.dynamics.deterministicReproducibility)} |
| Evidence order does not change the output hash | ${pct(metrics.dynamics.evidenceOrderInvariance)} |
| Engine time per analysis: mean / p95 / max | ${metrics.performance.engineMsMean} ms / ${metrics.performance.engineMsP95} ms / ${metrics.performance.engineMsMax} ms |

## Confusion: engine × oracle
${mt(confusionMatrices.engineVsOracle, CLS)}

## Confusion: engine × hidden truth
${mt(confusionMatrices.engineVsTruth, ['TRUE_BREACH', 'TRUE_NO_BREACH', 'NOT_DECIDABLE'])}

## Per category
| category | cases | agree w/ oracle | false CONFIRMED | false NO_BREACH | CONF / POSS / NO / IND / N/A | both bounds EXACT | oracle exact |
|---|---:|---:|---:|---:|---|---:|---:|
${CATEGORIES.map((c) => { const p = perCategory[c]!; return `| ${c} | ${p.cases} | ${p.agreementWithOracle === null ? 'n/a' : (p.agreementWithOracle * 100).toFixed(1) + '%'} | ${p.falseConfirmed} | ${p.falseNoBreach} | ${CLS.map((k) => p.classes[k]).join(' / ')} | ${p.boundsExact} | ${p.oracleExact} |`; }).join('\n')}

## Failure examples
${Object.keys(failures).length ? Object.entries(failures).map(([k, v]) => `### ${k} (${v.length}${v.length === 8 ? '+' : ''} shown)\n\`\`\`json\n${JSON.stringify(v.slice(0, 3), null, 1)}\n\`\`\``).join('\n\n') : 'None recorded.'}
`;
writeFileSync(new URL('report.md', OUT), report);
console.log(report.split('## Confusion')[0]);
console.log('failure counts:', JSON.stringify(Object.fromEntries(Object.entries(failures).map(([k, v]) => [k, v.length]))));
