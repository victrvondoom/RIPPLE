# Testing — what is actually covered

| Command | What it does |
|---|---|
| `npm test` | vitest, **125 tests / 15 files** (session 3, real run), in-memory SQLite, temp outbox |
| `npm run typecheck` | `tsc --noEmit` strict (server, web, tests) |
| `npm run lint` | eslint + typescript-eslint on `src` |
| `scripts/fresh-server.sh && node scripts/e2e.mjs` | Playwright/Chromium BEO + SceneShift journey (+ mobile) on a live server → `docs/evidence/*.png`, `e2e-log.txt`. Manual. |
| `node scripts/e2e-packs.mjs <pack>` | One browser journey per new pack (create → baseline → request → answers → impact → findings → approvals (incl. owner-level for ScopeGuard) → execute/verify → refused early completion → acknowledgements/reviews → follow-up evidence where required → completion) → `docs/evidence/packs/<pack>-*.png/-log.txt`. Manual. |
| `node scripts/e2e-crossdomain.mjs` | Packs page creates demo missions for all 8 packs; Control Center filters; shared approvals queue; people; work graph. Manual. |

## Automated test coverage
- `tests/engine.test.ts` — state-machine validity; impact graph reaches only dependent artifacts; no-change detection; BEO blocked-on-missing-info → answer → awaiting approval; correct numbers in drafts (servers ceil(145/15)=10, lead-time shortfall, venue capacity); allergen conflict flagged for human review and no certification wording; approval/role enforcement; execute→independent verify→acks→review→complete→baseline v2 with unresolved items recorded; tampered output fails verification; injected failure → recovery_required → audited retry; connector idempotency; staleness on a later change (actions + approvals stale, execution refused); input/lifecycle validation; workspace isolation; state-change audit trail.
- `tests/sceneshift.test.ts` — second pack on the same engine, through completion.
- `tests/switch.test.ts` — Switch adapter + engine against a **mock** of the documented protocol (not real Switch); inbound advisory messages; degradation to labelled local room; env config.
- `tests/api.test.ts` — 401s, login, cookie flags, CSRF/content-type, role authorization over HTTP, cross-workspace 404s, owner-only export (no password hashes), workspace delete confirmation, upload validation.

### Per-pack tests (new)
- `scopeguard` (8): validation; classification incl. allowances/exclusions; blocking on uncertain; no price/deadline promise; verification + tamper; completion + versioned scope; stale; all-included path.
- `invoiceguard` (9): validation; the ₹48,000 vs ₹40,000 example and every discrepancy code; FX blocking; evidence link; neutral-wording tamper; clean-invoice path; stale on corrected invoice.
- `shiftrelay` (7): validation; urgency scoring + SLA breach; omitted-job blocking; ownership/deadlines; completion refused until ALL acknowledgements and callback confirmations; verification tamper; supervisor-only approval + stale; clean handover.
- `movemate` (6): validation; lead-time/overdue/dependency deadlines; blocking + lease flags without legal wording; prerequisites + shared evidence link; approvals + readiness gate; follow-up with carried-over (not re-sent) identical email → completion.
- `podflow` (6): validation incl. unknown platform before any state change; coverage + deterministic candidates; blocking approval bound to candidate set (revised transcript invalidates it); source labelling/limits/gates; verification; tamper.
- `submitready` (7): validation; the four statuses strictly from evidence; consistency + deadline; blocking; report never claims without evidence (tamper); completion only after evidence-backed update + human N/A; citation evidence link.
- `api-packs` (9): for **every** pack over HTTP — validation, role-based 403s, approvals by required role, execution, all actions verified with all-passing evidence, early completion refused, acknowledgements, reviews, completion (or readiness refusal), audit; plus demo-mission endpoint.
- `crossdomain` (9): all 8 packs in one workspace without merged data; differing approval levels enforced; one person's work across domains; a change in one mission does not disturb others; multi-department fan-out with acknowledgement gating and completed+unresolved outcome; workspace isolation; shared-engine regressions (cross-role drafts, migration/sync, sample/schema consistency, no orphan roles).

## Not covered
Mattermost-bridged rooms with humans in chat (the `!` commands being typed by a human); the gateway export with a human session (sessions 13–15 cover agent-only rooms and the agent API); real model API; real email/chat; UI component unit tests; load/security testing; browser matrix (Chromium only); accessibility audit (labels/roles used, not audited).

## Session 18 - results (real runs, 2026-11-07)
```
$ npm run typecheck        -> tsc --noEmit -p tsconfig.json   (exit 0)
$ npm run lint             -> eslint src tests scripts bench   (exit 0)
$ npx vitest run
 Test Files  44 passed (44)
      Tests  364 passed (364)
$ bash scripts/fresh-server.sh 8791 && BASE_URL=http://localhost:8791 node scripts/e2e-crossdomain.mjs
CROSS-DOMAIN JOURNEY PASSED
$ python -m pytest tests_py -q
27 passed, 2 skipped
```
Baseline before session 18, on a clean worktree of HEAD (111aefd): `npx vitest run` -> 43 files, 331 passed, 13 failed (flipside-review and run-of-show were unregistered by merge 67105a5). New: `tests/pkggate.test.ts` (20). Package-risk benchmark: `docs/benchmarks/PACKAGE_RISK_BENCHMARK.md`.

## Latest recorded results
See `docs/evidence/test-output.txt` (vitest/tsc/eslint) and `docs/evidence/e2e-log.txt` (browser run). The e2e whitelists only two expected console errors: the pre-login 401 session probe and the one deliberate 422 refusal of early completion.

## Session 15 (Level 3) - results (real runs, 2026-11-06)
- `npx vitest run`: **31 files / 256 tests passed**. New: `tests/switch-level3.test.ts` (7 — one per Level-3 capability, engine integration to COMPLETED with a written version-2 playbook, and honest/local degradation). `tsc --noEmit` clean; `eslint src tests scripts` clean; `vite build` OK.
- `python -m pytest tests_py/test_switch_level3.py`: **6 passed** (one dedicated pytest verification test per Switch primitive, through `ripple_switch/switch_client.py` against `tests_py/mock_switch_core.py`; capabilities 5 and 6 cross-verify the TypeScript guardrail/playbook composer through `scripts/guardrail-cli.ts` / `scripts/playbook-cli.ts`).
- LIVE against the real switch-core 0.31.0 (server running, API 127.0.0.1:52042): `npx tsx scripts/switch-live-level3.ts` — **ALL 11 STEPS PASSED**:
  ```
  PASS  bridge health — http://127.0.0.1:52042/health
  PASS  create_room with linked_rooms + roles (room_role_defined at creation) — intake 750074b0-…; ops 8e5a9ec8-…; finance 42ba88f9-…
  PASS  room-membership isolation on #finance-settle (non-member connect refused) — HTTP 400 {"detail":"Agent is not a member of this room"}
  PASS  arbiter assumes settlement-signer (assume_role) — role: settlement-signer; instruction delta received (88 chars)
  PASS  list_roles read-back shows the live lease — held_by: ripple-arbiter; assumable_by_me: true
  PASS  conflicting assume_role refused while the exclusive seat is held — HTTP 400 "Role 'conflict-signer' is exclusive and currently held by another agent"
  PASS  addressing introspection + APPROVE authority announcement — get_my_context: who_can_talk=owner_and_owner_agents; owner=agent-bootstrap@switch.local; announced in #finance-settle
  PASS  follow-ups bootstrap posted; server feature flag read back — server.features: …, follow_the_conversation, …
  PASS  Citation #908 guardrail (live check of the same deterministic code) — guard 3/3; quarantined: true; llmCalls 0
  PASS  create_room_document + load_internal_documents read-back — document_id ff103f5f-…; read back 1 document(s)
  PASS  GET /rooms/{id}/yaml attempted; local fallback playbook written — local_fallback: playbooks\resolved-l3-393738be.template.yaml
  ```
  Evidence with full details: `docs/evidence/switch-live-level3-2026-11-06.json`. Real-server facts found this session and encoded honestly (not from mocks): non-member `connect_to_room` = **400** "Agent is not a member of this room"; `create_room` refuses an unknown `group_name`; `load_internal_documents` **requires `ids`**; `assume_role` keeps **one lease per agent**.
- NOT covered: Mattermost-bridged rooms with humans typing `!follow-ups on` in chat; the gateway `/rooms/{id}/yaml` with a real human session (agent key refused; labelled local fallback used instead); a `/rooms/from-yaml` re-import round-trip of an exported playbook.

## Session 5 (orchestrator) - results
- `npm test`: 18 files / 148 tests passed (2 consecutive full runs). New: `tests/orchestrator.test.ts` (13: BEO task graph and affected-only re-run after an answer; convergence of a mutually dependent pair; bounded escalation; malformed output rejection; pause mid-run and resume with reuse; manager-only pause and refused actions while paused; reassign authorization; restart recovery; stale-task timeout; cancellation; fingerprint and validation rules) and `tests/switch-generation.test.ts` (2: heartbeat echoes the announced generation; no generation for servers that never announce one).
- Hardened two timing tests that flaked under the parallel suite (switch-resilience "heartbeat 409", and the generation test) by polling for the same condition. Assertions unchanged.
- `npm run lint`, `npm run typecheck`, `npm run build`: clean.
- Live server (scratch DB): BEO iterations via the API, and pause/resume/submit/retry/reassign status codes. Browser checks via DOM reads: Orchestration tab, node selection, pause/resume buttons (audited), approval via card, reload restores state.
- Not run: the Playwright e2e scripts (playwright is not installed in node_modules). Screenshot capture timed out in this environment, so no image evidence was produced.
- Not covered: real Switch (installed 0.31.0 is stopped; see docs/SWITCH.md); true concurrency (analyzers are synchronous).
