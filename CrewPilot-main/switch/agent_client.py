"""Native client for the Switch agent protocol.

Switch talks to an always-on agent over one server-sent event stream (down)
and HTTP operation calls (up). This implements the protocol documented in
sandbox-quantum/switch (docs/official/internals/agent-protocol.md) and mirrors
the reference client in the project's Python e2e harness.

Flow:
  GET  /agents/{id}/events          SSE: messages addressed to this agent
  POST /agents/{id}/connection/beat every 2 seconds
  POST /agents/{id}/ops/connect_to_room
  POST /agents/{id}/ops/post_message
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

MessageHandler = Callable[[dict[str, Any]], Awaitable[None]]

CLIENT_NAME = "crewpilot"
CLIENT_VERSION = "0.2.0"

HEARTBEAT_SECONDS = 2.0
RECONNECT_DELAYS = (1.0, 2.0, 5.0, 10.0)
REQUEST_TIMEOUT_SECONDS = 30.0


class SwitchError(RuntimeError):
    """Raised when Switch is unreachable or refuses an operation."""


class SwitchAuthError(SwitchError):
    """Raised when Switch rejects the agent API key."""


class SwitchAgentClient:
    """An always-on Switch agent connection.

    The connection id is generated once and reused across reconnects, as the
    protocol requires. Cancelling `run()` stops the client.
    """

    def __init__(
        self,
        *,
        api_url: str,
        agent_id: str,
        api_key: str,
        agent_name: str,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.connection_id = str(uuid.uuid4())
        self._api_key = api_key
        self._cursor: int | None = None
        self._heartbeat_interval = HEARTBEAT_SECONDS
        self._http: aiohttp.ClientSession | None = None
        self._stop = asyncio.Event()
        self._on_message: MessageHandler | None = None
        self._stream_opened = False

    async def run(self, on_message: MessageHandler) -> None:
        """Listen forever, reconnecting with the same connection id."""
        self._on_message = on_message
        self._http = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS)
        )
        attempt = 0
        try:
            while not self._stop.is_set():
                self._stream_opened = False
                try:
                    await self._stream_once()
                    attempt = 0
                except asyncio.CancelledError:
                    raise
                except SwitchAuthError:
                    raise
                except (SwitchError, aiohttp.ClientError, asyncio.TimeoutError) as exc:
                    logger.warning("Switch event stream interrupted: %s", exc)
                    if self._stream_opened:
                        attempt = 0
                except Exception:
                    logger.exception("Unexpected Switch event stream failure")

                if self._stop.is_set():
                    break
                delay = RECONNECT_DELAYS[min(attempt, len(RECONNECT_DELAYS) - 1)]
                attempt += 1
                logger.info("Reconnecting to Switch in %.0fs", delay)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass
        finally:
            self._on_message = None
            if self._http is not None:
                await self._http.close()
                self._http = None

    async def close(self) -> None:
        self._stop.set()

    async def post_message(
        self,
        room_id: str,
        body: str,
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        """Claim the room and post a message through Switch."""
        await self.call_operation(
            "connect_to_room",
            {"room_id": room_id, "include_general_instructions": False},
        )
        arguments: dict[str, Any] = {"body": body}
        if thread_id:
            arguments["thread_id"] = thread_id
        result = await self.call_operation("post_message", arguments)
        return result if isinstance(result, dict) else {"result": result}

    async def call_operation(
        self,
        operation: str,
        arguments: dict[str, Any],
    ) -> Any:
        """Invoke one Switch agent operation and unwrap its result envelope."""
        if self._http is None:
            raise SwitchError("Switch client is not running.")

        headers = self._auth_headers()
        headers["Content-Type"] = "application/json"
        headers["X-Switch-Connection-Id"] = self.connection_id
        url = f"{self.api_url}/agents/{self.agent_id}/ops/{operation}"

        async with self._http.post(url, json=arguments, headers=headers) as response:
            text = await response.text()
            if response.status in {401, 403}:
                raise SwitchAuthError(
                    f"Switch rejected the agent API key (HTTP {response.status})."
                )
            if response.status >= 400:
                raise SwitchError(
                    f"Switch operation '{operation}' failed "
                    f"(HTTP {response.status}): {text[:300]}"
                )

        try:
            envelope = json.loads(text)
        except json.JSONDecodeError as exc:
            raise SwitchError(
                f"Switch operation '{operation}' returned a non-JSON response."
            ) from exc

        if isinstance(envelope, dict) and "result" in envelope:
            return envelope["result"]
        return envelope

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    async def _stream_once(self) -> None:
        headers = self._auth_headers()
        headers["Accept"] = "text/event-stream"
        if self._cursor is not None:
            headers["Last-Event-ID"] = str(self._cursor)

        url = f"{self.api_url}/agents/{self.agent_id}/events"
        params = {
            "connection_id": self.connection_id,
            "scope": "all",
            "filter": "addressed",
            "start_from": "head",
            "client": CLIENT_NAME,
            "client_version": CLIENT_VERSION,
        }
        # No total timeout: the SSE response is a long-lived stream.
        timeout = aiohttp.ClientTimeout(total=None, connect=15.0, sock_read=None)

        async with aiohttp.ClientSession(timeout=timeout) as stream_session:
            async with stream_session.get(
                url, params=params, headers=headers
            ) as response:
                if response.status in {401, 403}:
                    raise SwitchAuthError(
                        f"Switch rejected the agent API key (HTTP {response.status})."
                    )
                if response.status != 200:
                    detail = (await response.text())[:300]
                    raise SwitchError(
                        f"Switch event stream failed (HTTP {response.status}): {detail}"
                    )

                logger.info(
                    "Listening to Switch as '%s' (connection %s)",
                    self.agent_name,
                    self.connection_id,
                )
                self._stream_opened = True
                reader = asyncio.create_task(self._read_events(response))
                heartbeat = asyncio.create_task(self._heartbeat_loop())
                tasks = {reader, heartbeat}

                try:
                    done, pending = await asyncio.wait(
                        tasks, return_when=asyncio.FIRST_COMPLETED
                    )
                except BaseException:
                    for task in tasks:
                        task.cancel()
                    for task in tasks:
                        with contextlib.suppress(BaseException):
                            await task
                    raise

                for task in pending:
                    task.cancel()
                for task in pending:
                    with contextlib.suppress(BaseException):
                        await task

                for task in done:
                    exception = task.exception()
                    if exception is not None:
                        raise exception
                raise SwitchError("Switch closed the event stream.")

    async def _read_events(self, response: aiohttp.ClientResponse) -> None:
        """Parse the SSE stream; dispatch complete frames on a blank line."""
        data_lines: list[str] = []

        while True:
            raw = await response.content.readline()
            if not raw:
                raise SwitchError("Switch closed the event stream.")

            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line.startswith(":"):
                continue  # SSE keepalive comment
            if not line:
                if data_lines:
                    await self._dispatch_event("\n".join(data_lines))
                    data_lines.clear()
                continue
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            elif line.startswith("id:"):
                raw_id = line[3:].strip()
                if raw_id:
                    try:
                        self._cursor = int(raw_id)
                    except ValueError:
                        logger.debug("Ignoring non-numeric SSE id: %s", raw_id)

    async def _dispatch_event(self, raw: str) -> None:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Ignoring malformed Switch event: %s", raw[:200])
            return
        if not isinstance(event, dict):
            return

        event_type = str(event.get("type") or "")

        if event_type == "connection_state":
            cursor = event.get("cursor")
            if isinstance(cursor, int) or (
                isinstance(cursor, str) and cursor.isdigit()
            ):
                self._cursor = int(cursor)
            interval = event.get("heartbeat_interval_seconds")
            if isinstance(interval, (int, float)) and 0 < interval <= 60:
                self._heartbeat_interval = float(interval)
            logger.info(
                "Switch connection ready: rooms=%s cursor=%s protocol=%s",
                event.get("rooms"),
                event.get("cursor"),
                event.get("protocol"),
            )
            return

        if event_type == "gap":
            logger.warning(
                "Switch reported lost events (%s); re-read room context if needed.",
                event.get("reason"),
            )
            return

        if event_type == "evicted":
            logger.warning(
                "Switch evicted this connection: %s", event.get("reason")
            )
            raise SwitchError("The Switch connection was evicted.")

        if event_type in {"subscription_changed", "room_released"}:
            logger.info("Switch connection update (%s): %s", event_type, event)
            return

        if event_type == "message":
            if self._on_message is None:
                return
            try:
                await self._on_message(event)
            except (SwitchAuthError, asyncio.CancelledError):
                raise
            except Exception:
                logger.exception("Failed to handle a Switch message")
            return

        logger.debug("Ignoring Switch event type '%s'", event_type)

    async def _heartbeat_loop(self) -> None:
        url = f"{self.api_url}/agents/{self.agent_id}/connection/beat"

        while True:
            await asyncio.sleep(self._heartbeat_interval)
            if self._http is None:
                return

            payload: dict[str, Any] = {"connection_id": self.connection_id}
            if self._cursor is not None:
                payload["cursor"] = self._cursor

            try:
                async with self._http.post(
                    url, json=payload, headers=self._auth_headers()
                ) as response:
                    text = await response.text()
                    if response.status in {401, 403}:
                        raise SwitchAuthError(
                            "Switch rejected the agent API key during heartbeat."
                        )
                    if response.status in {404, 409}:
                        raise SwitchError(
                            "Switch refused the heartbeat "
                            f"(HTTP {response.status}); reopening the stream."
                        )
                    if response.status >= 400:
                        raise SwitchError(
                            "Switch heartbeat failed "
                            f"(HTTP {response.status}): {text[:200]}"
                        )
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                raise SwitchError(f"Switch heartbeat network error: {exc}") from exc
