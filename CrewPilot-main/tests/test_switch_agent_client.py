"""Tests for Switch agent SSE framing, connection lifecycle, and operations."""

from __future__ import annotations

import json
from typing import Any

import pytest

from switch.agent_client import (
    SwitchAgentClient,
    SwitchAuthError,
    SwitchError,
)


def _make_client() -> SwitchAgentClient:
    return SwitchAgentClient(
        api_url="http://localhost:8000",
        agent_id="agent-uuid-1",
        api_key="switch-api-key-test",
        agent_name="crewpilot",
    )


async def test_dispatch_connection_state_event() -> None:
    client = _make_client()
    raw_event = json.dumps(
        {
            "type": "connection_state",
            "cursor": "42",
            "heartbeat_interval_seconds": 3.5,
            "rooms": ["room-alpha"],
        }
    )
    await client._dispatch_event(raw_event)
    assert client._cursor == 42
    assert client._heartbeat_interval == 3.5


async def test_dispatch_gap_event_does_not_crash() -> None:
    client = _make_client()
    raw_event = json.dumps(
        {
            "type": "gap",
            "reason": "buffer_overflow",
        }
    )
    # gap should log a warning and return cleanly without raising
    await client._dispatch_event(raw_event)


async def test_dispatch_evicted_event_raises() -> None:
    client = _make_client()
    raw_event = json.dumps(
        {
            "type": "evicted",
            "reason": "replaced_by_new_connection",
        }
    )
    with pytest.raises(SwitchError, match="Switch connection was evicted"):
        await client._dispatch_event(raw_event)


async def test_dispatch_message_event() -> None:
    client = _make_client()
    received: list[dict[str, Any]] = []

    async def on_message(event: dict[str, Any]) -> None:
        received.append(event)

    client._on_message = on_message
    message_event = {
        "type": "message",
        "room_id": "room-1",
        "payload": {"body": "hello", "addressed": True},
    }
    await client._dispatch_event(json.dumps(message_event))
    assert len(received) == 1
    assert received[0]["payload"]["body"] == "hello"


class _FakeStreamResponse:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = list(lines)

    @property
    def content(self) -> _FakeStreamResponse:
        return self

    async def readline(self) -> bytes:
        if self._lines:
            return self._lines.pop(0)
        return b""


async def test_read_events_framing() -> None:
    client = _make_client()
    dispatched: list[str] = []

    async def mock_dispatch(raw: str) -> None:
        dispatched.append(raw)

    client._dispatch_event = mock_dispatch  # type: ignore[method-assign]

    raw_stream = [
        b": keepalive comment\n",
        b"id: 101\n",
        b'data: {"type": "message",\n',
        b'data:  "body": "first"}\n',
        b"\n",
        b"id: 102\n",
        b'data: {"type": "message", "body": "second"}\n',
        b"\n",
        b"",
    ]
    fake_resp = _FakeStreamResponse(raw_stream)

    with pytest.raises(SwitchError, match="Switch closed the event stream"):
        await client._read_events(fake_resp)  # type: ignore[arg-type]

    assert client._cursor == 102
    assert len(dispatched) == 2
    assert '{"type": "message",\n"body": "first"}' in dispatched[0]
    assert '{"type": "message", "body": "second"}' in dispatched[1]


class _FakeHttpResponse:
    def __init__(self, status: int, text_content: str) -> None:
        self.status = status
        self._text = text_content

    async def __aenter__(self) -> _FakeHttpResponse:
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        pass

    async def text(self) -> str:
        return self._text


class _FakeClientSession:
    def __init__(self, response: _FakeHttpResponse) -> None:
        self.response = response
        self.last_url: str = ""
        self.last_json: dict[str, Any] = {}
        self.last_headers: dict[str, str] = {}

    def post(self, url: str, json: dict[str, Any], headers: dict[str, str]) -> _FakeHttpResponse:
        self.last_url = url
        self.last_json = json
        self.last_headers = headers
        return self.response


async def test_call_operation_success() -> None:
    client = _make_client()
    fake_resp = _FakeHttpResponse(200, json.dumps({"result": {"message_id": "msg-999"}}))
    session = _FakeClientSession(fake_resp)
    client._http = session  # type: ignore[assignment]

    result = await client.call_operation("post_message", {"body": "testing"})
    assert result == {"message_id": "msg-999"}
    assert session.last_headers["X-Switch-Connection-Id"] == client.connection_id
    assert session.last_headers["Authorization"] == "Bearer switch-api-key-test"


async def test_call_operation_auth_error() -> None:
    client = _make_client()
    client._http = _FakeClientSession(_FakeHttpResponse(401, "Unauthorized"))  # type: ignore[assignment]

    with pytest.raises(SwitchAuthError, match="Switch rejected the agent API key"):
        await client.call_operation("connect_to_room", {"room_id": "r1"})


async def test_call_operation_failure() -> None:
    client = _make_client()
    client._http = _FakeClientSession(_FakeHttpResponse(500, "Internal Server Error"))  # type: ignore[assignment]

    with pytest.raises(SwitchError, match="Switch operation 'post_message' failed"):
        await client.call_operation("post_message", {"body": "hello"})
