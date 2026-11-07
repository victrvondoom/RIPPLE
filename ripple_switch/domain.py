"""Deterministic RIPPLE domain logic. ZERO LLM: every number here is computed from recorded data.

Reuses the original capabilities verbatim (ripple_switch/vendor):
  RESOLVE  inbox_intel.extract_commitments  -> the promise we already made to the customer, and its deadline
  RECLAIM  citation_verification.verify_claim -> every policy statement shown to anyone must appear in the cited clause
  REDEEM   safety.evaluate_intent / scan      -> refuse credential / money-transfer requests; scam indicators
"""
from __future__ import annotations

import calendar
import hashlib
import json
import re
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal

from .vendor import reclaim_citation, redeem_safety, resolve_inbox_intel


def ts(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def money(x) -> Decimal:
    return Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(obj) -> str:
    return hashlib.sha256((obj if isinstance(obj, str) else canonical(obj)).encode()).hexdigest()


# ---------- RESOLVE + REDEEM: intake ----------
def intake(email: dict, sent: list[dict], company: dict) -> dict:
    """What the customer asks, what we promised before, safety checks. Deterministic; quotes exact sentences."""
    off = int(company.get("utc_offset_hours", 0))  # fixed offset: works without the tzdata package
    msg = {"id": email["id"], "sender": email["from"], "to": email["to"], "body": email["body"], "sent_at": ts(email["sent_at"])}
    requests = [c for c in resolve_inbox_intel.extract_commitments([msg], company["support_address"], off) if c["kind"] == "REQUEST_TO_USER"]
    ours = [{"id": s["id"], "sender": s["from"], "to": s["to"], "body": s["body"], "sent_at": ts(s["sent_at"])} for s in sent]
    promises = [c for c in resolve_inbox_intel.extract_commitments(ours, company["support_address"], off) if c["kind"] == "PROMISE_BY_USER"]
    received_at = ts(email["sent_at"])
    for p in promises:
        p["overdue"] = bool(p["deadline_at"] and p["deadline_at"] < received_at)
    claimed = re.search(r"\$\s?([\d,]+(?:\.\d{1,2})?)", email["body"])
    return {
        "requests": requests, "our_promises": promises,
        "claimed_amount": str(money(claimed.group(1).replace(",", ""))) if claimed else None,
        "safety": redeem_safety.evaluate_intent(email["body"]).as_dict(),
        "scam": redeem_safety.scan(email["body"]),
        "injection": bool(resolve_inbox_intel.INJECTION_RE.search(email["body"])),
    }


# ---------- RECLAIM: incident evidence + SLA ----------
def incident_evidence(incident: dict, sla: dict, month: str) -> dict:
    """Monthly uptime per the contract: share of 5-minute intervals with error rate >= threshold, over the whole month."""
    y, m = (int(x) for x in month.split("-"))
    total = calendar.monthrange(y, m)[1] * 24 * 12
    thr = float(sla["unavailable_if_error_rate_pct_at_least"])
    bad = [i for i in incident["intervals_5min"] if i["start"].startswith(month) and float(i["error_rate_pct"]) >= thr]
    uptime = (Decimal(1) - Decimal(len(bad)) / Decimal(total)) * 100
    return {"incident_id": incident["id"], "service": incident["service"], "datacenter": incident["datacenter"], "hosts": incident["hosts"],
            "start": incident["start"], "end": incident["end"], "root_cause": incident["root_cause"], "defect": incident["defect"],
            "intervals_total_in_month": total, "intervals_unavailable": len(bad), "threshold_pct": thr,
            "peak_error_rate_pct": max(float(i["error_rate_pct"]) for i in incident["intervals_5min"]),
            "monthly_uptime_pct": str(uptime.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP))}


def sla_credit(uptime_pct: str, sla: dict, monthly_fee) -> dict:
    u = Decimal(uptime_pct)
    tier = next((t for t in sorted(sla["tiers"], key=lambda t: t["below_pct"]) if u < Decimal(str(t["below_pct"]))), None)
    pct = Decimal(str(tier["credit_pct"])) if tier else Decimal(0)
    amount = min(money(Decimal(str(monthly_fee)) * pct / 100), money(Decimal(str(monthly_fee)) * Decimal(str(sla["cap_pct"])) / 100))
    if amount < money(sla.get("min_payout", 0)):
        amount = money(0)
    return {"clause": sla["clause"], "uptime_pct": uptime_pct, "target_pct": sla["target_pct"], "tier_below_pct": tier and tier["below_pct"], "credit_pct": str(pct), "amount": str(amount)}


def duplicates(charges: list[dict]) -> list[dict]:
    by: dict[str, list[dict]] = {}
    for c in charges:
        by.setdefault(c["invoice"], []).append(c)
    out = []
    for inv, group in by.items():
        g = sorted(group, key=lambda c: ts(c["captured_at"]))
        out += [{"invoice": inv, "original": g[0], "duplicate": d} for d in g[1:]]
    return out


def grounded(statement: str, clause_text: str) -> bool:
    return reclaim_citation.verify_claim(statement, clause_text)


# ---------- the proposal a human approves (hash-bound) ----------
def refund_payload(case_id: str, account: str, dup: dict, credit: dict) -> dict:
    """Exactly what will be executed. Its SHA-256 is what the approver must quote; any change => a different hash."""
    actions = [{"op": "refund", "charge_id": dup["duplicate"]["id"], "invoice": dup["invoice"], "amount": str(money(dup["duplicate"]["amount"])), "currency": dup["duplicate"]["currency"], "policy": "BILL-7.1"}]
    if Decimal(credit["amount"]) > 0:
        actions.append({"op": "credit", "account": account, "amount": credit["amount"], "currency": dup["duplicate"]["currency"], "policy": credit["clause"]})
    return {"case_id": case_id, "account": account, "actions": actions}


# ---------- human command parsing + authority (never trusts message text for identity) ----------
CMD = re.compile(r"^\s*(APPROVE|REJECT)\s+(RPL-\d{4}-\d{4})\s+(.+?)\s*$", re.S)
HASH = re.compile(r"^[0-9a-f]{64}$")


def parse_command(body: str) -> dict | None:
    text = re.sub(r"^(@[\w.\-]+\s+)+", "", body.strip())   # tolerate a leading @mention
    if text.strip().lower() == "!simulate-timeout":
        return {"verb": "SIMULATE_TIMEOUT"}
    m = CMD.match(text)
    if not m:
        return None
    verb, case, rest = m.group(1), m.group(2), m.group(3).strip()
    if verb == "APPROVE":
        return {"verb": verb, "case_id": case, "payload_sha256": rest.lower()} if HASH.match(rest.lower()) else {"verb": "INVALID", "reason": "APPROVE needs the 64-hex payload SHA-256"}
    return {"verb": verb, "case_id": case, "reason": rest}


def authorize(sender: str, sender_name: str, sender_kind: str | None, participants: list[dict], approvers: list[str]) -> tuple[bool, str]:
    """Fail-closed. `sender`/`sender_kind` are set by the Switch server for the event, not by the message text.
    Agents (identity @switch-agent-...) can never approve; a human must be an allow-listed approver who is a USER
    participant of the finance room (or a platform client posting on that person's behalf)."""
    agent_names = {p["name"] for p in participants if p.get("type") == "agent"}
    if sender.startswith("@switch-agent-") or sender_name in agent_names:
        return False, f"sender {sender_name or sender} is an agent; agents cannot approve payouts"
    user_names = {p["name"] for p in participants if p.get("type") == "user"}
    if sender_name not in approvers:
        return False, f"{sender_name or sender} is not an authorised finance approver ({', '.join(approvers)})"
    if sender_kind != "platform" and sender_name not in user_names:
        return False, f"{sender_name} is not a human member of this room"
    return True, f"{sender_name} is an authorised human approver (sender {sender})"
