"""In-process mock of the switch-core 0.31 subset RIPPLE's Level-3 flow uses.

Modelled from the vendored source (%APPDATA%/switchdash/.../switch-core/0.31.0/src/core/switch_core):
membership comes from create_room.agent_names; a non-member connect_to_room is refused with
"Agent is not a member of this room" (OBSERVED live: the agent-bridge op layer answers HTTP 400;
api/operations.py maps auth-layer PermissionError to 403); room-roles are assumable instruction bundles where an
exclusive role has at most one LIVE holder (bridges/agent/operations/definitions.py assume_role);
linked_rooms read back from connect_to_room carry a per-caller `access` of "member"/"not_member";
create_room_document scopes a document to the room; GET /rooms/{id}/yaml on the GATEWAY refuses the
agent API key (401) and serves a human session.

This mock proves RIPPLE's protocol usage (the python client ripple_switch/switch_client.py, the same
wire shapes the TypeScript adapter emits). It is NOT a Switch server. The real-server run is
scripts/switch-live-level3.ts with evidence in docs/evidence/.
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class MockRoom:
    def __init__(self, name: str, agent_names: list[str], linked: list[dict], roles: list[dict]):
        self.id = f"rm-{name.lower()}"
        self.name = name
        self.members = list(agent_names)
        self.linked = linked
        self.roles = {r["name"]: r for r in roles}
        self.holders: dict[str, set[str]] = {}
        self.docs: list[dict] = []
        self.messages: list[dict] = []


class MockSwitchCore:
    """State + assertion helpers. The HTTP layer below shares one instance per test."""

    def __init__(self) -> None:
        self.rooms: dict[str, MockRoom] = {}
        self.keys: dict[str, str] = {}          # api key -> agent name
        self.lives: dict[str, set[str]] = {}    # agent name -> live connection ids (lease liveness)
        self.rooms_created = 0
        self.documents_created = 0
        self.gateway_token: str | None = None  # a human session token; the agent key is never accepted

    def register(self, api_key: str, agent_name: str) -> None:
        self.keys[api_key] = agent_name

    def live(self, agent: str) -> bool:
        return bool(self.lives.get(agent))

    def holder_of(self, room_id: str, role: str) -> list[str]:
        room = self.rooms[room_id]
        return sorted(h for h in room.holders.get(role, set()) if self.live(h))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:  # keep pytest output clean
        pass

    # ---------- plumbing ----------
    def _identity(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        return self.server.core.keys.get(auth.removeprefix("Bearer ")) if auth.startswith("Bearer ") else None

    def _send(self, status: int, body: Any, ctype: str = "application/json") -> None:
        raw = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self) -> dict:
        size = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(size)) if size else {}

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            return self._send(200, {"ok": True})
        if self.path.endswith("/yaml"):  # gateway export (a different port/host in reality)
            if self.headers.get("Authorization", "").endswith(self.server.core.gateway_token or "\0nothing"):
                return self._send(200, "version: 2\n# gateway room export\n", ctype="application/x-yaml")
            return self._send(401, {"detail": "Not authenticated — the agent API key is not accepted on the gateway."})
        if "/events" in self.path:
            return self._events()
        if "/history" in self.path:
            room_id = self.path.split("/rooms/")[1].split("/")[0]
            room = self.server.core.rooms.get(room_id)
            if room is None or self._identity() not in room.members:
                return self._send(400 if room else 404, {"detail": "Agent is not a member of this room" if room else "no room"})
            return self._send(200, {"events": room.messages})
        return self._send(404, {"detail": f"no route {self.path}"})

    def do_POST(self):  # noqa: N802
        path, body = self.path, self._body()
        me = self._identity()
        if me is None:
            return self._send(401, {"detail": "bad agent key"})
        if path.endswith("/connection/beat"):
            return self._send(200, {"result": {"ok": True}})
        if "/ops/" not in path:
            return self._send(404, {"detail": f"no route {path}"})
        op = path.rsplit("/ops/", 1)[1]
        return self._op(op, me, body)

    # ---------- ops ----------
    def _op(self, op: str, me: str, body: dict):
        core = self.server.core
        conn = self.headers.get("X-Switch-Connection-Id")
        claimed = self.server.conn_room.get(conn)  # type: ignore[attr-defined]
        member_names = lambda r: r.members  # noqa: E731

        if op == "create_room":
            core.rooms_created += 1
            room = MockRoom(body.get("name", "?"), body.get("agent_names") or [], body.get("linked_rooms") or [], body.get("roles") or [])
            core.rooms[room.id] = room
            return self._send(200, {"result": {"id": room.id, "name": room.name, "transport_room_id": f"!x:{room.id}",
                                               "failed_attachments": [], "group_name": body.get("group_name")}})
        if op == "create_room_document":
            room = core.rooms.get(claimed)
            if room is None:
                return self._send(409, {"detail": "No connected room."})
            core.documents_created += 1
            room.docs.append({**body, "document_id": f"doc-{core.documents_created}"})
            return self._send(200, {"result": {"document_id": f"doc-{core.documents_created}"}})
        if op == "load_internal_documents":
            room = core.rooms.get(claimed)
            if room is None:
                return self._send(409, {"detail": "No connected room."})
            return self._send(200, {"result": room.docs})
        if op in ("post_message", "send_targeted_message"):
            room = core.rooms.get(claimed)
            if room is None:
                return self._send(409, {"detail": "No connected room."})
            text = f"@{body['target_names'][0]} {body['body']}" if op == "send_targeted_message" and body.get("target_names") else body["body"]
            room.messages.append({"sender_name": me, "body": text, "attachments": body.get("attachments") or []})
            return self._send(200, {"result": {"event_id": f"e-{len(room.messages)}"}})
        if op == "connect_to_room":
            room = core.rooms.get(body.get("room_id", ""))
            if room is None:
                return self._send(404, {"detail": "Room not found."})
            if me not in member_names(room):
                return self._send(400, {"detail": "Agent is not a member of this room"})  # OBSERVED live: switch-core 0.31 answers the agent bridge with 400
            self.server.conn_room[conn] = room.id  # type: ignore[attr-defined]
            roles = [{"name": r["name"], "exclusive": r.get("exclusive", False),
                      "instructions_preview": r["instructions"][:40],
                      "held_by": [{"name": h, "present_here": True} for h in core.holder_of(room.id, r["name"])],
                      "assumable_by_me": (not r.get("exclusive")) or (not core.holder_of(room.id, r["name"]))} for r in room.roles.values()]
            links = [{"target_room_id": l["target_room_id"], "target_room_name": core.rooms.get(l["target_room_id"], None).name if l["target_room_id"] in core.rooms else "?",
                      "target_room_description": "", "label": l.get("label", ""),
                      "access": "member" if me in member_names(core.rooms[l["target_room_id"]]) else "not_member"} for l in room.linked if l["target_room_id"] in core.rooms]
            return self._send(200, {"result": {"agent_id": me, "room_id": room.id, "name": room.name, "participants": [{"name": n} for n in room.members],
                                               "roles": roles, "linked_rooms": links, "instructions": "", "warning": None}})
        if op == "define_role":
            room = core.rooms.get(claimed)
            if room is None:
                return self._send(409, {"detail": "No connected room."})
            room.roles[body["name"]] = {"name": body["name"], "instructions": body.get("instructions", ""), "exclusive": bool(body.get("exclusive"))}
            return self._send(200, {"result": {"status": "defined", "name": body["name"]}})
        if op == "assume_role":
            room = core.rooms.get(claimed)
            if room is None:
                return self._send(409, {"detail": "No connected room."})
            role = room.roles.get(body.get("role", ""))
            if role is None:
                return self._send(404, {"detail": f"No role {body.get('role')} in this room."})
            live = core.holder_of(room.id, role["name"])
            if me in live:
                return self._send(400, {"detail": "You already hold a role lease; release it before assuming another"})  # OBSERVED live
            if role.get("exclusive") and live:
                return self._send(400, {"detail": f"Role '{role['name']}' is exclusive and currently held by another agent (holders: {', '.join(live)})"})  # OBSERVED live: the agent-bridge op layer refuses with 400
            room.holders.setdefault(role["name"], set()).add(me)
            return self._send(200, {"result": {"role": role["name"], "instructions": role["instructions"]}})
        if op == "list_roles":
            room = core.rooms.get(claimed)
            if room is None:
                return self._send(409, {"detail": "No connected room."})
            return self._send(200, {"result": [{"name": r["name"], "exclusive": r.get("exclusive", False),
                                                "instructions_preview": r["instructions"][:30],
                                                "held_by": [{"name": h, "present_here": True} for h in core.holder_of(room.id, r["name"])],
                                                "assumable_by_me": (not r.get("exclusive")) or (not core.holder_of(room.id, r["name"]))} for r in room.roles.values()]})
        if op == "release_role":
            room = core.rooms.get(claimed)
            if room is not None:
                for s in room.holders.values():
                    s.discard(me)
            return self._send(200, {"result": {"status": "released"}})
        if op == "get_my_context":
            return self._send(200, {"result": {"you": {"name": me, "can_manage_agents": False},
                                               "person": {"name": "Owner One", "email": "owner@harborvine.example", "workspace_role": "owner"},
                                               "server": {"kind": "self-hosted", "version": "0.31.0-mock", "features": ["follow_the_conversation"]},
                                               "agents": [{"id": "ag-self", "name": me, "who_can_talk": "owner_and_owner_agents", "can_manage_agents": False}],
                                               "messaging_apps": {}, "services": [], "machines": []}})
        if op == "list_rooms":
            return self._send(200, {"result": []})
        return self._send(404, {"detail": f"mock: op {op} not modelled"})

    # ---------- SSE ----------
    def _events(self):
        from urllib.parse import parse_qs, urlparse
        me = self._identity()
        q = parse_qs(urlparse(self.path).query)
        conn = (q.get("connection_id") or [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        frame = {"type": "connection_state", "connection_id": conn, "cursor": 0, "generation": 1, "heartbeat_interval_seconds": 30}
        try:
            self.wfile.write(f"event: connection_state\ndata: {json.dumps(frame)}\n\n".encode())
            self.wfile.flush()
            self.server.conn_room.setdefault(conn, None)  # type: ignore[attr-defined]
            self.server.lives.setdefault(me, set()).add(conn)  # type: ignore[attr-defined]
            while getattr(self.server, "running", True):       # hold the stream open (keepalives), like the real bridge
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                time.sleep(1)
        except Exception:
            pass
        finally:
            conns = self.server.lives.get(me, set())  # type: ignore[attr-defined]
            conns.discard(conn)


def start() -> tuple[MockSwitchCore, ThreadingHTTPServer]:
    core = MockSwitchCore()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.core = core  # type: ignore[attr-defined]
    server.lives = core.lives  # type: ignore[attr-defined]  # same dict: lease liveness is served from one state
    server.conn_room = {}  # type: ignore[attr-defined]
    server.running = True  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return core, server
