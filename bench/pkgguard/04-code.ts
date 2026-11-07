/**
 * Step 4: static code analysis ("Inspector") on every archive that is still downloadable.
 * Archives are fetched into memory, scanned by src/server/capabilities/pkgguard/inspect.ts, and dropped. Nothing is
 * written to disk, extracted, installed, imported or executed. Only rule hits (rule id, file, line) are stored.
 *
 * Sets:
 *   npm malicious: every record of the step-2 replay whose malicious version still has a tarball on npm
 *   pypi malicious: PyPI MAL records whose project still has a release file listed by OSV as malicious (checked live)
 *   npm controls: 500 popular, 400 long-tail, all fresh (latest version)
 *   pypi controls: well-known list, 400 random (latest release; sdist preferred, because setup.py is where install-time
 *                  code lives and where false alarms happen)
 * Usage: npx tsx bench/pkgguard/04-code.ts
 */
import { inspectArchive, INSPECT_RULES_VERSION } from '../../src/server/capabilities/pkgguard/inspect.js';
import { getBytes, getCached, pool, readJsonl, writeJsonl, days } from './lib.js';
import { pypiMeta } from './pypidoc.js';
import type { MalRecord } from './01-malicious.js';

const CAP = 30 * 1024 * 1024;
const scan = async (eco: 'npm' | 'pypi', url: string | null) => {
  if (!url) return { scanned: false, reason: 'no archive' };
  const b = await getBytes(url, CAP);
  if (!b.buf) return { scanned: false, reason: b.error ?? `http ${b.status}` };
  const res = inspectArchive(eco, b.buf);
  const { version: rules, ...rest } = res;
  return { scanned: true, archiveBytes: b.buf.length, rulesVersion: rules, ...rest };
};

const npmMal = readJsonl<any>('npm-malicious-meta.jsonl').filter((r) => r.liveTarball);
const npmCtl = readJsonl<any>('npm-controls.jsonl').filter((r) => r.status === 200);
const fresh = npmCtl.filter((r) => r.group === 'fresh-candidate' && r.atSnapshot?.firstPublished && days(r.atSnapshot.firstPublished, r.atSnapshot.asOf) < 30);
const npmSets = [
  ...npmMal.map((r) => ({ ...r, label: 'malicious', group: 'malicious', url: r.liveTarball })),
  ...npmCtl.filter((r) => r.group === 'popular').slice(0, 500).map((r) => ({ ...r, label: 'benign', url: r.tarball })),
  ...npmCtl.filter((r) => r.group === 'longtail').slice(0, 400).map((r) => ({ ...r, label: 'benign', url: r.tarball })),
  ...fresh.map((r) => ({ ...r, label: 'benign', group: 'fresh', url: r.tarball })),
];
const npmOut = await pool(npmSets, 8, async (r) => ({ eco: 'npm', name: r.name, id: r.id ?? null, label: r.label, group: r.group, split: r.split, pkgVersion: r.liveMalVersion ?? r.latest ?? null, ...(await scan('npm', r.url)) }), 'npm-code');

// PyPI malicious: check which reported projects are still on PyPI with a file of a malicious version.
const pyMal = readJsonl<MalRecord>('malicious-pypi.jsonl');
const pyLive = (await pool(pyMal, 12, async (m) => {
  const f = await getCached(`https://pypi.org/pypi/${encodeURIComponent(m.name)}/json`);
  if (!f.body) return null;
  const d = JSON.parse(f.body);
  // A project re-registered after the report (by a new owner) is not the reported artifact: require that the files
  // were uploaded before the report time.
  const before = (v: string) => (d.releases[v] ?? []).some((f: any) => Date.parse(f.upload_time_iso_8601) <= Date.parse(m.reportedAt));
  const vs = (m.versions.length ? m.versions : Object.keys(d.releases)).filter((v) => d.releases[v]?.length && before(v));
  const files: any[] = vs.flatMap((v) => d.releases[v] ?? []);
  const pick = files.find((x) => x.packagetype === 'sdist') ?? files[0];
  return pick ? { ...m, url: pick.url as string, version: vs[vs.length - 1], atReport: pypiMeta(d, m.name, m.reportedAt) } : null;
}, 'pypi-mal-live')).filter((x): x is NonNullable<typeof x> => !!x);
const pyCtl = readJsonl<any>('pypi-controls.jsonl').filter((r) => r.status === 200);
const pySets = [
  ...pyLive.map((r) => ({ name: r.name, id: r.id, split: r.split, label: 'malicious', group: 'malicious', url: r.url, version: r.version, atReport: r.atReport })),
  ...pyCtl.filter((r) => r.group === 'popular').map((r) => ({ ...r, label: 'benign', url: r.archive, version: r.atSnapshot?.version })),
  ...pyCtl.filter((r) => r.group === 'random').slice(0, 400).map((r) => ({ ...r, label: 'benign', url: r.archive, version: r.atSnapshot?.version })),
];
const pyOut = await pool(pySets, 8, async (r: any) => ({ eco: 'pypi', name: r.name, id: r.id ?? null, label: r.label, group: r.group, split: r.split, pkgVersion: r.version ?? null, atReport: r.atReport ?? null, ...(await scan('pypi', r.url)) }), 'pypi-code');

writeJsonl('code-scan.jsonl', [...npmOut, ...pyOut]);
void INSPECT_RULES_VERSION;
const s = (xs: any[]) => ({ total: xs.length, scanned: xs.filter((x) => x.scanned).length });
console.log(JSON.stringify({ rules: INSPECT_RULES_VERSION, npmMalicious: s(npmOut.filter((x) => x.label === 'malicious')), npmBenign: s(npmOut.filter((x) => x.label === 'benign')), pypiMaliciousLive: pyLive.length, pypiMalicious: s(pyOut.filter((x) => x.label === 'malicious')), pypiBenign: s(pyOut.filter((x) => x.label === 'benign')) }));
