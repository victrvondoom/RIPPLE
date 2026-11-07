# Switch integration

**Status (session 15, live run 2026-11-06): the six Level 3 primitives are exercised against the REAL switch-core 0.31.0 — see "Session 15" at the bottom.** Without SWITCH_* variables the runtime is still LOCAL mode, labelled "LOCAL MODE (not Switch)".

### Session 15: the six Level 3 primitives, live on switch-core 0.31.0 (server left RUNNING for this run)
`npx tsx scripts/switch-live-level3.ts` — **ALL 11 STEPS PASSED**. Evidence: `docs/evidence/switch-live-level3-2026-11-06.json` (no keys in the file). What ran, per primitive:
1. **Dynamic bootstrap provisioning:** `create_room` with `linked_rooms` (ops → intake, finance → intake) and `roles` (exclusive `settlement-signer` defined at creation) — accepted, real room UUIDs recorded. Two real-server facts found and fixed on the way: `create_room` **refuses an unknown `group_name`** (HTTP 400 "No room group named …"; `group_name` must reference an existing group, so the case *group* is expressed in the version-2 template/playbook instead), and a non-member `connect_to_room` is refused with **HTTP 400 `{"detail":"Agent is not a member of this room"}`** — not 403 (403 is the agent-op auth layer). The adapter records the refusal verbatim as the isolation evidence; RIPPLE never claims "403" for it.
2. **Exclusive role lock:** `@ripple-arbiter` (own key from `data/switch-agents.local.json`) connected to `#finance-settle` and assumed `settlement-signer` (`{"role":"settlement-signer","instructions":"…"}`), `list_roles` read the live lease back (`held_by: ripple-arbiter`), and a second identity's `assume_role` was refused: **`Role 'conflict-signer' is exclusive and currently held by another agent`**. Bonus guarantee found live: an agent may hold **only one role lease at a time** ("You already hold a role lease; release it before assuming another") — so a conflicting payout receipt needs a second agent, and the server refuses it too.
3. **Follow-ups:** the bootstrap contract (`!follow-ups on`, `!assign-agent @<coordinator>`) is posted in the intake room and shipped in `switch/ripple-room.template.yaml` as a **`version: 2`** template. Honest label: the `!` commands are admin commands typed by a HUMAN in the bridged chat; agent-only `internal_only` rooms have no human typing them, so the room instructions carry the contract. The live server reported `follow_the_conversation` ON (`get_my_context` → `server.features`).
4. **Addressing introspection:** `get_my_context` returned `who_can_talk=owner_and_owner_agents` and the owner of record (`agent-bootstrap@switch.local`); the arbiter posted the **APPROVE authority announcement** naming the single authenticated sender who may run `APPROVE <CASE_ID> <SHA256>`.
5. **Guardrail + telemetry:** the #908 defense was live-checked through the same TS sanitizer the engine runs (injection caption → `guard 3/3`, quarantined, 0 LLM calls), and the **Switch Trust & ROI Telemetry** block was posted as a native room document and read back with `load_internal_documents` — which **requires its `ids` argument** (another real-server fact; the adapter now always sends it).
6. **Self-encoding capture:** the gateway `GET /rooms/{id}/yaml` refuses the agent key (no human session; recorded honestly), so the resolved topology was self-encoded as a **`version: 2` playbook** — `playbooks/resolved-l3-393738be.template.yaml` from the passing run.
Runtime wiring: a pack **declares** `switchCaseTopology` (the billing-dispute pack does); `Engine.ensureRoom` executes it generically through `CollabPort.openCaseTopology` (implemented only by `SwitchCollab`); on completion `collab.captureResolvedPlaybook` writes the playbook + final telemetry doc, and the engine stores the playbook as a `resolved_playbook` artifact (workspace-scoped) with an audit row. Mock parity: `tests/switch-level3.test.ts` (7 tests) and `tests_py/test_switch_level3.py` (6 pytest tests, through `ripple_switch/switch_client.py` + `tests_py/mock_switch_core.py`) model the observed 0.31 behavior, including the 400 refusal texts.
**NOT exercised:** mattermost-bridged rooms with humans typing `!follow-ups on` in chat; the gateway export with a real human session; `POST /rooms/from-yaml` round-trip of the exported playbook.

### Session 13: real-server results
- `node scripts/switch-register.mjs` registered `ripple` (coordinator) and `ripple-intake`, `ripple-commitments`, `ripple-rights`, `ripple-drafting` via `POST /agents` with the server's registration token, and wrote the SWITCH_* variables to `.env`. Keys go only into `.env` and `data/switch-agents.local.json`, both gitignored.
- First real `create_room` → **HTTP 400**: "Default bridge 'Mattermost' … is not running, so the room cannot be bridged". Docker Desktop (and therefore Mattermost) was not running. Fix: `SWITCH_INTERNAL_ONLY=1` makes the adapter request an agent-only room (`internal_only: true`). The room note says no chat bridge is attached.
- `npx tsx scripts/switch-live.ts`: 9/9 steps passed (create_room, stream, connect_to_room, post_message, send_targeted_message with `@ripple-intake` prefix, history read-back, second agent posting with its own key, RIPPLE receiving that reply over SSE). Evidence: `docs/evidence/switch-live-2026-11-06.json`.
- `node scripts/e2e-consumer-switch.mjs` against a fresh RIPPLE server (`collaboration=SWITCH`): full consumer-resolution mission completed. The Switch room history held 49 messages, including handoffs to all four role agents, findings, approval requests, decisions and verification results. Evidence: `docs/evidence/e2e-consumer-switch-2026-11-06.json`.
- **Session 14 fix found against the real server:** `post_message` and `send_targeted_message` have no room id. They go to the room the connection last claimed (`require_connected_room`). With three missions open, a later mission's messages did not reach its own room. The adapter now serialises every claim and send, and re-claims the target room before posting. Regression test: `tests/switch.test.ts` ("re-claims the target room"). After the fix, `npm run demo` passed all three billing scenarios with each room read back.
- **Not yet exercised:** Mattermost-bridged rooms (humans chatting in the room). To try: start Docker Desktop, start Mattermost from Switch Console, unset `SWITCH_INTERNAL_ONLY`, re-run both scripts. Role agents are registered identities. During the mission, their analysis runs inside RIPPLE (deterministic analyzers). They do not yet run as separate always-on processes that answer handoffs on their own.

## What Switch is (from the official repo, commit `473c2e6` of github.com/sandbox-quantum/switch)
Switch (`switch-core` + Switch Console) puts humans (via Slack/Discord/Telegram/Teams/Mattermost) and coding agents in shared rooms. An agent client talks to the **agent bridge**: SSE down, HTTP up, `Authorization: Bearer <agent API key>` (`docs/official/internals/agent-protocol.md`). Agents are **registered out of band** (`POST /agents/register-known` with a registration token → `{id, api_key}`; key shown once).

## What RIPPLE's adapter does (`src/server/collab/switch.ts`)
| Step | Protocol call (as documented) |
|---|---|
| probe | `GET {bridge}/health` (public) |
| create room | `POST /agents/{id}/ops/create_room` `{name, description, agent_names:[self, …role agents], instructions}` → `{id,…}` |
| open stream | `GET /agents/{id}/events?connection_id=<uuid>&scope=single&filter=all&start_from=head&rooms=<room id>` (rooms declared on the URL, per docs) |
| claim room | `POST …/ops/connect_to_room` `{room_id}` + header `X-Switch-Connection-Id` |
| heartbeat | `POST …/connection/beat` `{connection_id, cursor}` every 2 s |
| handoff/question | `POST …/ops/send_targeted_message` `{body, target_names:[role agent]}` |
| broadcast | `POST …/ops/post_message` `{body}` |
| inbound | SSE `message` frames → recorded as **advisory** external messages |

Engine behaviour when Switch is configured: a room per mission; each handoff, finding, question, approval request, decision and escalation is posted; role handoffs are addressed to the mapped Switch agent. **Analysis stays authoritative in RIPPLE (rule-based analyzers)**; replies from Switch agents/humans are shown in the room log but never change mission state. If Switch is unreachable the mission continues in a labelled local room (`rooms.status='degraded'`, audited).

## Connect a real Switch (steps — untested here)
1. Run Switch (see its `docs/official/deploy/self-host.md`) with a chat bridge (e.g. Mattermost) and install Switch Console.
2. In Switch, register a RIPPLE agent (`register-known`) → note `agent id` and `api key`. Register role agents (e.g. `ripple-kitchen`, `ripple-procurement`, `ripple-service`, `ripple-coordinator`) with `AGENT.md` instructions asking them to answer RIPPLE handoffs and never certify food safety.
3. Find the **agent bridge** base URL (not the Gateway URL; verify with `GET /health`).
4. Set in `.env`: `SWITCH_BRIDGE_URL`, `SWITCH_AGENT_ID`, `SWITCH_AGENT_API_KEY`, `SWITCH_SELF_NAME` (RIPPLE agent's registered name), `SWITCH_ROLE_AGENTS=kitchen=ripple-kitchen,procurement=ripple-procurement,service=ripple-service,coordinator=ripple-coordinator,change=ripple-change`.
5. Restart; Settings → Collaboration should read "Switch adapter configured"; create a mission change and confirm a room appears in your chat app. **Then record the result honestly in `progress.md`.**

## What was tested
`tests/switch.test.ts` runs the adapter and engine against an in-process **mock** of the subset of the protocol above (request shapes, SSE parsing, heartbeat, room claim, targeted handoffs, inbound recording, degradation). It validates our reading of the docs, not Switch itself. Unverified assumptions: exact `create_room` response key (`id`, per its docstring), `connect_to_room` arguments, `send_targeted_message` target names resolution, heartbeat edge cases (re-open on 404/409 is not auto-implemented — the adapter only records the error).

## Session 5 update: installed Switch 0.31.0 (read from disk, not run)
- Installed under `%APPDATA%\switchdash\local-switch-server\native\switch-core\0.31.0` (Switch Console "native" runtime; Postgres and Mattermost in Docker). Ports from ports.json: gateway 52041, api 52042, mattermost 52043, postgres 52044.
- **Status: STOPPED.** No listener on 52041-52044 and the switch-core process recorded in run/switch-core.json was gone. RIPPLE is NOT connected to it.
- Protocol checked against the 0.31.0 source (not invented):
  - `POST /agents/{id}/ops/{operation}` exists (api/operations.py); operations `create_room`, `connect_to_room`, `send_targeted_message`, `post_message` exist (operations/definitions.py).
  - `GET /agents/{id}/events` (SSE) requires `connection_id`; the first frame is `connection_state`, which carries `connection_id`, `generation`, `cursor` and `heartbeat_interval_seconds`.
  - `POST /agents/{id}/connection/beat` takes `connection_id` and `generation`; a holder that declared the fenced revision and omits `generation` is refused.
  - `send_targeted_message` prepends `@name` to the body and resolves targets by participant name.
- Adapter change (session 5): the heartbeat echoes `generation` from connection_state. Covered by tests/switch-generation.test.ts (mock). Other unverified items remain: connect_to_room argument shape, target-name resolution, and the body-prefix behaviour.
- Manual requirement to test for real: start the Switch native server from the Switch Console, register the RIPPLE agent and role agents, set the SWITCH_* variables in .env, restart RIPPLE, then check that a mission creates a room and that a handoff reaches the room. Record the real result here.
