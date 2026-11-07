# AGENTS.md — RIPPLE

Read this first. Then read `progress.md` (resume point) and `docs/ARCHITECTURE.md`.

## Product vision
RIPPLE is one centralized workflow & intervention platform: *one change → every consequence identified → every responsible person coordinated → every approved action verified.* It is NOT a chatbot or a generic task manager. One engine, one data model, one dependency graph, one approval/action/evidence ledger; **domain packs are configuration**, never separate apps.

## Architecture (one line each — details in docs/ARCHITECTURE.md)
- `src/server/engine/` mission engine (state machine, baselines, changes, analysis orchestration, approvals, actions, verification, completion). **Pack-agnostic.**

- `src/server/collab/` `CollabPort` boundary; `local.ts` (labelled local mode), `switch.ts` (Switch agent-protocol adapter).
- `src/server/connectors/` file-backed local connectors (document store, internal outbox, email dry-run) with idempotency + read-back `observe()`.
- `src/server/agents/provider.ts` model-provider abstraction (deterministic default; optional Anthropic wording-only).
- `src/server/api/` Hono HTTP API + read models (`snapshot.ts`). `src/server/db/` SQLite (`node:sqlite`).
- `src/web/` React UI (no business logic; it renders server read models).

## Conventions
- TypeScript strict. Business rules live in `engine/` or `packs/`, never in React components.
- Every tenant-owned row has `workspace_id`; every query filters by it. Never add an unscoped query on tenant tables.
- State changes ONLY via `Engine.transition()` (validated by `engine/states.ts`) and always audited.
- New domain = new `WorkflowPack` object registered in `packs/registry.ts`. If you need to change the engine for a pack, ask whether the abstraction is wrong first.
- Agent/analyzer output is structured (`RoleResult`) and labelled with its analyzer id; deterministic vs model output must stay distinguishable.

## Run / test
```bash
npm install
npm run start          # builds the web app and serves everything on http://localhost:8787
npm test               # vitest (engine, packs, API, Switch adapter vs mock)
npm run typecheck && npm run lint
scripts/fresh-server.sh && node scripts/e2e.mjs            # BEO + SceneShift browser journey on a throw-away DB
node scripts/e2e-packs.mjs <scopeguard|invoiceguard|shiftrelay|movemate|podflow|submitready>   # one pack's browser journey
node scripts/e2e-crossdomain.mjs                           # all packs in one Control Center
BASE_URL=http://localhost:8791 node scripts/e2e-flipside.mjs   # Flipside review journey (author answers, approves, proof OK / PROOF_FAIL)
npx tsx bench/pkgguard/05-evaluate.ts heldout                  # package-risk benchmark, offline from committed data
```

## Package Gate and the package-risk benchmark (session 18)
- `capabilities/pkgguard` is pure; `observe.ts` is the only code that touches registries, and it reads archives in memory only. Never install, extract to disk, import or run a package, in code or in the benchmark.
- Detection numbers may only come from `bench/pkgguard/results/metrics-heldout.json`. Change code rules only on the tuning split, bump `INSPECT_RULES_VERSION`, commit, then re-run held-out; disclose any change made after a held-out run.
- "clean" means no rule matched, never safe. A flagged package without a code reading is "not inspected". Package decisions bind to ecosystem + name + exact version.
Dev users (password `RIPPLE_SEED_PASSWORD`, default `ripple-demo`): maya@ (manager), luis@ (chef), priya@, dan@, sam@ (owner), vera@ (viewer) `@harborvine.example`.

## Adding or changing a pack (read before touching `packs/`)
A pack is one `WorkflowPack` object (`engine/types.ts`): schemas, roles + `roleOrder`, artifact catalog, propagation `rules`/`artifactEdges`/`decisions`, `detectChanges(plan, change, answers)`, `applyChange`, `analyzeRole` (returns `RoleResult` via the `Out` builder in `packs/common.ts`), optional `parseAnswer`, `verifyAction(action, observed, revisedPlan, ctx)`, `completionChecks(ctx)`, `labels`. Rules of thumb: derive statuses only from recorded data/evidence; ask a *blocking* question (and propose no actions) when a human decision is missing; keep question keys stable per decision (bind approvals to what was shown, see PodFlow `clip_selection_<fp>`); state the limits of what the pack did not do in its drafts; write a `verifyAction` that re-checks the *domain promise* (e.g. no price in client message); never branch on pack id in the engine/UI. Map every human role in `seed.ts` and add pack tests (the cross-domain test enforces sample validity and no orphan roles).

## Hard rules — no fake functionality, no false completion claims
1. Switch integration is ACTIVE (postponement lifted by the owner, session 13). Never claim a Switch capability works unless it was exercised against a real Switch server. What HAS been exercised against the local switch-core 0.31.0 (Switch Console): agent registration, `create_room` (agent-only `internal_only` rooms), events stream, `connect_to_room`, heartbeat, `post_message`, `send_targeted_message`, room history read-back, a second agent replying and RIPPLE receiving it, and a full consumer-resolution mission (`scripts/switch-live.ts`, `scripts/e2e-consumer-switch.mjs`, evidence in `docs/evidence/`). NOT yet exercised: Mattermost-bridged rooms with humans in chat (the bridge was not running). Unit tests still use a mock (`tests/switch*.test.ts`). Say exactly which.
2. An action is `verified` only when `Engine.verifyAction` independently re-reads the real effect. Never set action status from an agent's claim.
3. A mission completes only through `evaluateCompletion` (all criteria met). Do not bypass it.
4. Agents may flag allergen risks / missing info for qualified human review. They must never certify food safety (a verifier check also enforces wording).
5. Connectors are local/dry-run. Do not describe them as sending real email/chat or paying/submitting anything. Packs must never claim a requirement is satisfied without recorded evidence, never promise price/dates (ScopeGuard), never move money or accuse (InvoiceGuard), never give legal conclusions (MoveMate), never claim media was processed (PodFlow).
6. Do not claim tests/e2e passed without running them; paste real output into `docs/TESTING.md`/`progress.md`.
7. No secrets in git. `.env` is ignored; `.env.example` documents variables.
8. Label limitations honestly (see "Known limitations" in `progress.md`).

## Current implementation status
See `progress.md` (authoritative) and `docs/IMPLEMENTATION_PLAN.md`.

## Reality Gap Engine (session 7) — read docs/REALITY_GAP_ENGINE.md
- `src/server/reality/` holds the intended/declared/observed comparison, gap classes, counterfactual recovery, passports and the RIGOR benchmark. Connected systems are the **Reality Lab sandbox**, which must always be labelled as not production.
- Rules:
  - never mark an operation VERIFIED without an independent read;
  - never retry an EXECUTION_UNKNOWN write before a read-back;
  - approvals bind to plan/recovery hashes;
  - RIGOR metrics must stay computed from `bench_cases` rows;
  - scenario `truth` is for the scorer only, and the engine must never read `lab_effects` or `Lab.truth()`.

## Orchestration (session 5)
- `src/server/engine/orchestrator.ts` holds the Mission Orchestrator rules (fingerprints, output validation, MAX_PASSES). `Engine.orchestrate()` persists role tasks in `workflow_tasks`. Packs declare `roleDeps` and optional `roleInputs`; they never need to change the engine.
- Agents are deterministic analyzers. A role re-runs only when its inputs changed. Agent requests are honoured only when the target's inputs changed. The loop stops at MAX_PASSES and escalates to a human.
- (Superseded in session 13) Switch is now connected to the local switch-core 0.31.0 for agent-only rooms; see hard rule 1 and docs/SWITCH.md.

## Billing & SLA dispute (session 14): one company, obligation graph
- `npm run demo` registers agents on Switch (if `.env` configures it), boots a fresh server and runs the 3 must-pass scenarios (`scripts/e2e-billing-switch.ts`).
- The obligation dependencies are engine-enforced via `ActionSpec.blockedUntil`. Never let a customer-facing message claim a refund, credit or fix that is not verified or confirmed.
- `billing_sandbox` is a test ledger and must always be labelled as such. It never moves money.
- One Switch connection serves all rooms. Never call `post_message` without going through the adapter's serial room claim (`SwitchCollab.send`).

## Consumer resolution (session 13) — Citation + RIPPLE + Intake safety, read progress.md
- The three source products were integrated as CAPABILITIES ported to TypeScript, not as apps: `src/server/capabilities/reclaim` (retrieval, provenance, citation checks), `capabilities/resolve` (commitment ledger), `capabilities/redeem` (intake safety, scam scan, confirmed memory). They are pure functions; the only orchestrator is RIPPLE's engine.
- The `consumer-resolution` pack (`packs/consumer/`) uses all three. Only the consumer (`cr_consumer`) may answer their questions or approve messages sent on their behalf. A refund counts only when the consumer confirms it; never write "refunded" from a provider message.
- The bundled corpus rows are `authored_guide` (Citation authors, not official regulator text). Keep that label everywhere, and only cite claims `verifyClaim` finds in the corpus.
- The original Python repos (RESEOLVE, Open-Agent/reclaim, redeem) are outside this folder and must not be modified from here.

## Dashboards, Switch console, flagship (sessions 10–11), see docs/RIPPLE_IMPLEMENTATION_REPORT.md
- Feature preservation is the minimum bar: never remove a page, route, API, pack or nav destination. Extend instead.
- `src/server/api/dashboards.ts` has the read models for the 4 dashboards. Every number comes from rows. When there is no data, return null and the UI shows "—"; never fabricate a metric. UI pages must not hardcode content; add a read model instead.
- `src/server/capabilities/catalog.ts` is configuration. A catalogued capability is `pack-backed` only when an implemented pack exercises the capability.
- `src/server/console/`:
  - every state change is a proposal that a signed-in human confirms;
  - it then runs through the normal Engine method under that user's identity;
  - the model interpreter is a fallback only and may never confirm;
  - messages from Switch are advisory (read-only answers; changes are queued for a RIPPLE user);
  - the on/off switch reports only what it observed.
- Scripted faults live in the approved operation (e.g. `revenue-recovery` `scenarioFaults`). They are labelled and part of the workflow, so a failure must surface as a recorded state (`execution_unknown`, `recovery_required`), never as an app error. Never report UNKNOWN as success, and never repeat a write before a read-back.
