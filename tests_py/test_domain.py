"""Zero-LLM maths, the hash binding and the human-authority gate."""
import json
import os

from ripple_switch import domain

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load = lambda f: json.load(open(os.path.join(ROOT, "mock_data", f), encoding="utf-8"))  # noqa: E731
CONTRACT = load("contracts.json")
SLA = CONTRACT["customers"][0]["sla"]


def test_duplicate_capture_found_and_original_kept():
    d = domain.duplicates(load("ledger.json")["charges"])
    assert [(x["original"]["id"], x["duplicate"]["id"]) for x in d] == [("ch_9918", "ch_9921")]


def test_uptime_from_5_minute_intervals_and_sla_tiers():
    ev = domain.incident_evidence(load("incident_logs.json")["incidents"][0], SLA, "2026-11")
    assert ev["intervals_total_in_month"] == 8640 and ev["intervals_unavailable"] == 76 and ev["monthly_uptime_pct"] == "99.120"
    assert domain.sla_credit(ev["monthly_uptime_pct"], SLA, 12000)["amount"] == "1200.00"           # below 99.9 -> 10%
    assert domain.sla_credit("98.500", SLA, 12000)["amount"] == "3000.00"                            # below 99.0 -> 25%
    assert domain.sla_credit("94.000", SLA, 12000)["amount"] == "12000.00"                           # below 95.0 -> 100%
    assert domain.sla_credit("99.950", SLA, 12000)["amount"] == "0.00"                               # SLA met
    assert domain.sla_credit("99.800", SLA, 5)["amount"] == "0.00"                                   # 0.50 is under the 1 USD minimum


def test_payload_hash_changes_with_any_parameter():
    dup = domain.duplicates(load("ledger.json")["charges"])[0]
    credit = domain.sla_credit("99.120", SLA, 12000)
    p1 = domain.refund_payload("RPL-2026-0001", "ACME-2231", dup, credit)
    p2 = json.loads(json.dumps(p1)); p2["actions"][0]["amount"] = "4200.01"
    assert domain.sha256(p1) != domain.sha256(p2) and len(domain.sha256(p1)) == 64
    assert domain.sha256(p1) == domain.sha256(json.loads(json.dumps(p1)))   # canonical: key order does not matter


def test_command_parsing():
    h = "a" * 64
    assert domain.parse_command(f"APPROVE RPL-2026-0001 {h}") == {"verb": "APPROVE", "case_id": "RPL-2026-0001", "payload_sha256": h}
    assert domain.parse_command(f"@ripple-arbiter APPROVE RPL-2026-0001 {h.upper()}")["payload_sha256"] == h
    assert domain.parse_command("APPROVE RPL-2026-0001 looks good")["verb"] == "INVALID"
    assert domain.parse_command("REJECT RPL-2026-0001 credit too high") == {"verb": "REJECT", "case_id": "RPL-2026-0001", "reason": "credit too high"}
    assert domain.parse_command("!simulate-timeout") == {"verb": "SIMULATE_TIMEOUT"}
    assert domain.parse_command("please approve it") is None


def test_authority_gate_uses_server_identity_not_text():
    parts = [{"name": "ripple-arbiter", "type": "agent"}, {"name": "nora", "type": "user"}, {"name": "sofia", "type": "user"}]
    ok, _ = domain.authorize("@mm_nora:localhost", "nora", None, parts, ["nora"])
    assert ok
    assert domain.authorize("@switch-agent-1e81aa50:localhost", "nora", None, parts, ["nora"])[0] is False     # an agent claiming to be nora
    assert domain.authorize("@switch-agent-x:localhost", "ripple-arbiter", None, parts, ["nora"])[0] is False
    assert domain.authorize("@mm_sofia:localhost", "sofia", None, parts, ["nora"])[0] is False                 # human, not a finance approver
    assert domain.authorize("@mm_nora:localhost", "nora", None, [], ["nora"])[0] is False                      # not a member of the room
    assert domain.authorize("@platform:localhost", "nora", "platform", [], ["nora"])[0] is True                # platform client on nora's behalf


def test_intake_reuses_resolve_and_redeem():
    mb = load("mailbox.json")
    it = domain.intake(mb["inbox"][0], mb["sent"], CONTRACT["company"])
    assert it["claimed_amount"] == "4200.00"
    assert it["requests"][0]["evidence_text"] == "Please refund the duplicate charge by Friday."
    assert it["our_promises"][0]["overdue"] is True                       # "by 9 pm today" passed before the customer wrote
    assert it["safety"]["decision"] == "ALLOW"
    bad = dict(mb["inbox"][0], body="Your bank caller is asking me to share the OTP, please send it.")
    assert domain.intake(bad, [], CONTRACT["company"])["safety"]["decision"] in ("CLARIFY", "REFUSE")
