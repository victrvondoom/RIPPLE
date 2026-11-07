/**
 * Read-only registry observer: for each package an install line names, record what npm / PyPI say NOW and what the
 * static rules find in the archive. Archives are read into memory only; nothing is installed, extracted to disk,
 * imported or executed. The result is an `Observation` the package-gate pack consumes as recorded data, so the
 * analyzers stay deterministic and re-runnable. A network failure is recorded as `unreachable`, never as "clean".
 */
import type { PackageRef } from './installs.js';
import { inspectArchive, type InspectResult } from './inspect.js';
import type { PkgMeta } from './metadata.js';
import { docStatus, metaAt, pypiMeta, takedownTime, type NpmDoc } from './registry.js';

export interface Observation {
  ecosystem: 'npm' | 'pypi'; name: string; requestedVersion: string | null; resolvedVersion: string | null;
  existence: 'exists' | 'not-found' | 'unreachable' | 'version-not-found';
  observedAt: string; source: string;
  meta: PkgMeta | null;
  code: Pick<InspectResult, 'version' | 'score' | 'verdict' | 'hits' | 'installHook' | 'filesScanned'> | null;
  integrity: string | null; // registry-published archive digest (npm dist.integrity / PyPI sha256) for the version that was read
  /** Session 19: a registry statement about the name itself, e.g. npm replaced it with a security placeholder after removing malware. */
  registryNotice?: string | null;
}

const MAX_ARCHIVE = 30 * 1024 * 1024;
export type Fetcher = (url: string) => Promise<{ status: number; json?: any; bytes?: Buffer }>;
export const httpFetcher: Fetcher = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': 'ripple-pkgguard/1' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) return { status: r.status };
  if (/\.(?:tgz|tar\.gz|whl|zip)$/.test(new URL(url).pathname)) {
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > MAX_ARCHIVE ? { status: 413 } : { status: r.status, bytes: b };
  }
  return { status: r.status, json: await r.json() };
};

export async function observe(ref: PackageRef, opts: { inspect?: boolean; fetcher?: Fetcher; now?: string } = {}): Promise<Observation> {
  const f = opts.fetcher ?? httpFetcher; const now = opts.now ?? new Date().toISOString();
  const base: Observation = { ecosystem: ref.ecosystem, name: ref.name, requestedVersion: ref.version ?? null, resolvedVersion: null, existence: 'unreachable', observedAt: now, source: ref.ecosystem === 'npm' ? 'registry.npmjs.org' : 'pypi.org', meta: null, code: null, integrity: null };
  try {
    if (ref.ecosystem === 'npm') {
      const name = ref.name.startsWith('@') ? '@' + encodeURIComponent(ref.name.slice(1)) : encodeURIComponent(ref.name);
      const r = await f(`https://registry.npmjs.org/${name}`);
      if (r.status === 404) return { ...base, existence: 'not-found' };
      if (!r.json) return base;
      const doc = r.json as NpmDoc;
      // npm replaces a package it removed for security reasons with a `0.0.1-security` placeholder: the name carried malware.
      if (docStatus(doc) === 'placeholder') return { ...base, existence: 'exists', resolvedVersion: doc['dist-tags']?.latest ?? null, registryNotice: `npm security placeholder since ${takedownTime(doc) ?? 'an unknown date'}: npm removed this package's code for security reasons` };
      const want = ref.version && doc.versions?.[ref.version] ? ref.version : ref.version && doc['dist-tags']?.[ref.version] ? doc['dist-tags'][ref.version] : ref.version ? null : doc['dist-tags']?.latest ?? null;
      if (!want) return { ...base, existence: 'version-not-found' };
      const meta = metaAt(doc, ref.name, now, want);
      const dist = doc.versions?.[want]?.dist;
      let code: Observation['code'] = null;
      if (opts.inspect !== false && dist?.tarball) { const a = await f(dist.tarball); if (a.bytes) code = slim(inspectArchive('npm', a.bytes)); }
      return { ...base, existence: 'exists', resolvedVersion: want, meta, code, integrity: dist?.integrity ?? dist?.shasum ?? null };
    }
    const r = await f(`https://pypi.org/pypi/${encodeURIComponent(ref.name)}/json`);
    if (r.status === 404) return { ...base, existence: 'not-found' };
    if (!r.json) return base;
    const d = r.json;
    const want: string | null = ref.version ? (d.releases?.[ref.version]?.length ? ref.version : null) : d.info?.version ?? null;
    if (!want) return { ...base, existence: 'version-not-found' };
    const meta = pypiMeta(d, ref.name, now);
    const files: any[] = d.releases?.[want] ?? [];
    const pick = files.find((x) => x.packagetype === 'sdist') ?? files.find((x) => x.packagetype === 'bdist_wheel');
    let code: Observation['code'] = null;
    if (opts.inspect !== false && pick?.url) { const a = await f(pick.url); if (a.bytes) code = slim(inspectArchive('pypi', a.bytes)); }
    return { ...base, existence: 'exists', resolvedVersion: want, meta, code, integrity: pick?.digests?.sha256 ? `sha256-${pick.digests.sha256}` : null };
  } catch { return base; }
}
const slim = (r: InspectResult): Observation['code'] => ({ version: r.version, score: r.score, verdict: r.verdict, hits: r.hits.slice(0, 40), installHook: r.installHook, filesScanned: r.filesScanned });
