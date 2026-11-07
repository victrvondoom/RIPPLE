/**
 * Step 2b: weekly downloads for malicious npm packages that are STILL live, from the registry search API (the only
 * download source reachable from the benchmark sandbox; api.npmjs.org was refused by the network policy).
 * These are downloads at the snapshot, not at the install moment: removed packages have no recoverable download history
 * here, so download-based detection is reported only for this live subset and labelled as such.
 */
import { getCached, pool, readJsonl, writeJsonl } from './lib.js';

const rows = readJsonl<any>('npm-malicious-meta.jsonl').filter((r) => r.status === 'live');
const out = await pool(rows, 6, async (r) => {
  const f = await getCached(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(r.name)}&size=20`);
  const hit = f.body ? (JSON.parse(f.body).objects ?? []).find((o: any) => String(o.package.name).toLowerCase() === r.name) : null;
  return { name: r.name, id: r.id, weekly: hit ? Number(hit.downloads?.weekly ?? 0) : null, foundInSearch: !!hit, fetchedAt: f.fetchedAt };
}, 'npm-mal-downloads');
writeJsonl('npm-malicious-downloads.jsonl', out);
console.log(JSON.stringify({ live: rows.length, foundInSearch: out.filter((x) => x.foundInSearch).length }));
