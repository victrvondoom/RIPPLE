"""Deterministic action state machine for one case's payout, persisted as JSON with an append-only audit trail.

  PLANNED -> AWAITING_APPROVAL -> APPROVED -> DISPATCHING -> VERIFYING -> COMPLETED
  failure branches: RETRYABLE (safe to retry), UNCERTAIN (outcome unknown: read back before anything else),
                    REJECTED (human said no; terminal), BLOCKED (policy or verification stop; needs a human)
An approval is bound to the payload SHA-256 that was shown; if the payload changes, the approval is void.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone

TRANSITIONS: dict[str, set[str]] = {
    "PLANNED": {"AWAITING_APPROVAL", "BLOCKED"},
    "AWAITING_APPROVAL": {"APPROVED", "REJECTED", "BLOCKED", "PLANNED"},
    "APPROVED": {"DISPATCHING", "BLOCKED"},
    "DISPATCHING": {"VERIFYING", "UNCERTAIN", "RETRYABLE", "BLOCKED"},
    "UNCERTAIN": {"VERIFYING", "RETRYABLE", "BLOCKED"},
    "RETRYABLE": {"DISPATCHING", "BLOCKED"},
    "VERIFYING": {"COMPLETED", "BLOCKED"},
    "COMPLETED": set(), "REJECTED": set(), "BLOCKED": set(),
}
TERMINAL = {"COMPLETED", "REJECTED", "BLOCKED"}


class TransitionError(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class CaseRecord:
    def __init__(self, path: str, case_id: str):
        self.path, self.lock = path, threading.RLock()
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f)
        else:
            self.data = {"case_id": case_id, "state": "PLANNED", "payload": None, "payload_sha256": None, "approval": None, "rejection": None,
                         "dispatch": {"attempts": 0, "idempotency_key": None}, "rooms": {}, "documents": {}, "evidence": {}, "audit": []}
            self.log("created", "PLANNED", "system", "case opened")

    @property
    def state(self) -> str:
        return self.data["state"]

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=1)
        os.replace(tmp, self.path)

    def log(self, event: str, to: str, actor: str, reason: str, **extra) -> None:
        self.data["audit"].append({"at": _now(), "event": event, "state": to, "actor": actor, "reason": reason, **extra})
        self.save()

    def to(self, new: str, actor: str, reason: str, **extra) -> None:
        with self.lock:
            cur = self.data["state"]
            if new not in TRANSITIONS[cur]:
                raise TransitionError(f"{self.data['case_id']}: {cur} -> {new} is not allowed")
            self.data["state"] = new
            self.log("transition", new, actor, reason, **{"from": cur, **extra})

    def propose(self, payload: dict, payload_sha256: str, actor: str) -> bool:
        """Set the payload awaiting approval. A different hash voids any earlier approval request (returns True if voided).
        Once APPROVED, a changed payload is refused outright: the approval covered the old hash only."""
        with self.lock:
            invalidated = False
            if self.data["payload_sha256"] and self.data["payload_sha256"] != payload_sha256:
                if self.state == "APPROVED":
                    self.to("BLOCKED", actor, f"payload changed after approval ({self.data['payload_sha256'][:12]} -> {payload_sha256[:12]}); the approval covers the old hash only")
                    return True
                if self.state == "AWAITING_APPROVAL":
                    self.to("PLANNED", actor, f"payload changed ({self.data['payload_sha256'][:12]} -> {payload_sha256[:12]}); approval request voided")
                    invalidated = True
            self.data["payload"], self.data["payload_sha256"], self.data["approval"] = payload, payload_sha256, None
            self.save()
            if self.state == "PLANNED":
                self.to("AWAITING_APPROVAL", actor, f"payload {payload_sha256[:12]} awaiting human approval")
            return invalidated
