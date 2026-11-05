# progress.md - resume here

## Session 7 (latest): Reality Gap Engine + RIGOR benchmark + Split-Brain showcase
A second "RESOLVE competitive domination" directive was received. Following its own rule ("one fully working vertical slice over ten mock integrations"), this session built one slice: the Reality Gap Engine, the RIGOR benchmark and the split-brain demo. Full write-up: **docs/REALITY_GAP_ENGINE.md**.
- **Server code:** new `src/server/reality/` (states, types, lab, scenarios, rge, benchmark) and `src/server/api/reality.ts`.
- **Persistence:** 12 new workspace-scoped tables, created with `CREATE IF NOT EXISTS`.
- **Causal ledger:** reused as the event backbone, with 3 new cause types.
- **UI:** new page `src/web/pages/RealityPage.tsx` and a nav item "Reality Gap Engine".
- **Data governance:** workspace export and delete now include the new tables, plus `causal_events` and `workflow_tasks`, which were previously missing from both.
- **Preserved:** no existing route, page, pack, test or behaviour was removed or changed.

Verified (real runs, this session):
- Baseline before changes: `npm test` 19 files / 152 passed.
- After: `npx vitest run` 22 files / 175 passed (new: `tests/reality.test.ts` 13, `tests/rigor.test.ts` 5, `tests/reality-api.test.ts` 4, which includes cross-tenant API isolation). `tsc --noEmit` clean, `eslint src tests scripts` clean, `vite build` OK.
- Real browser (Chrome, fresh DB, port 8791) as Maya:
  - started the split-brain workflow, approved it and ran it;
  - the UI showed "Agent declaration: COMPLETED" against "Observed: PARTIALLY COMPLETED";
  - in the Recovery Simulator, blind retry was rejected (predicted double charge); I chose Resume, approved it and executed it → RECOVERED;
  - the API confirmed applied effects `pay, book, notify`, each exactly once, and 5 passports;
  - a full RIGOR run (124 cases) was launched from the UI and completed;
  - the explorer rendered 34 nodes and 53 edges;
  - no console errors.
  Screenshots and the RIGOR CSV/JSON are in `docs/evidence/reality/`.
- RIGOR (seed `rigor-demo-1`), full layer B4: false success 0/17, duplicates 0/34, unauthorized 0/34, bypass 0/34, stale evidence accepted 0/6, partial-commit detection 4/4, recovery success 7/8 (one deliberate failed compensation escalates). Weaker baselines B1–B3 fail measurably; the full table is in the doc.

NOT done (do not claim):
1. **Switch** is still not connected: no listener on 52041–52043, and the adapter is mock-tested only.
2. **External systems** are the labelled Reality Lab sandbox; there are no real payment, booking or deploy connectors.
3. **Agents** are deterministic, with no LLM.
4. **Execution** is sequential, with logical leases and re-reads and no wall-clock backoff.
5. **Isolation** is query discipline tested at the API and engine layers, not DB row security.
6. **Directive capability areas A–H** (decision memory, briefings, lineage/SQL, PR pipeline, and so on) exist only as benchmark scenarios, not as product features.
7. **The e2e Playwright scripts** were not run (Playwright is not installed locally); the browser check was manual through the Chrome tools.
8. **No demo video** was recorded.

## Session 6 (latest): execution outcome is never assumed from an error (EXECUTION_UNKNOWN)
Scope note: a RESOLVE directive (competitive capability expansion: incident, schema, PR review, CrewPilot, finance, OfferRoom, Study-Nexus, causal graph, real Switch) was received. Only this slice was implemented in this session. The rest is NOT built (see "NOT done" below). The project in this folder is RIPPLE; the directive was applied here.

What changed (real code, tests pass):
- `engine.ts` `executeAction`: when `connector.execute` throws, the new `settleFailedExecution()` reads the effect back with `connector.observe()` before deciding:
  - read-back finds the effect → action `executed` (result marked `recoveredBy: read-back`), causal `OBSERVED`, then the normal independent `verifyAction` runs. The effect is NOT repeated.
  - read-back confirms absence → action `failed` (as before), causal `FAILED`, retry allowed.
  - read-back itself throws → NEW action status `execution_unknown`, causal `EXECUTION_UNKNOWN`, audit `action_unknown`, escalation to the human manager.
- `execution_unknown` actions: a retry first reads back. Still unknown → 409 `still_unknown`, connector NOT called. Effect found → verified without re-execution. Absent → normal retry with the same idempotency key.
- `execution_unknown` blocks completion (`completion.ts` no_failed_or_stale), counts as recovery_required in `reconcile()`, appears in `problemActions` (snapshot), and has a badge + "Read back, then retry if absent" button in MissionWorkspace.
- No DB migration: `actions.status` is plain TEXT. The existing `fail_next` fault-injection test still passes unchanged (throw before write → read-back absent → `failed`).

Verified (real runs, this session):
- Baseline before changes: `npm test` 18 files / 148 passed.
- After changes: `npm test` 19 files / 152 passed (new `tests/execution-unknown.test.ts`, 4 tests: lost response → verified with one connector call; confirmed absence → failed then retry lands once; read-back broken → EXECUTION_UNKNOWN, no repeat, 409 on retry, completion blocked; read-back recovers → verified without re-execute).
- `npm run typecheck` clean; `npm run lint` clean; `npm run build` OK.

NOT done from the directive (explicitly, do not treat as complete):
1. Incident Intelligence (telemetry ingestion, hybrid BM25+dense retrieval, RRF, RCA, postmortem): not built.
2. Schema lineage graph, SQL impact analysis, dual-fixture tests: not built (SchemaCourt pack from session 3 is unchanged).
3. GitHub webhook ingestion with signature validation, patch execution, PR review publishing: not built.
4. CrewPilot/OfferRoom/Study-Nexus expansion, payment-provider sandbox: not built (existing packs unchanged).
5. Real Switch: still POSTPONED (AGENTS.md hard rule 1). The Switch adapter remains mock-tested only.
6. Causal graph explorer UI, Governance/Reliability Center UI, Workflow Studio composition engine: not built.
7. Multi-agent arbitration (adversarial reviewer, minority objections): not built.
8. Phase-1 docs (FEATURE_PRESERVATION_INVENTORY, COMPETITIVE_GAP_ANALYSIS, IMPLEMENTATION_ROADMAP) exist from earlier sessions and were NOT refreshed in this session.
9. Known edge: an `execution_unknown` action of a superseded analysis revision is not swept by `markStale()`. It stays in the ledger but is not re-reconciled automatically. Needs a decision first, because the effect may exist.
10. Browser check of the new badge/button was NOT run in this session; only the server tests and the build cover it.

## Session 5 (previous): Mission Orchestrator - tasked agents, bounded feedback loop, pause/resume, canvas
What is real now (verified by tests and a live-server run; see docs/TESTING.md):
- `workflow_tasks` table: one row per agent execution, reuse or re-analysis inside an analysis revision (status queued, running, done, reused, failed, rejected, interrupted, timed_out, cancelled). Orchestration events are written to the existing audit log with `orch_*` types.
- `src/server/engine/orchestrator.ts`: role fingerprints (a role re-runs only when its declared inputs or dependency outputs changed), output validation (malformed, mis-addressed or self-requesting output is rejected and discarded), MAX_PASSES = 3 bound, task timeout constant.
- `Engine.runAnalysis` dispatches tasks through `orchestrate()` in bounded passes, then materialises drafts, work items and actions as before. Unchanged roles reuse their previous result from an earlier revision (BEO: the Change agent is reused after a vegan answer).
- Agent requests (`RoleResult.requests`) are recorded as handoff messages; a request is honoured only if the target's inputs changed, otherwise it is logged as converged.
- Pause and resume (managers): pause stops the mission before the next agent task and refuses changes, answers and executions while paused; resume re-runs unfinished work and reuses completed agents. Also: retry analysis, reassign work item (audited), restart recovery (running tasks become interrupted, mission blocked), and a stale-task sweep every 15 s (timed_out plus escalation).
- API: POST /api/missions/:id/pause, /resume, /retry-analysis; POST /api/missions/:id/work-items/:wid/reassign.
- Read model: `missionDetail().orchestration` (current revision tasks, per-revision rounds, requests, escalations, progress) and `agents[].task`.
- UI: "Orchestration" tab (src/web/pages/Orchestration.tsx): SVG graph with hub and agent nodes from the plan, real handoff and request edges, dependency edges, open-question edges; agent panel (task, reason, dependencies, reuse, errors, findings, artifacts, messages); approval cards (recommendation, if approved / if rejected, exact content); sidebar (state, progress, blockers, Switch status, live activity from the server).
- Switch (installed 0.31.0 source read, see docs/SWITCH.md): the heartbeat now echoes the stream `generation` announced on `connection_state`. The previous adapter did not send it.

Verified this session
- npm test: 18 files / 148 tests passed (133 before, plus 13 orchestrator and 2 Switch generation). Two consecutive full runs green. npm run lint, npm run typecheck and npm run build clean.
- Two pre-existing timing tests (switch-resilience "heartbeat 409" and my own generation test) flaked under the parallel suite. The fixed sleep was replaced by a poll for the same condition; assertions unchanged.
- Live server (scratch DB, port 8790), via the API: BEO iteration 1 (5 tasks done, blocked on vegan count); iteration 2 after the answer (change reused, 4 re-run, 5 approvals pending); pause refuses changes with 409; resume returns 200.
- Browser (Chrome tools, DOM checks): Orchestration tab renders persisted state; Kitchen node opens its panel; pause and resume through the buttons are audited; an approval through its card is recorded; reload restores graph, agent states and 4 pending approvals from the server.
- NOT verified: screenshots (the capture call timed out on every attempt in this environment, so there is no image evidence); the Playwright e2e scripts (playwright is not installed in node_modules, so scripts/e2e*.mjs were not run); a real Switch.

Limits (do not hide)
1. Switch: the installed Switch 0.31.0 is present under %APPDATA%\switchdash\local-switch-server\native\switch-core\0.31.0 but was STOPPED (no listener on 52041-52044; the switch-core process was gone). Not connected. The adapter is still mock-tested only.
2. Analyzers are synchronous deterministic rules. The scheduler supports independent tasks, but nothing in this build runs them concurrently, so parallel execution is not claimed.
3. Feedback loops: no shipped pack emits agent requests yet; the loop is exercised by a test-only pack. BEO's only human loop is the vegan question (blocking), followed by re-analysis with reuse.
4. Per-agent pause, "request another review" and mid-task cancel are not implemented. Pause and retry act on the whole mission revision.
5. Agent status "awaiting human input" also shows for a non-blocking open question (e.g. the venue question).
6. Pre-existing: a deep link of the form #/mission/<id>?tab=... puts the query into the mission id, so actions fail from that URL. Navigation from the Missions list is unaffected. Not fixed here.
7. Limitation 5 from before still applies: readiness packs need a follow-up submission.

## Session 4: Studio honesty fix (fake telemetry + Approve buttons)
The Workflow Studio (`src/web/pages/WorkflowStudio.tsx`, `src/server/api/studio.ts`) is an inherited synthetic demo. It previously showed **fabricated live telemetry** (client-side `Math.random()` "tok/s / latency / tokens", hardcoded infra latencies/health "100%") and its **Approve buttons claimed false outcomes** ("Vendor dispute authorized! Dispatched to vendor AP.", fake "vendor acknowledged credit memo" events) when they only wrote an audit row.
Fixed (studio routes now only serve real measurements or audit-log demo decisions; nothing is dispatched):
- New `GET /api/studio/telemetry` returns **real** values measured at request time: uptime, SQLite size via `PRAGMA page_count/page_size`, workspace-scoped ledger counts (missions, open work items, agent runs, pending approvals, open questions, verified actions, evidence, audit events), provider name/kind, pack count, collab describe. UI top bar now polls this (5 s) instead of random numbers.
- `GET /api/studio/infrastructure` rebuilt: real counts/measured response time/Node version; fake per-node latencies, "100%" health and error counts removed. UI Infrastructure tab now renders these server values (was hardcoded).
- Approve/guidance endpoints validate input, record decisions/guidance **per workspace** (in-memory + audit-logged), and return honest messages ("decision recorded… nothing was sent"). UI approval flows, badges ("Decision recorded — demo only") and guidance copy updated; fabricated vendor-acknowledgment log lines removed; audit-tab and workflows responses labelled "synthetic demo".
- Renamed leftover "RESOLVE" branding to RIPPLE Studio.
Verified (real runs): `npm test` **16 files / 133 passed** (studio tests extended: telemetry values real, approve message honest, invalid action → 422, decision served back; infra has no fabricated `health`/`latency` fields), `npm run typecheck` + `npm run lint` clean, `vite build` OK, and a live throwaway-DB smoke test confirmed real telemetry (dbBytes 262144, auditEvents incremented on login/decision) and honest approve response.
Still synthetic (by design, now labelled): the six Studio workflow scenarios, their agents/steps/evidence cards, the audit-tab illustration and the "Simulate" run narrative.

## Session 4b: inherited moa's front door (pixel-meadow landing)
Ported moa's landing frontend (source `~/Downloads/vultr/moa-main`, Cal Hacks; earlier sessions already took moa's onboarding/home/avatar patterns by reference) into RIPPLE's Vite/React + plain-CSS stack: new `src/web/components/MeadowScene.tsx` (pixel meadow scene: dithered sky, clouds, birds, ridges, trees, wheat) + roaming draggable crew (7 RIPPLE pixel avatars with walk/say/grab/squirm/land physics, all `px*`/`pxl*` keyframes ported with reduced-motion honoured) and `Landing.tsx`, which wraps the **unchanged** real login form over the scene (all flows/e2e selectors intact) plus honest footer copy and a visible credit to moa. Decorative only — represents no engine state. Deliberately NOT inherited: moa's in-app UI (its Canvas/Board/Audit pages map to RIPPLE's existing engine-backed pages) and its Tailwind/shadcn design system. See `docs/INHERITANCE.md` §moa.
Also this session: fixed 5 pre-existing lint errors in newer engine code (`engine.ts` useless `passes` variable; `beo/pack.ts` unused destructures in `roleInputs` scrub).
Verified (real runs): typecheck + lint clean; `npm test` 16 files / 133 passed; `vite build` OK; real-browser check on a fresh server (`docs/evidence/landing-meadow.png`, `landing-meadow-login.png`): landing renders (wordmark, scene, 7 walkers), login over the meadow succeeds, zero browser console errors. NOTE: `scripts/e2e*.mjs` cannot run in this environment until `playwright` is installed locally (only global `playwright-core` + cached Chromium exist); the browser check above used playwright-core directly.

## Session 3: inherited five competitor projects
13 packs now (added/rewrote `offerroom`, `incident-sentinel`, `schemacourt`, `clearsend`, `crewpilot`; all in `extendedRegistry()`). Verified: `npm test` 132 passed / 16 files, typecheck + lint clean, build OK, `scripts/e2e-inherited.mjs` all PASS (see docs/END_TO_END_VERIFICATION.md). Full ledger: **docs/INHERITANCE.md**.
Engine additions: named-approver gate (`ActionSpec.approver`), `QuestionSpec.assigneeOnly`. Switch adapter gained reconnect/Last-Event-ID/heartbeat-interval/dedupe (mock-tested only).
Earlier docs from the previous pass overclaimed; corrected (banners in IMPLEMENTATION_REPORT / COMPETITIVE_POSITIONING; GAP_ANALYSIS and END_TO_END rewritten). Still-overstated lines may remain in DEMO_RUNBOOK.md ("3D map", "byte-for-byte") and IMPLEMENTATION_ROADMAP.md (checkboxes stale).
Next: browser e2e for new packs; wire OfferRoom mock-interview grading to a UI; real Switch run; the older sections below describe session 2.

## Where things stand (end of session 2)
All 8 workflow packs are implemented on the ONE engine and each has: domain logic, tests, an HTTP-API journey test and a real-browser journey.
BEO Rescue (flagship), SceneShift, **ScopeGuard, InvoiceGuard, ShiftRelay, MoveMate, PodFlow, SubmitReady**. Branch `claude/magical-hawking-wcg9wu`.
**Switch: real integration is POSTPONED by request. Nothing in this repo has been tested against a real Switch server.** Local collaboration mode and the (mock-tested) adapter are unchanged.

## Verified baseline at the start of session 2 (re-run, not assumed)
`npm test` 24 passed (4 files) · `npm run typecheck` clean · `npm run lint` clean.

## Verified at the end of session 2 (real runs; output in docs/evidence/test-output.txt)
- `npm test`: **12 files, 85 tests passed.** (typecheck + lint clean.) BEO/SceneShift/API/Switch tests were not weakened; one engine test string and the original e2e script's button labels were updated only because UI wording was generalised.
- Real-browser journeys on one fresh server, all passed: `scripts/e2e.mjs` (BEO + SceneShift + mobile), `scripts/e2e-packs.mjs <pack>` for scopeguard, invoiceguard, shiftrelay, movemate, podflow, submitready, and `scripts/e2e-crossdomain.mjs`. Logs/screenshots: `docs/evidence/` and `docs/evidence/packs/`.

## What each new pack actually does (details: docs/ARCHITECTURE.md §Packs)
- **ScopeGuard** classifies each requested item vs approved scope (included / out-of-scope / uncertain) using page, revision and integration allowances and explicit exclusions; uncertain → blocking human decision. Estimates hours and an *internal* cost range from the rate card, indicative slip, proposes tasks (gated behind recorded client acceptance), drafts a change order and client message that verifiably contain no price/deadline promise. Change-order publishing needs OWNER approval. Baseline v2 records the change order as pending client acceptance.
- **InvoiceGuard** line-item reconciliation: unmatched lines, over-milestone / over-approved totals, unaccepted deliverables, hours vs worklog evidence, rate cap, duplicates, arithmetic, quote ceiling, currency (blocking FX question). Neutral clarification draft (verified free of accusatory wording). Never initiates payment; disputed invoices are not booked as billed.
- **ShiftRelay** reconciles the open job board with the handover (detects omitted jobs → blocking question), transparent urgency score, parts/callback tracking, ownership + deadlines, supervisor approval, acknowledgement by outgoing + incoming + supervisor, callback-confirmation reviews; unresolved jobs stay in the outcome.
- **MoveMate** deadlines with notice lead times, dependency-propagated due dates, unowned obligations (blocking), workload, uncertain lease clauses flagged (no legal conclusions, verified), shared evidence links (one meter reading satisfies two tasks); completion requires every obligation done with evidence (needs a follow-up check-in).
- **PodFlow** transcript-text only (labelled everywhere; media never claimed as processed): coverage, scored highlight candidates, claim flags, creator clip approval bound to the candidate set, platform-limited titles/captions, content kit + publishing checklist, media-check and claim-verification reviews.
- **SubmitReady** rubric requirement status = verified / incomplete / uncertain / not applicable derived only from deliverable state + verified evidence; N/A claims need a human answer; consistency checks; compliance report verified so no VERIFIED line lacks evidence; completion needs full evidence-backed readiness.

## Shared-engine changes this session (generic, regression-tested)
work-item `dependsOn` (enforced prerequisites) and `satisfiedBy` (explicit, audited evidence links); pack `completionChecks` get the real plan state; `verifyAction` receives change context; `detectChanges` receives answers; actions may reference any earlier role's draft; owner-level vs manager-level approvals enforced and shown; outcome records list **completed and unresolved** work; `labels` for domain wording; `syncDirectory` + column migration for existing DBs; demo-mission endpoint (`POST /api/packs/:id/demo`) + Packs page buttons; Control Center filters (domain, status, owner, approval required, blocked/overdue, recent change); array editor + "start from previous submission" + JSON edit in the intake form; mobile layout fix.

## Real bugs found by this work (and fixed)
SubmitReady verifier recomputed statuses without the change context (caught by the browser run; unit test had not asserted "verified"); InvoiceGuard's Project Owner role was unmapped (caught by the orphan-role test); actions couldn't reference other roles' drafts (found building PodFlow); mobile horizontal overflow introduced by the new Control Center table (caught by the BEO e2e).

## Known limitations (do not hide)
1. **Switch**: postponed; adapter only mock-tested; inbound messages advisory; heartbeat re-open not implemented.
2. Agents are deterministic rule-based analyzers (labelled). Optional model wording (client email, BEO only) untested live.
3. Connectors are local file outbox/dry-run: nothing is emailed, posted, paid, uploaded or submitted anywhere.
4. Overdue in the Control Center compares work-item due dates with the server clock; demo data is dated Nov 2026.
5. A new change is always analysed against the *current approved baseline*, so "follow-up" submissions must restate cumulative progress (the UI's "Start from previous submission" helps). This is why MoveMate/SubmitReady need a second submission to complete.
6. Each pack's heuristics are intentionally simple and transparent (e.g. PodFlow scoring, ShiftRelay urgency score) — they are not validated against real-world data. Packs read user-entered JSON plans; there is no import from external systems.
7. Not production-hardened (see ARCHITECTURE security assumptions); `node:sqlite` experimental. Browser coverage is Chromium only; no component/a11y test suite.
8. SceneShift remains a minimal pack (one test, one UI journey inside e2e.mjs).

## Next concrete tasks
1. Real Switch run (docs/SWITCH.md) when a server is available; record honest results.
2. Real connector (SMTP/chat) with delivery receipts; then update verification wording.
3. Cumulative-change model (apply a completed change automatically as the new baseline mid-mission) to remove limitation 5.
4. Per-pack import (CSV/ICS/transcript upload) and richer SceneShift tests.
