/**
 * Temporal Contract Forensics — standalone demonstration.
 *
 *   npx tsx scripts/temporal-contract-forensics-demo.ts
 *
 * Every number, classification and request below is produced by engine calls on the fixture
 * fixtures/temporal-contract-forensics/demo-incident.json (+ demo-late-probe.json). Nothing is hardcoded.
 * Pure and offline: no network, no database, no model calls.
 */
import { readFileSync } from 'node:fs';
import { createTemporalContractForensics, formatDuration as d, type AnalysisRevision, type TemporalExposureResult } from '../src/server/capabilities/temporal-contract-forensics/index.js';

const root = new URL('../', import.meta.url);
const fx = JSON.parse(readFileSync(new URL('fixtures/temporal-contract-forensics/demo-incident.json', root), 'utf8'));
const late = JSON.parse(readFileSync(new URL('fixtures/temporal-contract-forensics/demo-late-probe.json', root), 'utf8'));
const tcf = createTemporalContractForensics();

const hhmmss = (iso: string) => iso.slice(11, iso.length - 1).replace(/\.000$/, '');
const seg = (s: { start: string; end: string; durationMs: number }) => `${hhmmss(s.start)}–${hhmmss(s.end)} (${d(s.durationMs)})`;
const h = (t: string) => console.log(`\n${'═'.repeat(100)}\n${t}\n${'═'.repeat(100)}`);
const money = (minor: number, cur: string) => `${cur} ${(minor / 100).toFixed(2)}`;
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function claim(e: (typeof fx.evidence)[number]): string {
  const a = e.assertion;
  const tb = (b: { earliest: string; latest: string }) => (b.earliest === b.latest ? hhmmss(b.earliest) : `${hhmmss(b.earliest)}…${hhmmss(b.latest)}`);
  if (a.kind === 'INTERVAL') return `${a.state} from ${tb(a.start)} to ${tb(a.end)}`;
  if (a.kind === 'POINT') return `${a.state} at ${tb(a.at)}`;
  return `→ ${a.to} at ${tb(a.at)}${a.holdsUntil ? ` (holds until ${hhmmss(a.holdsUntil)})` : ''}`;
}

function envelope(r: TemporalExposureResult) {
  console.log(`Certain qualifying downtime : ${r.envelope.certainDowntime.map((s) => `${seg(s)} [${s.evidenceIds.join(', ')}]`).join('; ') || 'none'}`);
  console.log(`Known non-qualifying (up)   : ${r.envelope.knownNonQualifying.map(seg).join('; ') || 'none'}`);
  console.log(`Possible downtime           : ${r.envelope.possibleDowntime.map(seg).join('; ') || 'none'}`);
  console.log(`Evidence gaps (no record)   : ${r.envelope.evidenceGaps.map(seg).join('; ') || 'none'}`);
  console.log(`Exclusions                  : ${r.envelope.exclusions.map((x) => `${x.maintenanceId} ${x.status} — ${x.reason}`).join('; ') || 'none'}`);
  const b = r.bounds!.qualifyingDowntimeMs;
  console.log(`QUALIFYING DOWNTIME BOUNDS  : ${d(b.min)} (${b.minStatus}) … ${d(b.max)} (${b.maxStatus})`);
  console.log(`Breach point                : ${d(r.bounds!.breachPointMs!.min)}  (contract: downtime must EXCEED ${d(r.bounds!.breachPointMs!.min - 1)})`);
  if (r.credit) console.log(`Credit exposure             : ${money(r.credit.minMinor, r.credit.currency)} … ${money(r.credit.maxMinor, r.credit.currency)}${r.credit.capMinor !== null ? ` (cap ${money(r.credit.capMinor, r.credit.currency)})` : ''}`);
}

const input = { contract: fx.contracts, evidence: fx.evidence, measurementWindow: fx.measurementWindow, incident: fx.incident, clocks: fx.clocks, maintenance: fx.maintenance };

h('TEMPORAL CONTRACT FORENSICS — demonstration (all figures computed by the engine)');
console.log(`Incident ${fx.incident.incidentId}: ${fx.incident.scope.service} / ${fx.incident.scope.region} / customer ${fx.incident.scope.customer}`);
console.log(`Contract versions supplied: ${fx.contracts.map((c: { version: string; effectiveFrom: string; effectiveTo: string | null }) => `v${c.version} (${c.effectiveFrom.slice(0, 10)} → ${c.effectiveTo?.slice(0, 10) ?? 'open'})`).join(', ')}`);
console.log(`Measurement window: ${fx.measurementWindow.start} → ${fx.measurementWindow.end}`);
console.log('\nEvidence as recorded (source clock):');
for (const e of fx.evidence) console.log(`  ${pad(e.id, 6)} ${pad(e.source.system, 18)} ${pad(e.source.authority, 29)} ${pad(claim(e), 58)} clock=${e.source.clockId}`);
console.log('Clocks:', fx.clocks.map((c: { clockId: string; knownOffsetMs: number; uncertaintyMs: number }) => `${c.clockId} offset ${d(c.knownOffsetMs)} ±${d(c.uncertaintyMs)}`).join('; '), '| customer-device: no profile');
console.log('Maintenance claimed:', fx.maintenance.map((m: { id: string; start: string; end: string; status: string }) => `${m.id} ${hhmmss(m.start)}–${hhmmss(m.end)} ${m.status}`).join('; '));

const r1: AnalysisRevision = tcf.open(input, { at: '2026-11-04T14:55:00Z', reason: 'initial evidence after incident close' });
const res1 = r1.result;
h('1. INITIAL EVIDENCE ENVELOPE');
console.log(`Contract selected: ${res1.contract!.contractId} v${res1.contract!.version} — ${res1.contract!.selectedBecause}`);
envelope(res1);

h('2. INITIAL CONTRACTUAL CLASSIFICATION');
console.log(res1.classification);
console.log(res1.classificationRule);

h('3. WHY THE DECISION IS UNCERTAIN');
console.log(res1.sensitivity.statement);
for (const u of res1.envelope.uncertain) console.log(`  undecided ${seg(u)} ← ${u.causes.map((c) => c.type === 'CLOCK_OFFSET' ? `clock ${c.clockId} offset (${c.evidenceIds.join(', ')})` : c.type === 'NO_EVIDENCE' ? `no record covers it${c.explicitUnknownEvidenceIds.length ? ` (explicit UNKNOWN: ${c.explicitUnknownEvidenceIds.join(', ')})` : ''}` : c.type === 'POSSIBLE_EXCLUSION' ? `maintenance ${c.maintenanceIds.join(', ')} may be excluded` : `${c.type.toLowerCase().replace(/_/g, ' ')} (${'evidenceIds' in c ? c.evidenceIds.join(', ') : ''})`).join('; ')}`);
for (const e of res1.evidence.filter((x) => x.issues.length)) console.log(`  ${pad(e.evidenceId, 6)} ${e.status}: ${e.issues.map((i) => i.code).join(', ')}`);
for (const x of res1.disclosures.filter((t) => t.includes('policy default'))) console.log(`  disclosure: ${x}`);

h('4. MINIMUM DECISIVE EVIDENCE (ranked by effect on the decision)');
const mde = tcf.minimumDecisiveEvidenceReport({ analysis: r1 });
console.log(mde.statement);
console.log(`(${mde.evaluations} exact re-evaluations of the decision)`);
for (const q of mde.requirements.slice(0, 6)) {
  console.log(`\n  #${q.rank} [${q.guarantee}, ${q.evaluation}] ${q.request}`);
  console.log(`     outcomes: ${q.outcomes.map((o) => `${o.outcome} → ${o.classification}${o.consistent ? '' : ' (contradicts evidence in use)'}`).join(' | ')}`);
  console.log(`     why: ${q.whyItMatters}`);
}
const noEffect = mde.requirements.filter((q) => q.guarantee === 'NO_EFFECT');
if (noEffect.length) console.log(`\n  Would NOT change the decision (${noEffect.length}): ${noEffect.map((q) => q.id).join(', ')}`);

h('5. NEW AUTHENTICATED EVIDENCE ARRIVES (fixture events)');
let rev = r1; const chain = [r1];
for (const ev of late.records) {
  console.log(`  ADD_EVIDENCE ${ev.id} ${ev.source.system} ${ev.source.authority}: ${claim(ev)} (received ${late.receivedAt})`);
  rev = tcf.update({ previous: rev, event: { type: 'ADD_EVIDENCE', evidence: ev, receivedAt: late.receivedAt, reason: 'regional probe backfill (late-arriving)' } });
  chain.push(rev);
}

h('6. NEW ANALYSIS REVISIONS');
for (const r of chain) {
  console.log(`Revision ${r.revision}  hash ${r.revisionHash.slice(0, 16)}…  parent ${r.parentRevisionHash?.slice(0, 16) ?? '—'}${r.parentRevisionHash ? '…' : ''}`);
  console.log(`   evidence-set ${r.evidenceSetHash.slice(0, 16)}…  contract ${r.contractHash?.slice(0, 16)}…  output ${r.outputHash.slice(0, 16)}…  at ${r.createdAt}`);
  console.log(`   reason: ${r.reason}; changes: ${r.changeSummary.join('; ')}`);
}
console.log('\nConflicts in the latest revision:');
for (const c of rev.result.conflicts) console.log(`  ${c.id} ${c.type} ${c.resolution}: ${c.explanation}`);

h('7. OLD AND NEW RESULTS SIDE BY SIDE');
const rows: [string, (r: TemporalExposureResult) => string][] = [
  ['classification', (r) => r.classification],
  ['min qualifying downtime', (r) => `${d(r.bounds!.qualifyingDowntimeMs.min)} ${r.bounds!.qualifyingDowntimeMs.minStatus}`],
  ['max qualifying downtime', (r) => `${d(r.bounds!.qualifyingDowntimeMs.max)} ${r.bounds!.qualifyingDowntimeMs.maxStatus}`],
  ['decision-sensitive width', (r) => d(r.sensitivity.decisionSensitiveMs)],
  ['credit exposure', (r) => (r.credit ? `${money(r.credit.minMinor, r.credit.currency)}–${money(r.credit.maxMinor, r.credit.currency)}` : '—')],
  ['evidence set aside', (r) => r.evidence.filter((e) => e.status === 'SET_ASIDE').map((e) => e.evidenceId).join(', ') || 'none'],
  ['evidence gaps', (r) => d(r.envelope.evidenceGaps.reduce((t, s) => t + s.durationMs, 0))],
];
console.log(pad('', 26) + chain.map((r) => pad(`revision ${r.revision}`, 26)).join(''));
for (const [label, f] of rows) console.log(pad(label, 26) + chain.map((r) => pad(f(r.result), 26)).join(''));

h('8. COUNTERFACTUAL (hypothetical — does not change the recorded analysis)');
const cf = tcf.counterfactual({ analysis: rev, changes: [
  { type: 'SHIFT_TIME', evidenceId: 'ev-p1', endpoint: 'end', byMs: -3 * 60_000 },
  { type: 'SET_EXCLUSION_STATUS', maintenanceId: 'MW-311', status: 'CONFIRMED' },
] });
console.log('Question: what if the regional probe\'s outage actually ended 3 minutes earlier AND maintenance MW-311 is a valid exclusion?');
for (const line of cf.explanation) console.log(`  ${line}`);
if (cf.result) { console.log('  Hypothetical envelope:'); envelope(cf.result); }
console.log(`  Recorded revision unchanged and verifiable: ${tcf.verify(rev).ok} (hash ${rev.revisionHash.slice(0, 16)}…)`);
const cf2 = tcf.counterfactual({ analysis: rev, changes: [{ type: 'SET_EXCLUSION_STATUS', maintenanceId: 'MW-311', status: 'CONFIRMED' }] });
console.log(`\nQuestion: what if only MW-311 is valid?  → ${cf2.result!.classification}; ${cf2.explanation[2]}`);

h('9. FINAL EXPLANATION WITH EVIDENCE REFERENCES');
const f = rev.result;
console.log(`${f.classification} under ${f.contract!.contractId} v${f.contract!.version} (content hash ${f.contract!.contentHash.slice(0, 16)}…).`);
console.log(f.classificationRule);
console.log(`Established downtime: ${f.envelope.certainDowntime.map((s) => `${seg(s)} by ${s.evidenceIds.join(' + ')}`).join('; ')}.`);
console.log(`Shown not down: ${f.envelope.knownNonQualifying.map((s) => `${seg(s)} by ${s.evidenceIds.join(' + ')}`).join('; ')}.`);
for (const c of f.conflicts) console.log(`Set aside (${c.id}, ${c.resolution}): ${c.setAside.join(', ')} — kept: ${c.kept?.join(', ') ?? '—'}.`);
for (const r of f.reasons) console.log(`Note: ${r}`);
if (f.credit) console.log(`Credit exposure: ${money(f.credit.minMinor, f.credit.currency)}–${money(f.credit.maxMinor, f.credit.currency)} (a policy calculation for human approval, not a payment).`);
console.log('Assumptions applied:'); for (const x of f.disclosures) console.log(`  - ${x}`);
const replay = (() => { let r = tcf.open(input, { at: '2026-11-04T14:55:00Z', reason: 'initial evidence after incident close' }); for (const ev of late.records) r = tcf.update({ previous: r, event: { type: 'ADD_EVIDENCE', evidence: ev, receivedAt: late.receivedAt, reason: 'regional probe backfill (late-arriving)' } }); return r; })();
console.log(`\nReproducibility: replaying the same inputs gives revision hash ${replay.revisionHash === rev.revisionHash ? 'IDENTICAL' : 'DIFFERENT'}; verify(rev ${rev.revision}) = ${JSON.stringify(tcf.verify(rev))}; verify(rev 1) = ${tcf.verify(r1).ok}.`);
