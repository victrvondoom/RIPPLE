/**
 * Versioned analysis sessions. A revision is a content-addressed, hash-chained record of
 * (contract versions, evidence ledger, context) → result. Revisions are immutable (deep-frozen); an update never
 * rewrites a previous revision, and any revision can be re-derived from its own ledger and context.
 *
 *   evidenceSetHash = H(active evidence, sorted by id)
 *   ledgerHash      = H(every ledger entry incl. retracted/superseded, with statuses and notes)
 *   outputHash      = H(result)
 *   revisionHash    = H(revision, parentRevisionHash, evidenceSetHash, ledgerHash, contractHash, outputHash, createdAt, reason, changeSummary)
 * Evaluation is a pure function of the ledger and context (no clock reads, no randomness), so identical inputs give
 * identical hashes.
 */
import { analyseContext, type InactiveEvidence } from './analysis.js';
import { diffResults } from './diff.js';
import { evidenceContentKey, validateEvidenceShape } from './evidence.js';
import { contentHash, frozenCopy } from './hash.js';
import { formatDuration, parseInstant, TcfInputError } from './time.js';
import {
  DEFAULT_POLICY, type AnalysisContext, type AnalysisInput, type AnalysisRevision, type EvidenceEvent, type ForensicsPolicy, type LedgerEntry,
  type TemporalEvidence, type TemporalExposureResult,
} from './types.js';

export function buildContext(input: Omit<AnalysisInput, 'evidence'>): AnalysisContext {
  const p = input.policy ?? {};
  const policy: ForensicsPolicy = { ...DEFAULT_POLICY, ...p, authorityRanks: { ...DEFAULT_POLICY.authorityRanks, ...(p.authorityRanks ?? {}) } };
  for (const k of ['resolveByAuthorityMinGap', 'defaultClockUncertaintyMs', 'staleAfterMs', 'delayedIngestionAfterMs', 'maxBranchNodes', 'maxUnconfirmedExclusions'] as const) {
    if (!Number.isSafeInteger(policy[k]) || policy[k] < 0) throw new TcfInputError('INVALID_POLICY', `policy.${k} must be a non-negative integer`);
  }
  if (policy.maxUnconfirmedExclusions > 12) throw new TcfInputError('INVALID_POLICY', 'policy.maxUnconfirmedExclusions above 12 is not supported (2^n scenarios)');
  return {
    contracts: Array.isArray(input.contract) ? [...input.contract] : [input.contract],
    measurementWindow: input.measurementWindow,
    ...(input.incident ? { incident: input.incident } : {}),
    clocks: [...(input.clocks ?? [])],
    maintenance: [...(input.maintenance ?? [])],
    policy,
  };
}

export function activeEvidence(ledger: readonly LedgerEntry[]): TemporalEvidence[] { return ledger.filter((l) => l.status === 'ACTIVE').map((l) => l.evidence); }

export function inactiveEvidence(ledger: readonly LedgerEntry[]): InactiveEvidence[] {
  return ledger.filter((l) => l.status !== 'ACTIVE').map((l) => ({ evidence: l.evidence, code: l.status === 'RETRACTED' ? 'RETRACTED' as const : 'SUPERSEDED' as const, detail: l.note ?? l.status }));
}

function evaluate(context: AnalysisContext, ledger: readonly LedgerEntry[]): TemporalExposureResult {
  return analyseContext(context, activeEvidence(ledger), inactiveEvidence(ledger)).result;
}

function seal(fields: Omit<AnalysisRevision, 'revisionHash' | 'outputHash' | 'evidenceSetHash' | 'ledgerHash' | 'contractHash'>): AnalysisRevision {
  const outputHash = contentHash('tcf.output', fields.result);
  const ledgerHash = contentHash('tcf.ledger', fields.ledger);
  const evidenceSetHash = fields.result.hashes.evidenceSetHash;
  const contractHash = fields.result.hashes.contractHash;
  const revisionHash = contentHash('tcf.revision', { revision: fields.revision, parentRevisionHash: fields.parentRevisionHash, evidenceSetHash, ledgerHash, contractHash, outputHash, createdAt: fields.createdAt, reason: fields.reason, changeSummary: fields.changeSummary });
  return frozenCopy({ ...fields, revisionHash, outputHash, evidenceSetHash, ledgerHash, contractHash });
}

export function openRevision(input: AnalysisInput, opts: { at: string; reason?: string }): AnalysisRevision {
  parseInstant(opts.at, 'at');
  const context = buildContext(input);
  input.evidence.forEach((e, i) => validateEvidenceShape(e, i));
  const ledger: LedgerEntry[] = [...input.evidence].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((e) => ({ evidence: structuredClone(e), status: 'ACTIVE', receivedAt: opts.at, contentHash: evidenceContentKey(e) }));
  const result = evaluate(context, ledger);
  return seal({ revision: 1, parentRevisionHash: null, createdAt: opts.at, reason: opts.reason ?? 'initial evidence ingestion', changeSummary: [`initial analysis of ${ledger.length} evidence record(s)`], changedFields: [], context, ledger, result });
}

/** Recompute a revision from its own inputs; detects tampering and non-reproducibility. */
export function verifyRevision(rev: AnalysisRevision): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const result = evaluate(rev.context, rev.ledger);
  const outputHash = contentHash('tcf.output', result);
  if (outputHash !== rev.outputHash) problems.push(`re-evaluation gives output ${outputHash}, revision records ${rev.outputHash}`);
  if (contentHash('tcf.output', rev.result) !== rev.outputHash) problems.push('stored result does not match its outputHash');
  if (contentHash('tcf.ledger', rev.ledger) !== rev.ledgerHash) problems.push('ledger does not match ledgerHash');
  const revisionHash = contentHash('tcf.revision', { revision: rev.revision, parentRevisionHash: rev.parentRevisionHash, evidenceSetHash: rev.evidenceSetHash, ledgerHash: rev.ledgerHash, contractHash: rev.contractHash, outputHash: rev.outputHash, createdAt: rev.createdAt, reason: rev.reason, changeSummary: rev.changeSummary });
  if (revisionHash !== rev.revisionHash) problems.push('revisionHash does not match the revision fields');
  return { ok: !problems.length, problems };
}

function summarise(before: TemporalExposureResult, after: TemporalExposureResult): string[] {
  const s: string[] = [];
  const b = before.bounds?.qualifyingDowntimeMs; const a = after.bounds?.qualifyingDowntimeMs;
  if (b && a && (b.min !== a.min || b.max !== a.max)) s.push(`qualifying downtime ${formatDuration(b.min)}–${formatDuration(b.max)} → ${formatDuration(a.min)}–${formatDuration(a.max)}`);
  if (before.classification !== after.classification) s.push(`classification ${before.classification} → ${after.classification}`);
  if (!s.length) s.push('no decision-relevant change');
  return s;
}

export function updateRevision(previous: AnalysisRevision, event: EvidenceEvent): AnalysisRevision {
  const check = verifyRevision(previous);
  if (!check.ok) throw new TcfInputError('REVISION_INTEGRITY', `previous revision failed verification: ${check.problems.join('; ')}`);
  const at = parseInstant(event.receivedAt, 'event.receivedAt');
  if (at < parseInstant(previous.createdAt, 'previous.createdAt')) throw new TcfInputError('REVISION_ORDER', 'an update cannot be received before the revision it updates');
  const ledger: LedgerEntry[] = previous.ledger.map((l) => structuredClone(l));
  const byId = new Map(ledger.map((l) => [l.evidence.id, l]));
  let what: string;
  if (event.type === 'ADD_EVIDENCE') {
    validateEvidenceShape(event.evidence, 0);
    const existing = byId.get(event.evidence.id);
    if (existing) {
      if (existing.contentHash === evidenceContentKey(event.evidence) && existing.status === 'ACTIVE') return previous; // idempotent re-delivery
      throw new TcfInputError('EVIDENCE_ID_CONFLICT', `evidence id ${event.evidence.id} already exists with different content or status; use CORRECT_EVIDENCE`);
    }
    ledger.push({ evidence: structuredClone(event.evidence), status: 'ACTIVE', receivedAt: event.receivedAt, contentHash: evidenceContentKey(event.evidence), ...(event.reason ? { note: event.reason } : {}) });
    what = `added ${event.evidence.id} (${event.evidence.source.system}/${event.evidence.source.recordId})`;
  } else if (event.type === 'CORRECT_EVIDENCE') {
    const t = byId.get(event.targetEvidenceId);
    if (!t || t.status !== 'ACTIVE') throw new TcfInputError('UNKNOWN_EVIDENCE', `no active evidence ${event.targetEvidenceId} to correct`);
    if (!event.reason?.trim()) throw new TcfInputError('REASON_REQUIRED', 'a correction needs a reason');
    validateEvidenceShape(event.corrected, 0);
    if (byId.has(event.corrected.id)) throw new TcfInputError('EVIDENCE_ID_CONFLICT', `corrected record needs a new id; ${event.corrected.id} exists`);
    t.status = 'SUPERSEDED'; t.supersededBy = event.corrected.id; t.note = `superseded by ${event.corrected.id}: ${event.reason}`;
    ledger.push({ evidence: structuredClone(event.corrected), status: 'ACTIVE', receivedAt: event.receivedAt, contentHash: evidenceContentKey(event.corrected), supersedes: t.evidence.id, note: event.reason });
    what = `corrected ${t.evidence.id} → ${event.corrected.id}: ${event.reason}`;
  } else {
    const t = byId.get(event.evidenceId);
    if (!t || t.status !== 'ACTIVE') throw new TcfInputError('UNKNOWN_EVIDENCE', `no active evidence ${event.evidenceId} to retract`);
    if (!event.reason?.trim()) throw new TcfInputError('REASON_REQUIRED', 'a retraction needs an explicit reason');
    t.status = 'RETRACTED'; t.note = `retracted: ${event.reason}`;
    what = `retracted ${t.evidence.id}: ${event.reason}`;
  }
  const result = evaluate(previous.context, ledger);
  return seal({
    revision: previous.revision + 1, parentRevisionHash: previous.revisionHash, createdAt: event.receivedAt,
    reason: event.type === 'ADD_EVIDENCE' ? event.reason ?? 'new evidence received' : event.reason,
    changeSummary: [what, ...summarise(previous.result, result)], changedFields: diffResults(previous.result, result),
    context: previous.context, ledger, result,
  });
}
