"""Minimal Switch agent-protocol client (standard library only).

Protocol as implemented by switch-core 0.31.0 (read from its source, exercised against a live local server):
  GET  {bridge}/agents/{id}/events?connection_id=...&rooms=...   SSE; first frame `connection_state` (cursor, generation,
                                                                 heartbeat_interval_seconds)
  POST {bridge}/agents/{id}/connection/beat                      heartbeat {connection_id, cursor, generation}
  POST {bridge}/agents/{id}/ops/{operation}                      operations, header X-Switch-Connection-Id
  GET  {bridge}/agents/{id}/rooms/{room}/history                 room history (members only)

`post_message`, `send_targeted_message` and `create_room_document` take NO room id: they act on the room this
connection last claimed with `connect_to_room`. Every claim+operation pair therefore runs under one lock, and the
client re-claims the target room first when needed (bug found against the live server in session 14).
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable


class SwitchError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class Message:
    room_id: str
    sender: str            # Switch identity of the sender (matrix id); set by the server, not by the message text
    sender_name: str
    sender_kind: str | None  # "platform" when a chat client posted on a person's behalf
    body: str
    message_id: str
    addressed: bool
    raw: dict = field(default_factory=dict)


class SwitchAgent:
    def __init__(self, bridge: str, agent_id: str, api_key: str, name: str, timeout: float = 15.0):
        self.bridge, self.agent_id, self.api_key, self.name = bridge.rstrip("/"), agent_id, api_key, name
        self.timeout = timeout
        self.connection_id = str(uuid.uuid4())
        self.cursor = 0
        self.generation: int | None = None
        self.beat_every = 2.0
        self.scope = "all"   # "all": the stream covers every room the agent belongs to, including rooms created later
        self.current_room: str | None = None
        self._lock = threading.RLock()
        self._closed = threading.Event()
        self._handlers: list[Callable[[Message], None]] = []
        self._threads: list[threading.Thread] = []
        self._seen: set[str] = set()

    # ---------- raw HTTP ----------
    def _req(self, method: str, path: str, body: Any = None, with_conn: bool = False, timeout: float | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        if with_conn:
            headers["X-Switch-Connection-Id"] = self.connection_id
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.bridge}{path}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                text = r.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            raise SwitchError(e.code, f"{method} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:300]}") from None

    def health(self) -> bool:
        try:
            with urllib.request.urlopen(f"{self.bridge}/health", timeout=5) as r:
                return r.status == 200
        except Exception:
            return False

    def op(self, name: str, args: dict | None = None) -> Any:
        # switch-core refuses operations on a connection whose event stream is not open (HTTP 409 "connection ... is not open").
        if not any(x.name == f"sse-{self.name}" and x.is_alive() for x in self._threads):
            self.listen([])
        res = self._req("POST", f"/agents/{self.agent_id}/ops/{name}", args or {}, with_conn=True)
        return res.get("result") if isinstance(res, dict) and "result" in res else res

    # ---------- room-scoped operations (serialised claim) ----------
    def claim(self, room_id: str) -> None:
        with self._lock:
            self.op("connect_to_room", {"room_id": room_id})
            self.current_room = room_id

    def in_room(self, room_id: str, name: str, args: dict | None = None) -> Any:
        """Run a room-scoped operation in `room_id`, re-claiming the room first if needed (under the lock)."""
        with self._lock:
            if self.current_room != room_id:
                self.op("connect_to_room", {"room_id": room_id})
                self.current_room = room_id
            return self.op(name, args)

    def post(self, room_id: str, body: str) -> Any:
        return self.in_room(room_id, "post_message", {"body": body})

    def post_to(self, room_id: str, body: str, targets: list[str]) -> Any:
        return self.in_room(room_id, "send_targeted_message", {"body": body, "target_names": targets})

    def create_document(self, room_id: str, name: str, description: str, instructions: str, content: str) -> str:
        return self.in_room(room_id, "create_room_document", {"name": name, "description": description, "instructions": instructions, "content": content})["document_id"]

    def load_documents(self, room_id: str, ids: list[str]) -> list[dict]:
        return self.in_room(room_id, "load_internal_documents", {"ids": ids})

    def participants(self, room_id: str) -> list[dict]:
        return self.in_room(room_id, "list_participants")

    def history(self, room_id: str, limit: int = 100) -> list[dict]:
        return self._req("GET", f"/agents/{self.agent_id}/rooms/{room_id}/history?limit={limit}")["events"]

    # ---------- event stream + heartbeat ----------
    def on_message(self, handler: Callable[[Message], None]) -> None:
        self._handlers.append(handler)

    def listen(self, rooms: list[str]) -> None:
        """Open the SSE stream for `rooms` (declared on the URL) and start the heartbeat thread."""
        ready = threading.Event()
        t = threading.Thread(target=self._stream, args=(rooms, ready), daemon=True, name=f"sse-{self.name}")
        t.start(); self._threads.append(t)
        ready.wait(10)
        if not any(x.name == f"beat-{self.name}" for x in self._threads):
            b = threading.Thread(target=self._beat, daemon=True, name=f"beat-{self.name}")
            b.start(); self._threads.append(b)

    def _stream(self, rooms: list[str], ready: threading.Event) -> None:
        """Keeps the stream open: on EOF / eviction it re-opens with the SAME connection id and Last-Event-ID (as Switch asks)."""
        q = f"connection_id={self.connection_id}&scope={self.scope}&filter=all&start_from=head&rooms={','.join(rooms)}&client=ripple-py"
        delay = 0.5
        while not self._closed.is_set():
            headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "text/event-stream"}
            if self.cursor:
                headers["Last-Event-ID"] = str(self.cursor)
            try:
                with urllib.request.urlopen(urllib.request.Request(f"{self.bridge}/agents/{self.agent_id}/events?{q}", headers=headers), timeout=3600) as r:
                    delay, buf = 0.5, ""
                    while not self._closed.is_set():
                        line = r.readline()
                        if not line:
                            break
                        line = line.decode(errors="replace")
                        if line.strip() == "":
                            self._frame(buf, ready); buf = ""
                        else:
                            buf += line
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):   # a bad key does not fix itself
                    ready.set(); return
            except Exception:
                pass
            ready.set()
            if self._closed.wait(delay):
                return
            delay = min(delay * 2, 5.0)
            if self.current_room:        # a re-opened connection holds no room until it is claimed again
                with self._lock:
                    self.current_room = None

    def _frame(self, raw: str, ready: threading.Event) -> None:
        # Switch sends the event type on the SSE `event:` line (e.g. `event: connection_state`), not always inside the JSON.
        data, eid, event = "", None, ""
        for line in raw.splitlines():
            if line.startswith("data:"):
                data += line[5:].strip()
            elif line.startswith("id:"):
                eid = line[3:].strip()
            elif line.startswith("event:"):
                event = line[6:].strip()
        if eid and eid.isdigit():
            self.cursor = max(self.cursor, int(eid))
        if not data:
            return
        try:
            d = json.loads(data)
        except json.JSONDecodeError:
            return
        if isinstance(d, dict) and "type" not in d:
            d["type"] = event
        if d.get("type") == "connection_state":
            self.cursor = max(self.cursor, int(d.get("cursor") or 0))
            if d.get("generation") is not None:
                self.generation = int(d["generation"])
            hb = d.get("heartbeat_interval_seconds")
            if hb and 0 < float(hb) <= 60:
                self.beat_every = float(hb)
            ready.set()
            return
        if d.get("type") != "message":
            return
        p = d.get("payload") or {}
        mid = str(p.get("message_id") or "")
        if mid in self._seen:
            return
        self._seen.add(mid)
        msg = Message(room_id=d.get("room_id", ""), sender=str(p.get("sender") or ""), sender_name=str(p.get("sender_name") or ""),
                      sender_kind=p.get("sender_kind"), body=str(p.get("body") or ""), message_id=mid, addressed=bool(p.get("addressed")), raw=d)
        for h in list(self._handlers):
            try:
                h(msg)
            except Exception as e:  # a handler bug must never kill the stream
                print(f"[{self.name}] handler error: {e}")

    def _beat(self) -> None:
        while not self._closed.wait(self.beat_every):
            body = {"connection_id": self.connection_id, "cursor": self.cursor}
            if self.generation is not None:
                body["generation"] = self.generation
            try:
                self._req("POST", f"/agents/{self.agent_id}/connection/beat", body, timeout=5)
            except Exception:
                pass

    def close(self) -> None:
        self._closed.set()


def load_agents(bridge: str, path: str = "data/switch-agents.local.json") -> dict[str, SwitchAgent]:
    """Agents registered by scripts/switch-register.mjs (keys stay on disk; never printed)."""
    with open(path, encoding="utf-8") as f:
        saved = json.load(f)
    return {name: SwitchAgent(bridge, v["id"], v["apiKey"], name) for name, v in saved.items()}


def wait_for(cond: Callable[[], bool], timeout: float = 10.0, step: float = 0.2) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(step)
    return cond()
