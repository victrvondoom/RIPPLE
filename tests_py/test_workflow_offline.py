"""Scenarios A-D through the REAL ripple_switch.agents.Network code, against an in-memory FAKE Switch.

The fake reproduces the membership behaviour observed on the live switch-core 0.31.0 (non-member: 403 on history,
refused on connect_to_room/room operations; agent senders carry @switch-agent-* identities). It proves the workflow
logic without a Switch server; tests_py/test_live_switch.py runs the same scenarios against the real server.
"""
import itertools
import socket
import threading

import pytest

import mock_enterprise
from ripple_switch import agents as agents_mod
from ripple_switch.agents import Network
from ripple_switch.switch_client import Message, SwitchError

_ids = itertools.count(1)


class FakeSwitch:
    def __init__(self):
        self.rooms: dict[str, dict] = {}
        self.agents: dict[str, "FakeAgent"] = {}
        self.lock = threading.RLock()

    def deliver(self, room_id, sender, body, targets=None, sender_name=None):
        mid = f"m{next(_ids)}"
        for name in list(self.rooms[room_id]["agents"]):
            a = self.agents.get(name)
            if a and a is not sender:
                text = (" ".join(f"@{t}" for t in targets) + " " + body) if targets else body
                msg = Message(room_id=room_id, sender=f"@switch-agent-{sender.name}:localhost", sender_name=sender_name or sender.name,
                              sender_kind=None, body=text, message_id=mid, addressed=bool(targets and name in targets))
                for h in a.handlers:
                    h(msg)


class FakeAgent:
    def __init__(self, hub, name):
        self.hub, self.name, self.handlers = hub, name, []
        hub.agents[name] = self

    def on_message(self, h): self.handlers.append(h)
    def listen(self, rooms): pass
    def close(self): pass

    def _member(self, room_id, status=403):
        if room_id not in self.hub.rooms or self.name not in self.hub.rooms[room_id]["agents"]:
            raise SwitchError(status, "Agent is not a member of this room")

    def op(self, name, args=None):
        args = args or {}
        if name == "create_room":
            rid = f"room-{next(_ids)}"; self.hub.rooms[rid] = {"name": args["name"], "agents": list(args["agent_names"]), "docs": {}, "links": []}
            return {"id": rid, "name": args["name"]}
        if name == "link_rooms":
            self._member(args["source_room_id"]); self.hub.rooms[args["source_room_id"]]["links"].append(args["target_room_id"]); return {"ok": True}
        if name == "get_my_context":
            return {"agents": [{"name": "ripple-arbiter", "who_can_talk": "owner_and_owner_agents"}]}
        raise AssertionError(f"unexpected op {name}")

    def in_room(self, room_id, name, args=None):
        self._member(room_id, 400)
        if name == "load_internal_documents":
            return [self.hub.rooms[room_id]["docs"][i] for i in args["ids"]]
        raise AssertionError(name)

    def post(self, room_id, body): self._member(room_id, 400); self.hub.deliver(room_id, self, body)
    def post_to(self, room_id, body, targets): self._member(room_id, 400); self.hub.deliver(room_id, self, body, targets)

    def create_document(self, room_id, name, description, instructions, content):
        self._member(room_id, 400); did = f"doc-{next(_ids)}"; self.hub.rooms[room_id]["docs"][did] = {"id": did, "name": name, "content": content}; return did

    def participants(self, room_id):
        self._member(room_id, 400); return [{"name": n, "type": "agent"} for n in self.hub.rooms[room_id]["agents"]]

    def history(self, room_id, limit=100):
        self._member(room_id); return []


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


@pytest.fixture()
def net(tmp_path, monkeypatch):
    monkeypatch.setattr(agents_mod, "DATA", str(tmp_path / "ripple"))
    monkeypatch.setattr(mock_enterprise, "TIMEOUT_DELAY_S", 2.0)
    port = free_port(); srv = mock_enterprise.serve(port, str(tmp_path / "mock"), reset=True)
    hub = FakeSwitch()
    agents = {n: FakeAgent(hub, n) for n in ("ripple-coordinator", "reclaim-investigator", "resolve-comms", "ripple-arbiter")}
    n = Network(agents, f"http://127.0.0.1:{port}", internal_only=True, log=lambda *_: None)
    n.hub = hub
    n.start()
    yield n
    n.close(); srv.shutdown()


def open_case(net):
    cid = net.ingest_customer_email()
    assert net.wait_state(cid, {"AWAITING_APPROVAL", "BLOCKED"}, 20) == "AWAITING_APPROVAL"
    return cid, net.case(cid)


def console(net, c, verb, arg, who="nora"):
    cmd = {"verb": verb, "case_id": c.data["case_id"], **({"payload_sha256": arg} if verb == "APPROVE" else {"reason": arg})}
    return net.decide(cmd, {"sender": f"local-console:{who}", "sender_name": who, "sender_kind": None, "room_id": c.data["rooms"]["finance"], "message_id": None, "channel": "local-console"})


def refunds(net, **q):
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    return net.ent.call("GET", "/ledger/refunds" + (f"?{qs}" if qs else ""), "finance")[1]["refunds"]


def test_topology_isolation_and_documents(net):
    cid, c = open_case(net)
    rooms = net.hub.rooms
    assert rooms[c.data["rooms"]["finance"]]["agents"] == ["ripple-arbiter"]
    assert sorted(rooms[c.data["rooms"]["ops"]]["agents"]) == ["reclaim-investigator", "ripple-coordinator"]
    assert c.data["rooms"]["ops"] in rooms[net.intake_room]["links"] and c.data["rooms"]["finance"] in rooms[net.intake_room]["links"]
    assert [d["name"] for d in rooms[c.data["rooms"]["ops"]]["docs"].values()] == [f"evidence-manifest-{cid}"]
    assert [d["name"] for d in rooms[c.data["rooms"]["finance"]]["docs"].values()] == [f"refund-proposal-{cid}"]
    assert "ch_9918" in rooms[c.data["rooms"]["finance"]]["docs"][c.data["documents"]["proposal"]["id"]]["content"]  # raw ledger only in finance
    assert not rooms[net.intake_room]["docs"]                                                                          # nothing raw in intake
    assert c.data["intake"]["our_promises"][0]["overdue"] is True                                                      # RESOLVE: our promise is overdue


def test_scenario_a_happy_path(net):
    cid, c = open_case(net)
    assert [(a["op"], a["amount"]) for a in c.data["payload"]["actions"]] == [("refund", "4200.00"), ("credit", "1200.00")]
    assert console(net, c, "APPROVE", c.data["payload_sha256"]) == "approved"
    assert net.wait_state(cid, {"COMPLETED", "BLOCKED"}, 20) == "COMPLETED"
    assert all(x["passed"] for x in c.data["verification"]["checks"]) and len(refunds(net, charge_id="ch_9921")) == 1
    assert net.wait_event("customer_reply", cid, 10)["readback_ok"] is True


def test_forged_and_spoofed_approvals_refused(net):
    cid, c = open_case(net)
    sha = c.data["payload_sha256"]
    # an agent posts APPROVE in the finance room under a spoofed display name: identity comes from the server, not the text
    net.hub.rooms[c.data["rooms"]["finance"]]["agents"].append("resolve-comms")
    net.hub.deliver(c.data["rooms"]["finance"], net.com, f"APPROVE {cid} {sha}", sender_name="nora")
    assert net.wait_event("decision_refused", cid, 10) and c.state == "AWAITING_APPROVAL"
    assert console(net, c, "APPROVE", sha, who="sofia") == "refused"          # a human, but not a finance approver
    assert console(net, c, "APPROVE", "0" * 64) == "hash_mismatch" and c.state == "AWAITING_APPROVAL"


def test_scenario_b_timeout_then_readback_no_double_refund(net):
    cid, c = open_case(net)
    net.decide({"verb": "SIMULATE_TIMEOUT"}, {"sender_name": "test", "room_id": c.data["rooms"]["finance"]})
    console(net, c, "APPROVE", c.data["payload_sha256"])
    assert net.wait_state(cid, {"COMPLETED", "BLOCKED"}, 20) == "COMPLETED"
    trail = [a["state"] for a in c.data["audit"] if a["event"] == "transition"]
    assert trail == ["AWAITING_APPROVAL", "APPROVED", "DISPATCHING", "UNCERTAIN", "VERIFYING", "COMPLETED"]
    assert len(refunds(net, charge_id="ch_9921")) == 1 and c.data["dispatch"]["attempts"] == 1


def test_scenario_c_rejection(net):
    cid, c = open_case(net)
    assert console(net, c, "REJECT", "not this quarter") == "rejected" and c.state == "REJECTED"
    assert not refunds(net)
    assert c.data["receipt"]["rejection"]["reason"] == "not this quarter" and c.data["receipt"]["status"] == "REJECTED"
    assert net.wait_event("customer_reply_held", cid, 10)
    assert console(net, c, "APPROVE", c.data["payload_sha256"]) == "noop"         # nothing to approve after a rejection


def test_scenario_d_cross_room_access_blocked(net):
    cid, _ = open_case(net)
    out = net.access_probe(cid)
    assert out["switch_history"] == "HTTP 403" and out["switch_documents"].startswith("HTTP 4") and out["backend_ledger"].startswith("HTTP 403")
