# TCFB results (generated — do not edit by hand)

Engine 1.0.0, seed 20261107, 3000 cases (150 × 20 categories), MDE sampled on up to 10 undecided cases per category. Run time 76.4 s.
Regenerate: `npx tsx bench/temporal-contract-forensics/run.ts 150 10`.

## Safety
| metric | value |
|---|---|
| **False confirmed breach rate** (engine CONFIRMED, truth no breach) | **0.00% (0/1402)** |
| … with honest evidence only | 0.00% (0/1259) |
| … in cases containing deliberately falsified evidence | 0.00% (0/143) |
| Precision of BREACH_CONFIRMED | 100.00% (1077/1077) |
| False NO_BREACH rate (engine NO_BREACH, truth breach) | 0.00% (0/1256) |
| … with honest evidence only | 0.00% (0/1099) |

## Classification against the independent oracle
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

## Temporal bounds
| metric | value |
|---|---|
| Bounds contain the hidden true downtime (honest evidence) | 100.00% (2354/2354) |
| Bounds contain the oracle's exact bounds | 100.00% (2654/2654) |
| Bounds labelled EXACT equal the oracle | 100.00% (2654/2654) |
| Both bounds proven tight (EXACT) | 95.63% (2538/2654) |
| Duplicate-duration prevention (no inflated minimum, duplicate/overlap categories) | 100.00% (300/300) |
| Contract-rule categories: agreement with oracle | 99.92% (1199/1200) |
| Evidence-gap detection: mean recall / precision (measure-weighted) | 1 / 1 |

## Minimum decisive evidence (acquired from the hidden truth)
| metric | value |
|---|---|
| Sampled undecided cases | 155 |
| Top-ranked request decides the case | 76.13% (118/155) |
| Top-ranked request decides it correctly | 76.13% (118/155) |
| Baseline: uniformly random listed request decides | 38.71% (60/155) |
| Baseline: random request decides correctly | 38.06% (59/155) |
| ALWAYS_DECISIVE guarantee held | 100.00% (2/2) |
| Top request kinds | OBSERVE_INTERVAL: 150, RESOLVE_TIMESTAMP: 4, CONFIRM_EXCLUSION: 1 |

## Dynamics and reproducibility
| metric | value |
|---|---|
| Late-arriving evidence: incremental revisions = batch analysis (output hash) | 100.00% (141/141) |
| Identical input → identical output and revision hash | 100.00% (3000/3000) |
| Evidence order does not change the output hash | 100.00% (3000/3000) |
| Engine time per analysis: mean / p95 / max | 3.44 ms / 2.81 ms / 719.22 ms |

## Confusion: engine × oracle
| engine \ reference | BREACH_CONFIRMED | BREACH_POSSIBLE | NO_BREACH | INDETERMINATE | NOT_APPLICABLE |
|---|---:|---:|---:|---:|---:|
| BREACH_CONFIRMED | 1077 | 0 | 0 | 0 | 0 |
| BREACH_POSSIBLE | 0 | 303 | 1 | 0 | 0 |
| NO_BREACH | 0 | 0 | 1253 | 0 | 0 |
| INDETERMINATE | 0 | 0 | 0 | 216 | 0 |
| NOT_APPLICABLE | 0 | 0 | 0 | 0 | 150 |

## Confusion: engine × hidden truth
| engine \ reference | TRUE_BREACH | TRUE_NO_BREACH | NOT_DECIDABLE |
|---|---:|---:|---:|
| BREACH_CONFIRMED | 1077 | 0 | 0 |
| BREACH_POSSIBLE | 169 | 135 | 0 |
| NO_BREACH | 0 | 1253 | 0 |
| INDETERMINATE | 10 | 14 | 192 |
| NOT_APPLICABLE | 0 | 0 | 150 |

## Per category
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

## Failure examples
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
