/**
 * Registry documents -> `PkgMeta` snapshots. Used by the package-gate pack's live observer AND by the benchmark, so the
 * numbers in bench/pkgguard come from the same code the product runs.
 *
 * npm: turns an npm registry document into a `PkgMeta` snapshot AT A GIVEN MOMENT, using only versions published at or
 * before that moment. This is how a removed malicious package is replayed: npm's security placeholder keeps the
 * original `time` map (version -> publish time) even after the code is gone, so age and release history at the
 * install moment are real registry data. Fields npm no longer has (install scripts of removed versions, historical
 * downloads) stay null.
 */
import type { PkgMeta } from './metadata.js';

export interface NpmDoc { name?: string; time?: Record<string, any>; versions?: Record<string, any>; 'dist-tags'?: Record<string, string>; repository?: unknown }
export const isPlaceholderVersion = (v: string) => /-security(?:\.\d+)?$/.test(v);

/** version -> publish time for real (non-placeholder) versions, sorted by time. */
export function versionTimes(doc: NpmDoc): [string, string][] {
  const t = doc.time ?? {};
  return Object.entries(t)
    .filter(([k, v]) => k !== 'created' && k !== 'modified' && k !== 'unpublished' && typeof v === 'string' && !isPlaceholderVersion(k))
    .sort((a, b) => Date.parse(a[1]) - Date.parse(b[1])) as [string, string][];
}
export function docStatus(doc: NpmDoc): 'live' | 'placeholder' | 'unpublished' {
  const vs = Object.keys(doc.versions ?? {});
  if (vs.length === 0) return 'unpublished';
  return vs.every(isPlaceholderVersion) ? 'placeholder' : 'live';
}
export function takedownTime(doc: NpmDoc): string | null {
  const t = doc.time ?? {};
  const ph = Object.entries(t).filter(([k]) => isPlaceholderVersion(k)).map(([, v]) => String(v)).sort();
  return ph[0] ?? (t.unpublished?.time ? String(t.unpublished.time) : null);
}
const major = (v: string) => { const m = /^v?(\d+)/.exec(v); return m ? Number(m[1]) : null; };
const HOOKS = ['preinstall', 'install', 'postinstall'];
export const hasHook = (manifest: any) => (manifest?.scripts ? HOOKS.some((k) => typeof manifest.scripts[k] === 'string' && manifest.scripts[k].trim()) : manifest?.hasInstallScript === true);

/**
 * Snapshot of the package as an installer would have seen it at `asOf`, installing `version` (the latest version
 * published by then when omitted).
 */
export function metaAt(doc: NpmDoc, name: string, asOf: string, version?: string, weeklyDownloads: number | null = null): PkgMeta & { version: string | null } {
  const vt = versionTimes(doc).filter(([, t]) => Date.parse(t) <= Date.parse(asOf) + 1000);
  const v = version ?? (vt.length ? vt[vt.length - 1][0] : null);
  const idx = v ? vt.findIndex(([k]) => k === v) : -1;
  const prev = idx > 0 ? vt[idx - 1][1] : null;
  const vTime = idx >= 0 ? vt[idx][1] : null;
  const majors = vt.map(([k]) => major(k)).filter((x): x is number => x !== null);
  const manifest = v ? doc.versions?.[v] : undefined;
  const repo = manifest ? !!(manifest.repository || doc.repository) : null;
  return {
    ecosystem: 'npm', name, asOf, version: v,
    firstPublished: vt.length ? vt[0][1] : null,
    versionCount: vt.length || null,
    maxMajor: majors.length ? Math.max(...majors) : null,
    quietDaysBefore: prev && vTime ? (Date.parse(vTime) - Date.parse(prev)) / 86400000 : null,
    installScript: manifest ? hasHook(manifest) : null,
    weeklyDownloads,
    hasRepository: repo,
  };
}

/** Turns a PyPI JSON document into a `PkgMeta` snapshot at a given moment (only files uploaded by then count). */
export function pypiMeta(d: any, name: string, asOf: string): PkgMeta & { version: string | null; sdistOnly: boolean | null } {
  const rel = Object.entries(d.releases as Record<string, any[]>)
    .map(([v, files]) => ({ v, t: files.map((f) => f.upload_time_iso_8601).filter(Boolean).sort()[0] as string | undefined, files }))
    .filter((x) => x.t && Date.parse(x.t) <= Date.parse(asOf) + 1000)
    .sort((a, b) => Date.parse(a.t!) - Date.parse(b.t!));
  const last = rel[rel.length - 1];
  const majors = rel.map((x) => Number(/^v?(\d+)/.exec(x.v)?.[1])).filter((x) => Number.isFinite(x));
  const sdistOnly = last ? last.files.some((f) => f.packagetype === 'sdist') && !last.files.some((f) => f.packagetype === 'bdist_wheel') : null;
  const urls = Object.values(d.info.project_urls ?? {}).concat(d.info.home_page ?? []).join(' ');
  return {
    ecosystem: 'pypi', name, asOf, version: last?.v ?? null,
    firstPublished: rel[0]?.t ?? null, versionCount: rel.length || null,
    maxMajor: majors.length ? Math.max(...majors) : null,
    quietDaysBefore: rel.length > 1 ? (Date.parse(last.t!) - Date.parse(rel[rel.length - 2].t!)) / 86400000 : null,
    // PyPI has no install hooks; an sdist-only release runs its setup.py at install, which is the closest analogue.
    installScript: sdistOnly, sdistOnly,
    weeklyDownloads: null, hasRepository: /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org/i.test(urls),
  };
}
