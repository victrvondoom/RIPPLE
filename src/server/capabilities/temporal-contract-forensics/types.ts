/**
 * Temporal Contract Forensics (TCF): public types.
 *
 * All instants cross the public boundary as ISO-8601 strings WITH an explicit offset ("Z" or "+hh:mm").
 * Internally every instant is an integer number of milliseconds since the Unix epoch (UTC) and every
 * duration is an integer number of milliseconds. No floating-point value is ever compared against a
 * contractual threshold.
 */

export const TCF_ENGINE = 'ripple.temporal-contract-forensics';
export const TCF_ENGINE_VERSION = '1.0.0';

export type IsoInstant = string;

// ───────────────────────────── evidence ─────────────────────────────

/** Documented source-authority classes, highest first. Ranks are configurable via `ForensicsPolicy`. */
export type AuthorityClass =
  | 'SIGNED_MONITORING'
  | 'AUTHENTICATED_INFRASTRUCTURE'
  | 'ENGINEERING_INCIDENT_REPORT'
  | 'SYNTHETIC_PROBE'
  | 'SUPPORT_TICKET'
  | 'CUSTOMER_REPORT'
  | 'UNVERIFIED_MANUAL';

export const AUTHORITY_CLASSES: readonly AuthorityClass[] = [
  'SIGNED_MONITORING', 'AUTHENTICATED_INFRASTRUCTURE', 'ENGINEERING_INCIDENT_REPORT', 'SYNTHETIC_PROBE',
  'SUPPORT_TICKET', 'CUSTOMER_REPORT', 'UNVERIFIED_MANUAL',
];

export type ObservedState = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';

/** A time that is only known to lie in [earliest, latest], as read from the SOURCE's clock. */
export interface TimeBound { earliest: IsoInstant; latest: IsoInstant }

export interface EvidenceScope {
  service: string;
  region?: string;
  customer?: string;
  /**
   * UNIVERSAL (default): a claim about this scope holds for every sub-scope (a HEALTHY claim about the whole
   * service means every region/customer was healthy). AGGREGATE: the claim is an aggregate signal, so a HEALTHY
   * claim says nothing about a narrower region/customer (an UNAVAILABLE claim still applies).
   */
  semantics?: 'UNIVERSAL' | 'AGGREGATE';
}

export interface EvidenceSource {
  system: string;
  recordId: string;
  authority: AuthorityClass;
  /** Clock that produced the timestamps. Defaults to `system`. Records sharing a clock share its unknown offset. */
  clockId?: string;
  /** Required for SIGNED_MONITORING to keep that authority; otherwise it is treated as unverified. */
  signatureVerified?: boolean;
}

/**
 * What the record asserts about the true service state.
 * - INTERVAL: the state held throughout [start, end).
 * - POINT: the state held at one instant inside `at`.
 * - TRANSITION: the state changed to `to` at an instant inside `at`. Transitions from one clock/scope are
 *   assembled into intervals (see docs). `holdsUntil` = the source vouches the state still held at that time.
 */
export type EvidenceAssertion =
  | { kind: 'INTERVAL'; state: ObservedState; start: TimeBound; end: TimeBound }
  | { kind: 'POINT'; state: ObservedState; at: TimeBound }
  | { kind: 'TRANSITION'; to: ObservedState; at: TimeBound; holdsUntil?: IsoInstant };

export interface TemporalEvidence {
  /** RIPPLE's identifier for this evidence item. */
  id: string;
  incidentId: string;
  scope: EvidenceScope;
  source: EvidenceSource;
  assertion: EvidenceAssertion;
  /** When the source recorded the observation (source clock). */
  observedAt: IsoInstant;
  /** When RIPPLE received it. Informational (delayed ingestion is flagged, never used as event time). */
  ingestedAt?: IsoInstant;
  provenance: { reference: string; contentHash: string };
  /** Optional reference to the contract the producer believed applied; checked, never trusted. */
  contractRef?: { contractId: string; version: string };
}

/** Known clock behaviour. Reading = true time + offset. Correction subtracts `knownOffsetMs`. */
export interface ClockProfile {
  clockId: string;
  knownOffsetMs: number;
  /** Residual offset uncertainty (±) after correction, at `lastSyncAt`. */
  uncertaintyMs: number;
  driftPpm?: number;
  lastSyncAt?: IsoInstant;
}

export interface MaintenanceRecord {
  id: string;
  start: IsoInstant;
  end: IsoInstant;
  announcedAt?: IsoInstant;
  /** Only applies to these regions when present. */
  regions?: string[];
  /** CONFIRMED = validated against the contract's notice rule by a human; UNCONFIRMED = claimed only. */
  status: 'CONFIRMED' | 'UNCONFIRMED' | 'REJECTED';
  reference: string;
}

// ───────────────────────────── contract ─────────────────────────────

export type QualifyingState = 'UNAVAILABLE' | 'DEGRADED';

/** A threshold on the measured qualifying downtime. Percent values are exact decimal strings, e.g. "99.9". */
export type ThresholdRule =
  | { type: 'DOWNTIME_EXCEEDS'; thresholdMs: number; inclusive: boolean }
  | { type: 'AVAILABILITY_BELOW'; targetPercent: string; inclusive: boolean };

export interface ContractDocument {
  contractId: string;
  version: string;
  effectiveFrom: IsoInstant;
  /** Exclusive end; null = open-ended. */
  effectiveTo: IsoInstant | null;
  /** If present, must equal the computed hash (sha256 of the canonical document without this field). */
  contentHash?: string;
  scope: { service: string; region?: string; customer?: string };
  measurement: {
    period: { type: 'INCIDENT_WINDOW' } | { type: 'CALENDAR_MONTH'; timeZone: string };
    metric: 'CUMULATIVE_DOWNTIME' | 'LONGEST_CONTINUOUS_DOWNTIME';
    qualifyingStates: QualifyingState[];
    granularity?: { bucketMs: number; rule: 'ANY_DOWNTIME_IN_BUCKET' | 'ENTIRE_BUCKET_DOWN' };
    /** Down episodes separated by a recovery shorter than this are one episode (flapping). */
    episodeMergeGapMs?: number;
    /** Whether the short recoveries inside a merged episode count as downtime. */
    countMergedGaps?: boolean;
    minimumQualifyingEpisodeMs?: number;
    gracePerEpisodeMs?: number;
    rounding?: { unitMs: number; method: 'FLOOR' | 'CEIL' | 'NEAREST_HALF_UP' };
  };
  breach?: ThresholdRule;
  credit?: {
    monthlyFeeMinor: number;
    currency: string;
    tiers: { when: ThresholdRule; creditPercent: string }[];
    capPercent?: string;
  };
  maintenance?: { noticeRequiredMs: number; regionSpecific?: boolean };
  evidenceRequirements?: { establishDowntimeWith?: AuthorityClass[] };
  /** Free-text clauses. Only `INFORMATIONAL` is understood; anything else produces a review requirement. */
  clauses?: { id: string; type: string; text: string }[];
}

export type MeasurementWindow = { start: IsoInstant; end: IsoInstant } | { calendarMonth: string };

// ───────────────────────────── policy ─────────────────────────────

export interface ForensicsPolicy {
  authorityRanks: Record<AuthorityClass, number>;
  /** A definite conflict is resolved by authority only when the ranks differ by at least this much. */
  resolveByAuthorityMinGap: number;
  /** Used (and disclosed) when a record's clock has no profile. */
  defaultClockUncertaintyMs: number;
  staleAfterMs: number;
  delayedIngestionAfterMs: number;
  /** Branch-and-bound node budget per bound. Bounds stay sound when it runs out; they are then marked not tight. */
  maxBranchNodes: number;
  /** Unconfirmed maintenance windows are enumerated exactly up to this many. */
  maxUnconfirmedExclusions: number;
}

export const DEFAULT_POLICY: ForensicsPolicy = {
  // Machine-recorded, authenticated telemetry outranks human-authored timelines; customer and support reports rank
  // together; unverified statements lowest. Configurable per analysis; recorded in the policy hash.
  authorityRanks: {
    SIGNED_MONITORING: 6, AUTHENTICATED_INFRASTRUCTURE: 5, SYNTHETIC_PROBE: 4, ENGINEERING_INCIDENT_REPORT: 3,
    SUPPORT_TICKET: 2, CUSTOMER_REPORT: 2, UNVERIFIED_MANUAL: 1,
  },
  resolveByAuthorityMinGap: 2,
  defaultClockUncertaintyMs: 60_000,
  staleAfterMs: 15 * 60_000,
  delayedIngestionAfterMs: 10 * 60_000,
  maxBranchNodes: 800,
  maxUnconfirmedExclusions: 8,
};

// ───────────────────────────── analysis input/output ─────────────────────────────

export interface IncidentRef { incidentId: string; scope: { service: string; region?: string; customer?: string } }

export interface AnalysisInput {
  /** One version, or the full version history of ONE contract. The effective version is selected by date. */
  contract: ContractDocument | ContractDocument[];
  evidence: TemporalEvidence[];
  measurementWindow: MeasurementWindow;
  incident?: IncidentRef;
  clocks?: ClockProfile[];
  maintenance?: MaintenanceRecord[];
  policy?: Partial<ForensicsPolicy>;
}

export type Classification = 'BREACH_CONFIRMED' | 'BREACH_POSSIBLE' | 'NO_BREACH' | 'INDETERMINATE' | 'NOT_APPLICABLE';

export interface Segment { start: IsoInstant; end: IsoInstant; startMs: number; endMs: number; durationMs: number }

export type UncertaintyCause =
  | { type: 'TIMESTAMP_UNCERTAINTY'; evidenceIds: string[] }
  | { type: 'CLOCK_OFFSET'; clockId: string; evidenceIds: string[] }
  | { type: 'NO_EVIDENCE'; explicitUnknownEvidenceIds: string[] }
  | { type: 'SET_ASIDE_EVIDENCE'; evidenceIds: string[] }
  | { type: 'POSSIBLE_EXCLUSION'; maintenanceIds: string[] };

export interface UncertainSegment extends Segment { causes: UncertaintyCause[] }

/** A segment together with the evidence that establishes it. */
export interface EvidencedSegment extends Segment { evidenceIds: string[] }

export type IssueCode =
  | 'INVALID_TIME_BOUND' | 'END_BEFORE_START' | 'EVENT_AFTER_OBSERVATION' | 'MISSING_SOURCE_METADATA' | 'MISSING_PROVENANCE'
  | 'DUPLICATE_RECORD' | 'DUPLICATE_CONTENT' | 'RECORD_ID_COLLISION' | 'INCOMPATIBLE_SCOPE' | 'NARROWER_SCOPE'
  | 'AGGREGATE_HEALTH_NOT_APPLICABLE' | 'UNVERIFIED_SIGNATURE' | 'MISSING_CLOCK_METADATA' | 'DRIFT_WITHOUT_SYNC_TIME'
  | 'STALE_OBSERVATION' | 'DELAYED_INGESTION' | 'OUT_OF_WINDOW' | 'EXPLICIT_UNKNOWN_STATE' | 'NOT_ACCEPTED_BY_CONTRACT'
  | 'INVALID_CONTRACT_REFERENCE' | 'OTHER_INCIDENT' | 'AMBIGUOUS_TRANSITION_ORDER' | 'OPEN_TRANSITION'
  | 'SET_ASIDE_BY_AUTHORITY' | 'SET_ASIDE_UNRESOLVED_CONFLICT' | 'SET_ASIDE_JOINT_INFEASIBILITY' | 'RETRACTED' | 'SUPERSEDED'
  | 'COUNTERFACTUAL_EXCLUDED';

export interface Issue { code: IssueCode; detail: string }

export type EvidenceStatus = 'USED' | 'SET_ASIDE' | 'EXCLUDED' | 'NOT_APPLICABLE' | 'DUPLICATE';

export interface EvidenceAssessment {
  evidenceId: string;
  source: string;
  recordId: string;
  status: EvidenceStatus;
  declaredAuthority: AuthorityClass;
  effectiveAuthority: AuthorityClass;
  rank: number;
  /** What the record contributed: ESTABLISHES_DOWNTIME (qualifying state), ESTABLISHES_NON_QUALIFYING, or NONE. */
  role: 'ESTABLISHES_DOWNTIME' | 'ESTABLISHES_NON_QUALIFYING' | 'NONE';
  issues: Issue[];
}

export type ConflictType = 'STATE_CONTRADICTION' | 'RECORD_ID_COLLISION' | 'JOINT_INFEASIBILITY';

export interface Conflict {
  id: string;
  type: ConflictType;
  evidenceIds: string[];
  resolution: 'RESOLVED_BY_AUTHORITY' | 'UNRESOLVED';
  /** For RESOLVED_BY_AUTHORITY: the evidence kept / set aside. */
  kept?: string[];
  setAside: string[];
  explanation: string;
  /** Where the contradiction lies in true time (the guaranteed overlap), when it is a state contradiction. */
  overlap?: Segment;
}

export type ReviewCode =
  | 'CONTRACT_FIELD_MISSING' | 'CONTRACT_FIELD_INVALID' | 'UNSUPPORTED_CLAUSE' | 'CONTRACT_HASH_MISMATCH'
  | 'CONTRACT_NOT_EFFECTIVE' | 'CONTRACT_VERSION_BOUNDARY_IN_WINDOW' | 'CONTRACT_COVERAGE_PARTIAL'
  | 'WINDOW_NOT_CONTRACT_PERIOD' | 'TOO_MANY_UNCONFIRMED_EXCLUSIONS' | 'NO_APPLICABLE_EVIDENCE' | 'SCOPE_OUTSIDE_CONTRACT'
  | 'EMPTY_MEASUREMENT_PERIOD';

export interface ReviewRequirement { code: ReviewCode; blocking: boolean; detail: string; clauseId?: string; field?: string }

export type BoundStatus = 'EXACT' | 'SOUND_NOT_TIGHT';

export interface ExposureBounds {
  /** Contractual qualifying downtime after all contract rules, over every timeline consistent with the evidence used. */
  qualifyingDowntimeMs: { min: number; max: number; minStatus: BoundStatus; maxStatus: BoundStatus };
  /** Smallest qualifying downtime that constitutes a breach (over exclusion scenarios). */
  breachPointMs: { min: number; max: number } | null;
  /** Availability over the measured period, exact decimal strings rounded outward (min down, max up). */
  availabilityPercent: { min: string; max: string } | null;
  /** Measured (non-excluded) period length over exclusion scenarios. */
  measuredPeriodMs: { min: number; max: number };
}

export interface ExclusionAssessment { maintenanceId: string; status: 'APPLIED' | 'POSSIBLE' | 'NOT_APPLIED'; reason: string; segment: Segment | null }

export interface DecisionSensitivity {
  conclusive: boolean;
  /** Width of the qualifying-downtime interval that straddles the breach point (0 when conclusive). */
  decisionSensitiveMs: number;
  /** Additional established qualifying downtime needed before a breach is confirmed (null when not applicable). */
  additionalDowntimeToConfirmMs: number | null;
  /** Possible qualifying downtime that must be ruled out to establish NO_BREACH (null when not applicable). */
  possibleDowntimeToEliminateMs: number | null;
  statement: string;
}

export interface CreditExposure { currency: string; minMinor: number; maxMinor: number; capMinor: number | null }

export interface TemporalExposureResult {
  engine: { name: typeof TCF_ENGINE; version: string };
  classification: Classification;
  /** The mathematical rule that produced the classification, with the numbers it compared. */
  classificationRule: string;
  reasons: string[];
  contract: {
    contractId: string; version: string; contentHash: string; effectiveFrom: IsoInstant; effectiveTo: IsoInstant | null; selectedBecause: string;
  } | null;
  target: { service: string; region?: string; customer?: string } | null;
  window: { requested: Segment; measured: Segment | null };
  bounds: ExposureBounds | null;
  envelope: {
    certainDowntime: EvidencedSegment[];
    knownNonQualifying: EvidencedSegment[];
    possibleDowntime: Segment[];
    uncertain: UncertainSegment[];
    evidenceGaps: Segment[];
    exclusions: ExclusionAssessment[];
  };
  sensitivity: DecisionSensitivity;
  credit: CreditExposure | null;
  conflicts: Conflict[];
  evidence: EvidenceAssessment[];
  reviewRequirements: ReviewRequirement[];
  /** Assumptions applied in this analysis, in plain words. */
  disclosures: string[];
  hashes: { evidenceSetHash: string; contractHash: string | null; policyHash: string; inputHash: string };
}

// ───────────────────────────── revisions & updates ─────────────────────────────

/** Ledger entries are never removed. Exact re-submissions are idempotent (no entry); duplicates by content stay ACTIVE and are detected by the engine. */
export type LedgerStatus = 'ACTIVE' | 'SUPERSEDED' | 'RETRACTED';

export interface LedgerEntry {
  evidence: TemporalEvidence;
  status: LedgerStatus;
  receivedAt: IsoInstant;
  contentHash: string;
  note?: string;
  supersededBy?: string;
  supersedes?: string;
}

export interface AnalysisContext {
  contracts: ContractDocument[];
  measurementWindow: MeasurementWindow;
  incident?: IncidentRef;
  clocks: ClockProfile[];
  maintenance: MaintenanceRecord[];
  policy: ForensicsPolicy;
}

export interface FieldChange { field: string; before: unknown; after: unknown }

export interface AnalysisRevision {
  revision: number;
  parentRevisionHash: string | null;
  revisionHash: string;
  evidenceSetHash: string;
  ledgerHash: string;
  contractHash: string | null;
  outputHash: string;
  createdAt: IsoInstant;
  reason: string;
  changeSummary: string[];
  changedFields: FieldChange[];
  context: AnalysisContext;
  ledger: LedgerEntry[];
  result: TemporalExposureResult;
}

export interface AddEvidenceEvent { type: 'ADD_EVIDENCE'; evidence: TemporalEvidence; receivedAt: IsoInstant; reason?: string }
export interface CorrectEvidenceEvent { type: 'CORRECT_EVIDENCE'; targetEvidenceId: string; corrected: TemporalEvidence; receivedAt: IsoInstant; reason: string }
export interface RetractEvidenceEvent { type: 'RETRACT_EVIDENCE'; evidenceId: string; receivedAt: IsoInstant; reason: string }
export type EvidenceEvent = AddEvidenceEvent | CorrectEvidenceEvent | RetractEvidenceEvent;

// ───────────────────────────── counterfactuals ─────────────────────────────

export type Endpoint = 'start' | 'end' | 'at';

export type CounterfactualChange =
  | { type: 'SHIFT_TIME'; evidenceId: string; endpoint: Endpoint | 'all'; byMs: number }
  | { type: 'SET_TIME_BOUND'; evidenceId: string; endpoint: Endpoint; bound: TimeBound }
  | { type: 'INGESTION_DELAY'; evidenceId: string; endpoint: Endpoint; delayMs: number }
  | { type: 'SET_CLOCK'; clockId: string; knownOffsetMs?: number; uncertaintyMs?: number }
  | { type: 'SET_AUTHORITY'; evidenceId: string; authority: AuthorityClass; signatureVerified?: boolean }
  | { type: 'SET_EXCLUSION_STATUS'; maintenanceId: string; status: MaintenanceRecord['status'] }
  | { type: 'EXCLUDE_EVIDENCE'; evidenceId: string; reason: string }
  | { type: 'ADD_EVIDENCE'; evidence: TemporalEvidence }
  | { type: 'SET_SCOPE_SEMANTICS'; evidenceId: string; semantics: 'UNIVERSAL' | 'AGGREGATE' };

export interface CounterfactualResult {
  hypothetical: true;
  label: string;
  status: 'COMPUTED' | 'IMPOSSIBLE';
  baseRevisionHash: string;
  baseOutputHash: string;
  changes: CounterfactualChange[];
  rejected: { index: number; reason: string }[];
  evidenceSetHash: string | null;
  result: TemporalExposureResult | null;
  diff: FieldChange[];
  attribution: { change: number; description: string; affectedEvidenceIds: string[] }[];
  explanation: string[];
}

// ───────────────────────────── minimum decisive evidence ─────────────────────────────

export type EvidenceRequestKind =
  | 'OBSERVE_INTERVAL' | 'RESOLVE_TIMESTAMP' | 'RESOLVE_CLOCK_OFFSET' | 'CONFIRM_EXCLUSION' | 'RESOLVE_CONFLICT' | 'CONTRACT_CLARIFICATION';

export type DecisiveGuarantee = 'ALWAYS_DECISIVE' | 'DECISIVE_IN_SOME_OUTCOMES' | 'NARROWS_ONLY' | 'NO_EFFECT';

export interface RequirementOutcome { outcome: string; classification: Classification; minMs: number | null; maxMs: number | null; consistent: boolean }

export interface EvidenceRequirement {
  id: string;
  kind: EvidenceRequestKind;
  request: string;
  /** Exact what-to-fetch, machine readable. */
  target: Record<string, unknown>;
  guarantee: DecisiveGuarantee;
  /** EXACT_EXTREMES: outcomes evaluated at the extremes of a monotone parameter (covers every value in between).
   *  ENUMERATED: every discrete outcome evaluated. SAMPLED: a finite sample of a non-monotone parameter. */
  evaluation: 'EXACT_EXTREMES' | 'ENUMERATED' | 'SAMPLED' | 'NOT_EVALUATED';
  outcomes: RequirementOutcome[];
  /** Largest decision-sensitive width left over across outcomes (ms). */
  worstCaseResidualMs: number;
  bestCaseResidualMs: number;
  /** Amount of observation requested (ms) — 0 for resolving an existing record. */
  requestedSpanMs: number;
  whyItMatters: string;
  rank: number;
}

export interface MinimumDecisiveEvidenceReport {
  conclusive: boolean;
  classification: Classification;
  statement: string;
  requirements: EvidenceRequirement[];
  /** Smallest combinations (up to 2 requests) that are decisive under every evaluated outcome. */
  decisiveCombinations: { requirementIds: string[]; outcomes: RequirementOutcome[] }[];
  /** Evidence that any decisive observation of an undecided segment would contradict, per direction. */
  blockers: { toConfirm: string[]; toRuleOut: string[] };
  evaluations: number;
}
