# Reality Gap Engine (RGE) and the RIGOR benchmark

*Detects when an agent's claimed outcome and the observed state disagree, then coordinates a verified recovery.*

Added in session 7 to the existing RIPPLE repository. The directive called the product "RIPPLE"; this repo is RIPPLE. Nothing was removed or renamed; the work is additive.

## What it is (and what it is not)
- **Is:** a pack-agnostic layer that runs consequential multi-system workflows under an execution contract. It compares three layers (intended, declared, observed), classifies disagreements as persisted gaps, plans recovery counterfactually, gates it on a hash-bound human approval, executes it with guarded writes, and verifies it again.
- **Connected systems are the Reality Lab sandbox** (`src/server/reality/lab.ts`): persisted, controlled "external systems" (payments, bookings, deploy, health, warehouse, and others). They are labelled in every API response and UI view as *not production integrations*. Faults are injected deterministically and labelled.
- **Agents are deterministic code** with enforced capabilities (`AGENTS` in `lab.ts`): a verifier or observer can only read; each executor can only write its own system; the planner, recovery, governance, adversary and memory agents cannot write at all. There is no LLM in this layer.
- **Switch: not connected.** Hand-offs are mirrored through the existing `CollabPort`. With no Switch server configured, that means LOCAL MODE, and the UI says so. On 2026-11-04 no Switch listener was found on ports 52041–52043.

## Files
| File | Role |
|---|---|
| `src/server/reality/states.ts` | Operation and workflow state machine. VERIFIED is reachable only from VERIFICATION_PENDING; a timeout goes to EXECUTION_UNKNOWN; VERIFIED → RECONCILIATION_REQUIRED models a stale completion. |
| `src/server/reality/types.ts` | Contract, fault, control and baseline definitions, and gap classes. |
| `src/server/reality/lab.ts` | Sandbox systems: capabilities, idempotency keys, compare-and-set writes, fault injection, the ground-truth effect log. |
| `src/server/reality/scenarios.ts` | 31 scenarios in 10 families (configuration, like packs). |
| `src/server/reality/rge.ts` | The engine: planner, governance, executors, verifier, reconciliation, gap detection, recovery planner, guarded recovery, passports, graph, mission-ledger audit. |
| `src/server/reality/benchmark.ts` | RIGOR: baselines, seeded case order, scoring against sandbox ground truth, metrics computed from `bench_cases` rows, CSV/JSON export. |
| `src/server/api/reality.ts` | The `/api/reality/*` and `/api/rigor/*` routes (workspace-scoped). |
| `src/web/pages/RealityPage.tsx` | The UI: Command Center, Split-Brain showcase, Gap Inbox, Causal Reality Explorer, Recovery Simulator, Proof-of-Outcome, RIGOR Lab. |
| Tables (`db/schema.ts`) | `rw_workflows`, `rw_operations`, `rw_handoffs`, `rw_observations`, `rw_approvals`, `rw_gaps`, `rw_recovery_plans`, `rw_passports`, `lab_resources`, `lab_effects`, `bench_runs`, `bench_cases`. All are `CREATE IF NOT EXISTS`, so no migration is needed. Every row carries `workspace_id`. |

The existing **causal ledger** (`causal_events`) is the event backbone. Every planning, approval, hand-off, execution, read-back, gap and recovery event is recorded there with `mission_id` = workflow id and parent links. Three cause types were added: `reality_gap`, `governance` and `agent_handoff`.

## Lifecycle of one workflow
1. **Planner** writes the contract: steps, post-conditions, preconditions, cross-system invariants and approval policy. It takes planning-time evidence for preconditions (mutable, with a TTL), and computes the plan hash.
2. **Governance** accepts only structured approvals from authenticated users with the right role. Each approval is bound to the plan hash and expires after 15 minutes. Two-person rules require distinct people. Message text is data, never an approval, and instruction-like text is flagged with `packs/untrusted.ts`. Authority is re-checked at execution time, so a demotion or plan amendment invalidates it.
3. **Evidence freshness.** Before a consequential step, preconditions are re-read. Evidence that changed is invalidated, and an *unreadable* source is **unknown, never "available"**.
4. **Hand-off** (Planner → Executor) is a structured record with task id, scope, criteria, expiry and failure handling. Durable hand-offs dedupe redeliveries and redeliver after a lost acknowledgement.
5. **Executor** writes with an idempotency key, using compare-and-set where declared. If the call errors, the engine **reads the effect back** before deciding: present means a lost response and is never repeated; absent means confirmed failure; unreadable means EXECUTION_UNKNOWN.
6. **Verifier** checks post-conditions with independent reads, re-reading up to 3 times to absorb replication lag. A tool's "success" is never proof on its own.
7. **Reconciliation** reads every watched resource and classifies gaps: `partial_commit`, `no_op`, `duplicate_effect`, `stale_completion`, `conflicting_completion` (an agent claim contradicted by reads), `unauthorized_mutation` (a writer with no authority), `unknown_outcome`, `delayed_consistency`, `lost_handoff`, `compensation_failure`, `invariant_violation`, plus the prevented classes `authorization_invalid` and `stale_evidence`. Each gap stores expected, declared and observed state, evidence ids, confidence and uncertainty, blast radius, causal predecessors, a cause hypothesis, investigation steps and the approval it needs.
8. **Counterfactual recovery planner** simulates each option on a copy of the observed state and re-evaluates the invariants:
   - *resume*: reuses the original idempotency key when the effect was never observed, and uses a corrective key when it was observed and later reversed by someone else;
   - *compensate*: irreversible steps are reported, never "undone";
   - *blind retry*: simulated to show the duplicate, then rejected by policy;
   - *escalate*.
   The **Adversarial reviewer** attaches objections, and they are preserved, not voted away.
9. A human **chooses** an option, then **approves** it; the approval binds to the chosen plan's hash. The guarded executor re-reads the simulated basis and refuses (re-plans) if anything changed. It runs at most 3 attempts, each after a read-back that confirmed absence. Customer-facing steps run only after the invariants are re-verified, and then everything is verified again: RECOVERED, or REQUIRES_HUMAN with a `compensation_failure` gap.
10. **Proof-of-Outcome passports** are issued per operation and per workflow, at decision points and at the end. Each body carries the intent, contract, plan version and hash, the approvals with their bound hash, actor capabilities, idempotency key, tool response, before and after observations, verifier log, failed conditions, recovery history and confidence. Each body is SHA-256-hashed over stable JSON; `GET /api/reality/passports/:id/verify` recomputes the hash, and a test shows tampering is detected.

The engine also re-audits the **existing mission action ledger** (`GET /api/reality/mission-audit`). It re-reads every executed or verified mission action from its connector and flags stale completions, duplicates, unknown outcomes and executions without approval.

## Running the split-brain showcase
UI path: **Reality Gap Engine → Split-Brain showcase → Start live workflow → Approve plan v1 → Run workflow**.
- The page shows *Agent declaration: COMPLETED* next to *Independently observed reality: PARTIALLY COMPLETED*.
- Open the Recovery Simulator, choose Resume, approve it, and click Execute guarded recovery.
- The result is RECOVERED, with exactly one payment capture, one booking (the original idempotency key) and one confirmation in the effect log.

The same flow is covered by `tests/reality.test.ts` and `tests/reality-api.test.ts`. Screenshots from a real browser run are in `docs/evidence/reality/`.

## RIGOR results (real run, not hardcoded)
- **Run:** started from the RIGOR Lab UI on 2026-11-04 on a fresh database.
- **Size:** seed `rigor-demo-1`, 31 scenarios × 4 baselines = 124 cases.
- **Exports:** `docs/evidence/reality/rigor-run.csv` and `rigor-metrics.json`.
- **Format:** each cell is numerator / denominator.

| Metric | B1 single agent | B2 hand-offs, no reconciliation | B3 approvals, no verification | B4 full layer |
|---|---|---|---|---|
| Verified completion | 3/17 | 3/17 | 10/17 | 17/17 |
| False success | 27/31 | 24/28 | 12/23 | 0/17 |
| Duplicate side effects | 6/44 | 6/41 | 0/39 | 0/34 |
| Unauthorized mutation | 2/44 | 0/41 | 0/39 | 0/34 |
| Stale evidence accepted | 5/6 | 5/6 | 5/6 | 0/6 |
| Approval bypass | 4/44 | 3/41 | 0/39 | 0/34 |
| Recovery success | 0/0 | 0/0 | 0/0 | 7/8 |
| Partial commit detection | 0/4 | 0/4 | 0/4 | 4/4 |
| Evidence completeness | 86/215 | 80/200 | 108/180 | 158/160 |
| Hand-off reliability | 44/45 | 41/42 | 39/39 | 34/34 |
| Reconciliation accuracy | 1/8 | 1/8 | 1/8 | 8/8 |
| Expected gap recall | 0/33 | 3/33 | 8/33 | 33/33 |

**How to read this honestly:**
- **The baselines are not other people's products.** They are the same runner with controls switched off; the exact switches are listed in the UI and in `types.ts`. No other repository was run.
- **Their failure modes are partly by construction.** For example, the no-reconciliation baselines trust an agent's completion claim. That aggregation rule is stated in the baseline description and in `rge.ts afterForward`.
- **Recovery success is 7/8 for B4.** `invoice-compensation-fails` deliberately injects a refund that is accepted but books nothing; the engine escalates (REQUIRES_HUMAN) instead of claiming consistency.
- **Evidence completeness is 158/160 for B4.** Two lost-response operations have no tool response because the call timed out; that is reported as missing, not filled in.
- **Median recovery time** (about 7–32 ms between runs) is in-process wall-clock time with scripted approvals. It is not a network or human-latency figure.
- **The suite is deterministic.** The same seed gives identical per-case counts (tested). The seed controls case order.

## Implemented vs roadmap
**Implemented and tested:**
- the state machine;
- governance: role, plan-hash binding, expiry, two-person rule, structured-only approvals, re-check at execution;
- evidence freshness;
- read-back on error;
- durable hand-offs;
- idempotency and compare-and-set;
- the gap classes listed above;
- counterfactual recovery with adversarial objections;
- hash-bound recovery approval;
- the basis-drift guard;
- guarded recovery with verification;
- passports with tamper detection;
- graph and traversal;
- re-audit (stale completion);
- the mission-ledger audit;
- RIGOR with 4 baselines and 13 metrics, CSV/JSON export;
- the UI surfaces;
- workspace export and deletion of the new tables;
- tenant isolation at the API layer (`tests/reality-api.test.ts`).

**Not built (roadmap, do not claim):**
- **Real Switch connection.** The adapter is still mock-tested only, and no Switch server was running.
- **Real external connectors** (payments, booking, deploy). Only the sandbox exists.
- **LLM agents.** All agents are deterministic.
- **Background reconciliation jobs and leases with wall-clock timeouts.** Hand-off leases and re-reads are logical; there is no sleep or backoff timer.
- **Concurrent execution.** It is sequential.
- **Encrypted secrets, scoped credentials and connection revocation** for real integrations.
- **Database-level row security.** Isolation is query discipline, tested at the API and engine layers.
- **Deeper capability work from the directive.** Context Keeper-style decision memory and briefings, schema lineage with SQL execution, PR/patch pipelines and scheduled digests appear only as benchmark scenarios. They are not product features.
- **A recorded video of the demo.** Only still screenshots exist.
