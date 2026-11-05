---
name: switch-protocol
description: Implements and troubleshoots native Switch agents, room messaging, addressing, SSE/HTTP connection lifecycle, cursor recovery and handoffs using verified official protocol contracts. Use whenever CrewPilot integrates with Switch.
---
# Switch Protocol Engineering

## Mandatory source verification
1. Read the hackathon's current overview/resources and the current official Switch agent protocol before changing transport or operations.
2. Verify the exact Switch server/Console version used by the team. Record the version, bridge API URL (not Gateway URL), protocol revision and source links in a compatibility note.
3. The documentation checked on 2026-11-01 specifies SSE down and authenticated HTTP operations up, matching CrewPilot's existing client. Do not migrate to WebSockets unless later authoritative docs and the actual deployed server prove this is required.
4. Never invent endpoint paths, operation names, fields, event shapes, addressing policies or semantics. Quote the official source and test against the live deployment.

## Connection correctness
- Keep a stable client-generated connection ID across reconnects; never share one ID between concurrently running processes.
- Parse the initial `connection_state`; honor server-provided heartbeat timing and cursor.
- Resume with the protocol-defined cursor (`Last-Event-ID` for the currently documented SSE interface).
- Send heartbeats at the documented interval and distinguish recoverable 404/409 reconnect behavior from authentication failure.
- Handle `gap`, `evicted`, `subscription_changed` and `room_released` explicitly. After a gap, re-read the authoritative room history/context before responding.
- Understand room claim/subscription timing so buffered events are not skipped.
- Keep transport, event parsing and workflow handlers independently testable.

## Room collaboration
- Switch is the central collaboration bus: human and agents share a room, roles/instructions/context and actual messages.
- Use separate agent identities and distinct credentials. Verify addressing rules permit the intended agent-to-agent messages while limiting who can invoke privileged work.
- Handoffs must be observable Switch messages addressed to the intended agent and carry exact task ID/revision/commit context.
- The Switch source lists task lifecycle frames but marks the task protocol not ready for use; do not build on those task frames unless current official docs remove that warning. Use supported room messages for this project.
- Do not replace Switch handoffs with direct Python function calls or a private queue.

## Tests
Use a fake Switch server for unit/integration tests covering connection state, auth failures, SSE framing, cursor resume, heartbeats, gaps, evictions, duplicate events, addressing and room claims. Also run a clearly labelled live end-to-end check against the exact demo deployment. Never present mocks as live verification.
