"""The local mock backend: department RBAC, idempotency, no double refund, lost-response timeout."""
import socket

import pytest

import mock_enterprise
from ripple_switch.agents import Enterprise


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


@pytest.fixture()
def ent(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_enterprise, "TIMEOUT_DELAY_S", 1.0)
    port = free_port(); srv = mock_enterprise.serve(port, str(tmp_path / "state"), reset=True)
    yield Enterprise(f"http://127.0.0.1:{port}")
    srv.shutdown()


BODY = {"charge_id": "ch_9921", "account": "ACME-2231", "amount": "4200.00", "currency": "USD", "case_id": "RPL-2026-0001", "payload_sha256": "h" * 64, "approval": {"by": "nora"}}


def test_department_rbac(ent):
    assert ent.call("GET", "/ledger/charges", "finance")[0] == 200
    st, body = ent.call("GET", "/ledger/charges", "engineering")
    assert st == 403 and "engineering" in body["detail"]
    assert ent.call("GET", "/incidents", "finance")[0] == 403
    assert ent.call("GET", "/incidents", "engineering")[0] == 200
    assert ent.call("GET", "/mailbox/inbox", "finance")[0] == 403


def test_refund_idempotent_and_never_twice(ent):
    st, r1 = ent.call("POST", "/ledger/refunds", "finance", BODY, key="k1")
    st2, r2 = ent.call("POST", "/ledger/refunds", "finance", BODY, key="k1")
    assert (st, st2) == (201, 200) and r2["deduplicated"] and r1["record"]["id"] == r2["record"]["id"]
    st3, r3 = ent.call("POST", "/ledger/refunds", "finance", BODY, key="other-key")
    assert st3 == 409 and r3["error"] == "already_refunded"
    assert len(ent.call("GET", "/ledger/refunds?charge_id=ch_9921", "finance")[1]["refunds"]) == 1


def test_simulated_timeout_commits_then_readback_finds_it(ent):
    with pytest.raises(TimeoutError):
        ent.call("POST", "/ledger/refunds?simulate=timeout", "finance", BODY, key="k-timeout", timeout=0.3)
    rows = ent.call("GET", "/ledger/refunds?idempotency_key=k-timeout", "finance")[1]["refunds"]
    assert len(rows) == 1 and rows[0]["amount"] == "4200.00"


def test_outbox_is_local_and_idempotent(ent):
    st, r = ent.call("POST", "/mailbox/outbox", "support", {"to": "a@b.c", "subject": "s", "body": "b"}, key="m1")
    assert st == 201 and r["record"]["delivery"].startswith("LOCAL OUTBOX ONLY")
    assert ent.call("POST", "/mailbox/outbox", "support", {"to": "a@b.c", "subject": "s", "body": "b"}, key="m1")[1]["deduplicated"]
