# Package-risk benchmark (metadata vs code vs combined)

Measures RIPPLE's own package checks (`src/server/capabilities/pkgguard`) on real npm and PyPI data. The report with
the measured numbers is `docs/benchmarks/PACKAGE_RISK_BENCHMARK.md`; the raw metrics are `results/metrics-*.json`.

**Safety.** No package is installed, imported, extracted to disk or executed. Archives are downloaded into memory,
read as text by `inspect.ts`, and dropped. Only rule hits (rule id, file, line) are stored, never code. Registry
*JSON* responses are cached in `.cache/` (git-ignored) so a re-run reads the same snapshot.

## Data sources (all reachable from the benchmark sandbox; no third-party repository was used)
| Source | What it gives | Used for |
|---|---|---|
| `storage.googleapis.com/osv-vulnerabilities/{npm,PyPI}/all.zip` (OSV export of the OpenSSF malicious-packages DB) | 222,872 npm / 11,971 PyPI `MAL-*` reports (withdrawn dropped), with report time, malicious versions and reporting source | malicious ground truth |
| `registry.npmjs.org/<name>` | current document; for removed malware npm keeps a `0.0.1-security` placeholder **whose `time` map still lists the original versions and publish times** | historical metadata replay (npm) |
| `registry.npmjs.org/-/v1/search` | names with real weekly downloads | popular / long-tail / fresh npm controls, top-2,000 reference list, live-malware downloads |
| `pypi.org/simple/` (JSON) and `pypi.org/pypi/<name>/json` | the full project index (933,610 after exclusions) and per-project upload history | PyPI controls, still-live PyPI malware |
| `bench/pkgguard/lists/*.txt` | authored inputs: npm crawl query terms, well-known PyPI names | stated as authored in the report |

Not reachable (refused by the sandbox network policy, so not used): `api.npmjs.org` (download history), `pypistats.org`,
`api.deps.dev`, `api.osv.dev`. Their absence is why historical download counts are not measured (see the report).

## Steps
```bash
npx tsx bench/pkgguard/01-malicious.ts        # OSV ground truth, provenance (sha256, Last-Modified), seeded samples
npx tsx bench/pkgguard/02-npm-malicious-meta.ts  # npm replay: snapshot at first malicious publish, at report, across the live window
npx tsx bench/pkgguard/02b-npm-downloads.ts   # weekly downloads for still-live malicious npm packages
npx tsx bench/pkgguard/03-benign.ts           # controls + reference lists (excludes every OSV-reported name)
npx tsx bench/pkgguard/04-code.ts             # in-memory static code reading of every still-downloadable archive
npx tsx bench/pkgguard/05-evaluate.ts tune    # metrics on the 30% tuning split
npx tsx bench/pkgguard/05-evaluate.ts heldout # metrics on the 70% held-out split (the reported numbers)
npx tsx bench/pkgguard/06-export-reference.ts # the reference lists the product ships
```

## Protocol (leakage control)
- **Split** by `sha256(ecosystem:name)`: 30% tuning, 70% held-out, decided before any data was read (`lib.ts`).
- **Metadata and name thresholds** (`metadata.ts META_RULES`, `names.ts NAME_RULES`) were fixed before any data was
  read and were not changed after. The report sweeps them by bucket so the trade-off is visible.
- **Code rules**: `inspect@1` was written before any data was read. `inspect@2` changed rules after looking at the
  **tuning split only** (changes listed in `inspect.ts`). The held-out split was evaluated once, with `inspect@2`, after
  the rule commit was recorded in the report.
- **Controls** exclude every name that appears anywhere in OSV `MAL-*` data. "Legitimate" therefore means "not reported
  malicious as of the OSV snapshot"; a few controls may be undiscovered malware.
- **Seeds**: 20261107 (malicious samples), 7112026 (controls).
