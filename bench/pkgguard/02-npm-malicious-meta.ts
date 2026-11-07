/**
 * Step 2: replay registry metadata for the stratified npm malicious sample.
 * For each record we fetch the CURRENT npm document (live, security placeholder, unpublished, or 404) and rebuild the
 * snapshot an installer would have seen at two moments:
 *   atPublish: the moment the first malicious version appeared (the earliest anyone could install it)
 *   atReport:  the moment the first source reported it (the latest an install could still be a "zero-day" install)
 * Writes data/npm-malicious-meta.jsonl. No archive is downloaded here.
 */
import { docStatus, metaAt, takedownTime, versionTimes, type NpmDoc } from './npmdoc.js';
import { getCached, npmDocUrl, pool, readJsonl, writeJsonl } from './lib.js';
import type { MalRecord } from './01-malicious.js';

const recs = readJsonl<MalRecord>('malicious-npm-sample.jsonl');
const rows = await pool(recs, 16, async (m) => {
  const f = await getCached(npmDocUrl(m.name), { maxBytes: 64 * 1024 * 1024 });
  const base = { id: m.id, name: m.name, split: m.split, reportedAt: m.reportedAt, sources: m.sources, fetchedAt: f.fetchedAt, httpStatus: f.status };
  if (f.status !== 200 || !f.body) return { ...base, status: f.status === 404 ? 'gone' : 'error' };
  const doc = JSON.parse(f.body) as NpmDoc;
  const vt = versionTimes(doc);
  const malVersions = m.allVersions ? vt.map(([v]) => v) : vt.map(([v]) => v).filter((v) => m.versions.includes(v));
  const malTimes = vt.filter(([v]) => malVersions.includes(v));
  if (malTimes.length === 0) return { ...base, status: docStatus(doc), placed: false, versionsInDoc: vt.length };
  const [firstMalVersion, tMal] = malTimes[0];
  const liveMal = malVersions.filter((v) => doc.versions?.[v]?.dist?.tarball);
  return {
    ...base, status: docStatus(doc), placed: true,
    firstMalVersion, tMal, takedownAt: takedownTime(doc),
    priorVersions: vt.filter(([, t]) => Date.parse(t) < Date.parse(tMal)).length,
    atPublish: metaAt(doc, m.name, tMal, firstMalVersion),
    atReport: metaAt(doc, m.name, m.reportedAt < tMal ? tMal : m.reportedAt),
    // 11 evenly spaced install moments across the live window [first malicious publish, takedown] (still-live: until the
    // snapshot). Each moment installs the newest malicious version published by then.
    windowEnd: takedownTime(doc) ?? (docStatus(doc) === 'live' ? f.fetchedAt : m.reportedAt),
    window: Array.from({ length: 11 }, (_, k) => {
      const end = Date.parse(takedownTime(doc) ?? (docStatus(doc) === 'live' ? f.fetchedAt : m.reportedAt));
      const t = new Date(Date.parse(tMal) + (Math.max(end, Date.parse(tMal)) - Date.parse(tMal)) * (k / 10)).toISOString();
      const v = malTimes.filter(([, tv]) => Date.parse(tv) <= Date.parse(t) + 1000).pop()?.[0] ?? firstMalVersion;
      return metaAt(doc, m.name, t, v);
    }),
    liveMalVersion: liveMal.length ? liveMal[liveMal.length - 1] : null,
    liveTarball: liveMal.length ? doc.versions![liveMal[liveMal.length - 1]].dist.tarball : null,
  };
}, 'npm-mal-meta');
writeJsonl('npm-malicious-meta.jsonl', rows);
const c = (k: string) => rows.filter((r: any) => r.status === k).length;
console.log(JSON.stringify({ total: rows.length, live: c('live'), placeholder: c('placeholder'), unpublished: c('unpublished'), gone: c('gone'), error: c('error'), placed: rows.filter((r: any) => r.placed).length, withLiveTarball: rows.filter((r: any) => r.liveTarball).length }));
