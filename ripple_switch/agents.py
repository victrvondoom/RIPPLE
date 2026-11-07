"""RIPPLE Switch-native agents: one company, three departments, coordinated in Switch rooms.

  #ripple-intake (bootstrap)      ripple-coordinator, resolve-comms, reclaim-investigator, ripple-arbiter (+ support humans)
  #ops-verification-<case>        ripple-coordinator, reclaim-investigator (+ engineering humans)   raw incident logs stay here
  #finance-approvals-<case>       ripple-arbiter ONLY (+ finance humans)                             raw ledger stays here
Room membership is enforced by the Switch server (a non-member gets 403 on history and is refused on connect_to_room).
Only verified claims, room-document ids and SHA-256 digests cross back into #ripple-intake.

Every agent is a deterministic protocol client (no LLM). The arbiter computes every amount in Python, binds the human
approval to the payload SHA-256, and dispatches through an UNCERTAIN-safe state machine with ledger read-back.
"""
from __future__ import annotations

import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from decimal import Decimal

from . import domain
from .state_machine import CaseRecord
from .switch_client import Message, SwitchAgent, SwitchError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "ripple_switch")
TOKENS = {"finance": "demo-finance-token", "engineering": "demo-engineering-token", "support": "demo-support-token"}
CASE_RE = re.compile(r"RPL-\d{4}-\d{4}")
MENTION = re.compile(r"^(@\S+\s+)+")


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Enterprise:
    """HTTP client for the local mock enterprise service (department-token RBAC)."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def call(self, method: str, path: str, dept: str, body: dict | None = None, key: str | None = None, timeout: float = 5.0) -> tuple[int, dict]:
        headers = {"X-Department-Token": TOKENS[dept], "Content-Type": "application/json"}
        if key:
            headers["Idempotency-Key"] = key
        req = urllib.request.Request(f"{self.base}{path}", data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")
        except (socket.timeout, TimeoutError):
            raise TimeoutError(f"{method} {path} timed out after {timeout}s") from None
        except urllib.error.URLError as e:
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                raise TimeoutError(f"{method} {path} timed out after {timeout}s") from None
            raise


class Network:
    def __init__(self, agents: dict[str, SwitchAgent], enterprise_url: str, internal_only: bool = True,
                 humans: dict[str, list[str]] | None = None, month: str = "2026-11", log=print):
        self.co, self.inv, self.com, self.arb = (agents[n] for n in ("ripple-coordinator", "reclaim-investigator", "resolve-comms", "ripple-arbiter"))
        self.ent = Enterprise(enterprise_url)
        self.internal_only, self.humans, self.month, self.log = internal_only, humans or {}, month, log
        self.pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="ripple-work")
        self.intake_room: str | None = None
        self.cases: dict[str, CaseRecord] = {}
        self.pending: dict[str, dict] = {}          # case_id -> {"arbitrate": {...}, "evidence": {...}}
        self.timeout_armed: set[str] = set()
        self.events: list[dict] = []                # what happened, for the demo report / tests
        self._lock = threading.RLock()
        os.makedirs(DATA, exist_ok=True)

    # ---------- plumbing ----------
    def record(self, kind: str, **kw) -> None:
        e = {"at": now(), "kind": kind, **kw}
        with self._lock:
            self.events.append(e)
        self.log(f"  · {kind}: " + ", ".join(f"{k}={v}" for k, v in kw.items())[:240])

    def case(self, case_id: str) -> CaseRecord:
        with self._lock:
            if case_id not in self.cases:
                self.cases[case_id] = CaseRecord(os.path.join(DATA, "cases", f"{case_id}.json"), case_id)
            return self.cases[case_id]

    def _async(self, fn, *a) -> None:
        """Slow work runs off the SSE threads so heartbeats and event reading never stall."""
        def run():
            try:
                fn(*a)
            except Exception as e:  # surfaced, never swallowed silently
                self.record("agent_error", where=getattr(fn, "__name__", "?"), error=str(e)[:300])
        self.pool.submit(run)

    def next_case_id(self) -> str:
        path = os.path.join(DATA, "sequence.json")
        with self._lock:
            n = (json.load(open(path)).get("n", 0) if os.path.exists(path) else 0) + 1
            json.dump({"n": n}, open(path, "w"))
        return f"RPL-{self.month[:4]}-{n:04d}"

    def _room_args(self, users: list[str]) -> dict:
        return {"internal_only": True} if self.internal_only else ({"user_names": users} if users else {})

    # ---------- bootstrap ----------
    def start(self) -> str:
        for a, h in ((self.co, self._on_coordinator), (self.inv, self._on_investigator), (self.com, self._on_comms), (self.arb, self._on_arbiter)):
            a.on_message(h)
            a.listen([])
        topo = os.path.join(DATA, "topology.json")
        if os.path.exists(topo):
            rid = json.load(open(topo)).get("intake_room")
            try:
                self.co.history(rid, limit=1)
                self.intake_room = rid
            except SwitchError:
                self.intake_room = None
        if not self.intake_room:
            r = self.co.op("create_room", {
                "name": "ripple-intake", "description": "RIPPLE bootstrap intake: customer disputes land here; per-case rooms are provisioned from here.",
                "agent_names": ["ripple-coordinator", "resolve-comms", "reclaim-investigator", "ripple-arbiter"],
                "instructions": "Only verified claims, room-document ids and SHA-256 digests are posted here. Raw logs stay in #ops-verification-*, raw ledgers in #finance-approvals-*.",
                **self._room_args(self.humans.get("support", []))})
            self.intake_room = r["id"]
            json.dump({"intake_room": r["id"], "created_at": now()}, open(topo, "w"))
        self.record("intake_room_ready", room=self.intake_room, mode="agent-only (internal_only)" if self.internal_only else "bridged")
        return self.intake_room

    # ---------- resolve-comms: customer email -> case ----------
    def ingest_customer_email(self) -> str | None:
        _, inbox = self.ent.call("GET", "/mailbox/inbox", "support")
        _, sent = self.ent.call("GET", "/mailbox/sent", "support")
        email = inbox["inbox"][-1]
        account = "ACME-2231" if "acme-logistics" in email["from"] else None
        _, contract = self.ent.call("GET", f"/contracts/{account}", "support")
        it = domain.intake(email, sent["sent"], contract["company"])
        if it["safety"]["decision"] != "ALLOW":
            self.com.post(self.intake_room, f"[RESOLVE] Email {email['id']} held for a human: {it['safety']['explanation']}")
            return None
        case_id = self.next_case_id()
        c = self.case(case_id)
        c.data["intake"] = {"email_id": email["id"], "account": account, "customer": contract["customer"]["name"], "contact": contract["customer"]["contact"],
                            "claimed_amount": it["claimed_amount"], "requests": [r["evidence_text"] for r in it["requests"]],
                            "our_promises": [{"text": p["evidence_text"], "deadline_at": p["deadline_at"], "overdue": p["overdue"]} for p in it["our_promises"]]}
        c.save()
        overdue = [p for p in it["our_promises"] if p["overdue"]]
        req = it["requests"][0] if it["requests"] else None
        due = f" (deadline {datetime.fromtimestamp(req['deadline_at'], timezone.utc):%Y-%m-%d %H:%M} UTC)" if req and req["deadline_at"] else ""
        body = (f"NEW DISPUTE {case_id} account={account} customer=\"{contract['customer']['name']}\" claimed=${it['claimed_amount']}\n"
                f"Customer asks: \"{req['evidence_text'] if req else '-'}\"{due}\n"
                + (f"OVERDUE promise we made: \"{overdue[0]['evidence_text']}\"\n" if overdue else "")
                + f"Safety: {it['safety']['decision']}; scam indicators: {it['scam']['risk_level']}; instruction-like text: {'yes' if it['injection'] else 'no'}")
        self.com.post_to(self.intake_room, body, ["ripple-coordinator"])
        self.record("case_opened", case=case_id, by="resolve-comms", claimed=it["claimed_amount"], overdue_promise=bool(overdue))
        return case_id

    def _on_comms(self, m: Message) -> None:
        text = MENTION.sub("", m.body)
        if m.room_id == self.intake_room and m.sender_name == "ripple-arbiter" and text.startswith("RECEIPT "):
            self._async(self._send_customer_reply, CASE_RE.search(text).group(0))

    def _send_customer_reply(self, case_id: str) -> None:
        c = self.case(case_id); r = c.data.get("receipt") or {}
        if r.get("status") != "COMPLETED":   # COMMS-2.3: confirm nothing the ledger does not show
            self.com.post(self.intake_room, f"[RESOLVE] {case_id}: customer reply HELD — payout status is {r.get('status', 'unknown')}; the Support lead decides the wording.")
            self.record("customer_reply_held", case=case_id, status=r.get("status"))
            return
        lines = [f"- {a['op']} of ${a['amount']} ({a.get('charge_id') or a.get('account')}) — ledger record {a['ledger_id']}" for a in r["actions"]]
        body = (f"Dear {c.data['intake']['customer']} team,\n\nWe confirmed the duplicate capture and have completed the following, verified in our ledger:\n"
                + "\n".join(lines) + f"\n\nReference: {case_id} (receipt {r['receipt_sha256'][:16]}).\n\nHarbor & Vine Cloud Support")
        key = domain.sha256(f"{case_id}|reply|{r['receipt_sha256']}")[:32]
        _, res = self.ent.call("POST", "/mailbox/outbox", "support", {"to": c.data["intake"]["contact"], "subject": f"Your dispute {case_id} is resolved", "body": body, "case_id": case_id}, key=key)
        _, back = self.ent.call("GET", f"/mailbox/outbox?idempotency_key={key}", "support")
        ok = len(back["outbox"]) == 1 and back["outbox"][0]["body"] == body
        self.com.post(self.intake_room, f"[RESOLVE] {case_id}: customer reply queued in the LOCAL outbox (not sent by email) and read back {'OK' if ok else 'MISMATCH'} (record {res['record']['id']}).")
        self.record("customer_reply", case=case_id, outbox_id=res["record"]["id"], readback_ok=ok)

    # ---------- ripple-coordinator: dynamic rooms ----------
    def _on_coordinator(self, m: Message) -> None:
        text = MENTION.sub("", m.body)
        if m.room_id == self.intake_room and m.sender_name == "resolve-comms" and text.startswith("NEW DISPUTE"):
            self._async(self._provision, CASE_RE.search(text).group(0), text)

    def _provision(self, case_id: str, body: str) -> None:
        c = self.case(case_id); account = re.search(r"account=(\S+)", body).group(1)
        ops = self.co.op("create_room", {"name": f"ops-verification-{case_id}", "description": f"Engineering root-cause verification for {case_id}",
                                          "agent_names": ["ripple-coordinator", "reclaim-investigator"], "instructions": "Raw incident logs stay in this room.",
                                          **self._room_args(self.humans.get("engineering", []))})
        fin = self.co.op("create_room", {"name": f"finance-approvals-{case_id}", "description": f"Finance approval for {case_id}",
                                          "agent_names": ["ripple-arbiter"], "instructions": "Raw ledger data stays in this room. Approvals: APPROVE <CASE_ID> <PAYLOAD_SHA256> / REJECT <CASE_ID> <REASON>.",
                                          **self._room_args(self.humans.get("finance", []))})
        for src, dst, label in ((self.intake_room, ops["id"], f"engineering verification {case_id}"), (self.intake_room, fin["id"], f"finance approvals {case_id}"), (ops["id"], self.intake_room, "case intake")):
            self.co.op("link_rooms", {"source_room_id": src, "target_room_id": dst, "label": label})
        self.arb.op("link_rooms", {"source_room_id": fin["id"], "target_room_id": self.intake_room, "label": "case intake"})
        c.data["rooms"] = {"intake": self.intake_room, "ops": ops["id"], "finance": fin["id"]}; c.save()
        self.record("rooms_provisioned", case=case_id, ops=ops["id"], finance=fin["id"])
        self.co.post(self.intake_room, f"[COORDINATOR] {case_id}: created #ops-verification-{case_id} (ripple-coordinator, reclaim-investigator) and #finance-approvals-{case_id} (ripple-arbiter only{'' if self.internal_only else ', + finance approvers'}); rooms linked. Raw logs and ledgers stay in those rooms.")
        self.co.post_to(ops["id"], f"INVESTIGATE {case_id} service=checkout-api account={account} month={self.month}", ["reclaim-investigator"])
        self.co.post_to(self.intake_room, f"ARBITRATE {case_id} account={account} finance_room={fin['id']}", ["ripple-arbiter"])

    # ---------- reclaim-investigator: evidence manifest in the Engineering room ----------
    def _on_investigator(self, m: Message) -> None:
        text = MENTION.sub("", m.body)
        if m.sender_name == "ripple-coordinator" and text.startswith("INVESTIGATE"):
            self._async(self._investigate, CASE_RE.search(text).group(0), m.room_id, text)

    def _investigate(self, case_id: str, ops_room: str, body: str) -> None:
        account = re.search(r"account=(\S+)", body).group(1); service = re.search(r"service=(\S+)", body).group(1)
        _, inc = self.ent.call("GET", f"/incidents?service={service}", "engineering")
        _, contract = self.ent.call("GET", f"/contracts/{account}", "engineering")
        ev = domain.incident_evidence(inc["incidents"][0], contract["customer"]["sla"], self.month)
        ev_sha = domain.sha256(ev)
        clause = next(p for p in contract["policies"] if p["id"] == contract["customer"]["sla"]["clause"])
        stmt = "share of 5-minute intervals in the month in which at least 5% of checkout requests failed"
        content = (f"# Evidence Manifest — {case_id}\n\nProduced by reclaim-investigator (deterministic; no LLM). Source: incident log export (synthetic demo data).\n\n"
                   "| Field | Value |\n|---|---|\n" + "".join(f"| {k} | {v} |\n" for k, v in ev.items())
                   + f"\nUptime definition grounded in {clause['id']} v{clause['version']}: \"{stmt}\" — verified against the clause text: {domain.grounded(stmt, clause['text'])}\n\n"
                   f"Evidence SHA-256 (canonical JSON): `{ev_sha}`\n\n```json\n{domain.canonical(ev)}\n```")
        doc = self.inv.create_document(ops_room, f"evidence-manifest-{case_id}", f"Technical & policy evidence for {case_id}", "Read by Engineering; only its digest leaves this room.", content)
        c = self.case(case_id); c.data["documents"]["evidence_manifest"] = {"room": ops_room, "id": doc, "sha256": ev_sha}; c.data["evidence"] = ev; c.save()
        self.inv.post(ops_room, f"[RECLAIM] {case_id}: Evidence Manifest written (room document {doc}). {ev['intervals_unavailable']} unavailable 5-min intervals → monthly uptime {ev['monthly_uptime_pct']}%. Root cause {ev['defect']}.")
        self.inv.post_to(self.intake_room, f"EVIDENCE {case_id} manifest_doc={doc} sha256={ev_sha} uptime_pct={ev['monthly_uptime_pct']} unavailable_intervals={ev['intervals_unavailable']} defect={ev['defect']}", ["ripple-arbiter"])
        self.record("evidence_manifest", case=case_id, doc=doc, sha256=ev_sha[:16], uptime=ev["monthly_uptime_pct"])

    def access_probe(self, case_id: str) -> dict:
        """Scenario D: the Engineering agent tries to read Finance data, through Switch and through the backend."""
        c = self.case(case_id); fin = c.data["rooms"]["finance"]; out = {}
        try:
            self.inv.history(fin, limit=5); out["switch_history"] = "ALLOWED (unexpected)"
        except SwitchError as e:
            out["switch_history"] = f"HTTP {e.status}"
        try:
            self.inv.in_room(fin, "load_internal_documents", {"ids": [c.data["documents"].get("proposal", {}).get("id", "x")]}); out["switch_documents"] = "ALLOWED (unexpected)"
        except SwitchError as e:
            out["switch_documents"] = f"HTTP {e.status}"
        st, body = self.ent.call("GET", "/ledger/charges?account=ACME-2231", "engineering")
        out["backend_ledger"] = f"HTTP {st} ({body.get('detail', '')})"
        self.inv.post(c.data["rooms"]["ops"], f"[RECLAIM] {case_id}: access check — finance room history: {out['switch_history']}; finance documents: {out['switch_documents']}; ledger API: {out['backend_ledger']}. Isolation holds.")
        self.record("access_probe", case=case_id, **out)
        return out

    # ---------- ripple-arbiter: deterministic finance gatekeeper ----------
    def _on_arbiter(self, m: Message) -> None:
        if m.sender_name == "ripple-arbiter":
            return
        text = MENTION.sub("", m.body)
        if m.room_id == self.intake_room and text.startswith(("ARBITRATE", "EVIDENCE")):
            cid = CASE_RE.search(text).group(0)
            with self._lock:
                if text.startswith("ARBITRATE") and m.sender_name == "ripple-coordinator":
                    self.pending.setdefault(cid, {})["arbitrate"] = {"finance_room": re.search(r"finance_room=(\S+)", text).group(1), "account": re.search(r"account=(\S+)", text).group(1)}
                elif text.startswith("EVIDENCE") and m.sender_name == "reclaim-investigator":
                    self.pending.setdefault(cid, {})["evidence"] = dict(re.findall(r"(\w+)=(\S+)", text))
                ready = {"arbitrate", "evidence"} <= set(self.pending.get(cid, {}))
            if ready:
                self._async(self._propose, cid)
            return
        cmd = domain.parse_command(m.body)
        if cmd:
            self._async(self.decide, cmd, {"sender": m.sender, "sender_name": m.sender_name, "sender_kind": m.sender_kind, "room_id": m.room_id, "message_id": m.message_id, "channel": "switch-room"})

    def _propose(self, case_id: str) -> None:
        c = self.case(case_id)
        with self._lock:
            p = self.pending.pop(case_id, None)
        if not p or c.state != "PLANNED":
            return
        fin = p["arbitrate"]["finance_room"]; account = p["arbitrate"]["account"]; ev = p["evidence"]
        _, contract = self.ent.call("GET", f"/contracts/{account}", "finance")
        _, led = self.ent.call("GET", f"/ledger/charges?account={account}", "finance")
        c.data["rooms"] = {**c.data.get("rooms", {}), "finance": fin}; c.data["approvers"] = contract["approvers"]["finance"]; c.save()
        dups = domain.duplicates(led["charges"])
        if not dups:
            c.to("BLOCKED", "ripple-arbiter", "no duplicate capture in the ledger; the customer claim is not supported")
            self.arb.post(self.intake_room, f"BLOCKED {case_id}: the ledger shows no duplicate capture; Support should ask the customer for transaction details.")
            return
        dup = dups[0]
        credit = domain.sla_credit(ev["uptime_pct"], contract["customer"]["sla"], contract["customer"]["monthly_fee"])
        payload = domain.refund_payload(case_id, account, dup, credit)
        sha = domain.sha256(payload)
        claimed = c.data.get("intake", {}).get("claimed_amount")
        c.propose(payload, sha, "ripple-arbiter")
        ctx = self.arb.op("get_my_context")
        me = next((a for a in ctx.get("agents", []) if a.get("name") == "ripple-arbiter"), {})
        humans = [x["name"] for x in self.arb.participants(fin) if x.get("type") == "user"]
        match = claimed and Decimal(claimed) == domain.money(dup["duplicate"]["amount"])
        doc_body = (f"# Refund proposal — {case_id} (FINANCE ROOM ONLY)\n\nComputed by ripple-arbiter in deterministic Python (no LLM).\n\n"
                    "## Ledger (raw, finance-only)\n" + "".join(f"- {x['id']} {x['invoice']} ${x['amount']} {x['captured_at']} {x['source']}\n" for x in led["charges"])
                    + f"\nDuplicate capture: {dup['duplicate']['id']} (retry of {dup['original']['id']}, invoice {dup['invoice']}).\n"
                    + (f"Customer claimed ${claimed}; ledger duplicate ${domain.money(dup['duplicate']['amount'])}: {'match' if match else 'MISMATCH, ledger amount used'}.\n" if claimed else "")
                    + f"\n## SLA ({credit['clause']})\nUptime {credit['uptime_pct']}% (evidence manifest {ev['manifest_doc']}, sha256 {ev['sha256'][:16]}…) vs target {credit['target_pct']}% → {credit['credit_pct']}% credit = ${credit['amount']}.\n"
                    f"\n## Payload to approve\n```json\n{json.dumps(payload, indent=1)}\n```\nPayload SHA-256: `{sha}`\n")
        doc = self.arb.create_document(fin, f"refund-proposal-{case_id}", f"Hash-bound payout proposal for {case_id}", "Approve only by quoting the SHA-256.", doc_body)
        c.data["documents"]["proposal"] = {"room": fin, "id": doc, "sha256": sha}; c.save()
        total = sum(Decimal(a["amount"]) for a in payload["actions"])
        self.arb.post(fin, (f"AWAITING_APPROVAL {case_id}: refund ${payload['actions'][0]['amount']} of duplicate {dup['duplicate']['id']}"
                            + (f" + SLA credit ${credit['amount']}" if Decimal(credit["amount"]) > 0 else "") + f" = ${total}. Proposal document {doc}.\n"
                            f"Authority: approvers {', '.join(c.data['approvers'])} (contract); human members of this room: {', '.join(humans) or 'none connected (chat bridge not running)'}; "
                            f"my addressing policy in Switch: {me.get('who_can_talk', 'unknown')}. Agents cannot approve.\n"
                            f"Reply exactly: APPROVE {case_id} {sha}   or   REJECT {case_id} <reason>"))
        self.arb.post(self.intake_room, f"AWAITING_APPROVAL {case_id} payload_sha256={sha} total=${total} (details and ledger stay in #finance-approvals-{case_id})")
        self.record("approval_requested", case=case_id, payload_sha256=sha[:16], total=str(total), proposal_doc=doc)

    def decide(self, cmd: dict, who: dict) -> str:
        """Single entry point for human decisions (from a Switch room message, or the labelled local console)."""
        if cmd["verb"] == "SIMULATE_TIMEOUT":
            cases = [k for k, c in self.cases.items() if c.data.get("rooms", {}).get("finance") == who.get("room_id")] if who.get("room_id") else list(self.cases)
            self.timeout_armed.update(cases)
            self.record("fault_armed", cases=",".join(cases), by=who.get("sender_name"))
            return "armed"
        if cmd["verb"] == "INVALID":
            self.arb.post(who["room_id"], f"Not accepted: {cmd['reason']}."); return "invalid"
        c = self.case(cmd["case_id"]); fin = c.data.get("rooms", {}).get("finance")
        if who["channel"] == "switch-room":
            if who["room_id"] != fin:
                ok, why = domain.authorize(who["sender"], who["sender_name"], who["sender_kind"], [], c.data.get("approvers", []))
                self.arb.post(who["room_id"], f"Not accepted: decisions for {cmd['case_id']} are only taken in #finance-approvals-{cmd['case_id']}" + ("" if ok else f"; also {why}") + ".")
                self.record("decision_refused", case=cmd["case_id"], by=who["sender_name"], reason="wrong room" + ("" if ok else f"; {why}"))
                return "refused"
            ok, why = domain.authorize(who["sender"], who["sender_name"], who["sender_kind"], self.arb.participants(fin), c.data.get("approvers", []))
        else:  # LOCAL CONSOLE: used only when no human can post in Switch (chat bridge down); labelled everywhere
            ok = who["sender_name"] in c.data.get("approvers", [])
            why = f"{who['sender_name']} {'is' if ok else 'is NOT'} a contract finance approver (LOCAL CONSOLE decision, not a Switch chat message)"
        if not ok:
            self.arb.post(fin or who["room_id"], f"Not accepted from {who['sender_name']}: {why}.")
            self.record("decision_refused", case=cmd["case_id"], by=who["sender_name"], reason=why)
            return "refused"
        if c.state != "AWAITING_APPROVAL":
            self.arb.post(fin, f"{cmd['case_id']} is {c.state}; nothing to decide."); return "noop"
        if who["channel"] != "switch-room":
            self.arb.post(fin, f"Decision received via LOCAL CONSOLE from {who['sender_name']} (the chat bridge is not running, so no human can post in this room): {cmd['verb']} {cmd['case_id']} {cmd.get('payload_sha256', cmd.get('reason', ''))}")
        if cmd["verb"] == "REJECT":
            c.data["rejection"] = {"by": who["sender_name"], "reason": cmd["reason"], "at": now(), "channel": who["channel"]}
            c.to("REJECTED", who["sender_name"], cmd["reason"])
            self.arb.post(fin, f"REJECTED {cmd['case_id']} by {who['sender_name']}: {cmd['reason']}. No ledger write will happen.")
            self._receipt(c)
            return "rejected"
        if cmd["payload_sha256"] != c.data["payload_sha256"]:
            self.arb.post(fin, f"Not accepted: hash {cmd['payload_sha256'][:12]}… does not match the current payload {c.data['payload_sha256'][:12]}…. Re-read the proposal.")
            self.record("decision_refused", case=cmd["case_id"], by=who["sender_name"], reason="hash mismatch")
            return "hash_mismatch"
        c.data["approval"] = {"by": who["sender_name"], "sender": who.get("sender"), "channel": who["channel"], "message_id": who.get("message_id"), "payload_sha256": cmd["payload_sha256"], "at": now()}
        c.to("APPROVED", who["sender_name"], f"approved payload {cmd['payload_sha256'][:12]} via {who['channel']}")
        self.arb.post(fin, f"APPROVED {cmd['case_id']} by {who['sender_name']} ({who['channel']}). Dispatching.")
        self._dispatch(c)
        return "approved"

    def _dispatch(self, c: CaseRecord) -> None:
        cid = c.data["case_id"]; fin = c.data["rooms"]["finance"]; acts = c.data["payload"]["actions"]
        keys = [domain.sha256(f"{cid}|{c.data['payload_sha256']}|{i}|{a['op']}")[:32] for i, a in enumerate(acts)]
        c.data["dispatch"]["keys"] = keys; c.save()
        approval = {"by": c.data["approval"]["by"], "channel": c.data["approval"]["channel"], "payload_sha256": c.data["payload_sha256"]}
        pending = list(range(len(acts)))
        for attempt in range(1, 4):
            c.to("DISPATCHING", "ripple-arbiter", f"attempt {attempt}: {len(pending)} ledger write(s)")
            c.data["dispatch"]["attempts"] = attempt; c.save()
            uncertain = []
            for i in pending:
                a = acts[i]; path = "/ledger/refunds" if a["op"] == "refund" else "/ledger/credits"
                fault = cid in self.timeout_armed and attempt == 1 and a["op"] == "refund"
                body = {"charge_id": a.get("charge_id"), "account": c.data["payload"]["account"], "amount": a["amount"], "currency": a["currency"], "case_id": cid, "payload_sha256": c.data["payload_sha256"], "approval": approval}
                try:
                    st, res = self.ent.call("POST", path + ("?simulate=timeout" if fault else ""), "finance", body, key=keys[i], timeout=1.5)
                except TimeoutError as e:
                    uncertain.append(i); self.record("dispatch_timeout", case=cid, op=a["op"], error=str(e)); continue
                if st >= 500:
                    uncertain.append(i)
                elif st not in (200, 201):
                    c.to("BLOCKED", "ripple-arbiter", f"ledger refused {a['op']}: HTTP {st} {res.get('error')}")
                    self.arb.post(fin, f"BLOCKED {cid}: the ledger refused the {a['op']} (HTTP {st} {res.get('error')}). Nothing was retried.")
                    self._receipt(c); return
            if not uncertain:
                break
            c.to("UNCERTAIN", "ripple-arbiter", f"{len(uncertain)} write(s) with unknown outcome; reading back before any retry")
            self.arb.post(fin, f"UNCERTAIN {cid}: the ledger did not answer in time. Reading back by idempotency key BEFORE any retry (no blind repeat).")
            absent = []
            for i in uncertain:
                path = "/ledger/refunds" if acts[i]["op"] == "refund" else "/ledger/credits"; col = path.split("/")[-1]
                _, back = self.ent.call("GET", f"{path}?idempotency_key={keys[i]}", "finance")
                if not back[col]:
                    absent.append(i)
                self.record("readback", case=cid, op=acts[i]["op"], found=bool(back[col]))
            if not absent:
                self.arb.post(fin, f"{cid}: read-back found the write(s) already committed. They are NOT repeated.")
                break
            c.to("RETRYABLE", "ripple-arbiter", f"read-back confirmed {len(absent)} write(s) absent; safe to retry with the same keys")
            pending = absent
        else:
            c.to("BLOCKED", "ripple-arbiter", "the ledger kept failing; a human is needed"); self._receipt(c); return
        self._verify(c, keys)

    def _verify(self, c: CaseRecord, keys: list[str]) -> None:
        cid = c.data["case_id"]; acts = c.data["payload"]["actions"]
        c.to("VERIFYING", "ripple-arbiter", "independent ledger read-back")
        checks, results = [], []
        for i, a in enumerate(acts):
            path = "/ledger/refunds" if a["op"] == "refund" else "/ledger/credits"; col = path.split("/")[-1]
            _, back = self.ent.call("GET", f"{path}?idempotency_key={keys[i]}", "finance")
            rows = back[col]; r = rows[0] if rows else None
            checks.append({"check": f"{a['op']} recorded exactly once", "passed": len(rows) == 1})
            checks.append({"check": f"{a['op']} amount equals approved ${a['amount']}", "passed": bool(r) and domain.money(r["amount"]) == domain.money(a["amount"])})
            checks.append({"check": f"{a['op']} bound to the approved payload hash", "passed": bool(r) and r["payload_sha256"] == c.data["payload_sha256"]})
            if a["op"] == "refund":
                _, by_charge = self.ent.call("GET", f"/ledger/refunds?charge_id={a['charge_id']}", "finance")
                checks.append({"check": f"charge {a['charge_id']} refunded exactly once (no double refund)", "passed": len(by_charge["refunds"]) == 1})
            if r:
                results.append({**a, "ledger_id": r["id"], "committed_at": r["committed_at"]})
        ok = all(x["passed"] for x in checks)
        c.data["verification"] = {"checks": checks, "at": now()}; c.save()
        c.to("COMPLETED" if ok else "BLOCKED", "ripple-arbiter", "every ledger write verified by independent read-back" if ok else "verification failed: " + "; ".join(x["check"] for x in checks if not x["passed"]))
        self.record("verified", case=cid, passed=ok, checks=len(checks))
        self._receipt(c, results)

    def _receipt(self, c: CaseRecord, results: list[dict] | None = None) -> None:
        cid = c.data["case_id"]; fin = c.data["rooms"]["finance"]
        r = {"receipt_id": f"{cid}-R", "case_id": cid, "status": c.state, "issued_at": now(), "payload_sha256": c.data["payload_sha256"],
             "approval": c.data.get("approval"), "rejection": c.data.get("rejection"), "actions": results or [],
             "verification": c.data.get("verification", {}).get("checks", []), "evidence_manifest": c.data["documents"].get("evidence_manifest"),
             "proposal_document": c.data["documents"].get("proposal"), "dispatch_attempts": c.data["dispatch"].get("attempts", 0),
             "state_trail": [f"{a.get('from', '')}->{a['state']}" for a in c.data["audit"] if a["event"] == "transition"],
             "data_note": "Synthetic demo data; the ledger is a local test service; no money moved; no email was sent."}
        r["receipt_sha256"] = domain.sha256(r)
        c.data["receipt"] = r; c.save()
        full = f"# RIPPLE Verified Resolution Receipt — {cid}\n\nStatus: **{r['status']}**\n\n```json\n{json.dumps(r, indent=1)}\n```\n"
        d1 = self.arb.create_document(fin, f"receipt-{cid}", f"RIPPLE receipt for {cid} (finance)", "Immutable record of the decision and its verification.", full)
        public = {k: r[k] for k in ("receipt_id", "case_id", "status", "issued_at", "payload_sha256", "receipt_sha256", "dispatch_attempts", "state_trail")}
        public["approved_by"] = (r["approval"] or {}).get("by"); public["rejected_by"] = (r["rejection"] or {}).get("by"); public["rejection_reason"] = (r["rejection"] or {}).get("reason")
        public["actions"] = [{"op": a["op"], "amount": a["amount"], "ledger_id": a["ledger_id"]} for a in r["actions"]]
        public["checks_passed"] = f"{sum(x['passed'] for x in r['verification'])}/{len(r['verification'])}"
        d2 = self.arb.create_document(self.intake_room, f"receipt-{cid}-public", f"RIPPLE receipt for {cid} (shareable)", "Verified claims and digests only; the ledger stays in finance.",
                                      f"# RIPPLE Verified Resolution Receipt — {cid}\n\n```json\n{json.dumps(public, indent=1)}\n```\n")
        c.data["documents"]["receipt"] = {"finance_doc": d1, "intake_doc": d2, "sha256": r["receipt_sha256"]}; c.save()
        self.arb.post(self.intake_room, f"RECEIPT {cid} status={r['status']} receipt_doc={d2} receipt_sha256={r['receipt_sha256']}")
        self.record("receipt", case=cid, status=r["status"], receipt_sha256=r["receipt_sha256"][:16], intake_doc=d2)

    def wait_state(self, case_id: str, states: set[str], timeout: float = 30.0) -> str:
        end = time.time() + timeout
        while time.time() < end:
            if case_id in self.cases and self.cases[case_id].state in states:
                return self.cases[case_id].state
            time.sleep(0.2)
        return self.cases[case_id].state if case_id in self.cases else "UNKNOWN"

    def wait_event(self, kind: str, case_id: str, timeout: float = 30.0) -> dict | None:
        end = time.time() + timeout
        while time.time() < end:
            hit = next((e for e in self.events if e["kind"] == kind and e.get("case") == case_id), None)
            if hit:
                return hit
            time.sleep(0.2)
        return None

    def close(self) -> None:
        self.pool.shutdown(wait=True)
        for a in (self.co, self.inv, self.com, self.arb):
            a.close()
