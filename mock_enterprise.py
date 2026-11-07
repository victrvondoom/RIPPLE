"""LOCAL SYNTHETIC stand-in for Harborvine's company systems (ledger, incidents, mailbox, contracts).

Stdlib only. Every response carries "mock": true and the header X-Ripple-Mock: local-synthetic.
No money moves, no email is sent, no real system is contacted.

Department RBAC: the X-Department-Token header picks the department (tokens in mock_data/departments.json).
Idempotency: a write with a repeated Idempotency-Key returns the original record with deduplicated=true.
No double refund: a second refund of the same charge is refused with 409 already_refunded.
Lost response: POST ...?simulate=timeout commits the write, sleeps TIMEOUT_DELAY_S, then fails with 504,
so a caller that gave up early can read back and find the effect.

State is JSON in <state_dir>/state.json. Every operation reads and writes that file under one process-wide
lock, so a Store(state_dir, reset=True) created elsewhere is seen by a running server.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.join(ROOT, "mock_data")
TIMEOUT_DELAY_S = 3.0  # lost-response simulation: the commit happens first, then the reply is delayed and fails
LOCK = threading.RLock()

# path prefix -> departments allowed (first match wins); anything not listed is 404
ACCESS = [
    ("/ledger/", {"finance"}),
    ("/incidents", {"engineering"}),
    ("/mailbox/", {"support"}),
    ("/contracts/", {"finance", "engineering", "support"}),
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _by_key(rows: list[dict], key: str) -> dict | None:
    return next((r for r in rows if r.get("idempotency_key") == key), None)


def _filter(rows: list[dict], q: dict, keys: tuple[str, ...]) -> list[dict]:
    return [r for r in rows if all(r.get(k) == q[k] for k in keys if k in q)]


class Store:
    """JSON-file state. reset=True wipes state.json and rebuilds it from the fixtures in mock_data/."""

    def __init__(self, state_dir: str, reset: bool = False):
        self.dir = state_dir
        self.path = os.path.join(state_dir, "state.json")
        if reset or not os.path.exists(self.path):
            self.reset()

    def reset(self) -> None:
        with LOCK:
            os.makedirs(self.dir, exist_ok=True)
            if os.path.exists(self.path):
                os.remove(self.path)
            fx = {name: json.load(open(os.path.join(FIXTURE_DIR, name), encoding="utf-8"))
                  for name in ("contracts.json", "departments.json", "incident_logs.json", "ledger.json", "mailbox.json")}
            self._save({"contracts": fx["contracts.json"], "departments": fx["departments.json"],
                        "incident_logs": fx["incident_logs.json"], "ledger": fx["ledger.json"],
                        "mailbox": fx["mailbox.json"], "seq": 0})

    def _save(self, state: dict) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, self.path)

    def _load(self) -> dict:
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    def view(self, fn):
        with LOCK:
            return fn(self._load())

    def transact(self, fn):
        with LOCK:
            state = self._load()
            result = fn(state)  # if fn raises, nothing is written
            self._save(state)
            return result


# ---------- handlers: each takes the loaded state and returns (status, payload) ----------
def _get(s: dict, path: str, q: dict) -> tuple[int, dict]:
    if path == "/ledger/charges":
        return 200, {"charges": _filter(s["ledger"]["charges"], q, ("account",))}
    if path == "/ledger/refunds":
        return 200, {"refunds": _filter(s["ledger"]["refunds"], q, ("charge_id", "idempotency_key"))}
    if path == "/ledger/credits":
        return 200, {"credits": _filter(s["ledger"]["credits"], q, ("account", "idempotency_key"))}
    if path == "/incidents":
        return 200, {"incidents": _filter(s["incident_logs"]["incidents"], q, ("service",))}
    if path == "/mailbox/inbox":
        return 200, {"inbox": s["mailbox"]["inbox"]}
    if path == "/mailbox/sent":
        return 200, {"sent": s["mailbox"]["sent"]}
    if path == "/mailbox/outbox":
        return 200, {"outbox": _filter(s["mailbox"]["outbox"], q, ("idempotency_key",))}
    if path.startswith("/contracts/"):
        account = path.split("/", 2)[2]
        cust = next((c for c in s["contracts"]["customers"] if c["account"] == account), None)
        if cust is None:
            return 404, {"error": "unknown_account", "detail": f"no contract for account {account}"}
        return 200, {"company": s["contracts"]["company"], "customer": cust,
                     "policies": s["contracts"]["policies"], "approvers": s["contracts"]["approvers"]}
    return 404, {"error": "not_found", "detail": f"no GET route {path}"}


def _post_refund(s: dict, body: dict, key: str) -> tuple[int, dict]:
    refunds = s["ledger"]["refunds"]
    same = _by_key(refunds, key)
    if same:
        return 200, {"record": same, "deduplicated": True}
    charge = next((c for c in s["ledger"]["charges"] if c["id"] == body.get("charge_id")), None)
    if charge is None:
        return 404, {"error": "unknown_charge", "detail": f"no charge {body.get('charge_id')} in the ledger"}
    prior = [r for r in refunds if r["charge_id"] == charge["id"]]
    if prior:  # no double refund, whatever the idempotency key
        return 409, {"error": "already_refunded", "detail": f"charge {charge['id']} was already refunded as {prior[0]['id']}", "record": prior[0]}
    if not body.get("approval", {}).get("by"):
        return 422, {"error": "approval_required", "detail": "a refund needs an approval.by"}
    if body.get("account") != charge["account"] or Decimal(str(body.get("amount", "0"))) > Decimal(str(charge["amount"])):
        return 422, {"error": "invalid_refund", "detail": "account mismatch or amount above the charge"}
    s["seq"] += 1
    rec = {"id": f"rf_{s['seq']:04d}", "idempotency_key": key, "charge_id": charge["id"], "account": charge["account"],
           "amount": body["amount"], "currency": body.get("currency", charge["currency"]), "case_id": body.get("case_id"),
           "payload_sha256": body.get("payload_sha256"), "approved_by": body["approval"]["by"], "committed_at": _now(), "status": "committed"}
    refunds.append(rec)
    return 201, {"record": rec, "deduplicated": False}


def _post_credit(s: dict, body: dict, key: str) -> tuple[int, dict]:
    credits = s["ledger"]["credits"]
    same = _by_key(credits, key)
    if same:
        return 200, {"record": same, "deduplicated": True}
    if not body.get("approval", {}).get("by"):
        return 422, {"error": "approval_required", "detail": "a credit needs an approval.by"}
    s["seq"] += 1
    rec = {"id": f"cr_{s['seq']:04d}", "idempotency_key": key, "account": body.get("account"), "amount": body.get("amount"),
           "currency": body.get("currency"), "case_id": body.get("case_id"), "payload_sha256": body.get("payload_sha256"),
           "approved_by": body["approval"]["by"], "committed_at": _now(), "status": "committed"}
    credits.append(rec)
    return 201, {"record": rec, "deduplicated": False}


def _post_outbox(s: dict, body: dict, key: str) -> tuple[int, dict]:
    outbox = s["mailbox"]["outbox"]
    same = _by_key(outbox, key)
    if same:
        return 200, {"record": same, "deduplicated": True}
    if not all(body.get(k) for k in ("to", "subject", "body")):
        return 422, {"error": "invalid_message", "detail": "to, subject and body are required"}
    s["seq"] += 1
    rec = {"id": f"ob_{s['seq']:04d}", "idempotency_key": key, "to": body["to"], "subject": body["subject"], "body": body["body"],
           "case_id": body.get("case_id"), "delivery": "LOCAL OUTBOX ONLY: stored in a local file, not sent by email", "committed_at": _now()}
    outbox.append(rec)
    return 201, {"record": rec, "deduplicated": False}


WRITES = {"/ledger/refunds": _post_refund, "/ledger/credits": _post_credit, "/mailbox/outbox": _post_outbox}


def dispatch(store: Store, method: str, path: str, q: dict, body: dict, dept_token: str, key: str | None) -> tuple[int, dict]:
    dept = store.view(lambda s: s["departments"]["tokens"].get(dept_token))
    if dept is None:
        return 401, {"error": "unauthorized", "detail": "missing or unknown X-Department-Token"}
    for prefix, allowed in ACCESS:
        if path.startswith(prefix):
            if dept not in allowed:
                return 403, {"error": "forbidden", "detail": f"department '{dept}' may not access {path}"}
            break
    else:
        return 404, {"error": "not_found", "detail": f"no route {path}"}
    if method == "GET":
        return store.view(lambda s: _get(s, path, q))
    if method == "POST" and path in WRITES:
        if not key:
            return 400, {"error": "idempotency_key_required", "detail": "POST writes need an Idempotency-Key header"}
        return store.transact(lambda s: WRITES[path](s, body, key))
    return 404, {"error": "not_found", "detail": f"no {method} route {path}"}


# ---------- HTTP ----------
class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, store: Store):
        self.store = store
        super().__init__(addr, _Handler)

    def shutdown(self) -> None:
        super().shutdown()
        self.server_close()


class _Handler(BaseHTTPRequestHandler):
    server_version = "RippleMock/1.0"

    def log_message(self, *args) -> None:  # keep test and demo output quiet
        pass

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def _handle(self, method: str) -> None:
        url = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return self._send(400, {"error": "bad_json", "detail": "request body is not JSON"})
        status, payload = dispatch(self.server.store, method, url.path, q, body,
                                   self.headers.get("X-Department-Token", ""), self.headers.get("Idempotency-Key"))
        if method == "POST" and q.get("simulate") == "timeout" and status in (200, 201):
            time.sleep(TIMEOUT_DELAY_S)  # the effect is already committed; only the reply is lost
            status, payload = 504, {"error": "gateway_timeout", "detail": "simulated lost response: the write committed, the reply did not arrive"}
        self._send(status, payload)

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps({**payload, "mock": True, "system": "harborvine-local-mock"}).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Ripple-Mock", "local-synthetic")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client already gave up; for the lost-response case that is the point


def serve(port: int, state_dir: str, reset: bool = False) -> _Server:
    """Start the mock on 127.0.0.1:port in a background thread. Call .shutdown() to stop it."""
    srv = _Server(("127.0.0.1", port), Store(state_dir, reset=reset))
    threading.Thread(target=srv.serve_forever, name="mock-enterprise", daemon=True).start()
    return srv


if __name__ == "__main__":  # manual run: python mock_enterprise.py 8790 data/mock_enterprise
    import sys

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    state = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "data", "mock_enterprise")
    srv = serve(port, state, reset=True)
    print(f"LOCAL SYNTHETIC mock (no real systems, no real money, no email) on http://127.0.0.1:{port}")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        srv.shutdown()
