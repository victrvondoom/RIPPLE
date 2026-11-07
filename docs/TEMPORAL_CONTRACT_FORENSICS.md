# Temporal Contract Forensics (TCF)

An evidence-bounded SLA decision engine. Given one contract and a set of time-uncertain, incomplete and possibly
contradictory observations of an incident, it computes **what contractual exposure is proven, what is merely possible,
what evidence is missing, and the minimum additional evidence that would decide the case**. It never picks a single
"downtime number" and never assigns a probability.

| | |
|---|---|
| Code | `src/server/capabilities/temporal-contract-forensics/` (pure TypeScript, no I/O, no model calls, no new dependencies) |
| Tests | `tests/temporal-contract-forensics/` (81 tests; run with `npx vitest run tests/temporal-contract-forensics`) |
| Demo | `npx tsx scripts/temporal-contract-forensics-demo.ts` (fixture in `fixtures/temporal-contract-forensics/`) |
| Benchmark | `npx tsx bench/temporal-contract-forensics/run.ts` — see [`TCF_BENCHMARK.md`](TCF_BENCHMARK.md) |
| Status | Standalone capability. **Not registered in the engine, packs, API or UI.** Integration is via the adapter contract below. |

## 1. Module map

| File | Responsibility |
|---|---|
| `types.ts` | Public types: evidence, contract, policy, results, revisions, counterfactuals, MDE |
| `time.ts` | Exact ISO-8601 parsing (offset required), formatting, IANA month windows (DST-safe) |
| `intervals.ts` | Interval algebra over integer ms (normalise, union, intersect, subtract, measure, overlap, clip, merge, bucketise) |
| `hash.ts` | Canonical JSON, SHA-256 content addresses, deep freeze |
| `contract.ts` | Contract semantics compiler: validation, hashing, version selection, exact threshold/availability/credit arithmetic |
| `qualify.ts` | The contractual measure μ (exclusions, granularity, flapping merge, minimum episode, grace, aggregation, rounding) |
| `evidence.ts` | Evidence normalisation: clocks, drift, duplicates, scope, authority, staleness, transition assembly, relevance |
| `conflicts.ts` | Contradiction detection and documented authority resolution |
| `bounds.ts` | Branch-and-bound over correlated clock offsets: exact extremes of μ over all consistent timelines |
| `analysis.ts` | Orchestration, exclusion scenarios, joint-infeasibility handling, classification, result assembly |
| `sensitivity.ts` | Minimum Decisive Evidence |
| `counterfactual.ts` | Deterministic, labelled counterfactuals |
| `revisions.ts` | Content-addressed, hash-chained analysis revisions (add / correct / retract) |
| `diff.ts` | Decision-relevant field diff |
| `index.ts` | Public entry point `createTemporalContractForensics()` |

## 2. Temporal evidence model

```ts
interface TemporalEvidence {
  id: string; incidentId: string;
  scope: { service; region?; customer?; semantics?: 'UNIVERSAL' | 'AGGREGATE' };
  source: { system; recordId; authority: AuthorityClass; clockId?; signatureVerified? };
  assertion:
    | { kind: 'INTERVAL'; state; start: TimeBound; end: TimeBound }   // state held throughout [start, end)
    | { kind: 'POINT'; state; at: TimeBound }                         // state held at one instant
    | { kind: 'TRANSITION'; to: state; at: TimeBound; holdsUntil? };  // state changed; assembled per source
  observedAt: string; ingestedAt?: string;
  provenance: { reference; contentHash };
}
interface TimeBound { earliest: string; latest: string }  // ISO-8601 WITH offset, in the source's clock
interface ClockProfile { clockId; knownOffsetMs; uncertaintyMs; driftPpm?; lastSyncAt? }
```

States are `HEALTHY | DEGRADED | UNAVAILABLE | UNKNOWN`. The contract decides which states qualify as downtime
(`UNAVAILABLE`, optionally `DEGRADED`); a record therefore asserts that the true state was either **qualifying (Q)**
or **non-qualifying (N)** over its interval/instant. `UNKNOWN` asserts nothing and is reported as an explicit gap.
"Recovered" is a `TRANSITION` to `HEALTHY`.

**Uncertainty model.** For an endpoint read as `r` on clock `c`:

```
true time = r − knownOffset(c) + δ(c) + ε
δ(c) ∈ [−U_c, +U_c]   one unknown offset SHARED by every record of clock c   (U_c = residual + drift since last sync)
ε    ∈ [lo, hi]       independent per endpoint: the record's own [earliest, latest] (+ drift accumulated in the window)
```

Sharing δ across a clock's records is what "maintain valid relationships between related observations" means
mathematically: a monitor that measured 40 minutes between two of its own records measured 40 minutes, wherever its
clock was. The engine never pairs the earliest admissible time of one record with the latest of another record from
the same clock unless a single offset allows it.

**Normalisation preserves originals.** The input evidence is never modified; the engine derives constraint records
and returns one `EvidenceAssessment` per input record (`USED / SET_ASIDE / EXCLUDED / NOT_APPLICABLE / DUPLICATE` plus
machine-readable issue codes). Retracted and superseded records remain listed.

| Situation | Handling |
|---|---|
| Timestamp uncertainty, clock offset, drift | as above; a clock without a profile gets `policy.defaultClockUncertaintyMs`, disclosed (`MISSING_CLOCK_METADATA`) |
| Delayed ingestion | flagged `DELAYED_INGESTION`; event time is used, never arrival time |
| Stale observation | flagged `STALE_OBSERVATION`, kept |
| Out-of-order events | transitions are ordered by event time; overlapping time ranges flagged `AMBIGUOUS_TRANSITION_ORDER` |
| Missing observations | time no record speaks for is *possibly down*; reported in `envelope.evidenceGaps` |
| Duplicates | same source system + record id + content, or same raw content hash ⇒ `DUPLICATE`, counted once |
| Same source id, different content | `RECORD_ID_COLLISION`: both set aside until a correction event says which is right |
| Scope | a record applies when its scope covers the contract scope; narrower scopes and other regions/customers do not; `AGGREGATE` health does not speak for a narrower scope |
| Event after its own observation time | `EVENT_AFTER_OBSERVATION`, excluded |
| Missing source/provenance | excluded; the engine never invents a source |
| Unverified "signed" record | treated as `UNVERIFIED_MANUAL` |
| Contract evidence requirement | Q records from non-accepted authorities cannot establish downtime |
| Open transition | establishes the state only at its instant (`OPEN_TRANSITION`) unless `holdsUntil` is given |

## 3. The Temporal Evidence Envelope

Let `Q` be the measured period (window ∩ contract effective period, minus applied exclusions) and θ = (δ_c) the vector of
unknown offsets of clocks with `U_c > 0`. For fixed θ:

```
Down(θ) = ∪ [sHi + δ, eLo + δ)  over Q intervals      (each interval shrunk to its latest start / earliest end)
Up(θ)   = ∪ [sHi + δ, eLo + δ)  over N intervals
θ is feasible ⇔ |Down(θ) ∩ Up(θ)| = 0, every Q point can lie outside Up(θ), every N point outside Down(θ)
```

A *timeline* is a set D of qualifying time. D is consistent with the evidence iff for some feasible θ,
`Down(θ) ⊆ D ⊆ complement(Up(θ))`. Because the contractual measure μ is monotone (D₁ ⊆ D₂ ⇒ μ(D₁) ≤ μ(D₂); proven step
by step in `qualify.ts` and property-tested on 3,000 random cases):

```
minimum downtime  m⁻ = min over feasible θ of μ(Down(θ) ∩ Q)
maximum downtime  m⁺ = max over feasible θ of μ(Q \ Up(θ))
```

These are the exact extremes over every consistent timeline, at integer-ms resolution. The envelope also reports
the sets behind them: certain qualifying time (in every timeline, cited to the evidence establishing it), known
non-qualifying time, possible downtime, undecided segments with their causes (`TIMESTAMP_UNCERTAINTY`,
`CLOCK_OFFSET`, `NO_EVIDENCE`, `SET_ASIDE_EVIDENCE`, `POSSIBLE_EXCLUSION`), evidence gaps and exclusions.

### Classification (per exclusion scenario c with breach point M_c)

`M_c` is the smallest integer downtime that is a breach (`T+1` for "exceeds T", `T` for "at least T", and for
availability targets the exact integer derived with BigInt arithmetic from the measured period of scenario c).

| Classification | Definition |
|---|---|
| `NOT_APPLICABLE` | no contract version is effective in the window, or the incident is outside the contract's scope |
| `INDETERMINATE` | a blocking contract review requirement; no applicable evidence; no consistent timeline exists; or an **unresolved** contradiction whose robust envelope still straddles the breach point |
| `BREACH_CONFIRMED` | `m⁻_c ≥ M_c` in **every** scenario — every consistent timeline breaches |
| `NO_BREACH` | `m⁺_c < M_c` in **every** scenario — no consistent timeline breaches |
| `BREACH_POSSIBLE` | otherwise — the evidence admits both |

Unconfirmed maintenance windows are enumerated exactly (2^k scenarios, k ≤ `policy.maxUnconfirmedExclusions`).
The decision-sensitive width is `m⁺ − m⁻` for straddling scenarios; the result also states the additional
established downtime needed to confirm (`M − m⁻`) and the possible downtime that must be eliminated to rule out
(`m⁺ − M + 1`). Credit exposure is `[credit(m⁻), credit(m⁺)]` (credit is monotone in downtime), with tiers and cap in
exact integer minor units. When classification is conclusive, the engine states that additional *consistent*
evidence can only narrow the bounds, so only a retraction, correction or contract change could alter it.

## 4. The interval-reasoning algorithm

1. **Interval algebra** (`intervals.ts`): half-open `[s, e)` integer intervals, normalised sets (sorted, disjoint,
   non-adjacent). All operations are linear or `O(n log n)`; measure is of the union, so overlapping intervals are
   never double counted. Equivalence with a bitmap model is property-tested on 2,000 random cases.
2. **Relaxation** for a box B of offsets: every record takes its worst offset independently,
   `ForcedDown(B) = ∪ [sHi + δhi, eLo + δlo) ⊆ Down(θ) ∀θ ∈ B`. μ of it is a sound lower bound of the minimum on B;
   symmetrically for the maximum. On a single-point box it is exact.
3. **Rigid-body bound** (plain cumulative measures): records of one clock move together, which the relaxation ignores.
   For every subset S of clock groups, Bonferroni's inequality
   `|∪ X_i| ≥ Σ min|X_i ∩ Q| − Σ max-overlap(X_i, X_j)` holds; `min |X_i(δ) ∩ Q|` and the pairwise maximum overlap
   (a function of the relative offset only) are continuous piecewise-linear and are computed exactly at their
   breakpoints. The best subset is used. This lets the search prove flat optima that the relaxation alone cannot.
4. **Constraint propagation**: every Q/N pair (and every point against a clock's opposite union) forbids a set of
   relative offsets `ρ = δ_A − δ_B`. Boxes are pruned when a pair has no admissible ρ and narrowed to the hull of
   admissible offsets (bounds consistency, iterated to a fixpoint).
5. **Branch and bound** (best-first, strong branching on the dimension whose split tightens the bound most,
   exact evaluation of box centres and vertices). It stops with `EXACT` when no open box can beat the incumbent. If the
   node budget (`policy.maxBranchNodes`, default 800) runs out, it reports the best **open relaxation** — a proven
   bound — labelled `SOUND_NOT_TIGHT`. If a non-tight bound is exactly what leaves the breach question open, a
   decision-directed refinement searches again (10× budget) only until "is the extreme ≥ M?" is settled.
6. **Contradictions** (`conflicts.ts`): a Q/N pair contradicts *definitely* when it overlaps under every admissible
   offset (closed form in ρ). If the authority ranks differ by ≥ `resolveByAuthorityMinGap` the lower record is set
   aside; otherwise both are (robust handling: any conclusion must hold whichever is wrong). If no single pair
   contradicts but **no** offset assignment is consistent (joint infeasibility), the engine looks for the lowest-
   authority record(s), at least the gap below the group's top authority, whose removal restores consistency; if
   none, the whole inconsistent group is set aside and the result is contested.

**Complexity.** Normalisation and conflicts: `O(n²)` pairs. Each B&B node: `O(k · n log n)` plus the rigid bound
`O(2^g · m²)` for g ≤ 6 clock groups. Nodes ≤ budget, so worst case `O(budget · k · n log n)`; zero uncertain clocks
take one evaluation. Exclusion scenarios multiply by `2^u`. The general problem (minimum union of rigidly shifting
interval families under disjunctive constraints) is a non-convex combinatorial optimisation; the engine is exact
when its proof closes and soundly bounded otherwise, and says which.

**Exactness evidence.** On 300 random cases with up to two uncertain clocks the engine is compared with an exhaustive
search (offsets on the 10 s lattice ± 1 ms, independent sweep measure); every bound labelled `EXACT` equals it and
every bound is sound (`tests/temporal-contract-forensics/invariants.test.ts`).

## 5. Contract semantics compiler

Contracts are structured data (`ContractDocument`), never free text. The compiler validates every field the decision
depends on and **refuses to default**: a missing threshold, undefined qualifying states, an invalid time zone or an
unversioned contract is a blocking `ReviewRequirement` (`INDETERMINATE`), never a guess.

Supported: effective period (`effectiveFrom`, exclusive `effectiveTo`); service/region/customer scope; measurement
period `INCIDENT_WINDOW` or `CALENDAR_MONTH` in an IANA zone (DST-safe month boundaries); metric
`CUMULATIVE_DOWNTIME` or `LONGEST_CONTINUOUS_DOWNTIME`; qualifying states; granularity buckets
(`ANY_DOWNTIME_IN_BUCKET`, `ENTIRE_BUCKET_DOWN`); flapping merge gap (with or without counting the gaps); minimum
qualifying episode; grace period per episode; rounding (`FLOOR`, `CEIL`, `NEAREST_HALF_UP`); thresholds
`DOWNTIME_EXCEEDS` or `AVAILABILITY_BELOW` (exact decimal strings, BigInt arithmetic, inclusive/exclusive); credit
tiers and cap (integer minor units); maintenance notice rule (exclusion only with sufficient, recorded notice;
region-specific windows); evidence requirements (which authorities may establish downtime); free-text clauses —
only `INFORMATIONAL` is understood, anything else is a blocking `UNSUPPORTED_CLAUSE` review item quoting the text.

**Versions.** Every contract has a version and a content hash (declared hashes are verified). The version is selected
by effective dates for the measurement window — never "the latest". A window outside every version is
`NOT_APPLICABLE`; a version boundary inside the window with different terms is a blocking review item (the window is
not split silently); partial coverage is clipped and disclosed.

## 5a. Evaluation order of μ (`qualify.ts`)

`S = D ∩ Q` → bucketise (aligned to the measured window start) → episodes merged across recoveries shorter than the
merge gap → drop episodes shorter than the minimum, subtract grace → Σ or max → round. Every step is monotone.

## 6. Minimum Decisive Evidence

For an undecided analysis, every candidate request is turned into its possible outcomes, and each outcome is applied
as a hypothetical change and the decision **recomputed exactly**:

| Request | Outcomes evaluated | Guarantee basis |
|---|---|---|
| `RESOLVE_TIMESTAMP` (one endpoint of one record) | the two extremes of its uncertainty | bounds are monotone in one endpoint, so the extremes cover every value between (`EXACT_EXTREMES`) |
| `RESOLVE_CLOCK_OFFSET` | 5 sampled offsets | offset effect is not monotone (`SAMPLED`, never claimed `ALWAYS_DECISIVE`) |
| `CONFIRM_EXCLUSION` | valid / not valid | `ENUMERATED` |
| `RESOLVE_CONFLICT` | either side correct | `ENUMERATED` |
| `OBSERVE_INTERVAL` (an undecided segment) | uniformly down / uniformly healthy | `ENUMERATED` over those two; mixed outcomes not evaluated, so never `ALWAYS_DECISIVE` |
| shortest anchored observation | "down until t" / "healthy from t" etc. | exact boundary: grid scan + binary search over integer ms, verified by evaluation |

Outcomes that would contradict evidence currently in use are reported but marked inconsistent and ignored for the
guarantee. Requests are ranked by guarantee (`ALWAYS_DECISIVE` > `DECISIVE_IN_SOME_OUTCOMES` > `NARROWS_ONLY` >
`NO_EFFECT`), exactness, worst-case residual decision-sensitive width, best case, then the amount of observation
requested — never by age or a fixed importance list. When no single request always decides, pairs of exact requests
are searched for combinations that decide under every outcome. The report also names **blockers**: evidence that any
decisive observation would have to contradict (e.g. "ruling the breach out would contradict ev-c1").

## 7. Counterfactuals

`SHIFT_TIME`, `SET_TIME_BOUND`, `INGESTION_DELAY` (the event may have happened up to d before it was recorded),
`SET_CLOCK`, `SET_AUTHORITY`, `SET_EXCLUSION_STATUS`, `EXCLUDE_EVIDENCE` (reason required), `ADD_EVIDENCE` (provenance
prefixed `hypothetical:`), `SET_SCOPE_SEMANTICS`. Each counterfactual starts from a revision's exact ledger and
context, applies only the listed changes (all-or-nothing: one invalid change ⇒ `IMPOSSIBLE`, no partial result),
recomputes, and returns the diff, per-change attribution, changed evidence use and a `HYPOTHETICAL` label. The base
revision is frozen and verifiably unchanged.

## 8. Versioned evidence updates

`open(input, { at })` creates revision 1; `update({ previous, event })` applies `ADD_EVIDENCE`, `CORRECT_EVIDENCE`
(supersedes; needs a reason and a new id) or `RETRACT_EVIDENCE` (needs a reason). The ledger is append-only.

```
evidenceSetHash = H(active evidence, sorted)         ledgerHash = H(every entry, with status and notes)
outputHash      = H(result)                          revisionHash = H(revision, parent, the hashes above, createdAt, reason, summary)
```

Each revision records its number, parent hash, the four hashes, creation time (supplied by the caller — the engine
never reads a clock), change summary, reason and the decision-relevant `changedFields`. `verify(rev)` re-derives the
result from the revision's own ledger and context and checks every hash; `update` refuses a revision that fails
verification or an event received before the revision it updates. An exact re-delivery returns the same revision
(idempotent). Incremental updates end at the same `outputHash` as one batch analysis of the same evidence, in any
order (tested, and measured in TCFB).

## 9. Source authority and conflicts

Default ranks (configurable per analysis, included in the policy hash): `SIGNED_MONITORING 6`,
`AUTHENTICATED_INFRASTRUCTURE 5`, `SYNTHETIC_PROBE 4`, `ENGINEERING_INCIDENT_REPORT 3`, `SUPPORT_TICKET 2`,
`CUSTOMER_REPORT 2`, `UNVERIFIED_MANUAL 1`; resolution gap 2. Rationale: authenticated machine records outrank
human-authored timelines; customer and support reports rank together. Lower-authority evidence is never discarded
silently: it is set aside *for the computation*, stays in the output with the conflict id and a machine-readable
explanation, and can be reinstated by a counterfactual. No language model participates in any classification.

## 10. Integration contract (for the RIPPLE workflow, via an adapter)

```ts
import { createTemporalContractForensics } from '../capabilities/temporal-contract-forensics/index.js';
const tcf = createTemporalContractForensics();
let rev = tcf.open({ contract, evidence, measurementWindow, clocks, maintenance, incident }, { at: receivedAtIso });
rev.result.classification;                       // BREACH_CONFIRMED | BREACH_POSSIBLE | NO_BREACH | INDETERMINATE | NOT_APPLICABLE
rev.result.bounds; rev.result.credit;            // proven bounds and credit exposure range
tcf.minimumDecisiveEvidence({ analysis: rev });  // ranked EvidenceRequirement[]
rev = tcf.update({ previous: rev, event });      // new hash-chained revision
tcf.counterfactual({ analysis: rev, changes });  // labelled hypothetical, never stored as the analysis
tcf.verify(rev);                                 // reproducibility check
```

Suggested adapter mapping (not implemented here — the main application is untouched by this assignment):

| RIPPLE concept | TCF |
|---|---|
| Billing pack outage log (`outage.start/end`), monitoring exports, LB logs, incident timeline, customer emails | `TemporalEvidence[]` with authority classes and clock ids |
| Billing pack `SLA-4.2` clause | `ContractDocument` (availability tiers → `AVAILABILITY_BELOW` thresholds, credit tiers, cap) |
| A credit `ActionSpec` | allowed only for `BREACH_CONFIRMED`; amount within `result.credit` |
| `BREACH_POSSIBLE` / `INDETERMINATE` | a blocking question to the owning human role, listing `minimumDecisiveEvidence` requests |
| New evidence in a mission | `update()`; store `revisionHash` with the mission so approvals bind to the analysis that was shown |
| Reviewer "what if" | `counterfactual()`; show the `HYPOTHETICAL` label |

This fits RIPPLE's rules: the decision is a deterministic analyzer output (`RoleResult`-compatible), approvals can
bind to `revisionHash`, nothing claims a credit is owed without proof, and the customer-facing message can quote
proven bounds instead of a point estimate.

## 11. Assumptions and known limitations

- **The model, not reality, is proven.** Bounds are exact *given* the evidence semantics: interval records assert their
  state continuously; declared uncertainties are honest. A failure shorter than a monitor's sampling interval cannot
  be seen. A source that lies *within* its declared uncertainty, or lies where no other record can contradict it, can
  move the bounds; TCFB measures this explicitly.
- Instantaneous observations carry no measurable duration; with granularity buckets this is conservative (the minimum
  may be lower than an "any failure in the bucket" reading of a point would give).
- Bounds can be `SOUND_NOT_TIGHT` when the node budget runs out (most often with 3+ uncertain clocks or non-plain
  measures such as grace/minimum episode with uncertain clocks); they are still proven bounds, and the decision is
  refined when the gap matters for the threshold. The general problem is not solved in polynomial time.
- Clock offsets are constant per clock within an analysis apart from bounded drift; drift between records is treated
  as independent per-endpoint uncertainty (sound, not tight).
- Joint-infeasibility resolution identifies whole records, not the smallest blameworthy subset of claims; it removes
  at most a rank class of records.
- A contract applies to one service/region/customer cell; multi-region aggregation rules, availability computed
  across several regions, contractual "per incident" counting across windows and business-hours calendars are not
  supported and must be expressed as separate analyses or raised as review items.
- Maintenance windows have exact (certain) times; uncertain maintenance boundaries are not modelled.
- MDE explores single requests and pairs; it does not search larger combinations, and mixed outcomes of an
  observation are not evaluated (so observations are never claimed `ALWAYS_DECISIVE`).
- Credit computation is a policy calculation for human approval; nothing in this module moves money or sends anything.
