# progress.md - resume here


## Session 19: Fixline and Recall Desk packs (idea placement in `docs/FEATURE_PLACEMENT.md`)
- **`fixline-bugfix`** (`packs/fixline/`): triage/repro/fixer/reviewer/CI-gate agents + support lead and engineering lead. Gates recomputed by analyzer, verifier and completion: repro failed before fix, locked test untouched, all tests green, reviewer of a different vendor approved. Only the engineering lead (`fx_lead` -> Maya) approves; four-eyes bars the reporter. Merge record is dry-run.
- **`recall-desk`** (`packs/recall/`): matcher/comms/sentinel/runner agents, QA Head (`rc_qa_head` -> Sam) and store manager (`rc_store_manager` -> Tess). Look-alike batch numbers become blocking questions only the QA Head answers; drafts (EN/HI) are never sent; completion needs a shelf read equal to the recalled batch per store.
- Seed: `fx_lead` on Maya, `fx_support` on Ana, `rc_qa_head` on Sam, `rc_store_manager` on Tess. Catalog: both packs in system "commerce".
- **Verified 2026-11-07:** `tsc` 0, `eslint` 0, `npx vitest run` **42 files, 325 tests passed** (new `tests/fixline-recall.test.ts`, 7). Live proof on a fresh server: `scripts/proof-fixline-recall.mjs` -> 14/14 PASS (wrong approvers refused with 403, merge record and stop-sale order VERIFIED, recall refused completion without a shelf check).
- **Not built (placed, see the doc):** dual-control ChatOps, Shipyard tickets/briefings, Room past-incident RCA, relayed-agent injection, Vaaradhi. **Not exercised** on real Switch, Mattermost or Telegram. Fixline/recall have no bespoke UI: they use the generic mission pages.

## Session 18: Flipside review pack + 3D frontend (built on the single engine)
Source: the owner's screen recording (Flipside landing: glossy 3D mascot, Seal/Ask/Refuse/Approve/Verify rail, Merkle seal view, chat cards) and the Track 01 brief (cross-team agent PR review; verification as a separate job).
- **Capability** `capabilities/seal/merkle.ts`: SHA-256 Merkle seal over session steps (domain-separated leaf/node, odd node paired with itself), `proofFor`, `verifyStep`. Standard library only.
- **Pack `flipside-review`** (`packs/flipside/`, extended registry; catalog system `engineering`): reviewer agent asks Q1 (assigneeOnly: the author), author agent proposes disclosing exactly ONE step (approver = the author's email), seal verifier checks it and an edited copy (PROOF_FAIL), and drafts the reviewer brief. A whole-session request has no action type: it is recorded as refused. `verifyAction` re-reads the stored delivery, recomputes the proof from the baseline seal, and fails if any other step's text appears. Completion adds: seal recomputes from leaf hashes, author answered, edited copy rejected.
- **Seed:** new manager `noor@harborvine.example` (maps `flip_author`), `omar@` maps `flip_reviewer`. The engine requires an approver to hold a manager role, so Priya (a member) was not used as the author.
- **API/read model:** `api/flipside.ts` (`GET /api/flipside`, `GET /api/flipside/:id`): tree levels from public leaf hashes, proof path, verdicts, next action. Only the one disclosed step's text is returned.
- **Frontend (no business logic):** `components/Mascot3D.tsx` (CSS 3D extruded mascot, damped-spring pointer tilt, eye tracking, blink, float; sleeps off-screen/hidden tab; honours reduced motion), `MerkleTree3D.tsx` (tilted 3D tree, animated proof path), `Stepper.tsx`, `FlipsideShowcase.tsx` (scroll-driven landing section, labelled ILLUSTRATION with synthetic data), `pages/FlipsidePage.tsx` (nav: Flipside Review), `flipside.css`.
- **Verified 2026-11-07:** `tsc` 0, `eslint` 0, `npx vitest run` **41 files, 318 tests passed** (new `tests/flipside.test.ts`, 8). Browser: `scripts/e2e-flipside.mjs` -> FLIPSIDE JOURNEY PASSED; `scripts/e2e.mjs` -> E2E PASSED; `scripts/e2e-crossdomain.mjs` -> CROSS-DOMAIN JOURNEY PASSED. Headless landing measured 61 rAF fps (software rendering; not a real-device measure).
- **Limits, do not claim:** the sample session is a synthetic fixture held in code (`packs/flipside/fixture.ts`); in a real deployment it would stay on the author's side and nothing here reads one. The seal proves a step is in the session sealed before review, not that the step is true or the PR safe. There is no `flip seal` CLI. Delivery is the local dry-run outbox. **Not exercised on real Switch or Mattermost**, so the recorded-run claims in the brief (real Switch 0.31.0 rooms, four live refusals, 14 message ids) are NOT claimed for RIPPLE. No Rust verifier and no `make judge` target exist here. The 3D is CSS transforms, not WebGL.

## Session 17: nine additional capabilities (built on the single engine)
Discovery first (nine read-only agents, one per folder, ideas kept as text under the session scratchpad `ideas/`), then the owner chose these nine. Each is labelled by its source. Verified 2026-11-07: `npm run typecheck` 0, `npm run lint` 0, `npx vitest run` **40 files, 310 tests passed**; `scripts/e2e.mjs` and `scripts/e2e-crossdomain.mjs` both pass on a clean local-mode server (port 8791, Switch variables blank).
- **Per-role tool scope**: `RoleDef.scope: 'read' | 'act'` (`engine/types.ts`). `validateRoleResult` refuses a read-only role's output that proposes actions. Sentinel's `telemetry_triager` and `commit_investigator` are read-only; `rollback_operator` keeps the default.
- **Repeat suppression**: `engine/repeat.ts`. A repeated inbound Switch flag from the same sender in the same mission is recorded once per 5 minutes. Only the inbound flag path uses it.
- **Untrusted-text additions**(`packs/untrusted.ts`): placeholder suppression for secrets (`AKIA…EXAMPLE` is ignored, a real-looking key is still flagged); `cleanCopy` (a reviewer copy with hidden characters removed and each dropped line listed; the stored original is never replaced); `agentFileKind` (CLAUDE.md, AGENTS.md, .cursorrules, copilot-instructions, mcp.json, .claude/); five more dangerous-command patterns (mkfs, dd to a device, DROP DATABASE/TABLE/SCHEMA, force-push, fork bomb); four more agent-directed patterns (hide actions from the user; read or send credentials).
- **Quiet hours**: `engine/quiet.ts`, `ActionSpec.quietHours` (UTC window, may wrap midnight), `actions.quiet_hours` column. `executeAction` returns 423 and changes nothing while quiet. **Not enabled in any pack:** blocking an incident rollback overnight would be harmful, so the mechanism is available and off by default.
- **Approval expiry**: `ActionSpec.approvalTtlMinutes`, `approvals.expires_at` column. `decideApproval` refuses an expired approval (409 `expired`) and returns its action to stale; `sweepExpiredApprovals()` runs on the server's existing 15-second timer. Enabled on sentinel's rollback approval (240 minutes).
- **Two-sided verification**: `capabilities/verify/twosided.ts`. The on-call SRE records probe results (`must-block …: blocked`, `must-allow …: allowed`); an `unknown` fails closed. Sentinel adds a non-blocking question and a completion check that appears only when probes are recorded. **RIPPLE sends no requests itself**; the "simulated" success on probe exceptions is deliberately not carried over.
- **Interim-then-permanent pair**: sentinel `interim_mitigation` question. A recorded TEMPORARY step becomes its own action, and the rollback is `blockedUntil` that action. The interim verifier checks only the TEMPORARY label and the "not the permanent fix" statement; it cannot prove the mitigation worked.
- **Derived-value reconciliation**: `capabilities/reconcile/derived.ts` (integer units, explicit tolerance, `no-cached-value` rather than zero, statement comparison that shows the gap and corrects nothing). Wired into the ledger seal check: each seal records its highest covered rowid (`ledger_seals.last_rowid`), and the check reports how many covered events still exist. Seals made before the column report `no-cached-value`. **No billing balance is wired:** billing's refunded totals are computed at snapshot time, not cached, so there was nothing real to reconcile there.
- **Deploy gate**: new pack `packs/depgate` (id `deploy-gate`, engineering workspace). It blocks only NEW critical CVEs compared with the deployed release, using an SBOM and CVE list the team supplies. Unverified evidence never clears; a block can be overridden only by the release owner (Sam in the seed); a clear gate proposes a dry-run deploy request. **It never scans, deploys or certifies.** Seeded role `depgate_owner` is mapped to Sam.
- **Limits, do not claim:** none of these runs against a live system. Two-sided checks depend on human-recorded probe results. The interim verifier does not prove the mitigation worked. Quiet hours are unused by any pack. The deploy gate's sample evidence is illustrative.
- **Still open from the owner:** "elevator" was named in the owner's list, but no folder or file in the project matches that name.

## Session 16: engine and pack additions (four built; the rest recorded, not built)
Scope: survey candidate ideas, then build the ones that fit the single engine.
- **Hidden-instruction, secret and dangerous-command scan**: `src/server/packs/untrusted.ts` adds `hiddenTextFindings` (Unicode Tag characters decoded to the ASCII they hide, bidi overrides, runs of 3+ zero-width characters), `secretFindings` (AWS/GitHub/Slack/`sk-` tokens and private-key blocks; the value is never echoed), `dangerousCommandFindings` (`rm -rf` on root/home, pipe-to-shell, `chmod 777`), and one entry point `untrustedFindings`. Callers switched: billing, clearsend, consumer, crewpilot packs and `reality/rge.ts`. **Inbound Switch messages** are now scanned in `engine.ts` and recorded as an advisory `untrusted_content_flagged` audit event (not acted on, state unchanged).
- **Four-eyes approvals**: `ActionSpec.separateFromRequester`; `approvals.separate_from_requester` column with a forward migration in `db/db.ts`; `decideApproval` refuses the person who submitted the change. Enabled on billing `refund_duplicate` and `issue_sla_credit` (money-moving actions).
- **Signed, portable ledger receipts**: `src/server/api/receipt.ts`. `POST /api/dash/trust/receipt` (manager/owner) issues a receipt over the current chain head, Ed25519-signed when `RIPPLE_RECEIPT_PRIVATE_KEY` is set (otherwise labelled UNSIGNED). `POST /api/dash/trust/receipt/verify` checks the signature and whether the first N events still hash to the signed head. Trust limits are stated in the receipt: an embedded key proves consistency, not identity; the verifier must supply the trusted public key. `.env.example` documents the variable.
- **Review fixes (ECC code-reviewer, same day):** a receipt that claimed `signed: true` with no signature object was returned `intact`; it is now `signature-invalid`. A negative event count is rejected. An intact chain checked only against an embedded key now returns `consistent-untrusted`, not `intact` (`intact` requires a trusted public key).
- **Verified (2026-11-07 runs):** `npm run typecheck` exit 0; `npm run lint` exit 0; `npx vitest run` → **34 files, 277 tests passed** (baseline before this session: 31 files, 256). Browser journeys on a clean local-mode server (port 8791, Switch variables blank): `node scripts/e2e.mjs` → `E2E PASSED`; `node scripts/e2e-crossdomain.mjs` → `CROSS-DOMAIN JOURNEY PASSED`. Note: `scripts/e2e.mjs` hardcodes port 8787, where an older RIPPLE server started with the Switch configuration was still running, so the first e2e attempt failed on the "LOCAL mode" assertion. That is an environment conflict, not a regression; stop the old server to run the script unchanged. New tests: `tests/controls16.test.ts` (16: scan cases, four-eyes refusal and flag-off path, receipt sign/verify/tamper/unsigned/workspace/key-escape/audit cases), `tests/receipt-api.test.ts` (2: manager issues and verifies over HTTP, viewer refused), `tests/inbound-untrusted.test.ts` (2: flagged inbound message recorded and state unchanged; ordinary message not flagged). Billing tests (8) still pass with four-eyes on.
- **NOT built (recorded for later, do not claim):** digest-bound approvals; two-sided verification; interim-then-permanent action pairs (a a verification pattern-style pattern); role-ownership lease with stale-holder takeover (a presence-lease pattern); numeric grounding gate for proposals (data-room; no pack consumer yet, so not added); canon-invariant checker (a canon pattern); SBOM/CVE gate (a release-gate pattern); briefdesk pack (a briefing pattern); commerce pack; release-desk pack (Release Desk); crewpilot reproduction-evidence stage (a bug-to-fix pattern). No receipt UI in the Trust page yet (API only).
- **Not exercised:** no live Switch run for any of this. The inbound flag is tested with a test port that mimics a Switch room, not a real room.
- **Housekeeping:** unused fixture and draft folders were removed from the working tree. The app's own folders are kept.

## Session 15: Level 3 — the six rare Switch primitives, live + mock + tests
Scope (owner directive): implement the 6 rarest/highest-scoring `sandbox-quantum/switch` capabilities other hackathon entries missed, each with a dedicated pytest verification test, and a "Why RIPPLE Pushes Switch to Level 3" table at the top of README.md. All protocol claims below were checked against the vendored switch-core 0.31.0 source FIRST (`%APPDATA%\switchdash\...\switch-core\0.31.0\src`), then exercised against the RUNNING real server.
- **Canonical names used (verified in source, not invented):** `/ops/create_room` with `linked_rooms`/`roles`/`agent_names` (bridges/agent/operations/definitions.py), `isolation refusal` (agent bridge: HTTP 400 "Agent is not a member of this room" — OBSERVED; 403 is the op auth layer), `define_role`/`assume_role`/`list_roles` (exclusive: one LIVE holder; one lease per agent), `get_my_context` (who_can_talk / person / server.features), `create_room_document` + `load_internal_documents` (requires `ids`), `GET /rooms/{id}/yaml` (gateway; needs a human session), `!follow-ups on` / `!assign-agent` (human-typed admin commands; template **version: 2**), `follow_the_conversation` feature flag.
- **New code:**
  - `src/server/capabilities/reclaim/attachments.ts` — the **#908 guardrail**: deterministic attachment/caption/filename sanitizer (mimetype/extension mismatch, executables, size, mxc:// validity, control chars, injection patterns); quarantined content stays data, `llmCalls: 0`.
  - `src/server/collab/switch.ts` — Level-3 primitives on the adapter: `createCaseRoom` (linked_rooms + roles), `joinRoom`, `inspectRoom`, `defineRoomRole`/`assumeRoomRole`/`listRoomRoles`, `myContext`, `createRoomDocument`/`loadInternalDocuments(ids)`, `exportRoomYamlGateway`, `openCaseTopology` (caps 1–4 executed, structured `CaseTopologyResult` with honest labels), `captureResolvedPlaybook` (cap 6 gateway attempt → labelled local `version: 2` fallback) + `postFinalTelemetryDocument`. New env: `SWITCH_ARBITER_*`, `SWITCH_GATEWAY_*` (.env.example).
  - `src/server/collab/playbook.ts` — the `version: 2` playbook composer + `playbooks/resolved-<case_id>.template.yaml` writer.
  - `src/server/collab/port.ts` — optional `CollabPort.openCaseTopology` / `captureResolvedPlaybook` + `CaseTopologyResult`. Types only added, nothing removed.
  - `src/server/engine/engine.ts` — pack-declared `switchCaseTopology` executed generically in `ensureRoom` (rooms rows + `case_topology_bootstrapped` audit + room message); inbound Switch attachments run through the guardrail before recording; on completion `captureResolvedPlaybook` + `resolved_playbook` artifact + `room_playbook_captured` audit. No branching on pack id in engine/UI. `completeMission` is now `async` (both callers await).
  - `packs/billing/pack.ts` — declares the case topology (ops/finance rooms, exclusive `settlement-signer`, arbiter `ripple-arbiter`); dispute `change.attachments` (zod, default []) are sanitized in `bd_intake` and quarantines surface as risks + a `attachment.quarantined` change item.
  - `switch/ripple-room.template.yaml` — rewritten as **`version: 2`** (agents with addressing, intake + ops_verify + finance_settle rooms, ONE group with links, exclusive settlement-signer role, kickoff with the `!follow-ups on`/`!assign-agent` bootstrap).
- **Verified (real runs, 2026-11-06):**
  - `npx tsx scripts/switch-live-level3.ts` against the RUNNING real switch-core 0.31.0 (API 127.0.0.1:52042): **ALL 11 STEPS PASSED** (health; linked-room provisioning; non-member connect refused 400 with the server's own text; arbiter assumes settlement-signer with its own key; list_roles lease read-back; conflicting assume refused — "is exclusive and currently held by another agent", one-lease-per-agent also observed; get_my_context addressing introspection + APPROVE authority announcement; follow-ups bootstrap + `follow_the_conversation` ON in server.features; #908 guardrail live check (guard 3/3, 0 LLM); trust-ROI room document created + read back via ids; gateway 401-refusal path → local `version: 2` playbook written). Evidence: `docs/evidence/switch-live-level3-2026-11-06.json`; playbook: `playbooks/resolved-l3-393738be.template.yaml`.
  - Real-server facts that changed the code (found live, not from the mock): `group_name` in `create_room` must name an EXISTING group (400 otherwise — we stopped sending it; the group lives in the v2 template/playbook); non-member connect = **400**, not 403; `load_internal_documents` **requires `ids`**; assume_role refuses a second concurrent lease per agent; conflict refusal text is `Role 'X' is exclusive and currently held by another agent`.
  - `npm test`-equivalent: `npx vitest run` **31 files / 256 tests passed** (new: `tests/switch-level3.test.ts`, 7 — one per capability + engine integration to COMPLETED with a written playbook + honest-degradation). `tsc --noEmit` clean, `eslint src tests scripts` clean, `vite build` OK.
  - `python -m pytest tests_py/test_switch_level3.py`: **6 passed** (one per primitive, via `ripple_switch/switch_client.py` against `tests_py/mock_switch_core.py`; caps 5/6 cross-verify the TS guardrail/playbook composer through `scripts/guardrail-cli.ts` / `scripts/playbook-cli.ts` — the same code the engine runs, never a re-implementation).
- **NOT done / do not claim:**
  1. **Mattermost-bridged rooms** with humans typing `!follow-ups on` / `!assign-agent` in chat — still not running; agent-only `internal_only` rooms carry the contract in room instructions + the bootstrap post, and the `!` flag flip itself is honestly labelled as human-typed.
  2. **Gateway export** (`GET /rooms/{id}/yaml`) with a REAL human session — the live run recorded the agent-key refusal and used the labelled local fallback; no `SWITCH_GATEWAY_*` credentials were configured.
  3. **`POST /rooms/from-yaml` round-trip** of an exported playbook (re-importing `playbooks/resolved-…`) was not run against the real server.
  4. The arbiter is NOT an always-on separate process: it connects with its own key during the bootstrap and disconnects after; an exclusive lease auto-releases shortly after disconnect (the role stays defined+exclusive on the server, and at most one LIVE holder is still the guarantee).
  5. Role-agent live answering (same as sessions 13–14) and bridge-addressed humans remain outside this session.

## Session 14: single-company Billing & SLA Dispute (obligation graph), 3 must-pass scenarios on real Switch
Scope chosen by the owner: one company, internal departments (Support, Engineering/Ops, Finance, Legal & Policy). Customers stay outside Switch: email in, dry-run email out. No multi-org or multinational scope.
- **Engine (generic):** `ActionSpec.blockedUntil {actions, workItems}`. `executeAction` refuses (409 `blocked_by_dependency`, audited) until the listed actions are verified and the listed work items are done. The field is stored in the payload only when declared, so other packs' hashes are unchanged.
- **Connector:** `billing_sandbox` (`connectors/billing.ts` + `packs/billing/ledger.ts`). It is a labelled per-mission test ledger: refund/credit with independent read-back, plus a provider-side rule that a charge is refunded at most once. A scripted `lost_response` fault commits the refund and then loses the response.
- **Pack `billing-dispute`** (`packs/billing/pack.ts`):
  - agents: Support intake (RIPPLE commitments), Incident agent, Billing agent (shares only the verified claim), Policy agent (SLA tiers/cap, claims grounded with Citation `verifyClaim`), Comms (obligation graph OB-1..OB-6 + reply);
  - humans: Nora (Finance lead, approves refund/credit and reconciles amounts), Eli (Engineering lead, confirms the fix), Sofia (Support lead, approves the reply).
- **Switch adapter fix (found in the live run):** `post_message`/`send_targeted_message` have no room id in switch-core 0.31. With several missions, messages could land in another mission's room. All claims and sends now run through a serial queue that re-claims the target room. Regression test in `tests/switch.test.ts`.
- **Verified (real runs):**
  - tsc and eslint clean; `npx vitest run` 30 files / 249 tests passed (`tests/billing.test.ts` 8 + 1 Switch regression);
  - `npm run demo` (fresh server + real Switch, agent-only rooms): ALL 3 SCENARIOS PASSED. Happy path; $10,000 credit rejected and never executed; timeout → UNKNOWN → read-back → verified, not repeated. Evidence in `docs/evidence/e2e-billing-switch-2026-11-06.json`;
  - `scripts/switch-live.ts` 9/9 again after the fix.
- **NOT done:**
  - per-department Switch rooms (one mission room is used; Finance's raw ledger stays in a Finance-owned artifact, but artifact read access is NOT role-restricted);
  - Mattermost humans in chat;
  - approval typed in chat;
  - docker-compose (the demo is `npm run demo`; Switch itself runs from Switch Console).

## Session 13: Citation + RIPPLE + Intake safety combined into RIPPLE; real Switch connected
Full write-up: **the session 13 notes**.
- **Capabilities, ported to TS (no second engine):**
  - `src/server/capabilities/resolve/commitments.ts` (RIPPLE `inbox_intel.py`);
  - `capabilities/reclaim/knowledge.ts` + `corpus.json` (BM25, provenance, citation checks; 28 airline/banking authored-guide rows);
  - `capabilities/redeem/intake.ts` (safety refusals, scam scan, confirmed-memory mapper).
- **New pack `consumer-resolution`** (`packs/consumer/pack.ts`, extended registry):
  - one mission per consumer problem across an airline and a bank;
  - only the consumer (Asha Rao, `asha@`) answers her questions and approves her messages; Kai Mendes (`kai@`) is the case reviewer;
  - the outcome stays "awaiting organisation response" until the consumer confirms a refund.
- **Switch:** postponement lifted by the owner.
  - Agents are registered on the local switch-core 0.31.0 (`scripts/switch-register.mjs`).
  - The adapter now supports `SWITCH_INTERNAL_ONLY=1` (agent-only rooms), because the Mattermost bridge was not running.
- **Verified (real runs):**
  - tsc and eslint clean; `npx vitest run` 29 files / 240 tests passed;
  - `scripts/switch-live.ts` 9/9 against real Switch;
  - `scripts/e2e-consumer-switch.mjs` E2E PASSED. Real server + real Switch, mission completed, 49 room messages read back.
  - Evidence: `docs/evidence/switch-live-2026-11-06.json`, `docs/evidence/e2e-consumer-switch-2026-11-06.json`.
- **NOT done:**
  - Mattermost-bridged rooms with humans in chat;
  - role agents running as separate Switch processes;
  - approval from chat;
  - Gmail/voice/OCR ports;
  - Playwright e2e for the new pack.

## Session 12: "fix all errors"
**Checks run:** typecheck, eslint, vitest, vite build, editor diagnostics, an API sweep (56 read endpoints × manager/member/viewer, all 200), a browser sweep (21 pages × manager + viewer: no JS errors, no error banners), and every e2e script.

**Fixed:**
1. **Server port conflict:** the server crashed with an unhandled `'error'` event when the port was taken (`src/server/index.ts`). It now prints a clear message and exits.
2. **Bundle size:** the vite warning (main bundle 558 kB) is gone. Larger pages lazy-load (`App.tsx`), bringing the main bundle to 278 kB.
3. **Hidden replan outcome (Cross-Domain Resolution):** after a replan, the "Outcome: replanned" banner was hidden, because it sat inside the chosen-option card and the new plan has no chosen option yet. It is now shown above the cards (`CrossDomainPanel.tsx`).
4. **Pack demo buttons (accessibility):** the buttons on Workflow Packs had identical names on every card. They now have per-pack `aria-label`s (`PacksPage.tsx`), with no visual change.
5. **E2E scripts:**
   - they crashed when Playwright was missing; they now resolve `playwright`, then `playwright-core`, then a global `playwright-core`, and fall back to the installed Chrome;
   - stale UI strings were updated ("Arm failure next run", "Independent Verification Ledger", "Pending Approvals");
   - a lingering-toast race in e2e-cdii was fixed;
   - e2e-cdii now does a clean reload before scenario 4;
   - selectors were scoped (impact select, answer toast).

**Verified (real runs, fresh DB each):**
- `vitest` 28 files / 225 tests passed; tsc and eslint 0 errors; build has no warnings.
- e2e results:
  - `e2e.mjs`: E2E PASSED;
  - `e2e-packs.mjs` × 6 (scopeguard, invoiceguard, shiftrelay, movemate, podflow, submitready): all PASSED;
  - `e2e-crossdomain.mjs`: PASSED;
  - `e2e-cdii.mjs`: PASSED twice; its only console entries are the expected pre-login 401 and the deliberate 409 gate refusal;
  - `e2e-followups.mjs` and `e2e-packs.mjs`: exit 0.

## Session 11 (latest): flagship Revenue Recovery + nothing static
Full write-up, including the demo runbook and limitations: **docs/RIPPLE_IMPLEMENTATION_REPORT.md**.
- **New pack `revenue-recovery`** (extended registry), with a labelled warehouse sandbox connector `warehouse_sandbox`. Human roles: `incident_commander` → Maya, `revenue_controller` → Ravi.
- **Flow:** competing hypotheses → adversarial review on evidence → human choice → per-operation approval → scripted lost response → `EXECUTION_UNKNOWN` → read-back recovery without repeating → invariant verification → completion. All of it is driven by chat.
- **Console additions:** `complete mission`; clearer UNKNOWN/Recovered wording; the execute proposal names the connector's real mode.
- **Now live:** How it works (`/api/dash/how`), Case Review (a real mission plus the console) and Studio home (live coverage). Workflow Studio's synthetic scenario is unchanged (labelled).
- **Verified:**
  - `npx vitest run`: 28 files / 225 tests passed (new: `tests/revenue.test.ts`, 2); tsc and eslint clean; vite build OK.
  - Browser (fresh DB, port 8794): the full flagship ran by chat to "Mission completed"; no console errors.
- **NOT done:**
  - real Switch: installed but stopped here, still mock-tested only;
  - the other two showcase verticals as new slices;
  - a visual workflow composer and a policy DSL;
  - a live call to the Opus fallback.

## Session 10 (latest): four dashboards + Switch room (console with on/off Switch connection)
Directive: build the "34 projects → 7 capability systems → 4 dashboards → 1 engine" architecture as live content (reference images were for content only), keep the existing peach/coral UI, and add a Switch room reachable from every page where you can turn the Switch connection on/off and get work done by talking.
- **Catalog:** `src/server/capabilities/catalog.ts` records 7 systems, all 34 catalogued capabilities and scenarios A–G, and maps the 13 packs to systems. Integration status is honest: `pack-backed` only where an implemented pack exercises the capability; everything else is `catalogued`. RupiVerse stays `pending` (its source is a FastAPI/Expo scaffold with only `/` and `/health`). Bangsayur is classified into Commerce from its README.
- **Read models:** `src/server/api/dashboards.ts` serves `/api/dash/mission-control|workbench|workbench/:id|trust|knowledge|briefing`, `/api/capabilities` and `/api/dash/trust/receipts/:id` (portable JSON receipt), plus `POST /api/dash/trust/verify|seal`. Every number is computed from recorded rows; with no data, values are null ("—"), never fabricated.
- **Trust:** a sha256 hash chain over `audit_events`. `ledger_seals` anchors heads, and re-verification detects any edit to a sealed row (tested). Separation of duties is re-checked from the ledger.
- **Knowledge:** decision validity (valid/applied/superseded) comes from change_seq and the subject action's status. Contradictions come from `cd_findings` and from approved actions whose observed outcome failed.
- **Switch console:** `src/server/console/` (intents.ts + console.ts), routes `/api/console*`.
  - Interpretation is a deterministic parser first. An optional model (Anthropic, default `claude-opus-5-5`, env `RIPPLE_CONSOLE_MODEL`) runs only for unrecognised phrasing, is schema-validated, and can never confirm.
  - Every state change (approve/reject/execute/answer/demo/seal) is a proposal that a signed-in user must confirm. It then runs through the normal Engine method under that user's role.
  - Messages from a Switch room are advisory: read-only replies only, and changes are queued for a RIPPLE user.
  - The on/off switch reports what it observed: `not_configured` (no env), `unreachable` (health/create_room failed), `connected` (mock bridge in tests), `disconnected` (after restart).
- **UI:** new pages `src/web/pages/dash/*` (Mission Control, Operations Workbench, Trust & Evidence, Knowledge & Decisions), `src/web/components/SwitchRoom.tsx` (floating dock on every page, Ctrl+K, voice input where the browser supports it, full page at `#/switch`), and CSS appended to `theme.css` using the existing tokens. No existing page was changed or removed; the nav gained 5 entries at the top.
- **Persistence:** 3 workspace-scoped tables (`ledger_seals`, `console_state`, `console_messages`), included in workspace export and delete.

Verified (real runs, this session):
- `npx vitest run`: 27 files / 223 tests passed (new: `tests/console.test.ts` 7 and `tests/dashboards.test.ts` 3, covering cross-tenant isolation, viewer/member refusal, tamper detection, and Switch advisory-only against a mock bridge). `tsc --noEmit` clean, `eslint src tests scripts` clean, `vite build` OK.
- Real browser (Chrome, fresh DB, port 8793) as Maya, all inside the Switch room:
  - "start demo invoiceguard" → Confirm → mission created;
  - "list approvals" → "approve 1 because matches the purchase order" → "yes" → approved as Maya;
  - "execute 1" → "yes" → "Executed and independently verified";
  - the toggle showed "Switch not configured · local console";
  - Trust: seal → "all seals intact";
  - Knowledge showed the decision with its rationale as valid;
  - no app console errors (only the MetaMask extension).

NOT done (do not claim):
1. **Switch** is still not exercised against a real server. Connected mode is tested only against a mock of the documented protocol.
2. **The model interpreter** was not called against the live Anthropic API (no key); only its guard logic is tested with an injected fetch.
3. **The 34 catalogued capabilities** are listed, not ported. Only the pack-backed ones run today.
4. **The ledger chain** is computed on read. Seals detect edits to sealed rows, but there is no external anchoring or signing.
5. **Playwright e2e scripts** were not run; the browser check was manual.

## Session 7: Reality Gap Engine + RIGOR benchmark + Split-Brain showcase
A second "RIPPLE competitive domination" directive was received. Following its own rule ("one fully working vertical slice over ten mock integrations"), this session built one slice: the Reality Gap Engine, the RIGOR benchmark and the split-brain demo. Full write-up: **docs/REALITY_GAP_ENGINE.md**.
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
Scope note: a RIPPLE directive (competitive capability expansion: incident, schema, PR review, Issue Triage, finance, Candidate Fit, Study-Nexus, causal graph, real Switch) was received. Only this slice was implemented in this session. The rest is NOT built (see "NOT done" below). The project in this folder is RIPPLE; the directive was applied here.

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
2. Schema lineage graph, SQL impact analysis, dual-fixture tests: not built (Schema Governance pack from session 3 is unchanged).
3. GitHub webhook ingestion with signature validation, patch execution, PR review publishing: not built.
4. Issue Triage/Candidate Fit/Study-Nexus expansion, payment-provider sandbox: not built (existing packs unchanged).
5. Real Switch: still POSTPONED (AGENTS.md hard rule 1). The Switch adapter remains mock-tested only.
6. Causal graph explorer UI, Governance/Reliability Center UI, Workflow Studio composition engine: not built.
7. Multi-agent arbitration (adversarial reviewer, minority objections): not built.
8. Phase-1 docs (FEATURE_PRESERVATION_INVENTORY, retired competitive analysis, IMPLEMENTATION_ROADMAP) exist from earlier sessions and were NOT refreshed in this session.
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
The Workflow Studio (`src/web/pages/WorkflowStudio.tsx`, `src/server/api/studio.ts`) is a synthetic demo. It previously showed **fabricated live telemetry** (client-side `Math.random()` "tok/s / latency / tokens", hardcoded infra latencies/health "100%") and its **Approve buttons claimed false outcomes** ("Vendor dispute authorized! Dispatched to vendor AP.", fake "vendor acknowledged credit memo" events) when they only wrote an audit row.
Fixed (studio routes now only serve real measurements or audit-log demo decisions; nothing is dispatched):
- New `GET /api/studio/telemetry` returns **real** values measured at request time: uptime, SQLite size via `PRAGMA page_count/page_size`, workspace-scoped ledger counts (missions, open work items, agent runs, pending approvals, open questions, verified actions, evidence, audit events), provider name/kind, pack count, collab describe. UI top bar now polls this (5 s) instead of random numbers.
- `GET /api/studio/infrastructure` rebuilt: real counts/measured response time/Node version; fake per-node latencies, "100%" health and error counts removed. UI Infrastructure tab now renders these server values (was hardcoded).
- Approve/guidance endpoints validate input, record decisions/guidance **per workspace** (in-memory + audit-logged), and return honest messages ("decision recorded… nothing was sent"). UI approval flows, badges ("Decision recorded — demo only") and guidance copy updated; fabricated vendor-acknowledgment log lines removed; audit-tab and workflows responses labelled "synthetic demo".
- Renamed leftover "RIPPLE" branding to RIPPLE Studio.
Verified (real runs): `npm test` **16 files / 133 passed** (studio tests extended: telemetry values real, approve message honest, invalid action → 422, decision served back; infra has no fabricated `health`/`latency` fields), `npm run typecheck` + `npm run lint` clean, `vite build` OK, and a live throwaway-DB smoke test confirmed real telemetry (dbBytes 262144, auditEvents incremented on login/decision) and honest approve response.
Still synthetic (by design, now labelled): the six Studio workflow scenarios, their agents/steps/evidence cards, the audit-tab illustration and the "Simulate" run narrative.

## Session 4b: landing page (pixel meadow)
Built a pixel-meadow landing page for the login screen, with decorative animated characters. The scene represents no engine state.
Also this session: fixed 5 pre-existing lint errors in newer engine code (`engine.ts` useless `passes` variable; `beo/pack.ts` unused destructures in `roleInputs` scrub).
Verified (real runs): typecheck + lint clean; `npm test` 16 files / 133 passed; `vite build` OK; real-browser check on a fresh server (`docs/evidence/landing-meadow.png`, `landing-meadow-login.png`): landing renders (wordmark, scene, 7 walkers), login over the meadow succeeds, zero browser console errors. NOTE: `scripts/e2e*.mjs` cannot run in this environment until `playwright` is installed locally (only global `playwright-core` + cached Chromium exist); the browser check above used playwright-core directly.

## Session 3: five domain packs added
13 packs now (added/rewrote `offerroom`, `incident-sentinel`, `schemacourt`, `clearsend`, `crewpilot`; all in `extendedRegistry()`). Verified: `npm test` 132 passed / 16 files, typecheck + lint clean, build OK, `scripts/e2e-packs.mjs` all PASS (see docs/END_TO_END_VERIFICATION.md).
Engine additions: named-approver gate (`ActionSpec.approver`), `QuestionSpec.assigneeOnly`. Switch adapter gained reconnect/Last-Event-ID/heartbeat-interval/dedupe (mock-tested only).
Earlier docs from the previous pass overclaimed; corrected (banners in IMPLEMENTATION_REPORT / retired competitive analysis; GAP_ANALYSIS and END_TO_END rewritten). Still-overstated lines may remain in DEMO_RUNBOOK.md ("3D map", "byte-for-byte") and IMPLEMENTATION_ROADMAP.md (checkboxes stale).
Next: browser e2e for new packs; wire Candidate Fit mock-interview grading to a UI; real Switch run; the older sections below describe session 2.

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
