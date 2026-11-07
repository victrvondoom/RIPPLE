#!/usr/bin/env python3
"""RIPPLE one-command demo: Switch-native, single-company dispute & SLA resolution (100% local, no cloud).

  python run_demo.py --all                 # scenarios A, B, C, D against your local Switch + the local mock backend
  python run_demo.py --scenario B          # one scenario (A happy path, B timeout recovery, C human rejection, D access block)
  python run_demo.py --all --human         # Mattermost running: wait for real APPROVE/REJECT messages from people in chat

Needs: Switch Console running (switch-core API on 127.0.0.1:52042) and `node scripts/switch-register.mjs` once (registers
the agents and writes .env). Human decisions: with no chat bridge (SWITCH_INTERNAL_ONLY=1) nobody can post in a Switch
room, so decisions are entered through the LOCAL CONSOLE and labelled as such everywhere; with Mattermost running, use --human.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
import mock_enterprise  # noqa: E402
from ripple_switch.agents import Network  # noqa: E402
from ripple_switch.switch_client import load_agents  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
MOCK_PORT = int(os.environ.get("RIPPLE_MOCK_PORT", "8790"))
GREEN, RED, BOLD, DIM, END = ("\033[32m", "\033[31m", "\033[1m", "\033[2m", "\033[0m") if sys.stdout.isatty() else ("",) * 5


def env() -> dict:
    out = dict(os.environ)
    p = os.path.join(ROOT, ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                out.setdefault(k, v)
    return out


class Report:
    def __init__(self):
        self.rows: list[dict] = []

    def check(self, scenario: str, name: str, ok: bool, detail: str = "") -> bool:
        self.rows.append({"scenario": scenario, "check": name, "passed": bool(ok), "detail": detail})
        mark = f"{GREEN}PASS{END}" if ok else f"{RED}FAIL{END}"
        print(f"  {mark} {name}" + (f"{DIM} — {detail}{END}" if detail else ""))
        return ok


def ledger(net: Network, kind: str = "refunds", **q) -> list:
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    return net.ent.call("GET", f"/ledger/{kind}" + (f"?{qs}" if qs else ""), "finance")[1][kind]


def human_decision(net: Network, case_id: str, verb: str, arg: str, approver: str, human: bool, timeout: float) -> None:
    c = net.case(case_id)
    if human:
        print(f"\n  {BOLD}Waiting for a person in #finance-approvals-{case_id}:{END}  {verb} {case_id} {arg}")
        net.wait_state(case_id, {"APPROVED", "REJECTED", "DISPATCHING", "VERIFYING", "COMPLETED", "UNCERTAIN", "BLOCKED"}, timeout)
        return
    cmd = {"verb": verb, "case_id": case_id, **({"payload_sha256": arg} if verb == "APPROVE" else {"reason": arg})}
    net.decide(cmd, {"sender": f"local-console:{approver}", "sender_name": approver, "sender_kind": None, "room_id": c.data["rooms"]["finance"], "message_id": None, "channel": "local-console"})


def open_case(net: Network, rep: Report, sc: str) -> str | None:
    case_id = net.ingest_customer_email()
    rep.check(sc, "customer email ingested by resolve-comms (RESOLVE commitments + REDEEM safety)", bool(case_id), case_id or "held")
    if not case_id:
        return None
    rep.check(sc, "coordinator provisioned linked #ops-verification and #finance-approvals rooms", bool(net.wait_event("rooms_provisioned", case_id, 30)), "create_room + link_rooms")
    rep.check(sc, "Evidence Manifest written as a Switch room document in the Engineering room", bool(net.wait_event("evidence_manifest", case_id, 30)))
    st = net.wait_state(case_id, {"AWAITING_APPROVAL", "BLOCKED"}, 40)
    rep.check(sc, "arbiter computed the payload deterministically and asked for hash-bound approval", st == "AWAITING_APPROVAL", f"state {st}, sha256 {str(net.case(case_id).data.get('payload_sha256'))[:16]}…")
    return case_id if st == "AWAITING_APPROVAL" else None


def scenario_a(net, rep, human, timeout):
    print(f"\n{BOLD}Scenario A — happy path{END}"); sc = "A"
    case_id = open_case(net, rep, sc)
    if not case_id:
        return None
    c = net.case(case_id); sha = c.data["payload_sha256"]
    got = [(a["op"], a["amount"]) for a in c.data["payload"]["actions"]]
    rep.check(sc, "zero-LLM maths: $4,200.00 duplicate refund + $1,200.00 SLA credit (99.120% uptime, 10% tier)", got == [("refund", "4200.00"), ("credit", "1200.00")], str(got))
    # an AGENT posts an approval: it must be refused, from server-set sender identity, not from the text
    net.com.post(net.intake_room, f"APPROVE {case_id} {sha}")
    hit = net.wait_event("decision_refused", case_id, 15)
    rep.check(sc, "forged approval posted by an agent is refused (Switch sender identity, wrong room)", bool(hit) and c.state == "AWAITING_APPROVAL", (hit or {}).get("reason", "no refusal seen")[:110])
    human_decision(net, case_id, "APPROVE", sha, "nora", human, timeout)
    st = net.wait_state(case_id, {"COMPLETED", "BLOCKED"}, 40)
    checks = c.data.get("verification", {}).get("checks", [])
    rep.check(sc, "approved → dispatched → verified by independent ledger read-back", st == "COMPLETED", f"state {st}; checks {sum(x['passed'] for x in checks)}/{len(checks)}")
    rep.check(sc, "exactly one refund of ch_9921 in the ledger", len(ledger(net, charge_id="ch_9921")) == 1)
    rep.check(sc, "Verified Resolution Receipt written as Switch room documents (finance + intake)", bool(net.wait_event("receipt", case_id, 20)), str(c.data.get("documents", {}).get("receipt", {}).get("intake_doc")))
    rep.check(sc, "customer reply queued only after the verified receipt (COMMS-2.3), read back from the outbox", bool(net.wait_event("customer_reply", case_id, 20)))
    return case_id


def scenario_b(net, rep, human, timeout):
    print(f"\n{BOLD}Scenario B — false-success / timeout recovery{END}"); sc = "B"
    case_id = open_case(net, rep, sc)
    if not case_id:
        return
    c = net.case(case_id)
    net.decide({"verb": "SIMULATE_TIMEOUT"}, {"sender_name": "demo-runner (--simulate-timeout)", "room_id": c.data["rooms"]["finance"]})
    human_decision(net, case_id, "APPROVE", c.data["payload_sha256"], "nora", human, timeout)
    st = net.wait_state(case_id, {"COMPLETED", "BLOCKED"}, 40)
    trail = [a["state"] for a in c.data["audit"] if a["event"] == "transition"]
    rep.check(sc, "ledger timeout recorded as UNCERTAIN (never as success)", "UNCERTAIN" in trail, " → ".join(trail))
    rb = [e for e in net.events if e["kind"] == "readback" and e.get("case") == case_id]
    rep.check(sc, "read-back BEFORE any retry found the refund already committed", bool(rb) and rb[0]["found"] is True, str(rb[:1])[:120])
    n = len(ledger(net, charge_id="ch_9921"))
    rep.check(sc, "no double refund: ch_9921 refunded exactly once", n == 1, f"{n} refund row(s)")
    rep.check(sc, "case COMPLETED after verification", st == "COMPLETED", st)


def scenario_c(net, rep, human, timeout):
    print(f"\n{BOLD}Scenario C — human rejection gate{END}"); sc = "C"
    case_id = open_case(net, rep, sc)
    if not case_id:
        return
    c = net.case(case_id)
    if not human:
        r = net.decide({"verb": "APPROVE", "case_id": case_id, "payload_sha256": "0" * 64}, {"sender": "local-console:nora", "sender_name": "nora", "sender_kind": None, "room_id": c.data["rooms"]["finance"], "message_id": None, "channel": "local-console"})
        rep.check(sc, "approval quoting a different payload hash is refused", r == "hash_mismatch" and c.state == "AWAITING_APPROVAL", r)
    human_decision(net, case_id, "REJECT", "credit exceeds what Finance will authorise this quarter; refund separately", "nora", human, timeout)
    st = net.wait_state(case_id, {"REJECTED"}, 20)
    rep.check(sc, "REJECT → state REJECTED", st == "REJECTED", st)
    rep.check(sc, "no ledger write happened", not ledger(net) and not ledger(net, "credits"))
    rec = net.wait_event("receipt", case_id, 20)
    rep.check(sc, "rejection recorded in the receipt room document", bool(rec) and (c.data.get("receipt") or {}).get("rejection", {}).get("by") == "nora", ((c.data.get("receipt") or {}).get("rejection") or {}).get("reason", "")[:60])
    rep.check(sc, "customer reply held (nothing confirmed that the ledger does not show)", bool(net.wait_event("customer_reply_held", case_id, 20)))


def scenario_d(net, rep, case_id):
    print(f"\n{BOLD}Scenario D — cross-room unauthorized access block{END}"); sc = "D"
    out = net.access_probe(case_id)
    rep.check(sc, "Engineering agent reading #finance-approvals history → 403 from Switch", out["switch_history"] == "HTTP 403", out["switch_history"])
    rep.check(sc, "Engineering agent loading finance room documents → refused by Switch", out["switch_documents"].startswith("HTTP 4"), out["switch_documents"])
    rep.check(sc, "Engineering token on the ledger API → 403 from the backend", out["backend_ledger"].startswith("HTTP 403"), out["backend_ledger"])


def export_topology(net: Network, e: dict, case_id: str | None) -> dict:
    """Try Switch's own GET /rooms/{id}/yaml (gateway; needs a signed-in user); always also write a v2 template of the run."""
    res: dict = {}
    gw = e.get("SWITCH_GATEWAY_URL", "http://127.0.0.1:52041").rstrip("/")
    try:
        headers = {"Authorization": f"Bearer {e['SWITCH_GATEWAY_TOKEN']}"} if e.get("SWITCH_GATEWAY_TOKEN") else {}
        with urllib.request.urlopen(urllib.request.Request(f"{gw}/rooms/{net.intake_room}/yaml", headers=headers), timeout=5) as r:
            res["switch_export"] = r.read().decode()
    except Exception as ex:
        res["switch_export_error"] = f"{type(ex).__name__}: {str(ex)[:100]} (gateway route needs the gateway running and a signed-in user)"
    os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
    path = os.path.join(ROOT, "out", f"{case_id or 'ripple'}.topology.template.yaml")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"""# Generated by RIPPLE from the resolved case {case_id}. NOT Switch's own export (see switch_export_error in the evidence file).
version: 2
params:
  case_id: {{type: string, default: "{case_id}", description: Case to resolve}}
resources:
  intake:
    type: room
    name: ripple-intake
    description: RIPPLE bootstrap intake
    agents: [ripple-coordinator, resolve-comms, reclaim-investigator, ripple-arbiter]
  ops:
    type: room
    name: "ops-verification-{{case_id}}"
    description: Engineering root-cause verification
    agents: [ripple-coordinator, reclaim-investigator]
    group: case_group
  finance:
    type: room
    name: "finance-approvals-{{case_id}}"
    description: Finance approval (ripple-arbiter only)
    agents: [ripple-arbiter]
    group: case_group
  case_group:
    type: group
    name: "ripple-{{case_id}}"
    description: One case, two isolated department rooms
    links:
      - {{from: ops, to: finance, label: evidence digest feeds the finance decision}}
""")
    res["template_path"] = os.path.relpath(path, ROOT)
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--scenario", choices=list("ABCD"), action="append")
    ap.add_argument("--human", action="store_true", help="wait for real APPROVE/REJECT messages from people in Mattermost")
    ap.add_argument("--human-timeout", type=float, default=600)
    a = ap.parse_args()
    which = list("ABCD") if a.all or not a.scenario else a.scenario
    e = env(); bridge = e.get("SWITCH_BRIDGE_URL", "http://127.0.0.1:52042")
    internal = e.get("SWITCH_INTERNAL_ONLY") == "1"
    if a.human and internal:
        print("--human needs a chat bridge: start Mattermost from Switch Console and unset SWITCH_INTERNAL_ONLY."); return 2
    print(f"{BOLD}RIPPLE — Switch-native dispute & SLA resolution (local, synthetic data){END}")
    if not os.path.exists(os.path.join(ROOT, "data", "switch-agents.local.json")):
        print("No registered agents. Start Switch Console, then: node scripts/switch-register.mjs"); return 2
    agents = load_agents(bridge)
    if not agents["ripple-coordinator"].health():
        print(f"Switch is not reachable at {bridge}. Start Switch Console, then: node scripts/switch-register.mjs"); return 2
    state_dir = os.path.join(ROOT, "data", "mock_enterprise")
    mock = mock_enterprise.serve(MOCK_PORT, state_dir, reset=True)
    humans = {} if internal else {"finance": ["nora"], "engineering": ["eli"], "support": ["sofia"]}
    net = Network(agents, f"http://127.0.0.1:{MOCK_PORT}", internal_only=internal, humans=humans)
    rep = Report(); last = None; topo: dict = {}
    try:
        print(f"Switch {bridge} · rooms {'agent-only (no chat bridge; human decisions via LOCAL CONSOLE, labelled)' if internal else 'bridged to chat'} · mock backend 127.0.0.1:{MOCK_PORT}")
        net.start()
        for s in which:
            mock_enterprise.Store(state_dir, reset=True)          # fresh synthetic ledger per scenario
            if s == "A":
                last = scenario_a(net, rep, a.human, a.human_timeout) or last
            elif s == "B":
                scenario_b(net, rep, a.human, a.human_timeout)
            elif s == "C":
                scenario_c(net, rep, a.human, a.human_timeout)
            elif s == "D":
                if not last:
                    print(f"\n{DIM}(Scenario D needs a case with rooms; opening one){END}"); last = open_case(net, rep, "D")
                if last:
                    scenario_d(net, rep, last)
        topo = export_topology(net, e, last)
        print(f"\n{BOLD}Room topology{END}: {topo['template_path']} (generated v2 template). Switch export: {'OK' if 'switch_export' in topo else topo['switch_export_error']}")
        for cid, c in net.cases.items():
            r = c.data.get("receipt")
            if r:
                print(f"{BOLD}RIPPLE Resolution Receipt {cid}{END}: {r['status']} · receipt sha256 {r['receipt_sha256'][:20]}… · actions {[(x['op'], x['amount'], x['ledger_id']) for x in r['actions']]} · trail {' → '.join(r['state_trail'])}")
    finally:
        net.close(); mock.shutdown()
    errors = [ev for ev in net.events if ev["kind"] == "agent_error"]
    if errors:
        rep.check("-", "no agent errors during the run", False, str(errors[:2])[:200])
    passed = bool(rep.rows) and all(r["passed"] for r in rep.rows)
    os.makedirs(os.path.join(ROOT, "docs", "evidence"), exist_ok=True)
    out = os.path.join(ROOT, "docs", "evidence", f"ripple-switch-demo-{datetime.now(timezone.utc):%Y-%m-%d}.json")
    json.dump({"bridge": bridge, "rooms": "internal_only" if internal else "bridged", "human_channel": "switch-room" if a.human else "local-console (labelled)",
               "data": "synthetic", "checks": rep.rows, "events": net.events, "topology": {k: v for k, v in topo.items() if k != "switch_export"},
               "receipts": {k: c.data.get("receipt") for k, c in net.cases.items()}, "passed": passed}, open(out, "w"), indent=1)
    print(f"\n{BOLD}{(GREEN + 'ALL CHECKS PASSED') if passed else (RED + 'SOME CHECKS FAILED')}{END} ({sum(r['passed'] for r in rep.rows)}/{len(rep.rows)}) — evidence: {os.path.relpath(out, ROOT)}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
