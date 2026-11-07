/**
 * Step 1: the malicious ground truth. Source: the OSV bulk export of the OpenSSF malicious-packages database
 * (gs://osv-vulnerabilities/{npm,PyPI}/all.zip, MAL-* records). It is independent of RIPPLE: reports come from
 * GitHub Advisory malware, Amazon Inspector, ReversingLabs, Checkmarx, OpenSSF package-analysis, kam193 and others.
 * Withdrawn records are dropped. Writes:
 *   data/osv-provenance.json        archive hashes, Last-Modified and download time
 *   data/malicious-pypi.jsonl       every PyPI MAL record (name level)
 *   data/malicious-npm-names.jsonl  a seeded 20,000-record sample of npm MAL records (name level)
 *   data/malicious-npm-sample.jsonl a seeded year-stratified sample for the registry-metadata replay (step 2)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipEntries } from '../../src/server/capabilities/pkgguard/archive.js';
import { CACHE, DATA, rng, sample, sha256, split, writeJsonl } from './lib.js';

const SEED = 20261107;
const PER_YEAR = 600; // npm metadata replay sample per report year

export interface MalRecord {
  id: string; eco: 'npm' | 'pypi'; name: string; published: string; reportedAt: string;
  versions: string[]; ranges: { introduced: string; fixed?: string; lastAffected?: string }[]; allVersions: boolean; sources: string[]; split: 'tune' | 'heldout';
}

async function load(eco: 'npm' | 'PyPI') {
  const file = join(CACHE, `osv-${eco}-all.zip`);
  const url = `https://storage.googleapis.com/osv-vulnerabilities/${eco}/all.zip`;
  let lastModified = 'cached';
  if (!existsSync(file)) {
    const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`);
    lastModified = r.headers.get('last-modified') ?? 'unknown';
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    writeFileSync(file + '.meta.json', JSON.stringify({ url, lastModified, downloadedAt: new Date().toISOString() }));
  }
  const buf = readFileSync(file);
  const meta = JSON.parse(readFileSync(file + '.meta.json', 'utf8')) as { url: string; lastModified: string; downloadedAt: string };
  void lastModified;
  const recs: MalRecord[] = []; let withdrawn = 0; let total = 0;
  for (const e of zipEntries(buf, { maxEntries: 1_000_000, maxEntryBytes: 16 * 1024 * 1024, maxUnpackedBytes: Number.MAX_SAFE_INTEGER })) {
    if ('skipped' in e || !e.path.startsWith('MAL-')) continue;
    total++;
    const d = JSON.parse(e.data.toString('utf8'));
    if (d.withdrawn) { withdrawn++; continue; }
    const aff = (d.affected ?? []).find((a: any) => a.package?.ecosystem === eco) ?? d.affected?.[0];
    if (!aff) continue;
    const origins: any[] = d.database_specific?.['malicious-packages-origins'] ?? [];
    const times = [d.published, ...origins.map((o) => o.modified_time)].filter(Boolean).map((t: string) => Date.parse(t)).filter((t) => !Number.isNaN(t) && t > Date.parse('2010-01-01'));
    const versions: string[] = aff.versions ?? [];
    // OSV ranges: [introduced, fixed) or [introduced, last_affected]. "All versions" only when every range starts at 0 and
    // never ends (session-18 fix: a bounded range with no explicit version list used to be read as "all versions").
    const ranges: { introduced: string; fixed?: string; lastAffected?: string }[] = [];
    for (const rg of aff.ranges ?? []) { let cur: { introduced: string; fixed?: string; lastAffected?: string } | null = null; for (const ev of rg.events ?? []) { if (ev.introduced !== undefined) { cur = { introduced: String(ev.introduced) }; ranges.push(cur); } else if (cur && ev.fixed) cur.fixed = String(ev.fixed); else if (cur && ev.last_affected) cur.lastAffected = String(ev.last_affected); } }
    const allVersions = ranges.length > 0 && ranges.every((x) => x.introduced === '0' && !x.fixed && !x.lastAffected);
    const ecoKey = eco === 'npm' ? 'npm' : 'pypi';
    const name = eco === 'npm' ? String(aff.package.name).toLowerCase() : String(aff.package.name).toLowerCase().replace(/[-_.]+/g, '-');
    recs.push({ id: d.id, eco: ecoKey, name, published: d.published, reportedAt: new Date(Math.min(...times)).toISOString(), versions, ranges, allVersions: allVersions || (versions.length === 0 && ranges.length === 0), sources: [...new Set(origins.map((o) => String(o.source)))], split: split(ecoKey, name) });
  }
  return { recs, provenance: { ...meta, sha256: sha256(buf), bytes: buf.length, malRecords: total, withdrawn, kept: recs.length } };
}

const npm = await load('npm');
const pypi = await load('PyPI');
writeFileSync(join(DATA, 'osv-provenance.json'), JSON.stringify({ npm: npm.provenance, pypi: pypi.provenance, seed: SEED, perYear: PER_YEAR }, null, 1));
writeJsonl('malicious-pypi.jsonl', pypi.recs);
const r = rng(SEED);
// One record per package name (a name can have several MAL reports).
const uniq = (rs: MalRecord[]) => [...new Map(rs.map((x) => [x.name, x])).values()];
const npmU = uniq(npm.recs);
writeJsonl('malicious-npm-names.jsonl', sample(npmU, 20000, r));
const byYear = new Map<string, MalRecord[]>();
for (const x of npmU) { const y = x.reportedAt.slice(0, 4); byYear.set(y, [...(byYear.get(y) ?? []), x]); }
const strat: MalRecord[] = [];
for (const [y, xs] of [...byYear.entries()].sort()) if (Number(y) >= 2022) strat.push(...sample(xs, PER_YEAR, r));
writeJsonl('malicious-npm-sample.jsonl', strat);
console.log(JSON.stringify({ npm: npm.provenance, pypi: pypi.provenance, npmUniqueNames: npmU.length, pypiUniqueNames: uniq(pypi.recs).length, stratified: strat.length, years: Object.fromEntries([...byYear].map(([y, v]) => [y, v.length])) }, null, 1));
