/**
 * Step 5: compute every number in the report from the data files. No network. Writes results/metrics.json and
 * results/tables.md. Usage: npx tsx bench/pkgguard/05-evaluate.ts [tune|heldout|all]   (default heldout)
 * Every metric carries its n and a Wilson 95% interval; precision is reported at the evaluated class mix only.
 */
import { metadataVerdict, META_RULES, type PkgMeta } from '../../src/server/capabilities/pkgguard/metadata.js';
import { NameIndex, NAME_RULES, STRONG_SQUAT } from '../../src/server/capabilities/pkgguard/names.js';
import { INSPECT_RULES_VERSION, INSPECT_THRESHOLDS } from '../../src/server/capabilities/pkgguard/inspect.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, ROOT, days, readJsonl, writeResult } from './lib.js';

const SPLIT = (process.argv[2] ?? 'heldout') as 'tune' | 'heldout' | 'all';
const inSplit = (r: { split?: string }) => SPLIT === 'all' || r.split === SPLIT;

// ---------- metric helpers ----------
const wilson = (k: number, n: number) => {
  if (n === 0) return null; const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)].map((x) => Math.round(x * 1000) / 10);
};
const pct = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 10 : null);
function confusion(pos: boolean[], neg: boolean[]) {
  const TP = pos.filter(Boolean).length, FN = pos.length - TP, FP = neg.filter(Boolean).length, TN = neg.length - FP;
  const precision = TP + FP ? TP / (TP + FP) : null; const recall = pos.length ? TP / pos.length : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
  return { TP, FN, FP, TN, precision: r3(precision), recall: r3(recall), f1: r3(f1), fpr: r3(neg.length ? FP / neg.length : null), fnr: r3(pos.length ? FN / pos.length : null), recallCI95: wilson(TP, pos.length), fprCI95: wilson(FP, neg.length) };
}
const rate = (xs: boolean[]) => ({ n: xs.length, hits: xs.filter(Boolean).length, pct: pct(xs.filter(Boolean).length, xs.length), ci95: wilson(xs.filter(Boolean).length, xs.length) });

// ---------- reference lists ----------
const npmRef = readJsonl<{ name: string }>('npm-reference.jsonl').map((r) => r.name);
const pyRef = readFileSync(join(ROOT, 'lists', 'pypi-wellknown-authored.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const pyCtlAll = readJsonl<any>('pypi-controls.jsonl');
const pyRefLive = pyRef.map((n) => n.toLowerCase().replace(/[-_.]+/g, '-')).filter((n) => pyCtlAll.some((c) => c.group === 'popular' && c.name === n && c.status === 200));
const ix = { npm: new NameIndex('npm', npmRef), pypi: new NameIndex('pypi', pyRefLive) };

const M: Record<string, any> = { split: SPLIT, generatedAt: new Date().toISOString(), rules: { META_RULES, NAME_RULES, INSPECT_RULES_VERSION, INSPECT_THRESHOLDS, referenceSizes: { npm: ix.npm.size(), pypi: ix.pypi.size() } } };

// ---------- E1: name-only lookalike detection ----------
function nameExperiment(eco: 'npm' | 'pypi', mal: { name: string; split: string }[], ctl: { name: string; split: string }[]) {
  const i = ix[eco];
  const malS = mal.filter(inSplit).filter((m) => !i.has(m.name)); // a compromised popular package cannot be a lookalike of itself
  const ctlS = ctl.filter(inSplit).filter((c) => !i.has(c.name));
  const mh = malS.map((m) => i.check(m.name)); const ch = ctlS.map((c) => i.check(c.name));
  const strong = (h: ReturnType<NameIndex['check']>) => h.some((x) => STRONG_SQUAT.includes(x.kind));
  const combo = (h: ReturnType<NameIndex['check']>) => h.some((x) => x.kind === 'combosquat');
  const byKind: Record<string, { malicious: number; control: number }> = {};
  for (const [hs, key] of [[mh, 'malicious'], [ch, 'control']] as const) for (const h of hs) for (const k of new Set(h.map((x) => x.kind))) { byKind[k] ??= { malicious: 0, control: 0 }; byKind[k][key]++; }
  const targets = new Map<string, number>(); mh.forEach((h) => h.filter((x) => STRONG_SQUAT.includes(x.kind)).forEach((x) => targets.set(x.target, (targets.get(x.target) ?? 0) + 1)));
  return {
    malicious: malS.length, controls: ctlS.length, excludedBecauseInReference: mal.filter(inSplit).length - malS.length,
    lookalike: confusion(mh.map(strong), ch.map(strong)),
    combosquat: confusion(mh.map(combo), ch.map(combo)),
    lookalikeOrCombo: confusion(mh.map((h) => strong(h) || combo(h)), ch.map((h) => strong(h) || combo(h))),
    byKind, topTargets: [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    controlFalseAlarmExamples: ctlS.map((c, k) => (strong(ch[k]) ? `${c.name} ~ ${ch[k][0].target} (${ch[k][0].kind})` : null)).filter(Boolean).slice(0, 20),
  };
}
const malNpmNames = readJsonl<any>('malicious-npm-names.jsonl');
const malPy = readJsonl<any>('malicious-pypi.jsonl');
const uniqPy = [...new Map(malPy.map((m) => [m.name, m])).values()];
M.E1_names = {
  npm: nameExperiment('npm', malNpmNames, readJsonl<any>('npm-names-control.jsonl')),
  pypi: nameExperiment('pypi', uniqPy, readJsonl<any>('pypi-names-control.jsonl')),
};

// ---------- E2: npm metadata replay ----------
const npmMal = readJsonl<any>('npm-malicious-meta.jsonl');
const placed = npmMal.filter((r) => r.placed).filter(inSplit);
const npmCtl = readJsonl<any>('npm-controls.jsonl').filter((r) => r.status === 200).filter(inSplit);
const fresh = npmCtl.filter((r) => r.group === 'fresh-candidate' && r.atSnapshot.firstPublished && days(r.atSnapshot.firstPublished, r.atSnapshot.asOf) < 30).map((r) => ({ ...r, group: 'fresh' }));
const ctlGroups: Record<string, any[]> = { popular: npmCtl.filter((r) => r.group === 'popular'), longtail: npmCtl.filter((r) => r.group === 'longtail'), fresh };
const V = (m: PkgMeta, eco: 'npm' | 'pypi') => metadataVerdict(m, ix[eco]);
const signalTable = (rows: PkgMeta[], eco: 'npm' | 'pypi') => {
  const vs = rows.map((m) => V(m, eco)); const keys = Object.keys(vs[0]?.signals ?? {});
  return Object.fromEntries(keys.map((k) => { const known = vs.filter((v) => v.signals[k] !== 'unknown'); return [k, { known: known.length, hit: known.filter((v) => v.signals[k] === 'hit').length, pct: pct(known.filter((v) => v.signals[k] === 'hit').length, known.length) }]; }).concat([['COMPOSITE', { known: vs.length, hit: vs.filter((v) => v.flagged).length, pct: pct(vs.filter((v) => v.flagged).length, vs.length) }]]));
};
const malAtPub = placed.map((r) => r.atPublish as PkgMeta); const malAtRep = placed.map((r) => r.atReport as PkgMeta);
const ctlSnap = Object.fromEntries(Object.entries(ctlGroups).map(([g, rs]) => [g, rs.map((r) => r.atSnapshot as PkgMeta)]));
const ctlAtLatest = Object.fromEntries(Object.entries(ctlGroups).map(([g, rs]) => [g, rs.filter((r) => r.atLatestRelease).map((r) => r.atLatestRelease as PkgMeta)]));
const flagged = (ms: PkgMeta[], eco: 'npm' | 'pypi' = 'npm') => ms.map((m) => V(m, eco).flagged);
const ageBucket = (d: number | null) => (d === null ? 'unknown' : d < 1 ? '<1 day' : d < 7 ? '1-7 days' : d < 30 ? '7-30 days' : d < 365 ? '30-365 days' : '>1 year');
const verBucket = (n: number | null) => (n === null ? 'unknown' : n === 1 ? '1' : n === 2 ? '2' : n <= 5 ? '3-5' : n <= 20 ? '6-20' : '>20');
const byBucket = (rows: PkgMeta[], f: (m: PkgMeta) => string) => {
  const out: Record<string, { n: number; flagged: number; pct: number | null }> = {};
  for (const m of rows) { const b = f(m); out[b] ??= { n: 0, flagged: 0, pct: null }; out[b].n++; if (V(m, 'npm').flagged) out[b].flagged++; }
  for (const b of Object.values(out)) b.pct = pct(b.flagged, b.n);
  return out;
};
const ageOf = (m: PkgMeta) => (m.firstPublished ? days(m.firstPublished, m.asOf) : null);
const yearOf = (r: any) => String(r.reportedAt).slice(0, 4);
const median = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(s.length / 2)] * 10) / 10 : null; };
const quant = (xs: number[], q: number) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10 : null; };
const takedown = placed.filter((r) => r.takedownAt).map((r) => days(r.tMal, r.takedownAt));
const reportLag = placed.map((r) => days(r.tMal, r.reportedAt));
const allCtl = Object.values(ctlSnap).flat();
const downloads = readJsonl<any>('npm-malicious-downloads.jsonl');
const dlByName = new Map(downloads.map((d) => [d.name, d.weekly]));
const dlBucket = (w: number | null | undefined) => (w === null || w === undefined ? 'unknown' : w < 10 ? '<10' : w < 50 ? '10-49' : w < 500 ? '50-499' : w < 5000 ? '500-4,999' : '>=5,000');
const dlTable = (pairs: { w: number | null | undefined; f: boolean }[]) => { const o: Record<string, { n: number; flagged: number; pct: number | null }> = {}; for (const p of pairs) { const b = dlBucket(p.w); o[b] ??= { n: 0, flagged: 0, pct: null }; o[b].n++; if (p.f) o[b].flagged++; } for (const b of Object.values(o)) b.pct = pct(b.flagged, b.n); return o; };
M.E2_npm_metadata = {
  sample: { malicious: npmMal.filter(inSplit).length, placedWithTimestamps: placed.length, statusCounts: Object.fromEntries(['live', 'placeholder', 'unpublished', 'gone', 'error'].map((s) => [s, npmMal.filter(inSplit).filter((r) => r.status === s).length])), controls: Object.fromEntries(Object.entries(ctlGroups).map(([g, r]) => [g, r.length])) },
  signals: { maliciousAtPublish: signalTable(malAtPub, 'npm'), maliciousAtReport: signalTable(malAtRep, 'npm'), ...Object.fromEntries(Object.entries(ctlSnap).map(([g, ms]) => [`control_${g}`, signalTable(ms, 'npm')])) },
  confusion: {
    atPublish_vs_allControls: confusion(flagged(malAtPub), flagged(allCtl)),
    atReport_vs_allControls: confusion(flagged(malAtRep), flagged(allCtl)),
    ...Object.fromEntries(Object.entries(ctlSnap).map(([g, ms]) => [`atPublish_vs_${g}`, confusion(flagged(malAtPub), flagged(ms))])),
    ...Object.fromEntries(Object.entries(ctlAtLatest).map(([g, ms]) => [`atPublish_vs_${g}_atLatestRelease`, confusion(flagged(malAtPub), flagged(ms))])),
  },
  liveWindow: {
    note: 'Mean over 11 evenly spaced install moments from the first malicious publish to takedown (or the snapshot if still live).',
    meanDetection: pct(placed.reduce((a, r) => a + r.window.filter((m: PkgMeta) => V(m, 'npm').flagged).length / r.window.length, 0), placed.length),
    byMoment: Array.from({ length: 11 }, (_, k) => ({ fraction: k / 10, ...rate(placed.map((r) => V(r.window[k], 'npm').flagged)) })),
    windowDays: { median: median(placed.map((r) => days(r.tMal, r.windowEnd))), p75: quant(placed.map((r) => days(r.tMal, r.windowEnd)), 0.75), p90: quant(placed.map((r) => days(r.tMal, r.windowEnd)), 0.9) },
    confusion_midWindow_vs_allControls: confusion(placed.map((r) => V(r.window[5], 'npm').flagged), flagged(allCtl)),
  },
  detectionByAgeAtPublish: byBucket(malAtPub, (m) => ageBucket(ageOf(m))),
  controlFlagRateByAge: byBucket(allCtl, (m) => ageBucket(ageOf(m))),
  detectionByVersionsAtPublish: byBucket(malAtPub, (m) => verBucket(m.versionCount)),
  detectionByReportYear: Object.fromEntries([...new Set(placed.map(yearOf))].sort().map((y) => { const rs = placed.filter((r) => yearOf(r) === y); return [y, rate(rs.map((r) => V(r.atPublish, 'npm').flagged))]; })),
  newlyRegistered: {
    brandNewAtPublish: rate(placed.map((r) => r.priorVersions === 0)),
    brandNewDetected: rate(placed.filter((r) => r.priorVersions === 0).map((r) => V(r.atPublish, 'npm').flagged)),
    existingPackageGotMaliciousVersion: rate(placed.map((r) => r.priorVersions > 0)),
    existingDetected: rate(placed.filter((r) => r.priorVersions > 0).map((r) => V(r.atPublish, 'npm').flagged)),
    existingOlderThan1yWithPriorVersions: rate(placed.filter((r) => r.priorVersions > 0).map((r) => (ageOf(r.atPublish) ?? 0) > 365)),
  },
  timing: {
    daysPublishToReport: { n: reportLag.length, median: median(reportLag), p25: quant(reportLag, 0.25), p75: quant(reportLag, 0.75), p90: quant(reportLag, 0.9) },
    daysPublishToTakedown: { n: takedown.length, median: median(takedown), p25: quant(takedown, 0.25), p75: quant(takedown, 0.75), p90: quant(takedown, 0.9) },
    reportedBefore7Days: rate(reportLag.map((d) => d < 7)),
  },
  downloads: {
    note: 'Weekly downloads at the snapshot for malicious packages still live (search API). Removed packages: no recoverable history.',
    maliciousLive: dlTable(placed.filter((r) => r.status === 'live').map((r) => ({ w: dlByName.get(r.name), f: V(r.atPublish, 'npm').flagged }))),
    maliciousLiveLowDownloads: rate(placed.filter((r) => r.status === 'live' && dlByName.get(r.name) !== null && dlByName.get(r.name) !== undefined).map((r) => dlByName.get(r.name)! < META_RULES.lowWeeklyDownloads)),
    controls: Object.fromEntries(Object.entries(ctlGroups).map(([g, rs]) => [g, dlTable(rs.map((r) => ({ w: r.weekly, f: V(r.atSnapshot, 'npm').flagged })))])),
  },
  falseAlarmExamples: Object.fromEntries(Object.entries(ctlGroups).map(([g, rs]) => [g, rs.filter((r) => V(r.atSnapshot, 'npm').flagged).slice(0, 12).map((r) => `${r.name}: ${V(r.atSnapshot, 'npm').reasons.join('; ')}`)])),
  missedExamples: placed.filter((r) => !V(r.atPublish, 'npm').flagged).slice(0, 12).map((r) => `${r.name} (${r.id}): age ${Math.round(ageOf(r.atPublish) ?? -1)}d, ${r.atPublish.versionCount} versions, prior ${r.priorVersions}`),
};

// ---------- E2b: PyPI metadata (controls only + still-live malicious) ----------
const pyCtl = pyCtlAll.filter((r) => r.status === 200).filter(inSplit);
const pyFresh = pyCtl.filter((r) => (r.group === 'random' || r.group === 'recent-serial') && r.atSnapshot.firstPublished && days(r.atSnapshot.firstPublished, r.atSnapshot.asOf) < 30).map((r) => ({ ...r, group: 'fresh' }));
const pyGroups: Record<string, any[]> = { popular: pyCtl.filter((r) => r.group === 'popular'), random: pyCtl.filter((r) => r.group === 'random'), fresh: pyFresh };
const code = readJsonl<any>('code-scan.jsonl');
const pyMalLive = code.filter((c) => c.eco === 'pypi' && c.label === 'malicious' && c.atReport).filter(inSplit);
M.E2b_pypi_metadata = {
  note: 'PyPI deletes removed projects; registry metadata for removed malware is not recoverable. Only still-live reported projects can be replayed (at report time).',
  controls: Object.fromEntries(Object.entries(pyGroups).map(([g, rs]) => [g, signalTable(rs.map((r) => r.atSnapshot), 'pypi')])),
  maliciousStillLive: pyMalLive.length ? signalTable(pyMalLive.map((r) => r.atReport), 'pypi') : null,
  confusion_liveMalicious_vs_allControls: pyMalLive.length ? confusion(pyMalLive.map((r) => V(r.atReport, 'pypi').flagged), [...new Map(Object.values(pyGroups).flat().map((r) => [r.name, r])).values()].map((r) => V(r.atSnapshot, 'pypi').flagged)) : null, // deduplicated by name (fresh overlaps random)
};

// ---------- E3: code-only ----------
const codeS = code.filter(inSplit).filter((c) => c.scanned);
const codeFlag = (c: any, level: 'review' | 'malicious') => (level === 'review' ? c.verdict !== 'clean' : c.verdict === 'malicious-looking');
const codeGroups = (eco: string) => { const xs = codeS.filter((c) => c.eco === eco); return { malicious: xs.filter((c) => c.label === 'malicious'), ...Object.fromEntries([...new Set(xs.filter((c) => c.label === 'benign').map((c) => c.group))].map((g) => [g, xs.filter((c) => c.label === 'benign' && c.group === g)])) } as Record<string, any[]>; };
const ruleFreq = (xs: any[]) => { const m = new Map<string, number>(); xs.forEach((x) => new Set((x.hits ?? []).map((h: any) => h.rule)).forEach((r: any) => m.set(r, (m.get(r) ?? 0) + 1))); return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1])); };
const npmSrc = new Map(npmMal.map((r) => [r.name, r.sources as string[]])); const pySrc = new Map(malPy.map((r) => [r.name, r.sources as string[]]));
M.E3_code = Object.fromEntries(['npm', 'pypi'].map((eco) => {
  const g = codeGroups(eco); const benign = Object.entries(g).filter(([k]) => k !== 'malicious');
  return [eco, {
    attempted: code.filter(inSplit).filter((c) => c.eco === eco).length, scanned: codeS.filter((c) => c.eco === eco).length,
    sizes: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length])),
    atReview: { vsAllBenign: confusion(g.malicious.map((c) => codeFlag(c, 'review')), benign.flatMap(([, v]) => v).map((c) => codeFlag(c, 'review'))), ...Object.fromEntries(benign.map(([k, v]) => [`fpr_${k}`, rate(v.map((c) => codeFlag(c, 'review')))])) },
    atMalicious: { vsAllBenign: confusion(g.malicious.map((c) => codeFlag(c, 'malicious')), benign.flatMap(([, v]) => v).map((c) => codeFlag(c, 'malicious'))), ...Object.fromEntries(benign.map(([k, v]) => [`fpr_${k}`, rate(v.map((c) => codeFlag(c, 'malicious')))])) },
    maliciousRuleFrequency: ruleFreq(g.malicious), benignRuleFrequency: ruleFreq(benign.flatMap(([, v]) => v)),
    benignFlaggedExamples: benign.flatMap(([, v]) => v).filter((c) => c.verdict !== 'clean').slice(0, 25).map((c) => `${c.group}/${c.name}@${c.pkgVersion ?? c.version}: ${c.score} [${[...new Set(c.hits.map((h: any) => h.rule))].join(',')}]`),
    maliciousMissedExamples: g.malicious.filter((c) => c.verdict === 'clean').slice(0, 25).map((c) => `${c.name}@${c.pkgVersion ?? c.version}: score ${c.score}, files ${c.filesScanned} [${[...new Set((c.hits ?? []).map((h: any) => h.rule))].join(',')}]`),
    maliciousWithoutCodeFile: rate(g.malicious.map((c) => c.codeFiles === 0)),
    // Recall split by who reported the package: the bulk Amazon Inspector feed vs every other source.
    recallBySource: (() => { const src = (c: any) => (eco === 'npm' ? npmSrc.get(c.name) : pySrc.get(c.name)) ?? []; const only = (c: any) => src(c).length > 0 && src(c).every((x: string) => x === 'amazon-inspector');
      return { amazonInspectorOnly: rate(g.malicious.filter(only).map((c) => codeFlag(c, 'review'))), otherSources: rate(g.malicious.filter((c) => !only(c)).map((c) => codeFlag(c, 'review'))) }; })(),
  }];
}));

// ---------- E4: combined (npm, packages that have BOTH a metadata replay and a code scan) ----------
const npmCode = new Map(codeS.filter((c) => c.eco === 'npm').map((c) => [`${c.label}:${c.name}`, c]));
const malBoth = placed.map((r) => ({ r, c: npmCode.get(`malicious:${r.name}`) })).filter((x) => x.c);
const benBoth = Object.values(ctlGroups).flat().map((r) => ({ r, c: npmCode.get(`benign:${r.name}`) })).filter((x) => x.c);
const combo = (level: 'review' | 'malicious') => {
  const m = malBoth.map(({ r, c }) => ({ meta: V(r.atPublish, 'npm').flagged, code: codeFlag(c, level) }));
  const b = benBoth.map(({ r, c }) => ({ meta: V(r.atSnapshot, 'npm').flagged, code: codeFlag(c, level), group: r.group }));
  const venn = (xs: { meta: boolean; code: boolean }[]) => ({ metadataOnly: xs.filter((x) => x.meta && !x.code).length, codeOnly: xs.filter((x) => !x.meta && x.code).length, both: xs.filter((x) => x.meta && x.code).length, neither: xs.filter((x) => !x.meta && !x.code).length, n: xs.length });
  return {
    malicious: venn(m), benign: venn(b),
    benignByGroup: Object.fromEntries([...new Set(b.map((x) => x.group))].map((g) => [g, venn(b.filter((x) => x.group === g))])),
    metadataOnly: confusion(m.map((x) => x.meta), b.map((x) => x.meta)),
    codeOnly: confusion(m.map((x) => x.code), b.map((x) => x.code)),
    either: confusion(m.map((x) => x.meta || x.code), b.map((x) => x.meta || x.code)),
    both: confusion(m.map((x) => x.meta && x.code), b.map((x) => x.meta && x.code)),
  };
};
M.E4_npm_combined = { note: 'Malicious = still-downloadable malicious versions (metadata at first malicious publish). Benign = controls with a scanned latest version (metadata at snapshot).', atReview: combo('review'), atMalicious: combo('malicious') };

writeResult(`metrics-${SPLIT}.json`, M);
console.log(JSON.stringify({ split: SPLIT, E1npm: M.E1_names.npm.lookalike, E1pypi: M.E1_names.pypi.lookalike, E2: M.E2_npm_metadata.confusion.atPublish_vs_allControls, E3npm: M.E3_code.npm?.atReview?.vsAllBenign, E4either: M.E4_npm_combined.atReview.either }, null, 1));
void DATA;
