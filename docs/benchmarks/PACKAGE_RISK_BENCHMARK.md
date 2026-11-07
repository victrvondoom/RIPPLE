# Package-risk benchmark: metadata vs static code vs combined (npm and PyPI)

Date: 2026-11-07. System measured: RIPPLE's own `src/server/capabilities/pkgguard` (the checks used by the
`package-gate` pack). Harness: `bench/pkgguard/` (method and commands in `bench/pkgguard/README.md`).
Raw metrics: `bench/pkgguard/results/metrics-heldout.json` (reported), `metrics-tune.json` (tuning split).
The tables in the appendix are generated from those files by `07-tables.ts`; nothing in them was typed by hand.

**Labels used below.** *Measured* = computed by the harness from the data files. *Source claim* = something a data
source states (for example OSV's report time). *Inference* = our reading of a measured number. *Recommendation* = what
we suggest; nothing marked as a recommendation is implemented unless the text says so.

**What this is not.** It does not measure the separate "Gatekeeper" project whose description the owner supplied as a
concept. By the owner's instruction no external repository was used, so Gatekeeper's published numbers (npm 60.5% /
PyPI 84% on Datadog's dataset) were **not** verified or reproduced here, and they cannot be compared one-for-one with
the numbers below: different code, different malicious population, different negative controls.

## 1. Headline (measured, held-out 70% split)

| Question (from the brief) | Answer on this data |
|---|---|
| 1. Detected by **metadata alone** | npm: **93.9%** [92.8–94.9] of 1,973 malicious packages at their first malicious publish; **58.8%** averaged over the whole live window; **40.9%** by the time the first report appeared. PyPI: not measurable for removed packages (see §4); 56.3% [39.3–71.8] of 32 still-live reported projects. |
| 2. Detected by **static code alone** | npm: **3.2%** [1.5–6.9] of 185 still-downloadable malicious archives (score ≥ 4). PyPI: **50.0%** [33.6–66.4] of 32. |
| 3. Detected by **both** | npm: 2 of 185 (1.1%). Detected by **either**: 179 of 185 (**96.8%** [93.1–98.5]). |
| 4. **Missed by both** | npm: **6 of 185** (3.2%). |
| 5. **Legitimate packages flagged** | Metadata composite: popular npm **0.0%** [0–0.6] (0/673), long-tail 1.9%, **fresh (< 30 days) 15.4%** [11.8–19.9]; fresh PyPI **43.8%**. Code (score ≥ 4): npm 1.5% overall, PyPI 3.5% (popular PyPI 5.5%). Either: npm 6.8% [5.3–8.5]. |
| 6. Effect of **package age** | Flagged: < 1 day old 97.2% (n=1,890); 1–7 days 65.2% (n=23); 7–30 days 20% (n=5); older 0% (n=55). 95.8% of the malicious packages were < 1 day old at their first malicious publish. |
| 7. Effect of **download count** | Only measurable for the 249 malicious packages still live (snapshot downloads, inflated by mirrors/scanners). "< 50 per week" fired on only **20.9%** of the 220 with a known count, while firing on 13.4% of long-tail and 16.4% of fresh legitimate packages: weak signal here. |
| 8. **Typo-similarity** | npm: recall **0.1%** [0.1–0.2] (20 of 13,960 malicious names), false alarms 0.7% of 84,165 legitimate names. PyPI: recall **6.6%** [6.1–7.2] (555 of 8,390), false alarms 0.4% of 34,849. |
| 9. **Newly registered** packages | 94.3% of npm malicious packages were brand-new registrations; the metadata composite flags 97.6% of those but only **32.7%** [24.8–41.8] of the 113 malicious versions pushed to an already-existing package. |
| 10. **Caught before installation** | Every check here runs before install. At the earliest possible install the metadata rules flag 93.9%; across the live window 58.8%. On the npm subset with both signals, 96.8% are flagged by at least one (with 6.8% of legitimate controls flagged too). |

## 2. Datasets (provenance)

| Set | Source | Collected | Size |
|---|---|---|---|
| Malicious ground truth | OSV bulk export of the OpenSSF malicious-packages DB: `gs://osv-vulnerabilities/npm/all.zip` (sha256 `cc2efc57…028e6`, Last-Modified 2026-11-06 23:33 GMT), `PyPI/all.zip` (sha256 `c435a459…59cd8`, 2026-11-07 08:47 GMT) | 2026-11-07 09:01 UTC | npm 222,872 `MAL-*` records (334 withdrawn dropped); PyPI 11,971 (25 dropped) |
| npm metadata replay | 3,000 records, seeded, 600 per report year 2022–2026; current registry document of each | 2026-11-07 | 2,797 placed on a timeline (1,973 held-out) |
| npm names (name rule) | seeded 20,000 unique malicious names; 120,363 crawled legitimate names outside the reference list | 2026-11-07 | held-out 13,960 vs 84,165 |
| PyPI names | all 11,971 malicious names; 50,000 seeded names from the 933,610-project simple index | 2026-11-07 | held-out 8,390 vs 34,849 |
| npm controls | npm search API crawl (150 authored generic terms × 4 pages): popular = top 1,000 by weekly downloads; long-tail = 1,200 random outside the top 5,000; fresh = first published < 30 days before the snapshot | 2026-11-07 | held-out 673 / 872 / 311 |
| PyPI controls | authored well-known list (330 names, existence-checked; **not** a download ranking); 1,500 random from the simple index; fresh = first upload < 30 days | 2026-11-07 | held-out 222 / 991 / 368 |
| Code-reading sets | every archive still downloadable: npm malicious 271 (185 held-out), PyPI still-live reported projects with files uploaded before the report 62 (32 held-out); controls 1,344 npm + 717 PyPI | 2026-11-07 | see appendix T9 |

Independence: the malicious labels come from OSV's sources (GitHub Advisory malware, Amazon Inspector, ReversingLabs,
Checkmarx, OpenSSF package-analysis, kam193, Google), not from RIPPLE. Every control excludes any name that appears
anywhere in the OSV malicious data. "Legitimate" therefore means "not reported as of the snapshot".

## 3. Method

- **Historical metadata, not reconstructed.** npm replaces removed malware with a `0.0.1-security` placeholder but keeps
  the original `time` map (version → publish time). The replay rebuilds what an installer saw at a moment *t* using only
  versions published by *t*: first publish, version count, highest major version, gap since the previous release.
  Fields npm no longer has (install scripts of removed versions, historical downloads) are recorded as unknown, never
  guessed. Moments: the first malicious publish, the first report (OSV `published` or the earliest source time), and 11
  evenly spaced moments from the first malicious publish to npm's takedown (or to the snapshot, if still live).
- **Rules (fixed before any data was read).** `metadata.ts`: flag when the name is a lookalike, OR the version looks like
  dependency confusion (major ≥ 90 with ≤ 3 releases), OR (younger than 30 days AND ≤ 2 releases), OR (younger than 30
  days AND an install script). `names.ts`: optimal-string-alignment distance 1 (names ≥ 4 chars) or 2 (≥ 9 chars),
  separator, scope and homoglyph confusion against the reference lists (npm: top 2,000 by weekly downloads; PyPI: the
  330-name authored list). `inspect.ts`: 30 weighted rules; "review" at score ≥ 4, "malicious-looking" at ≥ 7.
- **Leakage control.** 30/70 tuning/held-out split by `sha256(ecosystem:name)`. Metadata and name thresholds were
  never changed. Code rules went from `inspect@1` (written blind) to `inspect@2` using the tuning split only; the rules
  were frozen in commit `52239ba` before the held-out split was evaluated.
- **Safety.** No package was installed, imported, extracted to disk or run. Archives were read into memory as text and
  dropped; only rule ids, files and line numbers were stored.
- **Statistics.** Wilson 95% intervals for every rate. Precision and F1 are reported at each comparison's own
  malicious:legitimate mix and are not prevalence-adjusted; false-positive rates are the numbers to carry to a real
  team, where nearly every install is legitimate.

## 4. Findings (measured, with our reading)

1. **On npm, metadata is the detector; code reading barely adds anything in this population.** At the first malicious
   publish the metadata rules flag 93.9% of 1,973 malicious packages; code reading flags 3.2% of the 185 still
   downloadable. Only 4 of 185 were caught by code alone. *Inference:* most npm entries in OSV are brand-new, one-version
   packages (dependency confusion probes, token-farming spam, bulk-reported floods). 151 of the 185 still-downloadable
   archives were reported only by the Amazon Inspector bulk feed, and code reading flags 2% of those versus 8.8% of the
   34 reported by other sources.
2. **The "new package" signal decays fast, and the real live window is long.** Detection is 93.9% at the first
   malicious publish, 65.0% one tenth into the live window and 47.9% at takedown (median window 11.4 days; p90 747
   days). *Inference:* a team that installs a malicious package late in its life is protected by metadata only half
   the time.
3. **The cost of the metadata rule is paid by fresh legitimate packages.** 0% of popular npm packages are flagged, but
   15.4% of npm packages under 30 days old and 43.8% of fresh PyPI projects are. *Inference:* the rule is only usable as
   "ask a person", never as a silent block, and its alarm volume depends on how often a team installs new packages.
4. **Typosquat detection is a minor channel.** On npm it matches 0.1% of malicious names while matching 0.7% of
   legitimate names: in this data a lookalike match is more often a legitimate package (`eventemitter2` ~
   `eventemitter3`) than malware. On PyPI it matches 6.6% of malicious names (most-imitated: requests, beautifulsoup4,
   websocket-client, colorama) at a 0.4% false-alarm rate.
5. **Malicious versions of existing packages are the blind spot.** 5.7% of npm malicious packages were existing
   packages that received a malicious version (for example `fsevents` 1.0.0–1.2.10, which had 15 earlier versions); the
   metadata composite flags only 32.7% of them.
6. **PyPI code reading works better than npm.** 50.0% at review (76.5% of the 17 samples reported by sources other than
   Amazon Inspector), with 3.5% false alarms (5.5% on popular projects, mostly SDK and tooling code that legitimately
   downloads and runs things: psutil, werkzeug, debugpy, anthropic). At the stricter score ≥ 7 it flags 9.4% with 0.6%
   false alarms.
7. **Downloads are not a usable signal from this sandbox.** Historical counts for removed packages were not reachable
   (`api.npmjs.org`, `pypistats.org` and `api.deps.dev` were refused by the network policy). For still-live malware the
   snapshot counts are inflated: 147 of 249 sit at 50–499 weekly downloads.

## 5. Comparison with the existing benchmark claim

| | Concept project's claim (not verified here) | This benchmark (RIPPLE's checks) |
|---|---|---|
| Malicious set | Datadog malicious-software-packages dataset (human-triaged archives with payloads) | OSV/OpenSSF `MAL-*` reports; code only where npm/PyPI still serve the archive |
| npm code detection | 60.5% flagged (200 held-out) | 3.2% at review (185 held-out); 8.8% on non-bulk-reported samples |
| PyPI code detection | 84% flagged (196 held-out) | 50.0% at review (32 held-out); 76.5% on non-bulk-reported samples |
| Legitimate false alarms (code) | npm 0.2% malicious + 0.8% review; PyPI 1.5% + 8.3% | npm 0.4% at ≥ 7, 1.5% at ≥ 4; PyPI 0.6% at ≥ 7, 3.5% at ≥ 4 |
| Metadata measured? | No ("cannot be replayed") | Yes, for npm, from retained registry timestamps |

*Inference:* the two code numbers measure different populations. The archives npm still serves are mostly packages
without a payload, so this benchmark's npm code number is a floor for "malware that is still downloadable", not an
estimate of payload-detection skill. The claim that metadata "cannot be replayed on packages the registries have already
removed" is false for npm (placeholders keep the timestamps) and true for PyPI.

## 6. False positives and false negatives (what they look like)

- **Metadata false alarms** are fresh, small packages: scoped forks and ports (`@ohos-ports/…`), new SDK plugins, and
  lookalike-but-legitimate names (`debounced` ~ `debounce`, `bower` ~ `bowser`, unscoped `babel-*` vs `@babel/*`).
- **Metadata misses** are mostly brand-new packages that published many versions in their first second (for example
  `tiny-range-binarysearch`: 100 versions at once; `hs-lodash`: 22), which the "≤ 2 versions" condition does not match,
  plus malicious versions of established packages.
- **Code false alarms** are build tools and SDKs that legitimately read credentials, spawn shells or fetch code (held-out
  examples: vite, playwright-core, psutil, werkzeug, debugpy).
- **Code misses**: 24 of 185 npm malicious archives contain no JavaScript at all; most others contain trivial code; on
  PyPI the misses fetch over the network with no executed payload in the archive.

## 7. Limitations

- PyPI metadata for removed projects is unrecoverable from PyPI itself; the PyPI metadata numbers cover only 32
  still-live reported projects (wide intervals).
- The live-window average weights every moment equally; real installs are not uniform in time.
- Download counts are snapshot values for live packages only.
- The PyPI reference and popular lists are an authored list of well-known projects, not a download ranking.
- The npm long-tail and fresh controls come from search results, which favour packages with text matching common terms.
- OSV includes bulk-reported spam; we did not relabel any record. Results by reporting source are in T9.
- Slopsquatting (registration of names that coding agents invent) could not be measured: no corpus of agent-invented
  names with registration outcomes was available. The pack's invented-name tracking is tested, not benchmarked.
- **Disclosed corrections after the first held-out evaluation (no rule changed):** (a) a ground-truth parser bug read an
  OSV *bounded* range with no version list as "all versions"; it affected 2 of 3,000 sampled npm records (30 of
  222,872 overall) and moved the headline at-publish recall from 94.0% to 93.9%; (b) the PyPI all-controls comparison
  counted fresh projects drawn from the random sample twice (false-alarm rate 11.6% → 10.9% after deduplication);
  (c) the "by reporting source" and "no code file" breakdowns were added afterwards. Re-collection between runs read
  1,452 instead of 1,458 random PyPI projects (fetch failures are not cached).

## 8. Recommendations supported by these numbers

1. **Ship metadata as the first gate, with a human decision, not a block** (finding 1 and 3). The package-gate pack
   already does this: a flagged package waits for the security lead's decision on its exact version.
2. **Add a version-diff check for updates to established packages** (finding 5): compare the new version's install
   scripts, network code and file list against the previous version. *Not built.* This targets the 67% of malicious
   versions of existing packages that the metadata rules miss.
3. **Test a "burst" rule on a fresh split** (§6): many versions published within hours of creation. *Hypothesis only*;
   it was seen in held-out misses, so it must be measured on new data before it is claimed.
4. **Check advisories at install time** (finding 2): only 34.4% of reports appear within 7 days of the malicious
   publish, so an OSV lookup helps late installs but cannot replace the age rule.
5. **Do not headline typosquat detection on npm** (finding 4); keep it for PyPI.

## 9. Reproduce

```bash
npm ci
npx tsx bench/pkgguard/05-evaluate.ts heldout   # offline: recomputes every metric from the committed data/*.jsonl.gz
npx tsx bench/pkgguard/07-tables.ts heldout
```
Re-collecting from the network (steps 01–04, about 30 minutes, reads live registries) is described in
`bench/pkgguard/README.md`; registry state changes daily, so a re-collection is a new snapshot.

## Appendix: generated tables (held-out split)

Split: **heldout**. Rules: inspect@2; reference lists: npm 2000, PyPI 330 names. *Precision and F1 depend on the malicious:legitimate mix of each comparison and are not prevalence-adjusted.*

### T1. Lookalike-name rule (name only, no registry data)

| Detector / comparison | TP | FN | FP | TN | Precision* | Recall [95% CI] | F1* | FPR [95% CI] | FNR |
|---|---|---|---|---|---|---|---|---|---|
| npm: lookalike (distance/separator/scope/homoglyph), 13960 malicious vs 84165 control names | 20 | 13940 | 556 | 83609 | 3.5% | 0.1% [0.1–0.2] | 0.3% | 0.7% [0.6–0.7] | 99.9% |
| npm: combosquat (affix) | 3 | 13957 | 63 | 84102 | 4.5% | 0.0% [0–0.1] | 0.0% | 0.1% [0.1–0.1] | 100.0% |
| pypi: lookalike (distance/separator/scope/homoglyph), 8390 malicious vs 34849 control names | 555 | 7835 | 132 | 34717 | 80.8% | 6.6% [6.1–7.2] | 12.2% | 0.4% [0.3–0.4] | 93.4% |
| pypi: combosquat (affix) | 11 | 8379 | 11 | 34838 | 50.0% | 0.1% [0.1–0.2] | 0.3% | 0.0% [0–0.1] | 99.9% |

Most-imitated targets (held-out malicious names): npm bs-logger (2), ansi-escapes (1), reflect-metadata (1), callsites (1), cose-base (1), express (1); PyPI requests (42), beautifulsoup4 (40), websocket-client (30), colorama (29), pycodestyle (24), bitcoinlib (22), scikit-learn (22), pillow (21).

False-alarm examples (control names): npm eventemitter2 ~ eventemitter3 (typo-distance); wbuf ~ obuf (typo-distance); ulid ~ uuid (typo-distance); sockjs ~ socks (typo-distance); touch ~ youch (typo-distance). PyPI authlib ~ oauthlib (typo-distance); swipy ~ scipy (typo-distance); tmock ~ mock (typo-distance); fake ~ faker (typo-distance); zippy ~ zipp (typo-distance).

### T2. npm metadata rules, replayed from registry timestamps (1973 of 2120 sampled malicious records placed on a timeline)

Registry status of the sampled malicious packages today: live 249, placeholder 1321, unpublished 433, gone 117, error 0. Controls: popular 673, longtail 872, fresh 311.

| Detector / comparison | TP | FN | FP | TN | Precision* | Recall [95% CI] | F1* | FPR [95% CI] | FNR |
|---|---|---|---|---|---|---|---|---|---|
| composite at FIRST MALICIOUS PUBLISH vs all controls | 1853 | 120 | 65 | 1791 | 96.6% | 93.9% [92.8–94.9] | 95.2% | 3.5% [2.8–4.4] | 6.1% |
| composite at MID LIVE-WINDOW vs all controls | 1122 | 851 | 65 | 1791 | 94.5% | 56.9% [54.7–59] | 71.0% | 3.5% [2.8–4.4] | 43.1% |
| composite at FIRST REPORT vs all controls | 806 | 1167 | 65 | 1791 | 92.5% | 40.9% [38.7–43] | 56.7% | 3.5% [2.8–4.4] | 59.1% |
| at publish vs popular controls (snapshot) | 1853 | 120 | 0 | 673 | 100.0% | 93.9% [92.8–94.9] | 96.9% | 0.0% [0–0.6] | 6.1% |
| at publish vs longtail controls (snapshot) | 1853 | 120 | 17 | 855 | 99.1% | 93.9% [92.8–94.9] | 96.4% | 1.9% [1.2–3.1] | 6.1% |
| at publish vs fresh controls (snapshot) | 1853 | 120 | 48 | 263 | 97.5% | 93.9% [92.8–94.9] | 95.7% | 15.4% [11.8–19.9] | 6.1% |
| at publish vs popular controls (at their latest release) | 1853 | 120 | 9 | 664 | 99.5% | 93.9% [92.8–94.9] | 96.6% | 1.3% [0.7–2.5] | 6.1% |
| at publish vs longtail controls (at their latest release) | 1853 | 120 | 91 | 781 | 95.3% | 93.9% [92.8–94.9] | 94.6% | 10.4% [8.6–12.6] | 6.1% |
| at publish vs fresh controls (at their latest release) | 1853 | 120 | 56 | 255 | 97.1% | 93.9% [92.8–94.9] | 95.5% | 18.0% [14.1–22.7] | 6.1% |

### T3. Each metadata signal: share of packages where it fired (n = packages where the field was known)

| Signal | Malicious @publish | Malicious @report | Popular | Long-tail | Fresh (<30 d) |
|---|---|---|---|---|---|
| new_package | 97% (n=1973) | 31.6% (n=1973) | 0% (n=673) | 0% (n=872) | 6.8% (n=311) |
| young_package | 97.2% (n=1973) | 41.2% (n=1973) | 0% (n=673) | 4.5% (n=872) | 100% (n=311) |
| few_versions | 93.9% (n=1973) | 81.6% (n=1973) | 2.2% (n=673) | 9.9% (n=872) | 13.5% (n=311) |
| install_script | 5.1% (n=175) | 4.8% (n=186) | 0.3% (n=673) | 1.5% (n=872) | 2.3% (n=311) |
| low_downloads | — (n=0) | — (n=0) | 0% (n=673) | 13.4% (n=872) | 16.4% (n=311) |
| dependency_confusion_version | 10.9% (n=1973) | 11.3% (n=1973) | 0% (n=673) | 0% (n=872) | 1% (n=311) |
| dormant_revival | 19.5% (n=113) | 6.5% (n=598) | 20% (n=669) | 10.6% (n=829) | 0% (n=311) |
| lookalike_name | 1% (n=1973) | 1% (n=1973) | 0% (n=673) | 0.9% (n=872) | 0% (n=311) |
| combosquat_name | 0% (n=1973) | 0% (n=1973) | 0% (n=673) | 0% (n=872) | 0% (n=311) |
| no_repository | 24% (n=175) | 22.6% (n=186) | 0.3% (n=673) | 10.2% (n=872) | 12.9% (n=311) |
| young_and_few_versions | 93.6% (n=1973) | 34.5% (n=1973) | 0% (n=673) | 0.9% (n=872) | 13.5% (n=311) |
| young_and_install_script | 3.1% (n=226) | 0.6% (n=1183) | 0% (n=673) | 0.2% (n=872) | 2.3% (n=311) |
| COMPOSITE | 93.9% (n=1973) | 40.9% (n=1973) | 0% (n=673) | 1.9% (n=872) | 15.4% (n=311) |

### T4. Detection by package age at the first malicious publish, and the control flag rate by age

| Age bucket | Malicious n | Malicious flagged | Control n | Control flagged |
|---|---|---|---|---|
| <1 day | 1890 | 97.2% | 0 | — |
| 1-7 days | 23 | 65.2% | 21 | 4.8% |
| 7-30 days | 5 | 20% | 329 | 17% |
| 30-365 days | 16 | 0% | 157 | 0% |
| >1 year | 39 | 0% | 1349 | 0.6% |

### T5. Detection by number of versions at the first malicious publish

| Versions | n | Flagged |
|---|---|---|
| 1 | 1785 | 100% |
| 2 | 67 | 92.5% |
| 3-5 | 50 | 12% |
| 6-20 | 29 | 0% |
| >20 | 42 | 0% |

### T6. Detection across the live window (install moments from first malicious publish to takedown)

| Moment (fraction of window) | 0 | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 | 1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Flagged | 93.9% | 65% | 62.3% | 59.9% | 57.6% | 56.9% | 53.1% | 52% | 50% | 48.5% | 47.9% |

Mean over the window: **58.8%**. Window length (days): median 11.4, p75 172.3, p90 746.9.

### T7. New registrations vs malicious versions of existing packages; timing

| Measure | Value |
|---|---|
| Brand-new package at its first malicious publish (no earlier version) | 94.3% of 1973 [93.2–95.2] |
| … of those, flagged by the composite | 97.6% of 1860 [96.8–98.2] |
| Existing package that received a malicious version | 5.7% of 1973 |
| … of those, flagged by the composite | 32.7% of 113 [24.8–41.8] |
| Days from first malicious publish to first report (median / p25 / p75 / p90) | 51 / 1.6 / 456.4 / 546.5 |
| Days from first malicious publish to npm takedown (median / p25 / p75 / p90), n | 6.7 / 0.7 / 70.3 / 544.8, n=1752 |
| Reported within 7 days of first malicious publish | 34.4% |

### T8. Weekly downloads (snapshot; only packages still live; removed packages have no recoverable history here)

| Bucket | Malicious still live: n / flagged | Popular | Long-tail | Fresh |
|---|---|---|---|---|
| <10 | 32 / 96.9% | — | 18 / 5.6% | 10 / 80% |
| 10-49 | 14 / 35.7% | — | 99 / 4% | 41 / 26.8% |
| 50-499 | 147 / 87.8% | — | 220 / 2.7% | 110 / 17.3% |
| 500-4,999 | 10 / 20% | — | 225 / 0.9% | 121 / 6.6% |
| >=5,000 | 17 / 0% | 673 / 0% | 310 / 1.3% | 29 / 6.9% |
| unknown | 29 / 93.1% | — | — | — |

"Low downloads" (< 50/week) fired on 20.9% of 220 still-live malicious packages with a known count.

### T9. Static code reading only (archives still downloadable; read in memory)

| Detector / comparison | TP | FN | FP | TN | Precision* | Recall [95% CI] | F1* | FPR [95% CI] | FNR |
|---|---|---|---|---|---|---|---|---|---|
| npm at "review" (score ≥ 4): 185 malicious vs 332 popular + 293 longtail + 308 fresh | 6 | 179 | 14 | 919 | 30.0% | 3.2% [1.5–6.9] | 5.9% | 1.5% [0.9–2.5] | 96.8% |
| npm at "malicious-looking" (score ≥ 7) | 2 | 183 | 4 | 929 | 33.3% | 1.1% [0.3–3.9] | 2.1% | 0.4% [0.2–1.1] | 98.9% |
| pypi at "review" (score ≥ 4): 32 malicious vs 217 popular + 268 random | 16 | 16 | 17 | 468 | 48.5% | 50.0% [33.6–66.4] | 49.2% | 3.5% [2.2–5.5] | 50.0% |
| pypi at "malicious-looking" (score ≥ 7) | 3 | 29 | 3 | 482 | 50.0% | 9.4% [3.2–24.2] | 15.8% | 0.6% [0.2–1.8] | 90.6% |

- npm: false-alarm rate at review by control group: popular 0.6% (2/332), longtail 1.4% (4/293), fresh 2.6% (8/308). Malicious archives with no JavaScript/Python file at all: 13% (24/185). Recall at review by reporting source: Amazon Inspector only 2% (3/151), other sources 8.8% (3/34) [3–23].
- pypi: false-alarm rate at review by control group: popular 5.5% (12/217), random 1.9% (5/268). Malicious archives with no JavaScript/Python file at all: 0% (0/32). Recall at review by reporting source: Amazon Inspector only 20% (3/15), other sources 76.5% (13/17) [52.7–90.4].

### T10. npm: metadata vs code vs combined, same packages (185 malicious with both a replay and a code reading; 933 controls)

| Outcome (code at review) | Malicious | Controls |
|---|---|---|
| metadata only | 173 | 49 |
| code only | 4 | 13 |
| both | 2 | 1 |
| neither | 6 | 870 |

| Detector / comparison | TP | FN | FP | TN | Precision* | Recall [95% CI] | F1* | FPR [95% CI] | FNR |
|---|---|---|---|---|---|---|---|---|---|
| metadataOnly (code at review) | 175 | 10 | 50 | 883 | 77.8% | 94.6% [90.3–97] | 85.4% | 5.4% [4.1–7] | 5.4% |
| codeOnly (code at review) | 6 | 179 | 14 | 919 | 30.0% | 3.2% [1.5–6.9] | 5.9% | 1.5% [0.9–2.5] | 96.8% |
| either (code at review) | 179 | 6 | 63 | 870 | 74.0% | 96.8% [93.1–98.5] | 83.8% | 6.8% [5.3–8.5] | 3.2% |
| both (code at review) | 2 | 183 | 1 | 932 | 66.7% | 1.1% [0.3–3.9] | 2.1% | 0.1% [0–0.6] | 98.9% |
| either (code at malicious-looking) | 176 | 9 | 53 | 880 | 76.9% | 95.1% [91–97.4] | 85.0% | 5.7% [4.4–7.4] | 4.9% |
| both (code at malicious-looking) | 1 | 184 | 1 | 932 | 50.0% | 0.5% [0.1–3] | 1.1% | 0.1% [0–0.6] | 99.5% |

### T11. PyPI metadata (controls, and the reported projects still live on PyPI, evaluated at report time)

| Group | young (<30 d) | few versions (≤2) | young AND few | sdist-only release | composite |
|---|---|---|---|---|---|
| popular | 0% (n=222) | 0% (n=222) | 0% (n=222) | 0% (n=222) | 0% (n=222) |
| random | 3% (n=991) | 42.6% (n=991) | 1.5% (n=991) | 19.9% (n=991) | 2.3% (n=994) |
| fresh | 100% (n=368) | 43.8% (n=368) | 43.8% (n=368) | 0.5% (n=368) | 43.8% (n=368) |
| malicious, still live | 84.4% (n=32) | 56.3% (n=32) | 56.3% (n=32) | 9.4% (n=32) | 56.3% (n=32) |

| Detector / comparison | TP | FN | FP | TN | Precision* | Recall [95% CI] | F1* | FPR [95% CI] | FNR |
|---|---|---|---|---|---|---|---|---|---|
| PyPI composite: still-live malicious vs all PyPI controls | 18 | 14 | 169 | 1384 | 9.6% | 56.3% [39.3–71.8] | 16.4% | 10.9% [9.4–12.5] | 43.8% |
