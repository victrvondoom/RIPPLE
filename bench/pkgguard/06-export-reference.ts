/** Step 6: export the reference lists the product uses (src/server/capabilities/pkgguard/reference-lists.json). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, ROOT, readJsonl } from './lib.js';

const npm = readJsonl<{ name: string }>('npm-reference.jsonl').map((r) => r.name);
const authored = readFileSync(join(ROOT, 'lists', 'pypi-wellknown-authored.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).map((n) => n.toLowerCase().replace(/[-_.]+/g, '-'));
const live = new Set(readJsonl<any>('pypi-controls.jsonl').filter((r) => r.group === 'popular' && r.status === 200).map((r) => r.name));
const pypi = authored.filter((n) => live.has(n));
const prov = JSON.parse(readFileSync(join(DATA, 'osv-provenance.json'), 'utf8'));
const ctl = JSON.parse(readFileSync(join(DATA, 'controls-provenance.json'), 'utf8'));
writeFileSync(join(ROOT, '..', '..', 'src', 'server', 'capabilities', 'pkgguard', 'reference-lists.json'), JSON.stringify({
  provenance: { npm: `top 2,000 by weekly downloads in the bench/pkgguard npm search crawl (${ctl.collectedAt.slice(0, 10)}: ${ctl.npmQueryTerms} terms + ${ctl.npmStemQueries} name-stem queries); names reported malicious in every version removed, names with only specific hijacked versions kept`, pypi: `authored well-known list (bench/pkgguard/lists), ${pypi.length} names existence-checked on PyPI 2026-11-07`, osvSnapshot: prov.npm.lastModified },
  npm, pypi,
}));
console.log({ npm: npm.length, pypi: pypi.length });
