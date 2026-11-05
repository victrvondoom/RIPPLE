# Architecture

## Stack choice
Node 22 + TypeScript (strict), **Hono** HTTP API, **node:sqlite** (built in; no native build step; WAL), **zod** validation, **React + Vite** UI, **vitest** tests, Playwright for the e2e script. Chosen for a fast, dependency-light full-stack build that runs anywhere Node 22 runs. `node:sqlite` is flagged experimental by Node — see DECISIONS.md D-2.

## Boundaries
1. **Frontend** `src/web` — renders server read models; no business rules.
2. **API** `src/server/api` — auth, authorization entry checks, zod validation, CSRF checks, read models (`snapshot.ts`).
3. **Mission engine** `engine/engine.ts` — the only writer of mission state.
4. **Workflow-pack registry** `packs/registry.ts` (+ `types.ts` interface).
5. **Dependency & impact analysis** `engine/graph.ts` — builds the graph from a pack's declarative rules.
6. **Agent orchestration** inside `Engine.runAnalysis` — ordered handoffs (`pack.roleOrder`), each role returns a structured `RoleResult`.
7. **Switch adapter** `collab/` — `CollabPort` interface; `LocalCollab`, `SwitchCollab`.
8. **Action/connector execution** `connectors/` + `Engine.executeAction`.
9. **Verification & evidence** `Engine.verifyAction`, `engine/completion.ts`.
10. **Persistence & audit** `db/` (`Db`, schema) + `audit_events`.

## Data model (all tables carry `workspace_id`)
Workspace, User (role owner/manager/member/viewer), Session, Mission, Artifact (original plan + versioned drafts with provenance + content hash), BaselineVersion, ChangeEvent (`seq`, baseline version, structured `items`), GraphNode + Dependency (per `analysis_rev`; kinds change/artifact/task/department/owner/decision/action/evidence), WorkItem, AgentRole (+ AgentRun for status/output), CollaborationRoom, Message (handoff/finding/question/answer/approval_request/decision/status/escalation), Question, Approval, Action (idempotency key, payload hash, baseline/change/analysis versions), Acknowledgement, Evidence, Outcome, Connector, AuditEvent. Workflow packs are code (registry); `agent_roles` binds pack roles to workspace users.

## Mission state machine (`engine/states.ts`)
`draft → baseline_ready → analyzing → (blocked | awaiting_approval) → executing → verifying → completed`, plus `recovery_required`, `failed`, `cancelled`. `completed → baseline_ready` allows a later change. Transitions are validated; each is audited with a human-readable reason shown in the UI. After approvals/executions `Engine.reconcile` derives the state from observable action statuses (failed → recovery_required; approved-unexecuted → executing; proposed → awaiting_approval; all decided & ≥1 verified → verifying).

## Workflow-pack interface (`engine/types.ts: WorkflowPack`)
`id/name/domain/version/description`, `labels` (domain wording for generic UI), `roles`, `roleOrder`, `planSchema`, `changeSchema`, `artifacts` (+owner role & department), `rules` (change field → artifact), `artifactEdges`, `decisions`, `sample()` (labelled demo scenario), `detectChanges(plan, change, answers)`, `applyChange(plan, change, answers)`, `analyzeRole(role, ctx)`, optional `parseAnswer`, `verifyAction(action, observed, revisedPlan, {baselinePlan, change, answers})`, `completionChecks({baselinePlan, revisedPlan, change, answers, today})`. The engine contains no BEO or SceneShift knowledge; SceneShift was added with zero engine changes.

## Shared mechanisms added for the multi-pack platform (all generic, regression-tested)
- **Work-item prerequisites** (`dependsOn`): the engine refuses to mark an item done while a prerequisite is open (409).
- **Explicit evidence links** (`satisfiedBy`): completing item X auto-satisfies items declared as satisfied by X; recorded as audit event `evidence_linked`.
- **Approval levels**: each action declares `approvalRole` (`manager` | `owner`); the engine enforces it and the UI states who may decide.
- **Draft/action decoupling**: an action may reference a draft produced by any role in the same analysis revision.
- **Readiness completion**: packs add `completionChecks` evaluated on the *real* revised plan (MoveMate: all obligations done with evidence; SubmitReady: every applicable requirement evidence-verified).
- **Outcome record** lists *completed* items (verified actions, done work, acknowledgements, recorded human answers) and *unresolved* items.
- **Demo missions**: `POST /api/packs/:id/demo` builds a mission from the pack's labelled sample (optionally runs analysis).
- **Directory sync**: `syncDirectory` gives existing workspaces the roles/people of newly installed packs; `Db` adds missing columns on open.

## Pack summaries (what each actually computes)
| Pack | Core domain function | Blocking human input | Verification checks beyond the generic read-back | Completion extras |
|---|---|---|---|---|
| BEO Rescue | portions, ingredient deltas, staffing ratios, timeline, curfew/capacity, allergen flags | vegan count | revised guest count/time present; no safety-certification wording | reviews + acks |
| SceneShift | shot-scene invalidation, continuity chain, department tasks | — (reshoot vs ADR is a question) | expected heading present | reviews + acks |
| ScopeGuard | `classify()` against scope, allowances, exclusions; `effort()` from rate card | uncertain request → PM decides | CO lists every out-of-scope item and says "TO BE CONFIRMED"; client message has no price/deadline | client-acceptance review; owner-level approval of the CO |
| InvoiceGuard | `reconcile()` line-item comparison | FX rate when currency differs | neutral wording; every discrepancy recorded; "no payment initiated" | reviewer verification |
| ShiftRelay | `assess()` board-vs-handover, urgency score | status of omitted jobs | every unresolved job listed and assigned; callbacks listed | acks by outgoing + incoming + supervisor; callback confirmations |
| MoveMate | `assessMove()` deadlines, lead times, dependency propagation, evidence | owner of unowned obligation | no legal conclusions; every obligation listed; disclaimer; uncertain clauses flagged | all obligations done with evidence |
| PodFlow | `coverage()`, `candidates()` scoring, claim flags, platform limits | clip approval (bound to candidate set) | source label; clip timestamps; caption/title limits; flags travel with kit; no media-processing claim | creator reviews (claims, media check) |
| SubmitReady | `evaluate()` requirement status from evidence; consistency checks | owner of unowned deliverable | no VERIFIED line without verified evidence; statuses recomputed independently | every applicable requirement verified or human-confirmed N/A |

## Impact analysis
`detectChanges(baseline, change)` → `ChangeItem[]`. `buildImpactGraph` instantiates only nodes reached from those items via `rules` and `artifactEdges`, then attaches departments, owners and gating decisions. Unreached artifacts are reported as "checked, not affected". Role analyzers then add tasks, actions, evidence nodes link to verified actions. Graph rows are kept per `analysis_rev`.

## Version-aware execution
Each action stores `baseline_version`, `change_seq`, `analysis_rev`, `payload_hash`, `idempotency_key = sha256(ws|mission|effectKey|payloadHash)`. A new change or answer starts a new analysis rev: live actions (proposed/approved/failed) become `stale` with a reason, their approvals become `stale`, and execution/decision on them is refused (409). If a new proposal has byte-identical content to an already **verified** action, the proof is carried over and the effect is not repeated.

## Action execution & verification
Execute requires: action `approved` (or failed/verification_failed for retry), current version, a granted approval for consequential actions, manager/owner role. Connector `execute` is idempotent by key. Verification is separate and independent: `observe()` re-reads the effect; checks = exists, exactly one effect, approved text present byte-for-byte, pack checks (e.g. revised guest count/time present, no safety-certification wording), delivery-scope note. Only all-pass → `verified`. Failures create evidence rows, move the mission to `recovery_required`; retry is explicit and audited.

## Completion criteria (`engine/completion.ts`)
In `verifying`; no blocking questions; all current approvals decided; every current action verified or rejected (≥1 verified); none failed/stale; acknowledgements received; all `review` work items done. Non-blocking open questions and outstanding tasks are recorded in the outcome as unresolved. Completing writes baseline v(N+1) = baseline + change + answers.

## Switch integration boundary
Engine → `CollabPort` only. `SwitchCollab` speaks the documented agent protocol (see `docs/SWITCH.md`). RIPPLE keeps authority for state; Switch traffic is conversation. Failure to reach Switch degrades to a labelled local room and is audited.

## Security assumptions
Single-node deployment behind TLS terminated elsewhere; cookies are `HttpOnly; SameSite=Lax` (+`Secure` when `NODE_ENV=production`); scrypt password hashing; in-memory login throttling; workspace scoping by query discipline (tested, not enforced by DB row-level security); uploads are parsed as JSON in memory, size-capped, extension-allowlisted and never written to disk by name; connector paths are derived from sanitized ids. Not reviewed or penetration-tested.

## Mission Orchestrator (session 5)
Coordination rules: `src/server/engine/orchestrator.ts` (pure, pack-agnostic). Execution and persistence: `Engine.runAnalysis` -> `Engine.orchestrate()`.
- **Tasks.** Each role run is a `workflow_tasks` row: queued -> running -> done | reused | failed | rejected | interrupted | timed_out | cancelled. Tasks carry pass, kind (analysis | reanalysis), reason, requested_by, depends_on, fingerprint, run_id and reused_from.
- **Fingerprints.** `roleFingerprint(pack, role, ctx)` hashes the role's declared inputs (`pack.roleInputs`, default: change, items, answers, revised plan) plus the outputs of its dependencies (`pack.roleDeps`, default: every earlier role). A role whose fingerprint matches its last completed run reuses that result and is not re-run.
- **Passes.** Pass 1 plans every role in roleOrder. After each pass, roles whose fingerprint changed are re-run in the next pass. Convergence = nothing changed. The loop is bounded by MAX_PASSES = 3; on the bound the orchestrator stops and creates a blocking question for the human manager (`iteration_limit_<rev>`). No actions are created in that case.
- **Requests.** `RoleResult.requests` are agent-to-agent messages. A request is honoured only when its target's inputs changed; otherwise it is audited as converged.
- **Validation.** Every role output is validated (`validateRoleResult`) before it can change state: schema, roleKey identity, request targets, work-item roles, unique draft kinds. A rejected output creates no drafts, actions or questions and raises a blocking question for a human.
- **Human control.** Pause (manager) stops before the next task and refuses changes, answers and executions; resume re-runs unfinished work and reuses completed agents. Retry analysis, reassign work item (audited), cancel (cancels queued and running tasks).
- **Recovery.** `recoverInterrupted()` on boot: running tasks become interrupted and missions in `analyzing` become blocked and resumable. `sweepStaleTasks()` every 15 s: running tasks older than TASK_TIMEOUT_MS become timed_out and escalate.
- **Audit.** Orchestration events are rows in `audit_events` with `orch_*` types; no second event table.
- **Read model.** `missionDetail().orchestration` and `agents[].task` feed the Orchestration tab (`src/web/pages/Orchestration.tsx`). The UI polls every 3 s; it stores no mission state.
- **Packs.** BEO declares `roleDeps` (the Event Manager depends on the four departments) and `roleInputs` (Service ignores menu, dietary and supplier data). Other packs use the defaults and are unaffected.
