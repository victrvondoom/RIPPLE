/**
 * TCFB shared definitions. The generator emits, for every case, BOTH the engine input and an independent
 * "oracle view": what each record asserts mathematically, in integer ms, computed by the generator from the numbers
 * it used to build the record. The oracle never sees the engine's parsed/normalised form.
 */
import type { AnalysisInput, AuthorityClass, TemporalEvidence } from '../../src/server/capabilities/temporal-contract-forensics/index.js';

export const SEED = 20261107;
export const LATTICE = 10_000; // every generated instant, offset and uncertainty is a multiple of 10 s (drift cases excepted)
export const MIN = 60_000;

export const CATEGORIES = [
  'ACCURATE_TIMESTAMPS', 'CLOCK_DRIFT', 'LARGE_CLOCK_OFFSET', 'MISSING_RECOVERY', 'DUPLICATE_OUTAGE_EVENTS', 'LATE_ARRIVING_EVIDENCE',
  'OUT_OF_ORDER_EVENTS', 'PARTIAL_REGIONAL_OUTAGE', 'OVERLAPPING_INCIDENTS', 'FLAPPING_RECOVERY', 'CONFLICTING_TELEMETRY',
  'MAINTENANCE_EXCLUSIONS', 'CONTRACT_VERSION_CHANGE', 'WINDOW_BOUNDARY', 'TIMEZONE_BOUNDARY', 'THRESHOLD_EQUALITY',
  'MULTIPLE_OVERLAPPING_INTERVALS', 'MISSING_CONTRACT_FIELDS', 'INCORRECT_SERVICE_SCOPE', 'DELIBERATE_CONTRADICTION',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Engine default authority ranks, restated so the oracle does not import engine policy code. Checked at start-up. */
export const RANKS: Record<AuthorityClass, number> = {
  SIGNED_MONITORING: 6, AUTHENTICATED_INFRASTRUCTURE: 5, SYNTHETIC_PROBE: 4, ENGINEERING_INCIDENT_REPORT: 3, SUPPORT_TICKET: 2, CUSTOMER_REPORT: 2, UNVERIFIED_MANUAL: 1,
};
export const RESOLVE_GAP = 2;

export interface OracleRecord {
  id: string;
  clock: string;
  polarity: 'Q' | 'N';
  kind: 'INTERVAL' | 'POINT';
  /** Clock-corrected reading frame (true time = value + δ(clock)); start ∈ [sLo,sHi], end ∈ [eLo,eHi]. */
  sLo: number; sHi: number; eLo: number; eHi: number;
  rank: number;
}

export interface OracleRules { thresholdMs: number; inclusive: boolean; metric: 'CUMULATIVE_DOWNTIME' | 'LONGEST_CONTINUOUS_DOWNTIME'; mergeGapMs: number; countMergedGaps: boolean; minEpisodeMs: number; graceMs: number }

export interface OracleView {
  window: [number, number];
  appliedExclusions: [number, number][];
  possibleExclusions: [number, number][];
  records: OracleRecord[];
  clocks: Record<string, number>; // clockId → residual uncertainty U (ms)
  rules: OracleRules | null;
  /** Set when the generator constructed the case so that this classification is the only correct one. */
  expected: 'NOT_APPLICABLE' | 'INDETERMINATE' | null;
  /** Whether the oracle's exhaustive offset search is exact for this case (≤ 2 uncertain clocks, lattice data). */
  exact: boolean;
}

export interface Truth {
  /** True qualifying-state intervals of the contracted scope (ms). */
  down: [number, number][];
  /** Exclusions that are truly valid. */
  validExclusions: [number, number][];
  /** null when the contract question has no answer (missing terms, out of scope). */
  breach: boolean | null;
  metricMs: number | null;
  breachPointMs: number | null;
}

export interface CaseMeta {
  /** Evidence ids whose claims exceed their declared uncertainty (deliberate lies). */
  liars: string[];
  /** Gaps injected into the evidence (true time). */
  gaps: [number, number][];
  /** True clock offsets (reading − true) per clock at the reference instant, and drift rate. */
  trueOffsets: Record<string, number>;
  /** For each evidence id: true reading (source clock) of each endpoint, to simulate "resolve this timestamp". */
  trueReadings: Record<string, { start?: number; end?: number; at?: number }>;
  /** For LATE_ARRIVING_EVIDENCE: ids that arrive after the first analysis. */
  lateIds: string[];
  /** Maintenance truth: id → truly valid. */
  maintenanceValid: Record<string, boolean>;
  service: string; region?: string; customer?: string;
}

export interface BenchCase { id: string; category: Category; index: number; input: AnalysisInput; oracle: OracleView; truth: Truth; meta: CaseMeta }

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p };
}
export type Rng = ReturnType<typeof rng>;

/** Independent ISO formatting (no engine code). */
export const iso = (ms: number) => { const s = new Date(ms).toISOString(); return s.endsWith('.000Z') ? s.replace('.000Z', 'Z') : s; };

export type Ev = TemporalEvidence;
