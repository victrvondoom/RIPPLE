# Implementation plan & status

**Phase 8 (this session) — remaining workflow packs: DONE** — ScopeGuard, InvoiceGuard, ShiftRelay, MoveMate, PodFlow, SubmitReady implemented in that order, each with domain tests, an HTTP-API journey, and a real-browser journey; plus cross-domain Control Center filters, demo-mission creation, shared-engine improvements (see progress.md). **Switch real integration: POSTPONED.**


| Phase | Scope | Status |
|---|---|---|
| 0 Inspect & plan | env, stack, Switch docs, context files | **Done** |
| 1 Foundation | app shell, SQLite, schema, seed workspace, run/test commands | **Done** |
| 2 Mission engine | states, baselines, changes, graph, approvals, audit + tests | **Done** (tests in `tests/engine.test.ts`) |
| 3 BEO Rescue | pack, agents, drafts, approvals, verification, evidence | **Done** end-to-end (tests + browser e2e) |
| 4 Switch collaboration | adapter + local mode, handoffs, room↔state | **Adapter + local mode done; real Switch NOT tested** (blocker: no Switch server/credentials in sandbox) |
| 5 UI completion | 8 views, loading/empty/error/blocked/success states, responsive | **Done** (see screenshots) |
| 6 Reusability | SceneShift on same engine | **Done** (minimal; test + UI screenshot) |
| 7 Validation & demo | tests, lint, typecheck, e2e, evidence, docs | **Done** for what is listed in TESTING.md |

## Acceptance criteria (BEO Rescue)
- Baseline v1 saved; change detected vs baseline ✔ · missing vegan count blocks and explains ✔ · impact graph with downstream highlighting ✔ · five agent roles with distinct structured output ✔ · drafts (revised BEO, kitchen, procurement, staffing, client email) ✔ · approvals gate execution ✔ · stale on new change ✔ · failure visible + explicit recovery ✔ · independent verification evidence ✔ · acknowledgements ✔ · completion refused until criteria met ✔ · baseline v2 + outcome with unresolved items ✔.

## Remaining / known blockers
- Real Switch run (POSTPONED by request) (needs Docker Switch stack + registered agents + chat bridge). Steps in `docs/SWITCH.md`.
- Real connectors (SMTP/chat/document system).
- Inbound Switch messages are recorded but cannot yet answer questions/approve (identity mapping not built).
- Six other packs are declared-only.
- DB-level tenant isolation, CSRF tokens, password reset/rotation UI, rate limiting beyond in-memory login throttle.
- UI component tests; the e2e script is manual (`node scripts/e2e.mjs`), not part of `npm test`.

## Session 5: Mission Orchestrator
- Done: persisted task graph, fingerprint reuse, bounded passes with escalation, validated outputs, agent requests, pause/resume/retry/reassign, restart recovery, stale-task sweep, Orchestration canvas tab, Switch heartbeat generation fix.
- Not done: real Switch run (installed 0.31.0 is stopped); true concurrency; per-agent pause; shipped packs that emit agent requests; Playwright e2e run; screenshot evidence.
