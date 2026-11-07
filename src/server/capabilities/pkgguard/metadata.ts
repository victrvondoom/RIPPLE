/**
 * Metadata rules (the "Scout" concept: judge a package by what the registry says about it, before reading any code).
 * Pure: the caller supplies a `PkgMeta` snapshot taken AT A STATED MOMENT (`asOf`). Unknown fields stay `null` and a rule
 * that needs an unknown field reports `unknown`, never `pass`. The thresholds were fixed before the benchmark ran
 * (bench/pkgguard/README.md records the commit); the benchmark sweeps them separately so the trade-off is visible.
 */
import type { Ecosystem } from './installs.js';
import { STRONG_SQUAT, type NameIndex, type SquatHit } from './names.js';

export const META_RULES = {
  newDays: 7,
  youngDays: 30,
  fewVersions: 2,
  lowWeeklyDownloads: 50,
  /** A first major version this high on a package with few releases is the classic dependency-confusion tell (99.99.9). */
  confusionMajor: 90,
  confusionMaxVersions: 3,
  /** A new release after this many quiet days, on a package older than a year (possible account takeover). */
  dormantDays: 365,
} as const;

export interface PkgMeta {
  ecosystem: Ecosystem;
  name: string;
  /** The moment the snapshot describes (ISO). For a live package: now. For a historical replay: the install moment. */
  asOf: string;
  /** First publish of any version (ISO), or null when the registry no longer has it. */
  firstPublished: string | null;
  /** Number of versions published at or before `asOf`, or null. */
  versionCount: number | null;
  /** Highest major version number published at or before `asOf`, or null. */
  maxMajor: number | null;
  /** Days between the release being installed and the previous release, or null (first release / unknown). */
  quietDaysBefore: number | null;
  /** npm: the version being installed declares preinstall/install/postinstall. PyPI: null (sdists run setup.py by design). */
  installScript: boolean | null;
  weeklyDownloads: number | null;
  hasRepository: boolean | null;
}

export type RuleState = 'hit' | 'clear' | 'unknown';
export interface MetaVerdict {
  flagged: boolean;
  signals: Record<string, RuleState>;
  squat: SquatHit[];
  ageDays: number | null;
  reasons: string[];
}

const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86400000;
const st = (v: boolean | null): RuleState => (v === null ? 'unknown' : v ? 'hit' : 'clear');

/**
 * Composite (fixed a priori):
 *   flagged = lookalike name
 *          OR dependency-confusion version
 *          OR (young AND few versions)
 *          OR (young AND install script)
 * "low downloads" and "dormant revival" are reported but NOT in the composite: downloads are unknown for every removed
 * package (no fair replay), and a dormant revival is common for legitimate maintenance releases.
 */
export function metadataVerdict(m: PkgMeta, index: NameIndex | null): MetaVerdict {
  const ageDays = m.firstPublished ? days(m.firstPublished, m.asOf) : null;
  const young = ageDays === null ? null : ageDays < META_RULES.youngDays;
  const isNew = ageDays === null ? null : ageDays < META_RULES.newDays;
  const few = m.versionCount === null ? null : m.versionCount <= META_RULES.fewVersions;
  const confusion = m.maxMajor === null || m.versionCount === null ? null : m.maxMajor >= META_RULES.confusionMajor && m.versionCount <= META_RULES.confusionMaxVersions;
  const dormant = m.quietDaysBefore === null || ageDays === null ? null : m.quietDaysBefore >= META_RULES.dormantDays && ageDays > 365;
  const low = m.weeklyDownloads === null ? null : m.weeklyDownloads < META_RULES.lowWeeklyDownloads;
  const squat = index ? index.check(m.name) : [];
  const lookalike = index ? squat.some((h) => STRONG_SQUAT.includes(h.kind)) : null;
  const combo = index ? squat.some((h) => h.kind === 'combosquat') : null;
  const and = (a: boolean | null, b: boolean | null) => (a === false || b === false ? false : a === null || b === null ? null : true);
  const youngFew = and(young, few);
  const youngScript = and(young, m.installScript);
  const signals: Record<string, RuleState> = {
    new_package: st(isNew), young_package: st(young), few_versions: st(few), install_script: st(m.installScript),
    low_downloads: st(low), dependency_confusion_version: st(confusion), dormant_revival: st(dormant),
    lookalike_name: st(lookalike), combosquat_name: st(combo), no_repository: st(m.hasRepository === null ? null : !m.hasRepository),
    young_and_few_versions: st(youngFew), young_and_install_script: st(youngScript),
  };
  const flagged = !!(lookalike || confusion || youngFew || youngScript);
  const reasons: string[] = [];
  if (lookalike) reasons.push(...squat.filter((h) => STRONG_SQUAT.includes(h.kind)).map((h) => `name ${h.detail}`));
  if (confusion) reasons.push(`version ${m.maxMajor}.x on a package with ${m.versionCount} release(s) (dependency-confusion pattern)`);
  if (youngFew) reasons.push(`${Math.max(0, Math.floor(ageDays!))} day(s) old with ${m.versionCount} release(s)`);
  if (youngScript) reasons.push(`${Math.max(0, Math.floor(ageDays!))} day(s) old and runs an install script`);
  return { flagged, signals, squat, ageDays, reasons };
}
