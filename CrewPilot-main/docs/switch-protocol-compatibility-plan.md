# Switch Protocol Compatibility Plan (M0 Preparation Baseline)

**Status:** Approved Technical Plan  
**Date:** 2026-11-01  
**Project:** CrewPilot — Evidence-Driven Bug Investigation Squad  
**Target Specification:** `https://github.com/sandbox-quantum/switch/blob/main/docs/official/internals/agent-protocol.md`  

---

## 1. Executive Summary & Transport Architecture

The official Switch agent protocol specifies an asymmetric, resilient transport model:
- **Downstream Events:** Server-Sent Events (SSE) stream (`GET /agents/{agent_id}/events`).
- **Upstream Operations:** Authenticated HTTP POST calls (`POST /agents/{agent_id}/ops/{operation}`).
- **Keepalive Liveness:** Periodic HTTP heartbeat (`POST /agents/{agent_id}/connection/beat`).

### Transport Decision:
The existing CrewPilot client in `switch/agent_client.py` correctly implements this official SSE/HTTP protocol.
- **No WebSocket Migration:** The official custom agent protocol does not specify a primary WebSocket transport. We will **not** migrate `switch/agent_client.py` to WebSockets and will **not** add a WebSocket fallback.
- **SSE is Active, Not Deprecated:** The official documentation and protocol reference confirm SSE as the standard event streaming transport for Switch agents.

This document outlines the protocol compatibility requirements, lifecycle handling, room subscription semantics, and multi-agent collaboration patterns to be verified during Milestone 1 (M1).

---

## 2. Switch Deployment & Version Verification

At the opening of Milestone 1 (2026-11-04):
1. **Server Health & Metadata Check:** Query `GET /health` or `GET /version` on the target Switch server instance to record the exact deployment version.
2. **Protocol Version Handshake:** Inspect the `protocol` attribute received in the initial `connection_state` event frame to confirm protocol feature parity.

---

## 3. Connection Lifecycle & Event Stream Parameters

### 3.1 Stream Endpoint & Query Parameters
The client opens the SSE stream at `GET /agents/{agent_id}/events` with the following parameters:

```text
GET /agents/{agent_id}/events?connection_id={uuid}&scope=all&filter=addressed&start_from=head&client=crewpilot&client_version=0.2.0
Headers:
  Authorization: Bearer <agent_api_key>
  Accept: text/event-stream
  Last-Event-ID: <cursor> (on reconnection)
```

| Parameter | Type / Format | Purpose & Behavior |
| :--- | :--- | :--- |
| `connection_id` | UUID string | Generated once per client instance at startup. Reused across reconnections to maintain session continuity and avoid state churn. |
| `scope` | `"all"` or `"single"` | Controls room event visibility. See Section 5 for detailed subscription semantics. |
| `filter` | `"addressed"` | Filters stream events so the agent receives only messages addressed to it (mentions or targeted messages), eliminating chatter from busy channels. |
| `start_from` | `"head"` or integer | Set to `"head"` on clean initial connection to start from real-time events. |
| `Last-Event-ID` | Integer header | Standard SSE header passed on reconnect to resume from the last successfully processed event cursor. |

### 3.2 Heartbeat Liveness & Reconnection
- **Interval:** The client sends a heartbeat every 2.0 seconds (or interval negotiated via `connection_state`).
- **Endpoint:** `POST /agents/{agent_id}/connection/beat`
- **Payload:** `{"connection_id": "<uuid>", "cursor": <int>}`
- **Backoff:** Reconnections use exponential backoff (`1.0s, 2.0s, 5.0s, 10.0s`). The stable `connection_id` is preserved.

---

## 4. Inbound SSE Event Frames & Dispatch Handling

| Event Frame Type | Key Payload Fields | Client Handling & State Transitions |
| :--- | :--- | :--- |
| `connection_state` | `cursor`, `heartbeat_interval_seconds`, `rooms`, `protocol`, `generation` | Signals connection ready. Client records the initial cursor, updates the heartbeat interval, and logs active rooms. |
| `message` | `room_id`, `payload` (`body`, `sender`, `sender_name`, `thread_id`, `addressed`) | Standard room message. Dispatched to `on_message` handler if `addressed` is true. |
| `gap` | `reason`, `expected_cursor`, `received_cursor` | Signals event stream discontinuity. Client logs warning and triggers room context re-read via `read_context` before taking further actions. |
| `evicted` | `reason` | Server evicted the connection (e.g. duplicate connection or server shutdown). Client terminates cleanly without reconnect loop. |
| `subscription_changed`| `room_id`, `status` | Room membership or claim update. |
| `room_released` | `room_id` | Server released a room claim. |

---

## 5. Room Subscription & Claim Semantics

Proper handling of room scopes and claims prevents dropped events without causing unnecessary room claim contention.

### 5.1 `scope=all` vs. `scope=single`
- **`scope=all` (Recommended & Implemented):** The agent automatically receives addressed events from **every room it belongs to**. Individual room claiming on stream connection is **not** required.
- **`scope=single`:** The agent monitors only a single declared room.

> **Correction Note:** Agents do **not** need to issue `connect_to_room` for every room immediately after `connection_state`. Under `scope=all`, membership in the room is sufficient to receive addressed messages.

### 5.2 Room Operations & Context Retrieval
- **`connect_to_room` (`POST /agents/{id}/ops/connect_to_room`):**
  - Schema: `{"room_id": str, "include_general_instructions": bool}`
  - **Implication:** `connect_to_room` establishes an active room claim, taking over claim status, and returns initial room context.
- **`read_context` (`POST /agents/{id}/ops/read_context`):**
  - Schema: `{"room_id": str}`
  - **Implication:** Retrieves recent room message history and context without taking over the active room claim. Ideal for recovering context after a `gap` event.

### 5.3 Current CrewPilot Behavior & M1 Integration Testing
- **Current Behavior:** `SwitchAgentClient.post_message` calls `connect_to_room` prior to `post_message` to ensure room claim before sending.
- **M1 Testing Goal:** Verify in a multi-agent setting whether three distinct agents (`crewpilot-triager`, `crewpilot-repro-builder`, `crewpilot-reviewer`) calling `connect_to_room` cause claim-takeover friction, or if calling `post_message` with `scope=all` functions without re-claiming on every message.

---

## 6. Multi-Agent Collaboration & Handoff Protocols

### 6.1 Task Lifecycle Protocol Status
The Switch protocol source includes experimental task frames:
- `task_delegate`, `task_accept`, `task_update`, `task_finalise`, `task_cancel`

**Directive:** The official protocol explicitly marks task lifecycle event frames as **not yet ready for client workflows**. CrewPilot will **not** build on experimental task frames.

### 6.2 Verified Messaging Handoffs
Agent-to-agent handoffs between Triager, Builder, and Reviewer will use documented, reliable room messaging:
1. **Public Room Mentions:** Addressing peer agents by their registered name (e.g., `@crewpilot-repro-builder start task-0123`).
2. **Targeted Messages:** Using `POST /agents/{id}/ops/send_targeted_message` when private or direct agent coordination is needed.
3. **Operations Contract Verification:**
   - `post_message`: `{"body": str, "thread_id": str | None}`
   - `connect_to_room`: `{"room_id": str, "include_general_instructions": bool}`
   - `read_context`: `{"room_id": str}`
   - `update_agent_detail`: `{"description": str}`

### 6.3 Addressing Configuration
By default, new custom agents in Switch have **owner-only addressing** permissions. During M1:
- Ensure the Switch room configuration permits all three squad agents to receive messages from each other and from the human developer.
- Test cross-agent message delivery during the initial M1 smoke test.
