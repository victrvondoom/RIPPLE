/**
 * Temporal Contract Forensics (TCF) — public integration contract.
 *
 * A pure, deterministic capability: no I/O, no clock reads, no model calls. It answers, for one contract and a set
 * of time-uncertain, possibly contradictory observations: what contractual exposure is PROVEN, what is merely
 * POSSIBLE, what is missing, and which minimum additional evidence would decide it.
 *
 * Integration (for the RIPPLE engine/packs, via an adapter; this module registers nothing itself):
 *   const tcf = createTemporalContractForensics();
 *   let rev = tcf.open({ contract, evidence, measurementWindow, clocks, maintenance }, { at: receivedAtIso });
 *   rev.result.classification            // BREACH_CONFIRMED | BREACH_POSSIBLE | NO_BREACH | INDETERMINATE | NOT_APPLICABLE
 *   tcf.minimumDecisiveEvidence({ analysis: rev })  // ranked evidence requests
 *   rev = tcf.update({ previous: rev, event })      // new revision, hash-chained to the previous one
 *   tcf.counterfactual({ analysis: rev, changes })  // labelled hypothetical, never stored as the analysis
 * See docs/TEMPORAL_CONTRACT_FORENSICS.md.
 */
import { analyseContext } from './analysis.js';
import { runCounterfactual } from './counterfactual.js';
import { buildContext, openRevision, updateRevision, verifyRevision } from './revisions.js';
import { minimumDecisiveEvidenceReport, type MdeOptions } from './sensitivity.js';
import type {
  AnalysisInput, AnalysisRevision, CounterfactualChange, CounterfactualResult, EvidenceEvent, EvidenceRequirement, MinimumDecisiveEvidenceReport,
  TemporalExposureResult,
} from './types.js';

export * from './types.js';
export { TcfInputError, parseInstant, formatInstant, formatDuration, calendarMonthWindow } from './time.js';
export { contractHash, compileContract } from './contract.js';
export { canonicalJson, contentHash } from './hash.js';
export { diffResults } from './diff.js';
export type { MdeOptions } from './sensitivity.js';

export interface TemporalContractForensics {
  /** Stateless one-shot analysis. */
  analyse(input: AnalysisInput): TemporalExposureResult;
  /** Start a versioned analysis session (revision 1). `at` is the ingestion time, supplied by the caller (no clock reads). */
  open(input: AnalysisInput, opts: { at: string; reason?: string }): AnalysisRevision;
  /** Apply one evidence event; returns a NEW revision (or the same revision for an exact re-delivery). */
  update(input: { previous: AnalysisRevision; event: EvidenceEvent }): AnalysisRevision;
  /** Re-derive a revision from its own ledger and context and check every hash. */
  verify(revision: AnalysisRevision): { ok: boolean; problems: string[] };
  counterfactual(input: { analysis: AnalysisRevision; changes: CounterfactualChange[] }): CounterfactualResult;
  minimumDecisiveEvidence(input: { analysis: AnalysisRevision; options?: MdeOptions }): EvidenceRequirement[];
  minimumDecisiveEvidenceReport(input: { analysis: AnalysisRevision; options?: MdeOptions }): MinimumDecisiveEvidenceReport;
}

export function createTemporalContractForensics(): TemporalContractForensics {
  return {
    analyse: (input) => analyseContext(buildContext(input), input.evidence).result,
    open: (input, opts) => openRevision(input, opts),
    update: ({ previous, event }) => updateRevision(previous, event),
    verify: (r) => verifyRevision(r),
    counterfactual: ({ analysis, changes }) => runCounterfactual(analysis, changes),
    minimumDecisiveEvidence: ({ analysis, options }) => minimumDecisiveEvidenceReport(analysis, options).requirements,
    minimumDecisiveEvidenceReport: ({ analysis, options }) => minimumDecisiveEvidenceReport(analysis, options),
  };
}
