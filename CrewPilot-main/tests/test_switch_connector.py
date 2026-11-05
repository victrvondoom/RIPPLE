"""Tests for Switch room connector triage routing and requester authorization."""

from __future__ import annotations

from typing import Any

from agent.triage_agent import TriageAgent, TriageResult
from github_issues import IssueInput
from switch.agent_client import SwitchAgentClient
from switch.switch_connector import PendingTriage, SwitchTriageConnector


class _MockSwitchClient(SwitchAgentClient):
    def __init__(self) -> None:
        super().__init__(
            api_url="http://localhost:8000",
            agent_id="test-agent",
            api_key="test-key",
            agent_name="crewpilot",
        )
        self.sent_messages: list[dict[str, Any]] = []

    async def post_message(
        self,
        room_id: str,
        body: str,
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        record = {"room_id": room_id, "body": body, "thread_id": thread_id}
        self.sent_messages.append(record)
        return record


def _make_connector(mock_client: _MockSwitchClient) -> SwitchTriageConnector:
    agent = TriageAgent(provider="openai", api_key="sk-test", model="gpt-4o-mini")
    return SwitchTriageConnector(
        client=mock_client,
        triage_agent=agent,
        agent_name="crewpilot",
    )


async def test_ignore_unaddressed_event() -> None:
    client = _MockSwitchClient()
    connector = _make_connector(client)

    event = {
        "type": "message",
        "room_id": "room-1",
        "payload": {
            "addressed": False,
            "body": "@crewpilot triage https://github.com/owner/repo/issues/1",
        },
    }
    await connector.handle_event(event)
    assert len(client.sent_messages) == 0


async def test_ignore_own_messages() -> None:
    client = _MockSwitchClient()
    connector = _make_connector(client)

    event = {
        "type": "message",
        "room_id": "room-1",
        "payload": {
            "addressed": True,
            "sender_name": "crewpilot",
            "body": "Triaging issue now",
        },
    }
    await connector.handle_event(event)
    assert len(client.sent_messages) == 0


async def test_ignore_duplicate_message_ids() -> None:
    client = _MockSwitchClient()
    connector = _make_connector(client)

    event = {
        "type": "message",
        "room_id": "room-1",
        "payload": {
            "message_id": "msg-duplicate-123",
            "addressed": True,
            "sender_name": "alice",
            "body": "help",
        },
    }
    await connector.handle_event(event)
    assert len(client.sent_messages) == 1
    assert "CrewPilot Auto-Triager" in client.sent_messages[0]["body"]

    # Send identical message_id again
    await connector.handle_event(event)
    assert len(client.sent_messages) == 1


async def test_help_command() -> None:
    client = _MockSwitchClient()
    connector = _make_connector(client)

    event = {
        "type": "message",
        "room_id": "room-1",
        "payload": {
            "addressed": True,
            "sender_name": "bob",
            "body": "@crewpilot help",
        },
    }
    await connector.handle_event(event)
    assert len(client.sent_messages) == 1
    assert "CrewPilot Auto-Triager" in client.sent_messages[0]["body"]


async def test_triage_flow_and_requester_approval(monkeypatch: Any) -> None:
    client = _MockSwitchClient()
    connector = _make_connector(client)

    # Mock issue loader
    async def mock_load_issue(raw: str, token: str | None = None) -> IssueInput:
        return IssueInput(
            text="Repository: owner/repo\nIssue #10: Null pointer in auth\n\nFix it.",
            source="owner/repo#10",
        )

    monkeypatch.setattr("switch.switch_connector.load_issue", mock_load_issue)

    # Mock triage agent
    mock_result = TriageResult(
        category="bug",
        severity="high",
        difficulty="easy",
        summary="Fix null pointer exception during auth check",
        suggested_fix_plan=["1. Check token null", "2. Return 401"],
    )
    monkeypatch.setattr(connector._agent, "triage", lambda text: mock_result)

    # 1. Request triage
    triage_event = {
        "type": "message",
        "room_id": "room-eng",
        "payload": {
            "message_id": "msg-1",
            "thread_id": "thread-10",
            "addressed": True,
            "sender": "user-alice-id",
            "sender_name": "Alice",
            "body": "@crewpilot triage https://github.com/owner/repo/issues/10",
        },
    }
    await connector.handle_event(triage_event)

    # Expected: "Triaging..." and then the triage plan
    assert len(client.sent_messages) == 2
    assert "Triaging... I'll post the plan" in client.sent_messages[0]["body"]
    assert "Issue triage" in client.sent_messages[1]["body"]
    assert "Fix null pointer exception during auth check" in client.sent_messages[1]["body"]
    assert ("room-eng", "thread-10") in connector._pending

    # 2. Non-requester attempts approval -> rejected
    unauthorized_event = {
        "type": "message",
        "room_id": "room-eng",
        "payload": {
            "message_id": "msg-2",
            "thread_id": "thread-10",
            "addressed": True,
            "sender": "user-charlie-id",
            "sender_name": "Charlie",
            "body": "@crewpilot approve",
        },
    }
    await connector.handle_event(unauthorized_event)
    assert len(client.sent_messages) == 3
    assert "Only Alice can approve this triage" in client.sent_messages[2]["body"]
    assert ("room-eng", "thread-10") in connector._pending

    # 3. Requester Alice approves -> accepted and pending cleared
    authorized_event = {
        "type": "message",
        "room_id": "room-eng",
        "payload": {
            "message_id": "msg-3",
            "thread_id": "thread-10",
            "addressed": True,
            "sender": "user-alice-id",
            "sender_name": "Alice",
            "body": "@crewpilot approve",
        },
    }
    await connector.handle_event(authorized_event)
    assert len(client.sent_messages) == 4
    assert "Approved by Alice" in client.sent_messages[3]["body"]
    assert ("room-eng", "thread-10") not in connector._pending


async def test_duplicate_pending_triage_rejection(monkeypatch: Any) -> None:
    client = _MockSwitchClient()
    connector = _make_connector(client)

    # Pre-populate pending
    req_key = connector._request_key("https://github.com/owner/repo/issues/42")
    connector._pending[("room-1", "thread-1")] = PendingTriage(
        requester_id="user-1",
        requester_name="Alice",
        source="owner/repo#42",
        summary="Some bug",
        request_key=req_key,
    )

    duplicate_event = {
        "type": "message",
        "room_id": "room-1",
        "payload": {
            "message_id": "msg-dup",
            "thread_id": "thread-2",
            "addressed": True,
            "sender": "user-2",
            "sender_name": "Bob",
            "body": "@crewpilot triage https://github.com/owner/repo/issues/42",
        },
    }
    await connector.handle_event(duplicate_event)
    assert len(client.sent_messages) == 1
    assert "already awaiting a decision" in client.sent_messages[0]["body"]


async def test_decision_without_pending_triage() -> None:
    client = _MockSwitchClient()
    connector = _make_connector(client)

    event = {
        "type": "message",
        "room_id": "room-1",
        "payload": {
            "message_id": "msg-orphan",
            "addressed": True,
            "sender": "user-1",
            "sender_name": "Alice",
            "body": "@crewpilot approve",
        },
    }
    await connector.handle_event(event)
    assert len(client.sent_messages) == 1
    assert "There is no triage waiting for approval here" in client.sent_messages[0]["body"]


def test_cross_thread_room_fallback_finding_documented() -> None:
    """Document existing P0 defect in baseline _find_pending.

    When an approval arrives in a different thread or top-level room,
    _find_pending falls back to the most recent pending triage in the room.
    In a busy room with multiple pending tasks, this causes cross-task
    approval confusion.

    Per PREP-02 / PREP-04, this test documents that the existing baseline
    exhibits room-level fallback, which will be strictly replaced by durable
    task ID bindings during hackathon milestone M1.
    """
    client = _MockSwitchClient()
    connector = _make_connector(client)

    connector._pending[("room-1", "thread-A")] = PendingTriage(
        requester_id="user-A",
        requester_name="Alice",
        source="owner/repo#1",
        summary="Bug A",
        request_key="k1",
    )
    connector._pending[("room-1", "thread-B")] = PendingTriage(
        requester_id="user-B",
        requester_name="Bob",
        source="owner/repo#2",
        summary="Bug B",
        request_key="k2",
    )

    # In thread-C (an unknown thread in room-1), the current baseline falls back
    # to the latest room entry (thread-B):
    key, pending = connector._find_pending("room-1", "thread-C")
    assert key == ("room-1", "thread-B")
    assert pending is not None
    assert pending.source == "owner/repo#2"
    # This documents the known fallback behavior to be eliminated in M1.
