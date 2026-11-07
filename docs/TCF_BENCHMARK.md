# Temporal Contract Forensics Benchmark (TCFB)

TCFB evaluates whether the Temporal Contract Forensics engine reaches **correct contractual decisions when the
evidence is uncertain, incomplete, duplicated, late, shuffled or deliberately contradictory**. It is not a unit-test
suite: every case is generated from a hidden ground-truth timeline, the engine sees only evidence derived from that
truth, and its output is scored against both the truth and an independent brute-force oracle.

```bash
npx tsx bench/temporal-contract-forensics/run.ts 150 10     # 3,000 cases; MDE on ≤10 undecided cases per category
npx tsx bench/temporal-contract-forensics/render-doc.ts     # copy the generated report into this document
```

Outputs in `bench/temporal-contract-forensics/results/`: `results.json` (metrics, per-category, configuration),
`cases.csv` (one row per case), `confusion.json`, `failures.json` (examples of every failure type), `report.md`.
Fixed seed `20261107`; the generator, oracle and runner are published next to the results.

## Methodology

### Ground truth and honest evidence
Each case draws a true timeline of the contracted scope: 1–4 outage intervals on a 10-second lattice inside or across
a 2-hour incident window (a calendar month for time-zone cases). Honest sources observe it through a clock whose true
offset lies within the declared residual uncertainty (0–120 s; known offsets up to 15 min are corrected; drift up to
the declared ppm since a declared sync time) and report alternating state intervals whose boundary bounds always
contain the true reading (detection jitter 0–60 s). At most two clocks per case carry residual uncertainty, so that
the oracle can be exhaustive. With probability 0.35 an honest source misses a stretch around an outage boundary, and in
half of the cases the contractual threshold is placed within ±3 minutes of the true contractual downtime — the
regime where timestamp and clock uncertainty actually decide the outcome.

### The 20 adversarial categories (150 cases each)
| # | Category | What it adds |
|---|---|---|
| 1 | ACCURATE_TIMESTAMPS | exact clocks and timestamps (control) |
| 2 | CLOCK_DRIFT | a drifting clock (true rate within the declared ppm) |
| 3 | LARGE_CLOCK_OFFSET | a known offset of 2–15 min to correct, plus residual uncertainty |
| 4 | MISSING_RECOVERY | a source reports the onset (open transition) and goes silent; others may have gaps |
| 5 | DUPLICATE_OUTAGE_EVENTS | re-sent records and the same raw record under another id |
| 6 | LATE_ARRIVING_EVIDENCE | ~40 % of the evidence arrives as later revision updates |
| 7 | OUT_OF_ORDER_EVENTS | transition streams delivered in shuffled order |
| 8 | PARTIAL_REGIONAL_OUTAGE | region-scoped contract; a foreign-region outage; an AGGREGATE global monitor |
| 9 | OVERLAPPING_INCIDENTS | two overlapping incidents on the same scope, records filed under both |
| 10 | FLAPPING_RECOVERY | short recoveries; merge gap, gap counting, minimum episode, grace, longest-continuous |
| 11 | CONFLICTING_TELEMETRY | a low-authority source lies beyond its stated uncertainty (sometimes where nothing contradicts it) |
| 12 | MAINTENANCE_EXCLUSIONS | confirmed, unconfirmed, late-notice and other-region maintenance windows |
| 13 | CONTRACT_VERSION_CHANGE | two versions; window in one (or straddling the boundary ⇒ must be INDETERMINATE) |
| 14 | WINDOW_BOUNDARY | outages crossing the window start or end |
| 15 | TIMEZONE_BOUNDARY | calendar-month contracts in Tokyo, Kolkata (+05:30) and New York (DST months) with outages across the local month boundary |
| 16 | THRESHOLD_EQUALITY | true downtime exactly equals the threshold; "exceeds" vs "at least" |
| 17 | MULTIPLE_OVERLAPPING_INTERVALS | 3–4 sources plus overlapping partial claims (double-counting trap) |
| 18 | MISSING_CONTRACT_FIELDS | no threshold, no qualifying states, an unsupported clause, or no version ⇒ must be INDETERMINATE |
| 19 | INCORRECT_SERVICE_SCOPE | evidence and incident for another service, or no effective contract ⇒ must be NOT_APPLICABLE |
| 20 | DELIBERATE_CONTRADICTION | a source of similar authority lies beyond its uncertainty |

### The oracle (independent reference)
`oracle.ts` shares no code with the engine. The generator emits, next to the engine input, its own mathematical
description of every record (computed from the numbers it used to build the record), so the oracle never sees the
engine's parsing or normalisation. The oracle then enumerates **every** offset assignment of the uncertain clocks on
the lattice ± 1 ms, checks consistency by direct pairwise and point tests, computes downtime with an event sweep and its
own episode logic, enumerates exclusion scenarios, and applies the documented authority policy by enumeration. It is
exact for the generated data and exponential in the number of uncertain clocks (which is why it is a benchmark tool
and the engine uses branch and bound). It applies the same documented policy choices as the engine (authority ranks,
resolution gap, relevance rule): agreement on those is a test of implementation, not of the policy itself.

### What is measured
- **Safety (against the hidden truth):** false confirmed breach rate (engine `BREACH_CONFIRMED` while the true
  downtime does not breach) — overall, with honest evidence only, and in cases with deliberately falsified evidence;
  precision of `BREACH_CONFIRMED`; false `NO_BREACH` rate.
- **Classification (against the oracle):** agreement per class; excessive abstention (oracle decisive, engine
  `BREACH_POSSIBLE`/`INDETERMINATE`); overall abstention; decisive rate on decidable truth.
- **Temporal bounds:** bounds contain the true downtime (honest evidence); bounds contain the oracle's exact bounds;
  bounds labelled `EXACT` equal the oracle; share of proven-tight bounds; no inflated minimum in duplicate/overlap
  categories (duplicate-duration prevention).
- **Contract rules:** agreement with the oracle in the rule-heavy categories (12, 13, 14, 15, 16, 18, 19, 10).
- **Evidence gaps:** measure-weighted recall and precision of the reported evidence gaps against the oracle's
  uncovered time.
- **Minimum decisive evidence:** on a sample of undecided cases, the top-ranked request is *acquired from the hidden
  truth* (an authoritative observation of the requested interval built from the true timeline, the true reading of a
  requested timestamp, the true clock offset, the true validity of a maintenance window, or the falsified side of a
  conflict excluded) and the case is re-analysed. Measured: decisive afterwards, decisive and correct afterwards,
  validity of `ALWAYS_DECISIVE` claims, and the same for a **uniformly random listed request** as a baseline.
- **Dynamics:** late-arriving evidence applied as revision updates (in reverse order) must end at the same output hash
  as one batch analysis; identical input must reproduce identical output and revision hashes; evidence order must not
  change the output hash.
- **Performance:** engine time per analysis (mean, p95, max).

### Limitations of the benchmark
- Generated, not field data: monitors are idealised (honest bounds, interval semantics). Sub-sampling blips and
  monitors that lie *within* their stated uncertainty are not generated, so the honest-evidence results do not measure
  them; the falsified-evidence categories show what a lie outside the stated uncertainty does.
- At most two uncertain clocks per case (oracle exhaustiveness); three or more are covered by unit tests against the
  hidden truth only, where bounds may be `SOUND_NOT_TIGHT`.
- The oracle implements the same documented policy; a wrong policy would be wrong in both.
- Availability-percentage thresholds and granularity buckets are covered by unit tests, not by TCFB categories.
- MDE usefulness is measured on a sample (≤ 10 undecided cases per category), with the top request only.

## Results

<!-- TCF:RESULTS:BEGIN -->
_Rendered from `bench/temporal-contract-forensics/results/report.md`; regenerate rather than edit._

Engine 1.0.0, seed 20261107, 3000 cases (150 × 20 categories), MDE sampled on up to 10 undecided cases per category. Run time 76.4 s.
Regenerate: `npx tsx bench/temporal-contract-forensics/run.ts 150 10`.

### Safety
| metric | value |
|---|---|
| **False confirmed breach rate** (engine CONFIRMED, truth no breach) | **0.00% (0/1402)** |
| … with honest evidence only | 0.00% (0/1259) |
| … in cases containing deliberately falsified evidence | 0.00% (0/143) |
| Precision of BREACH_CONFIRMED | 100.00% (1077/1077) |
| False NO_BREACH rate (engine NO_BREACH, truth breach) | 0.00% (0/1256) |
| … with honest evidence only | 0.00% (0/1099) |

### Classification against the independent oracle
| metric | value |
|---|---|
| Agreement with oracle (all classes) | 99.97% (2999/3000) |
| Correct BREACH_CONFIRMED | 100.00% (1077/1077) |
| Correct NO_BREACH | 99.92% (1253/1254) |
| Correct BREACH_POSSIBLE | 100.00% (303/303) |
| Correct INDETERMINATE | 100.00% (216/216) |
| Correct NOT_APPLICABLE | 100.00% (150/150) |
| Excessive abstention (oracle decisive, engine not) | 0.04% (1/2331) |
| Abstention overall (POSSIBLE or INDETERMINATE) | 18.25% (520/2850) |
| Decisive on cases whose truth is decidable | 87.66% (2330/2658) |

### Temporal bounds
| metric | value |
|---|---|
| Bounds contain the hidden true downtime (honest evidence) | 100.00% (2354/2354) |
| Bounds contain the oracle's exact bounds | 100.00% (2654/2654) |
| Bounds labelled EXACT equal the oracle | 100.00% (2654/2654) |
| Both bounds proven tight (EXACT) | 95.63% (2538/2654) |
| Duplicate-duration prevention (no inflated minimum, duplicate/overlap categories) | 100.00% (300/300) |
| Contract-rule categories: agreement with oracle | 99.92% (1199/1200) |
| Evidence-gap detection: mean recall / precision (measure-weighted) | 1 / 1 |

### Minimum decisive evidence (acquired from the hidden truth)
| metric | value |
|---|---|
| Sampled undecided cases | 155 |
| Top-ranked request decides the case | 76.13% (118/155) |
| Top-ranked request decides it correctly | 76.13% (118/155) |
| Baseline: uniformly random listed request decides | 38.71% (60/155) |
| Baseline: random request decides correctly | 38.06% (59/155) |
| ALWAYS_DECISIVE guarantee held | 100.00% (2/2) |
| Top request kinds | OBSERVE_INTERVAL: 150, RESOLVE_TIMESTAMP: 4, CONFIRM_EXCLUSION: 1 |

### Dynamics and reproducibility
| metric | value |
|---|---|
| Late-arriving evidence: incremental revisions = batch analysis (output hash) | 100.00% (141/141) |
| Identical input → identical output and revision hash | 100.00% (3000/3000) |
| Evidence order does not change the output hash | 100.00% (3000/3000) |
| Engine time per analysis: mean / p95 / max | 3.44 ms / 2.81 ms / 719.22 ms |

### Confusion: engine × oracle
| engine \ reference | BREACH_CONFIRMED | BREACH_POSSIBLE | NO_BREACH | INDETERMINATE | NOT_APPLICABLE |
|---|---:|---:|---:|---:|---:|
| BREACH_CONFIRMED | 1077 | 0 | 0 | 0 | 0 |
| BREACH_POSSIBLE | 0 | 303 | 1 | 0 | 0 |
| NO_BREACH | 0 | 0 | 1253 | 0 | 0 |
| INDETERMINATE | 0 | 0 | 0 | 216 | 0 |
| NOT_APPLICABLE | 0 | 0 | 0 | 0 | 150 |

### Confusion: engine × hidden truth
| engine \ reference | TRUE_BREACH | TRUE_NO_BREACH | NOT_DECIDABLE |
|---|---:|---:|---:|
| BREACH_CONFIRMED | 1077 | 0 | 0 |
| BREACH_POSSIBLE | 169 | 135 | 0 |
| NO_BREACH | 0 | 1253 | 0 |
| INDETERMINATE | 10 | 14 | 192 |
| NOT_APPLICABLE | 0 | 0 | 150 |

### Per category
| category | cases | agree w/ oracle | false CONFIRMED | false NO_BREACH | CONF / POSS / NO / IND / N/A | both bounds EXACT | oracle exact |
|---|---:|---:|---:|---:|---|---:|---:|
| ACCURATE_TIMESTAMPS | 150 | 100.0% | 0 | 0 | 69 / 6 / 75 / 0 / 0 | 150 | 150 |
| CLOCK_DRIFT | 150 | 100.0% | 0 | 0 | 73 / 14 / 63 / 0 / 0 | 150 | 150 |
| LARGE_CLOCK_OFFSET | 150 | 100.0% | 0 | 0 | 56 / 18 / 76 / 0 / 0 | 139 | 150 |
| MISSING_RECOVERY | 150 | 100.0% | 0 | 0 | 34 / 76 / 36 / 4 / 0 | 136 | 150 |
| DUPLICATE_OUTAGE_EVENTS | 150 | 100.0% | 0 | 0 | 70 / 21 / 59 / 0 / 0 | 137 | 150 |
| LATE_ARRIVING_EVIDENCE | 150 | 100.0% | 0 | 0 | 73 / 21 / 56 / 0 / 0 | 134 | 150 |
| OUT_OF_ORDER_EVENTS | 150 | 100.0% | 0 | 0 | 76 / 17 / 57 / 0 / 0 | 141 | 150 |
| PARTIAL_REGIONAL_OUTAGE | 150 | 100.0% | 0 | 0 | 40 / 9 / 101 / 0 / 0 | 147 | 150 |
| OVERLAPPING_INCIDENTS | 150 | 100.0% | 0 | 0 | 73 / 17 / 60 / 0 / 0 | 150 | 150 |
| FLAPPING_RECOVERY | 150 | 100.0% | 0 | 0 | 56 / 13 / 81 / 0 / 0 | 150 | 150 |
| CONFLICTING_TELEMETRY | 150 | 100.0% | 0 | 0 | 70 / 8 / 72 / 0 / 0 | 140 | 150 |
| MAINTENANCE_EXCLUSIONS | 150 | 99.3% | 0 | 0 | 48 / 35 / 67 / 0 / 0 | 136 | 150 |
| CONTRACT_VERSION_CHANGE | 150 | 100.0% | 0 | 0 | 50 / 6 / 52 / 42 / 0 | 101 | 150 |
| WINDOW_BOUNDARY | 150 | 100.0% | 0 | 0 | 44 / 10 / 96 / 0 / 0 | 150 | 150 |
| TIMEZONE_BOUNDARY | 150 | 100.0% | 0 | 0 | 52 / 12 / 86 / 0 / 0 | 150 | 150 |
| THRESHOLD_EQUALITY | 150 | 100.0% | 0 | 0 | 24 / 15 / 111 / 0 / 0 | 150 | 150 |
| MULTIPLE_OVERLAPPING_INTERVALS | 150 | 100.0% | 0 | 0 | 98 / 5 / 47 / 0 / 0 | 133 | 150 |
| MISSING_CONTRACT_FIELDS | 150 | 100.0% | 0 | 0 | 0 / 0 / 0 / 150 / 0 | 0 | 150 |
| INCORRECT_SERVICE_SCOPE | 150 | 100.0% | 0 | 0 | 0 / 0 / 0 / 0 / 150 | 0 | 150 |
| DELIBERATE_CONTRADICTION | 150 | 100.0% | 0 | 0 | 71 / 1 / 58 / 20 / 0 | 144 | 150 |

### Failure examples
### CLASS_MISMATCH_VS_ORACLE (1 shown)
```json
[
 {
  "id": "MAINTENANCE_EXCLUSIONS#27",
  "engine": "BREACH_POSSIBLE",
  "oracle": "NO_BREACH",
  "bounds": [
   1890000,
   1900002
  ],
  "oracleBounds": [
   1890000,
   1900000
  ],
  "reasons": [
   "a bound is sound but not tight (search budget exhausted); the classification is still safe"
  ]
 }
]
```

### EXCESSIVE_ABSTENTION (1 shown)
```json
[
 {
  "id": "MAINTENANCE_EXCLUSIONS#27",
  "engine": "BREACH_POSSIBLE",
  "oracle": "NO_BREACH",
  "bounds": [
   1890000,
   1900002
  ],
  "oracleBounds": [
   1890000,
   1900000
  ]
 }
]
```

<!-- TCF:RESULTS:END -->
