# Switch integration

**Status: adapter implemented from the official docs; NOT tested against a real Switch server.** The default runtime is LOCAL mode, labelled "LOCAL MODE (not Switch)" in the UI, API and every room record.

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
