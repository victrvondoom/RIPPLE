/**
 * Step 3: legitimate-package controls (negative set) and the popular-name reference lists.
 *
 * npm: the registry search API (registry.npmjs.org/-/v1/search) returns real weekly downloads. We crawl it with a fixed
 * list of generic query terms (lists/npm-query-terms.txt), 4 pages of 250 each, then one page for each name stem of the
 * 1,000 most-downloaded names found (pass 2), and keep the union.
 *   - reference list: the 2,000 names with the most weekly downloads in the union (used by the lookalike rule)
 *   - popular control: the top 1,000 (what developers install most; an install-weighted proxy)
 *   - long-tail control: 1,200 seeded-random names outside the top 5,000
 * *   - fresh control: names first published < 30 days before the snapshot, from up to 3,000 crawled names whose latest release is < 30 days old
 *   - name-only control: every crawled name outside the reference list
 * PyPI: no download statistics source was reachable, so
 *   - reference list + popular control: the authored list lists/pypi-wellknown-authored.txt, existence-checked
 *   - random control: 1,500 seeded-random names from the full simple index (pypi.org/simple/)
 *   - fresh control: the random names whose first upload is < 30 days before the snapshot (plus 1,500 extra drawn from
 *     the 20,000 highest-serial projects, i.e. most recently changed, to get enough fresh packages)
 *   - name-only control: 50,000 seeded-random names from the simple index
 * Any name that appears in the OSV malicious data (all 222,871 npm / 11,971 PyPI names) is excluded from every control.
 * A control package is "legitimate" only in the sense "not reported malicious as of the OSV snapshot".
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipEntries } from '../../src/server/capabilities/pkgguard/archive.js';
import { metaAt, type NpmDoc } from './npmdoc.js';
import { pypiMeta } from './pypidoc.js';
import { CACHE, DATA, ROOT, getCached, npmDocUrl, pool, readJsonl, rng, sample, split, writeJsonl } from './lib.js';
import type { MalRecord } from './01-malicious.js';

const SEED = 7112026;
const r = rng(SEED);
const lines = (f: string) => readFileSync(join(ROOT, 'lists', f), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));

// ---- all malicious names (exclusion set), read straight from the OSV archives ----
/** Every name in a non-withdrawn malicious report (`all`), and the subset reported as malicious in EVERY version
 *  (`whole`). A name with only specific hijacked versions (chalk 5.6.1, debug 4.4.2, axios 1.14.1) is still the real
 *  package: it stays in the popular-name reference list but is excluded from the legitimate controls. */
function malNames(eco: 'npm' | 'PyPI'): Set<string> & { whole: Set<string> } {
  const s = new Set<string>() as Set<string> & { whole: Set<string> }; s.whole = new Set<string>();
  for (const e of zipEntries(readFileSync(join(CACHE, `osv-${eco}-all.zip`)), { maxEntries: 1_000_000, maxEntryBytes: 16 * 1024 * 1024, maxUnpackedBytes: Number.MAX_SAFE_INTEGER })) {
    if ('skipped' in e || !e.path.startsWith('MAL-')) continue;
    const d = JSON.parse(e.data.toString('utf8'));
    if (d.withdrawn) continue; // session 19 fix: a withdrawn report (e.g. MAL-2024-2929 for react) is not a malicious label
    for (const a of d.affected ?? []) {
      if (!a.package?.name) continue;
      const n = eco === 'npm' ? String(a.package.name).toLowerCase() : String(a.package.name).toLowerCase().replace(/[-_.]+/g, '-');
      s.add(n);
      const bounded = (a.versions ?? []).length > 0 || (a.ranges ?? []).some((r: any) => (r.events ?? []).some((ev: any) => ev.fixed || ev.last_affected || (ev.introduced && ev.introduced !== '0')));
      if (!bounded) s.whole.add(n);
    }
  }
  return s;
}
const malNpm = malNames('npm'); const malPy = malNames('PyPI');
void readJsonl<MalRecord>;

// ---------------- npm ----------------
const terms = lines('npm-query-terms.txt');
const crawl = new Map<string, { weekly: number; date: string }>();
const search = async ({ t, from }: { t: string; from: number }) => {
  const f = await getCached(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(t)}&size=250&from=${from}`);
  if (!f.body) return;
  for (const o of (JSON.parse(f.body).objects ?? []) as any[]) {
    const n = String(o.package.name).toLowerCase();
    crawl.set(n, { weekly: Number(o.downloads?.weekly ?? 0), date: String(o.package.date ?? '') });
  }
};
await pool(terms.flatMap((t) => [0, 250, 500, 750].map((from) => ({ t, from }))), 6, search, 'npm-search');
// Pass 2 (session 19 fix): query the name stems of the 1,000 most-downloaded names found so far (lodash.merge -> lodash,
// @babel/core -> babel). The authored terms missed lodash (204M weekly downloads); stems come from the data itself.
// Repeat until the top 2,000 yields no new stem (at most 4 rounds).
const queried = new Set(terms); const stems: string[] = [];
for (let round = 0; round < 4; round++) {
  const fresh = [...new Set([...crawl.entries()].filter(([n]) => !malNpm.whole.has(n)).sort((a, b) => b[1].weekly - a[1].weekly).slice(0, 2000)
    .map(([n]) => n.replace(/^@/, '').split(/[/.\-_]/)[0]).filter((s) => s.length >= 3 && !queried.has(s)))];
  if (!fresh.length) break;
  fresh.forEach((s) => queried.add(s)); stems.push(...fresh);
  await pool(fresh.map((t) => ({ t, from: 0 })), 6, search, `npm-search-stems-${round + 1}`);
}
const ranked = [...crawl.entries()].filter(([n]) => !malNpm.has(n)).sort((a, b) => b[1].weekly - a[1].weekly);
const refRanked = [...crawl.entries()].filter(([n]) => !malNpm.whole.has(n)).sort((a, b) => b[1].weekly - a[1].weekly);
writeJsonl('npm-reference.jsonl', refRanked.slice(0, 2000).map(([name, v], i) => ({ rank: i + 1, name, weekly: v.weekly, versionSpecificReport: malNpm.has(name) })));
const popular = ranked.slice(0, 1000);
const tail = sample(ranked.slice(5000), 1200, r);
const recent = ranked.slice(5000).filter(([, v]) => v.date && Date.now() - Date.parse(v.date) < 30 * 86400000);
const freshCandidates = sample(recent.filter(([n]) => !tail.some(([t]) => t === n)), 3000, r);
const refSet = new Set(refRanked.slice(0, 2000).map(([n]) => n));
writeJsonl('npm-names-control.jsonl', ranked.filter(([n]) => !refSet.has(n)).map(([name, v]) => ({ name, weekly: v.weekly, split: split('npm', name) })));

async function npmControl(set: [string, { weekly: number }][], group: string) {
  return pool(set, 12, async ([name, v]) => {
    const f = await getCached(npmDocUrl(name), { maxBytes: 64 * 1024 * 1024 });
    if (!f.body) return { name, group, status: f.status, error: f.error ?? null };
    const doc = JSON.parse(f.body) as NpmDoc;
    const latest = doc['dist-tags']?.latest;
    const now = metaAt(doc, name, f.fetchedAt, latest, v.weekly);
    const latestTime = latest ? doc.time?.[latest] : null;
    return {
      name, group, status: 200, split: split('npm', name), weekly: v.weekly, latest: latest ?? null,
      tarball: latest ? doc.versions?.[latest]?.dist?.tarball ?? null : null,
      atSnapshot: now,
      atLatestRelease: latestTime ? metaAt(doc, name, latestTime, latest, null) : null,
    };
  }, `npm-${group}`);
}
const npmRows = [...await npmControl(popular, 'popular'), ...await npmControl(tail, 'longtail'), ...await npmControl(freshCandidates, 'fresh-candidate')];
writeJsonl('npm-controls.jsonl', npmRows);

// ---------------- PyPI ----------------
const simple = await getCached('https://pypi.org/simple/', { accept: 'application/vnd.pypi.simple.v1+json', timeoutMs: 300000 });
const projects = (JSON.parse(simple.body!).projects as { name: string; '_last-serial': number }[])
  .map((p) => ({ name: p.name.toLowerCase().replace(/[-_.]+/g, '-'), serial: p['_last-serial'] }))
  .filter((p) => !malPy.has(p.name));
const wellKnown = lines('pypi-wellknown-authored.txt').map((n) => n.toLowerCase().replace(/[-_.]+/g, '-'));
const pyRandom = sample(projects, 1500, r);
const bySerial = projects.slice().sort((a, b) => b.serial - a.serial).slice(0, 20000);
const pyRecent = sample(bySerial, 1500, r);
writeJsonl('pypi-names-control.jsonl', sample(projects.filter((p) => !wellKnown.includes(p.name)), 50000, r).map((p) => ({ name: p.name, split: split('pypi', p.name) })));

async function pyControl(names: string[], group: string) {
  return pool(names, 12, async (name) => {
    const f = await getCached(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { maxBytes: 64 * 1024 * 1024 });
    if (!f.body) return { name, group, status: f.status };
    const d = JSON.parse(f.body);
    const m = pypiMeta(d, name, f.fetchedAt);
    const files: any[] = d.urls ?? [];
    const pick = files.find((x) => x.packagetype === 'sdist') ?? files.find((x) => x.packagetype === 'bdist_wheel');
    return { name, group, status: 200, split: split('pypi', name), atSnapshot: m, archive: pick?.url ?? null, archiveKind: pick?.packagetype ?? null, archiveBytes: pick?.size ?? null };
  }, `pypi-${group}`);
}
const pyRows = [...await pyControl(wellKnown, 'popular'), ...await pyControl(pyRandom.map((p) => p.name), 'random'), ...await pyControl(pyRecent.map((p) => p.name), 'recent-serial')];
writeJsonl('pypi-controls.jsonl', pyRows);
const ok = (rows: any[], g: string) => rows.filter((x) => x.group === g && x.status === 200).length;
const provenance = { collectedAt: new Date().toISOString(), seed: SEED, npmQueryTerms: terms.length, npmStemQueries: stems.length, npmCrawled: crawl.size, npmMalExcluded: crawl.size - ranked.length, npmNameControls: ranked.filter(([n]) => !refSet.has(n)).length, npmPopular: ok(npmRows, 'popular'), npmLongtail: ok(npmRows, 'longtail'), npmFreshCandidates: ok(npmRows, 'fresh-candidate'), pypiProjects: projects.length, pypiWellKnown: ok(pyRows, 'popular'), pypiRandom: ok(pyRows, 'random'), pypiRecent: ok(pyRows, 'recent-serial') };
writeFileSync(join(DATA, 'controls-provenance.json'), JSON.stringify(provenance, null, 1));
console.log(JSON.stringify(provenance));
