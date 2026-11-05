# CrewPilot — Auto-Triager on Switch

CrewPilot is an AI teammate for team chat. This repository contains **Auto-Triager**, a workflow built for the **Flip the Switch Hackathon** (Best Business Workflow track).

A developer mentions the agent in Discord with a GitHub issue URL or a pasted issue description. The agent — connected through the real [Switch](https://github.com/sandbox-quantum/switch) platform — fetches the issue, classifies it, estimates severity and difficulty, writes a fix plan, and posts the result back into the channel. The human then approves the plan or requests changes.

**Switch owns the chat integration.** It bridges the Discord channel to a Switch room, and this Python process joins that room as a native always-on agent using Switch's real agent protocol (SSE events down, HTTP operations up). There is no separate `discord.py` bot and no mock middleware anymore.

## What the demo shows

1. A developer posts in Discord:
   ```text
   @crewpilot triage https://github.com/psf/requests/issues/1
   ```
2. Switch's Discord bridge turns the channel into a Switch room and delivers the addressed message to the agent.
3. The agent fetches the GitHub issue, asks OpenAI, Anthropic, or Groq for a structured triage, and validates the JSON.
4. The agent posts a triage card back through Switch. Switch mirrors it into Discord under the agent's name.
5. The requester replies:
   ```text
   @crewpilot approve
   ```
   or:
   ```text
   @crewpilot changes: add a regression test for large exports
   ```
6. The agent records the decision in the room. Only the original requester can approve.

## Architecture

```text
Discord channel
   |
   |  messages, mentions, threads
   v
Switch Discord bridge (owned by Switch, configured in Switch Console)
   |
   v
Switch server / room
   |
   |  SSE events down  (GET /agents/{id}/events)
   |  HTTP operations up (connect_to_room, post_message)
   v
CrewPilot Python agent
   |-- GitHub REST API      (issue URL resolution)
   |-- OpenAI / Anthropic / Groq   (structured triage JSON)
   v
Triage card + human approval, back through Switch to Discord
```

Why this shape matters:

- **Switch is the middleware layer.** It owns registration, room membership, addressing, delivery, and the Discord bridge.
- **The agent is transport-independent.** It only speaks Switch's agent protocol, so the same agent can later live in Slack, Teams, Discord, Telegram, or Mattermost.
- **The human stays in the loop.** The agent proposes; the requester approves or requests changes.

## Project structure

```text
CrewPilot/
├── main.py                    # Starts the native Switch agent
├── config.py                  # Env + saved credential loading/validation
├── github_issues.py           # Resolves GitHub issue URLs via REST
├── agent/
│   ├── prompts.py             # Triage system prompt and JSON contract
│   └── triage_agent.py        # OpenAI/Anthropic/Groq client + validation
├── switch/
│   ├── agent_client.py        # Real SSE + HTTP agent protocol client
│   ├── switch_connector.py    # Room triage workflow and approval handling
│   ├── register_agent.py      # One-time custom-agent registration CLI
│   └── credentials.py         # Local, git-ignored credential storage
├── requirements.txt
├── .env.example
└── README.md
```

## Before you start: a Switch server

This project is a **client of Switch**, not a replacement for it. You need a Switch deployment you can register an agent against.

You need:

- The **Switch agent bridge / API URL**. On a local Compose deployment this is typically `http://localhost:8000`. This is not the Gateway UI URL.
- A **registration token** for a Switch user. The registered agent is owned by that user.
- **Discord connected to Switch**, usually by a Switch administrator in Switch Console.
- An **OpenAI, Anthropic, or Groq API key**.
- Optionally a **GitHub token** for private issues and higher API limits.

If a hackathon organizer runs Switch for you, ask them for the API URL and a registration token. If you self-host, the token is `AGENT_REGISTRATION_TOKEN` in your deployment's `.env`.

Switch setup references:

- [Self-hosting Switch](https://github.com/sandbox-quantum/switch/blob/main/docs/official/deploy/self-host.md)
- [Connect Discord](https://github.com/sandbox-quantum/switch/blob/main/docs/official/deploy/messaging-apps/discord.md)
- [The Switch agent protocol](https://github.com/sandbox-quantum/switch/blob/main/docs/official/internals/agent-protocol.md)

### Connect Discord to Switch

The short version, if Discord is not connected yet:

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and copy its bot token.
2. Enable the privileged **Message Content Intent** and **Server Members Intent**.
3. Invite the bot with the `bot` and `applications.commands` scopes. It needs permissions to view channels, send messages, manage webhooks, manage channels/roles, read message history, attach files, and add reactions.
4. Copy the Discord **server (guild) ID**.
5. In Switch Console, open the server → **Messaging apps** → **Connect** → **Discord**, and enter the bot token and guild ID.
6. Link your own Discord account to your Switch user, so Switch recognizes you as the agent's owner.
7. Post an ordinary message in the Discord channel. This is what creates its Switch room; a channel with no messages is not a room yet.

## Setup

### 1. Install dependencies

From the project root:

```bash
python -m venv .venv
```

Activate the virtual environment:

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

```bash
# Windows Git Bash
source .venv/Scripts/activate

# macOS / Linux
source .venv/bin/activate
```

Then:

```bash
pip install -r requirements.txt
```

### 2. Configure `.env`

```powershell
# Windows PowerShell
Copy-Item .env.example .env

# macOS / Linux / Git Bash
cp .env.example .env
```

Fill in at least:

```dotenv
SWITCH_API_URL=http://localhost:8000
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

For Anthropic instead:

```dotenv
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-5
```

For Groq instead (its OpenAI-compatible API is used through the OpenAI SDK):

```dotenv
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=openai/gpt-oss-120b
# GROQ_BASE_URL=https://api.groq.com/openai/v1
```

Groq's default model here uses JSON object mode. If you switch to another Groq
model, choose one that supports JSON mode, or update the model name if Groq
retires the default.

### 3. Register the agent once

Set `SWITCH_REGISTRATION_TOKEN` in `.env` (or pass `--token`), then run:

```bash
python -m switch.register_agent --name crewpilot --description "Triages GitHub issues into fix plans and records human approval."
```

The command:

- registers a custom, always-on agent with the Switch server;
- saves the API key to `.switch/agent.json`, which is git-ignored;
- prints the agent ID and the next steps.

The server returns the API key only once, so do not delete `.switch/agent.json`. If you already have agent credentials from an administrator, skip this command and set `SWITCH_AGENT_ID`, `SWITCH_API_KEY`, and `SWITCH_AGENT_NAME` in `.env` instead.

### 4. Invite the agent into the room

In Discord, make sure the channel has had at least one ordinary message (so the Switch room exists), then run:

```text
!invite-agent @crewpilot
```

On Discord you can also use `/invite-agent agent:crewpilot`. In Switch Console, you can invite it from the room as well.

The agent starts with an owner-only addressing policy. If someone other than the registration token's owner will demo it, widen **Who can talk to your agent** in Switch Console (or use custom rules), and make sure that person's Discord account is linked to their Switch user.

### 5. Run the agent

```bash
python main.py
```

Expected startup output:

```text
INFO crewpilot: Starting CrewPilot as Switch agent 'crewpilot' at http://localhost:8000
INFO switch.agent_client: Listening to Switch as 'crewpilot' (connection ...)
INFO switch.agent_client: Switch connection ready: rooms=['...'] cursor=... protocol=...
```

Leave it running. It holds one SSE connection, sends a heartbeat every two seconds, and reconnects with the same connection ID and last event cursor if the socket drops.

### 6. Use it in Discord

```text
@crewpilot triage https://github.com/psf/requests/issues/1
```

Or paste the issue text:

```text
@crewpilot triage The CSV export returns an empty file when the report has more than 500 rows.
```

The agent replies with a card containing category, severity, difficulty, summary, and a numbered fix plan.

Decide on it:

```text
@crewpilot approve
@crewpilot changes: check pagination before changing the export query
```

Ask for usage help with:

```text
@crewpilot help
```

The agent requires the word `triage` (or a GitHub issue URL) so ordinary room conversation does not invoke the LLM.

## How Switch is used

Switch is the middleware and the chat transport. This Python process is a
native **Switch agent**, not a Discord bot. Switch owns the Discord bot and the
bridge from each Discord channel to a Switch room; CrewPilot never connects to
Discord directly.

The end-to-end path:

1. A person addresses `@crewpilot` in a Discord channel.
2. Switch's Discord bridge normalizes the message into a Switch room event.
3. Switch streams that event to the agent over SSE.
4. The agent resolves the issue, calls its LLM provider, and validates the JSON.
5. The agent claims the room and posts the result with an HTTP operation.
6. Switch mirrors the agent's message back into Discord.
7. Approval or change requests travel the same path in reverse.

What Switch owns:

- agent registration and API credentials;
- room membership, addressing policy and delivery filtering;
- one ordered SSE stream per agent, the heartbeat, and cursor-based replay;
- the Discord bot, webhooks, and Discord-side delivery.

What CrewPilot owns:

- GitHub issue resolution;
- the LLM prompt and structured JSON validation;
- the content of the triage card;
- in-memory pending-triage and approval state.

Switch's published agent protocol is implemented in `switch/agent_client.py`:

| Concern | Switch contract |
|---|---|
| Registration | `POST /agents` with the registration token; `connector_type: custom`; integration profile `always_on` |
| Events | `GET /agents/{agent_id}/events` as Server-Sent Events, with `scope=all`, `filter=addressed`, and a stable `connection_id` |
| Resume | Reconnect with the same connection ID and `Last-Event-ID` cursor |
| Liveness | `POST /agents/{agent_id}/connection/beat` every 2 seconds (`heartbeat_interval_seconds` from `connection_state` is honored) |
| Acting in a room | `POST /agents/{agent_id}/ops/connect_to_room` |
| Posting a reply | `POST /agents/{agent_id}/ops/post_message` with `X-Switch-Connection-Id` |
| Authorization | `Authorization: Bearer <agent API key>` on every agent call |

The implementation follows Switch's own Python e2e client (`core/tests/e2e/follow_the_conversation/harness.py`) and the [agent protocol documentation](https://github.com/sandbox-quantum/switch/blob/main/docs/official/internals/agent-protocol.md).

### Why `!triage` is no longer a Discord bot command

The previous prototype ran its own `discord.py` bot with a `!triage` prefix command. That bypassed Switch. In this version, Switch owns the Discord connection, its bot, and its commands. A Switch agent is addressed by mention:

```text
@crewpilot triage <issue>
```

This is the native Switch model: one bridge for Discord, and every agent participating in the room as a member.

## Configuration reference

| Variable | Required | Purpose |
|---|---|---|
| `SWITCH_API_URL` | Yes | Switch agent bridge/API URL, e.g. `http://localhost:8000`; not the Gateway UI URL |
| `SWITCH_REGISTRATION_TOKEN` | Registration only | Token used by `python -m switch.register_agent`; not needed by `main.py` |
| `SWITCH_AGENT_ID` | Yes, unless saved | Agent id returned by registration; env overrides `.switch/agent.json` |
| `SWITCH_API_KEY` | Yes, unless saved | Agent API key returned once by registration |
| `SWITCH_AGENT_NAME` | No | Registered agent name; defaults to the saved value or `crewpilot` |
| `LLM_PROVIDER` | No | `openai` (default), `anthropic`, or `groq` |
| `OPENAI_API_KEY` | When provider is OpenAI | OpenAI API key |
| `OPENAI_MODEL` | No | Defaults to `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` | When provider is Anthropic | Anthropic API key |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-sonnet-4-5` |
| `GROQ_API_KEY` | When provider is Groq | Groq API key |
| `GROQ_MODEL` | No | Defaults to `openai/gpt-oss-120b` |
| `GROQ_BASE_URL` | No | Defaults to `https://api.groq.com/openai/v1` |
| `GITHUB_TOKEN` | No | Enables private issues and higher GitHub rate limits |
| `LOG_LEVEL` | No | Python log level, default `INFO` |

Credentials are resolved from `.env` first, then from `.switch/agent.json` created by the registration command.

## Approval behavior

- A new triage gets an immediate `Triaging...` acknowledgement, then the plan.
- A repeated triage request for the same issue is rejected while a plan is
  awaiting a decision, so it cannot silently overwrite the pending triage.
- Only the Switch participant who requested the triage can approve or request changes.
- Approval state is kept in memory and recorded as a room message. Restarting the agent clears pending approvals.
- This MVP does **not** write labels, comments, or fixes to GitHub. The next step would be adding GitHub as a Switch service connection and posting the approval back to the issue.
- `@crewpilot help` lists the triage, approve, and changes actions. Native slash
  commands are owned by Switch, not by this agent.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Switch returned 404` during registration | `SWITCH_API_URL` is probably the Gateway URL; use the agent bridge/API URL |
| `Switch rejected the registration token` | Use the server's `AGENT_REGISTRATION_TOKEN`, not an agent API key |
| Registration returns `409` | The name already exists; choose another name or pass `--overwrite` (this issues a new API key) |
| `Switch agent credentials are missing` | Run the registration command, or set `SWITCH_AGENT_ID` and `SWITCH_API_KEY` |
| Agent starts but never replies | Check the agent is invited to the room, the message mentions it, and the sender is allowed by the agent's addressing policy |
| `!invite-agent` does nothing | The Discord channel is not a Switch room yet; post an ordinary message first |
| Discord bot sees no messages | Enable **Message Content Intent** and **Server Members Intent** on the bot, then reconnect the bridge |
| Agent name does not autocomplete in Discord | The Discord bridge may have agent roles disabled; type the name manually or enable `agent_roles` |
| Agent replies in Switch but not in Discord | Check the Discord bridge status and the bot's webhook/channel permissions |
| No `Listening to Switch` log | Check `SWITCH_API_URL`, network access, and that the server is running at that address |
| `LLM request failed` | Check the selected provider's API key and model name |
| Agent reconnects repeatedly | Check the heartbeat/stream path is reachable; Switch closes the stream when heartbeats fail |

## Verification status

The native client and workflow were exercised against a local fake Switch
server implementing the same SSE/HTTP contract: stream connect, heartbeat,
reconnect with `Last-Event-ID`, incoming addressed message, triage post, and
approval post. Registration payloads, duplicate prevention, acknowledgement,
approval rules, and the Groq path were also verified offline.

The complete **Discord → Switch → CrewPilot → Groq → Switch → Discord** flow
was verified live on a local Switch deployment, including requester-only
approval. To run it on another deployment you still need its Switch API URL,
a registration token, a connected Discord bridge, and either an OpenAI,
Anthropic, or Groq key.

## Two-minute demo outline

- **0:00–0:15** — The problem: issue triage interrupts engineers and produces inconsistent plans.
- **0:15–0:35** — Architecture: one human and one AI teammate in Discord, connected through Switch.
- **0:35–1:10** — Mention the agent with a real GitHub issue; show the posted triage card.
- **1:10–1:30** — Reply `approve`; show the recorded decision and the agent's terminal logs (SSE connection, Switch operation posts).
- **1:30–1:50** — Show the same agent is transport-independent: Switch can place it in Slack or Teams without changing the agent code.
- **1:50–2:00** — Business value and next steps: GitHub write-back, persistent approvals, more Switch workflows.

## Security notes

- `.env` and `.switch/` are git-ignored. Never commit the registration token, agent API key, LLM key, or GitHub token.
- Issue text is treated as untrusted data in the prompt; the model is instructed not to follow instructions embedded in it.
- The agent does not execute repository code or modify GitHub in this MVP.
- Switch governs who can address the agent and which rooms it can see.

## License

MIT — see [LICENSE](LICENSE).
