import json

import pytest

from ripple_switch.state_machine import CaseRecord, TransitionError


def rec(tmp_path):
    return CaseRecord(str(tmp_path / "RPL-2026-0001.json"), "RPL-2026-0001")


def test_happy_path_and_persistence(tmp_path):
    c = rec(tmp_path)
    c.propose({"a": 1}, "h1", "arbiter")
    for s in ("APPROVED", "DISPATCHING", "VERIFYING", "COMPLETED"):
        c.to(s, "t", "step")
    again = CaseRecord(c.path, "RPL-2026-0001")
    assert again.state == "COMPLETED"
    assert [a["state"] for a in again.data["audit"] if a["event"] == "transition"] == ["AWAITING_APPROVAL", "APPROVED", "DISPATCHING", "VERIFYING", "COMPLETED"]


def test_illegal_transitions_refused(tmp_path):
    c = rec(tmp_path)
    with pytest.raises(TransitionError):
        c.to("DISPATCHING", "t", "skip approval")
    c.propose({"a": 1}, "h1", "arbiter"); c.to("REJECTED", "nora", "no")
    with pytest.raises(TransitionError):
        c.to("APPROVED", "t", "after rejection")


def test_uncertain_requires_readback_paths(tmp_path):
    c = rec(tmp_path); c.propose({"a": 1}, "h1", "arbiter"); c.to("APPROVED", "n", "ok"); c.to("DISPATCHING", "a", "go"); c.to("UNCERTAIN", "a", "timeout")
    with pytest.raises(TransitionError):
        c.to("DISPATCHING", "a", "blind retry")         # never repeat a write before a read-back
    c.to("RETRYABLE", "a", "read-back: absent"); c.to("DISPATCHING", "a", "retry same key")


def test_changed_payload_voids_pending_approval_and_blocks_after_approval(tmp_path):
    c = rec(tmp_path); c.propose({"a": 1}, "h1", "arbiter")
    assert c.propose({"a": 2}, "h2", "arbiter") is True and c.state == "AWAITING_APPROVAL" and c.data["payload_sha256"] == "h2"
    c.to("APPROVED", "nora", "ok h2")
    assert c.propose({"a": 3}, "h3", "arbiter") is True and c.state == "BLOCKED"
    assert json.load(open(c.path))["state"] == "BLOCKED"
