/**
 * Evidence normalisation. Original evidence is never modified: this module derives `NormRecord`s (constraints
 * over the true timeline) and an `EvidenceAssessment` per input record that says exactly what happened to it.
 *
 * Temporal uncertainty model (per record endpoint, in TRUE time):
 *   true = reading − knownOffset(clock) + δ(clock) + ε
 *   δ(clock) ∈ [−U, +U]  common to every record from that clock (U = residual uncertainty + drift since sync)
 *   ε ∈ [lo, hi]         independent per endpoint (the record's own [earliest, latest] + drift within the window)
 * NormRecord stores reading − knownOffset with the ε range; δ is handled by the bound engine.
 */
import type { CompiledContract } from './contract.js';
import { contentHash, omit } from './hash.js';
import { formatInstant, isSafeMs, parseInstant, TcfInputError } from './time.js';
import type {
  AuthorityClass, ClockProfile, Conflict, EvidenceAssessment, ForensicsPolicy, IncidentRef, Issue, ObservedState, TemporalEvidence,
} from './types.js';

export interface NormRecord {
  key: string;
  evidenceIds: string[];
  system: string;
  clockId: string;
  authority: AuthorityClass;
  rank: number;
  /** Q = asserts a qualifying state (counts as downtime), N = asserts a non-qualifying state. */
  polarity: 'Q' | 'N';
  kind: 'INTERVAL' | 'POINT';
  /** Start ∈ [sLo, sHi], end ∈ [eLo, eHi] (POINT: the instant ∈ [sLo, sHi]; e = s). Excludes the clock offset δ. */
  sLo: number; sHi: number; eLo: number; eHi: number;
  hypothetical?: boolean;
}

export interface UnknownRange { lo: number; hi: number; evidenceId: string }

export interface Normalized {
  records: NormRecord[];
  clockU: Map<string, number>;
  assessments: Map<string, EvidenceAssessment>;
  unknown: UnknownRange[];
  collisions: Conflict[];
  disclosures: string[];
  applicableCount: number;
}

export interface Target { service: string; region?: string; customer?: string }

const issue = (a: EvidenceAssessment, code: Issue['code'], detail: string) => { if (!a.issues.some((i) => i.code === code && i.detail === detail)) a.issues.push({ code, detail }); };

export function evidenceContentKey(e: TemporalEvidence): string {
  return contentHash('tcf.evidence.content', omit(e, ['id', 'ingestedAt']));
}

export function validateEvidenceShape(e: TemporalEvidence, i: number): void {
  if (!e || typeof e !== 'object') throw new TcfInputError('INVALID_EVIDENCE', `evidence[${i}] is not an object`);
  if (typeof e.id !== 'string' || !e.id) throw new TcfInputError('INVALID_EVIDENCE', `evidence[${i}].id must be a non-empty string`);
  if (!e.assertion || typeof e.assertion !== 'object' || !['INTERVAL', 'POINT', 'TRANSITION'].includes(e.assertion.kind)) throw new TcfInputError('INVALID_EVIDENCE', `evidence ${e.id}: assertion.kind must be INTERVAL, POINT or TRANSITION`);
  if (!e.scope || typeof e.scope.service !== 'string') throw new TcfInputError('INVALID_EVIDENCE', `evidence ${e.id}: scope.service is required`);
  if (!e.source || typeof e.source !== 'object') throw new TcfInputError('INVALID_EVIDENCE', `evidence ${e.id}: source is required`);
}

function stateOf(e: TemporalEvidence): ObservedState { return e.assertion.kind === 'TRANSITION' ? e.assertion.to : e.assertion.state; }

function polarityOf(state: ObservedState, c: CompiledContract): 'Q' | 'N' | null {
  if (state === 'UNKNOWN') return null;
  if (state === 'HEALTHY') return 'N';
  return c.qualifyingStates.has(state as 'UNAVAILABLE' | 'DEGRADED') ? 'Q' : 'N';
}

/** Does a record about `scope` speak for the target? Returns null when it applies, else the reason. */
export function scopeApplies(scope: TemporalEvidence['scope'], polarity: 'Q' | 'N', t: Target): Issue | null {
  if (scope.service !== t.service) return { code: 'INCOMPATIBLE_SCOPE', detail: `record is about service "${scope.service}", the contract covers "${t.service}"` };
  for (const dim of ['region', 'customer'] as const) {
    const r = scope[dim]; const want = t[dim];
    if (r !== undefined && want !== undefined && r !== want) return { code: 'INCOMPATIBLE_SCOPE', detail: `record is about ${dim} "${r}", the contract covers ${dim} "${want}"` };
    if (r !== undefined && want === undefined) return { code: 'NARROWER_SCOPE', detail: `record covers only ${dim} "${r}"; it cannot establish the state of the whole contracted ${dim} scope` };
    if (r === undefined && want !== undefined && polarity === 'N' && scope.semantics === 'AGGREGATE') return { code: 'AGGREGATE_HEALTH_NOT_APPLICABLE', detail: `aggregate health across all ${dim}s does not establish ${dim} "${want}" was healthy` };
  }
  return null;
}

interface ClockInfo { u: number; correction: number; ppm: number; ref: number }

function clockInfo(id: string, profiles: Map<string, ClockProfile>, windowStart: number, policy: ForensicsPolicy, disclosures: Set<string>, onMissing: () => void, onNoSync: () => void): ClockInfo {
  const p = profiles.get(id);
  if (!p) { onMissing(); disclosures.add(`Clock "${id}" has no profile: an offset uncertainty of ±${policy.defaultClockUncertaintyMs} ms (policy default) is assumed, not measured.`); return { u: policy.defaultClockUncertaintyMs, correction: 0, ppm: 0, ref: windowStart }; }
  let u = p.uncertaintyMs; const ppm = p.driftPpm ?? 0;
  if (ppm > 0) {
    if (p.lastSyncAt) { const sync = parseInstant(p.lastSyncAt, `clock ${id}.lastSyncAt`); u += Math.ceil((ppm * Math.abs(windowStart - sync)) / 1e6); }
    else { onNoSync(); u += policy.defaultClockUncertaintyMs; disclosures.add(`Clock "${id}" drifts (${ppm} ppm) but has no last-sync time: ±${policy.defaultClockUncertaintyMs} ms extra (policy default) is assumed.`); }
  }
  return { u, correction: p.knownOffsetMs, ppm, ref: windowStart };
}

export function validateClocks(clocks: ClockProfile[]): Map<string, ClockProfile> {
  const m = new Map<string, ClockProfile>();
  for (const c of clocks) {
    if (!c || typeof c.clockId !== 'string' || !c.clockId) throw new TcfInputError('INVALID_CLOCK', 'clockId is required');
    if (!isSafeMs(c.knownOffsetMs) || !isSafeMs(c.uncertaintyMs) || c.uncertaintyMs < 0) throw new TcfInputError('INVALID_CLOCK', `clock ${c.clockId}: knownOffsetMs and uncertaintyMs must be integers (uncertainty ≥ 0)`);
    if (c.driftPpm !== undefined && (!Number.isSafeInteger(c.driftPpm) || c.driftPpm < 0)) throw new TcfInputError('INVALID_CLOCK', `clock ${c.clockId}: driftPpm must be a non-negative integer`);
    if (m.has(c.clockId)) throw new TcfInputError('INVALID_CLOCK', `clock ${c.clockId} profiled twice`);
    m.set(c.clockId, c);
  }
  return m;
}

interface Parsed { e: TemporalEvidence; a: EvidenceAssessment; polarity: 'Q' | 'N' | null; clockId: string; ci: ClockInfo; sLo: number; sHi: number; eLo: number; eHi: number; holds: number | null }

export function normalizeEvidence(
  evidence: readonly TemporalEvidence[],
  ctx: { contract: CompiledContract; target: Target; window: { start: number; end: number }; clocks: ClockProfile[]; policy: ForensicsPolicy; incident?: IncidentRef },
): Normalized {
  const { contract, target, window, policy } = ctx;
  const profiles = validateClocks(ctx.clocks);
  const disclosures = new Set<string>();
  const assessments = new Map<string, EvidenceAssessment>();
  const seenIds = new Set<string>();
  evidence.forEach((e, i) => { validateEvidenceShape(e, i); if (seenIds.has(e.id)) throw new TcfInputError('DUPLICATE_EVIDENCE_ID', `evidence id ${e.id} appears twice`); seenIds.add(e.id); });
  const sorted = [...evidence].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Duplicates & record-id collisions (identity = source system + source record id; content = everything but RIPPLE id/ingest time).
  const bySource = new Map<string, TemporalEvidence>(); const byRaw = new Map<string, TemporalEvidence>();
  const dupOf = new Map<string, { of: string; code: 'DUPLICATE_RECORD' | 'DUPLICATE_CONTENT' }>();
  const collisions: Conflict[] = []; const collided = new Set<string>();
  for (const e of sorted) {
    const sk = `${e.source?.system}\u0000${e.source?.recordId}`;
    const prev = bySource.get(sk);
    if (prev) {
      if (evidenceContentKey(prev) === evidenceContentKey(e)) dupOf.set(e.id, { of: prev.id, code: 'DUPLICATE_RECORD' });
      else {
        collided.add(prev.id); collided.add(e.id);
        const existing = collisions.find((c) => c.evidenceIds.includes(prev.id));
        if (existing) { existing.evidenceIds.push(e.id); existing.setAside.push(e.id); } else collisions.push({ id: '', type: 'RECORD_ID_COLLISION', evidenceIds: [prev.id, e.id], resolution: 'UNRESOLVED', setAside: [prev.id, e.id], explanation: `${e.source.system} record ${e.source.recordId} arrived twice with different content; without a correction event neither version is used` });
      }
      continue;
    }
    bySource.set(sk, e);
    const raw = e.provenance?.contentHash;
    if (raw) { const p = byRaw.get(raw); if (p) { dupOf.set(e.id, { of: p.id, code: 'DUPLICATE_CONTENT' }); continue; } byRaw.set(raw, e); }
  }

  const parsed: Parsed[] = [];
  const unknown: UnknownRange[] = [];
  const clockCache = new Map<string, ClockInfo>();
  let applicableCount = 0;
  for (const e of sorted) {
    const declared = e.source?.authority;
    const a: EvidenceAssessment = { evidenceId: e.id, source: String(e.source?.system ?? ''), recordId: String(e.source?.recordId ?? ''), status: 'USED', declaredAuthority: declared, effectiveAuthority: declared, rank: policy.authorityRanks[declared] ?? 0, role: 'NONE', issues: [] };
    assessments.set(e.id, a);
    const d = dupOf.get(e.id);
    if (d) { a.status = 'DUPLICATE'; issue(a, d.code, `same ${d.code === 'DUPLICATE_RECORD' ? 'source record' : 'raw content'} as ${d.of}; counted once`); continue; }
    if (collided.has(e.id)) { a.status = 'SET_ASIDE'; issue(a, 'RECORD_ID_COLLISION', 'another record carries the same source id with different content'); continue; }
    if (!e.source?.system || !e.source?.recordId || !(declared in policy.authorityRanks)) { a.status = 'EXCLUDED'; issue(a, 'MISSING_SOURCE_METADATA', 'source system, record id and a known authority class are required; the engine does not invent a source'); continue; }
    if (!e.provenance?.reference || !e.provenance?.contentHash) { a.status = 'EXCLUDED'; issue(a, 'MISSING_PROVENANCE', 'provenance reference and content hash are required'); continue; }
    if (declared === 'SIGNED_MONITORING' && e.source.signatureVerified !== true) { a.effectiveAuthority = 'UNVERIFIED_MANUAL'; a.rank = policy.authorityRanks.UNVERIFIED_MANUAL; issue(a, 'UNVERIFIED_SIGNATURE', 'declared signed monitoring but the signature is not verified; treated as unverified'); }
    if (ctx.incident && e.incidentId !== ctx.incident.incidentId) issue(a, 'OTHER_INCIDENT', `filed under incident ${e.incidentId}; still evidence of the service state`);
    if (e.contractRef && (e.contractRef.contractId !== contract.doc.contractId || e.contractRef.version !== contract.doc.version)) issue(a, 'INVALID_CONTRACT_REFERENCE', `refers to ${e.contractRef.contractId} v${e.contractRef.version}; the effective contract is ${contract.doc.contractId} v${contract.doc.version}`);
    const state = stateOf(e);
    const polarity = polarityOf(state, contract);
    const scopeIssue = scopeApplies(e.scope, polarity ?? 'N', target);
    if (scopeIssue) { a.status = 'NOT_APPLICABLE'; a.issues.push(scopeIssue); continue; }
    applicableCount++;
    const clockId = e.source.clockId ?? e.source.system;
    let ci = clockCache.get(clockId);
    if (!ci) { ci = clockInfo(clockId, profiles, window.start, policy, disclosures, () => issue(a, 'MISSING_CLOCK_METADATA', `no profile for clock ${clockId}`), () => issue(a, 'DRIFT_WITHOUT_SYNC_TIME', `clock ${clockId} drift has no sync time`)); clockCache.set(clockId, ci); }
    else if (!profiles.has(clockId)) issue(a, 'MISSING_CLOCK_METADATA', `no profile for clock ${clockId}`);
    const conv = (iso: string, field: string): [number, number] => {
      const r = parseInstant(iso, field) - ci!.correction;
      // Drift accumulated between the reference instant and this event. The true event time may differ from the
      // corrected reading by up to the clock uncertainty, so that distance is added before rounding up.
      const w = ci!.ppm ? Math.ceil((ci!.ppm * (Math.abs(r - ci!.ref) + ci!.u)) / 1e6) : 0;
      return [r - w, r + w];
    };
    try {
      let sLo: number, sHi: number, eLo: number, eHi: number; let holds: number | null = null;
      const tb = (b: { earliest: string; latest: string }, f: string): [number, number] => {
        const lo = conv(b.earliest, `${f}.earliest`)[0]; const hi = conv(b.latest, `${f}.latest`)[1];
        if (lo > hi) throw new TcfInputError('INVALID_TIME_BOUND', `${f}: earliest is after latest`);
        return [lo, hi];
      };
      if (e.assertion.kind === 'INTERVAL') { [sLo, sHi] = tb(e.assertion.start, 'start'); [eLo, eHi] = tb(e.assertion.end, 'end'); if (sLo > eHi) throw new TcfInputError('END_BEFORE_START', 'the interval ends before it can have started'); }
      else { [sLo, sHi] = tb(e.assertion.at, 'at'); [eLo, eHi] = [sLo, sHi]; if (e.assertion.kind === 'TRANSITION' && e.assertion.holdsUntil) { holds = conv(e.assertion.holdsUntil, 'holdsUntil')[0]; } }
      const obs = conv(e.observedAt, 'observedAt')[1];
      const lastClaim = Math.max(e.assertion.kind === 'INTERVAL' ? eLo : sLo, holds ?? -Infinity);
      if (lastClaim > obs) { a.status = 'EXCLUDED'; issue(a, 'EVENT_AFTER_OBSERVATION', `claims a state at ${formatInstant(lastClaim)}, after the source recorded it (${formatInstant(obs)})`); continue; }
      if (obs - Math.max(sHi, eHi, holds ?? -Infinity) > policy.staleAfterMs) issue(a, 'STALE_OBSERVATION', `recorded ${Math.round((obs - Math.max(sHi, eHi)) / 60000)} min after the event; kept, with that age disclosed`);
      if (e.ingestedAt) { const ing = parseInstant(e.ingestedAt, 'ingestedAt'); if (ing - parseInstant(e.observedAt, 'observedAt') > policy.delayedIngestionAfterMs) issue(a, 'DELAYED_INGESTION', 'reached RIPPLE late; its event time is used, never its arrival time'); }
      if (polarity === null) {
        a.status = 'USED'; issue(a, 'EXPLICIT_UNKNOWN_STATE', 'the source states it does not know the state here; recorded as an evidence gap');
        if (e.assertion.kind === 'TRANSITION') parsed.push({ e, a, polarity, clockId, ci, sLo, sHi, eLo, eHi, holds }); // still ends the previous state
        else unknown.push({ lo: sLo - ci.u, hi: Math.max(eHi, sHi) + ci.u, evidenceId: e.id });
        continue;
      }
      if (polarity === 'Q' && contract.establishWith && !contract.establishWith.has(a.effectiveAuthority)) { a.status = 'EXCLUDED'; issue(a, 'NOT_ACCEPTED_BY_CONTRACT', `the contract establishes downtime only with ${[...contract.establishWith].join(', ')}`); continue; }
      parsed.push({ e, a, polarity, clockId, ci, sLo, sHi, eLo, eHi, holds });
    } catch (err) {
      if (!(err instanceof TcfInputError)) throw err;
      a.status = 'EXCLUDED'; issue(a, err.code === 'END_BEFORE_START' ? 'END_BEFORE_START' : 'INVALID_TIME_BOUND', err.message);
    }
  }

  const records: NormRecord[] = [];
  const mk = (p: Parsed, key: string, ids: string[], polarity: 'Q' | 'N', kind: 'INTERVAL' | 'POINT', sLo: number, sHi: number, eLo: number, eHi: number, rank: number, authority: AuthorityClass): NormRecord =>
    ({ key, evidenceIds: ids, system: p.e.source.system, clockId: p.clockId, authority, rank, polarity, kind, sLo, sHi, eLo, eHi });

  for (const p of parsed.filter((x) => x.e.assertion.kind !== 'TRANSITION')) {
    p.a.role = p.polarity === 'Q' ? 'ESTABLISHES_DOWNTIME' : 'ESTABLISHES_NON_QUALIFYING';
    records.push(mk(p, p.e.id, [p.e.id], p.polarity!, p.e.assertion.kind as 'INTERVAL' | 'POINT', p.sLo, p.sHi, p.eLo, p.eHi, p.a.rank, p.a.effectiveAuthority));
  }
  // Transition assembly: per (system, clock, scope), ordered by EVENT time (never arrival order).
  const groups = new Map<string, Parsed[]>();
  for (const p of parsed.filter((x) => x.e.assertion.kind === 'TRANSITION')) {
    const g = `${p.e.source.system}\u0000${p.clockId}\u0000${p.e.scope.region ?? ''}\u0000${p.e.scope.customer ?? ''}\u0000${p.e.scope.semantics ?? ''}`;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  for (const [, list] of [...groups.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    list.sort((x, y) => x.sLo - y.sLo || x.sHi - y.sHi || (x.e.id < y.e.id ? -1 : 1));
    list.forEach((p, i) => {
      const next = list[i + 1];
      if (p.polarity === null) { unknown.push({ lo: p.sLo - p.ci.u, hi: (next ? next.sHi : Math.max(p.sHi, p.holds ?? p.sHi)) + p.ci.u, evidenceId: p.e.id }); return; }
      p.a.role = p.polarity === 'Q' ? 'ESTABLISHES_DOWNTIME' : 'ESTABLISHES_NON_QUALIFYING';
      if (next && next.sLo < p.sHi) { issue(p.a, 'AMBIGUOUS_TRANSITION_ORDER', `its time range overlaps the next transition ${next.e.id}; their order is not established`); issue(next.a, 'AMBIGUOUS_TRANSITION_ORDER', `its time range overlaps the previous transition ${p.e.id}`); }
      const rank = next ? Math.min(p.a.rank, next.a.rank) : p.a.rank;
      const auth = next && next.a.rank < p.a.rank ? next.a.effectiveAuthority : p.a.effectiveAuthority;
      // A state vouched for only until `holdsUntil` ends there when the next transition comes later: the source
      // says nothing about the time in between (e.g. it stopped reporting), so the state is not extended over it.
      if (next && !(p.holds !== null && p.holds < next.sLo)) records.push(mk(p, `${p.e.id}→${next.e.id}`, [p.e.id, next.e.id], p.polarity!, 'INTERVAL', p.sLo, p.sHi, next.sLo, next.sHi, rank, auth));
      else if (p.holds !== null) records.push(mk(p, `${p.e.id}→holdsUntil`, [p.e.id], p.polarity!, 'INTERVAL', p.sLo, p.sHi, p.holds, p.holds, p.a.rank, p.a.effectiveAuthority));
      else { issue(p.a, 'OPEN_TRANSITION', 'no later transition or holdsUntil from this source: it establishes the state only at the transition instant'); records.push(mk(p, p.e.id, [p.e.id], p.polarity!, 'POINT', p.sLo, p.sHi, p.sLo, p.sHi, p.a.rank, p.a.effectiveAuthority)); }
    });
  }
  // Transitions to UNKNOWN produce no record; they terminate the previous state and mark an explicit gap.
  const clockU = new Map<string, number>();
  for (const [id, ci] of clockCache) clockU.set(id, ci.u);
  // Relevance closure. A record matters if it can overlap the window, OR if it can constrain the offset of an
  // uncertain clock used by a relevant record (same clock, or a possible cross-clock overlap of opposite polarity).
  // Everything else is outside the question; dropping it cannot change any bound or classification.
  const hull = (r: NormRecord) => { const u = clockU.get(r.clockId) ?? 0; return [r.sLo - u, (r.kind === 'INTERVAL' ? r.eHi : r.sHi) + u + 1] as const; };
  const relevant = new Set(records.filter((r) => { const [lo, hi] = hull(r); return hi > window.start && lo < window.end; }).map((r) => r.key));
  for (let grew = true; grew;) {
    grew = false;
    const uncertainClocks = new Set(records.filter((r) => relevant.has(r.key) && (clockU.get(r.clockId) ?? 0) > 0).map((r) => r.clockId));
    for (const r of records) {
      if (relevant.has(r.key)) continue;
      const [lo, hi] = hull(r);
      const coupled = uncertainClocks.has(r.clockId) || records.some((x) => relevant.has(x.key) && x.polarity !== r.polarity && (uncertainClocks.has(x.clockId) || (clockU.get(r.clockId) ?? 0) > 0) && hull(x)[0] < hi && lo < hull(x)[1]);
      if (coupled) { relevant.add(r.key); grew = true; }
    }
  }
  const kept = records.filter((r) => relevant.has(r.key));
  const keptIds = new Set(kept.flatMap((r) => r.evidenceIds));
  for (const r of records) for (const id of r.evidenceIds) if (!keptIds.has(id)) { const a = assessments.get(id)!; if (a.status === 'USED') { a.status = 'NOT_APPLICABLE'; issue(a, 'OUT_OF_WINDOW', 'cannot overlap the measured window or constrain any clock offset that does'); } }
  records.length = 0; records.push(...kept);
  records.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  collisions.forEach((c, i) => { c.id = `X${i + 1}`; });
  return { records, clockU, assessments, unknown, collisions, disclosures: [...disclosures].sort(), applicableCount };
}
