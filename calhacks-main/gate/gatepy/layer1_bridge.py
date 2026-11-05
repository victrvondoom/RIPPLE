"""Run the TypeScript Layer 1 rules (the single source of truth) over GateInputs via gate-l1.

run_layer1 starts one Node process per batch (training and evaluation). The purchase-time service keeps one
long-lived process instead (Layer1Process), since gate-l1 answers each input line as soon as it reads it.
"""
import json
import os
import shutil
import subprocess
import threading

from calhacks_contracts import Check, GateInput

from gatepy import CONTRACTS, LAYER1_CLI


def _node() -> str:
    node = os.environ.get("NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node not found; Layer 1 needs Node 22+ (set NODE to override)")
    return node


def _checks(results: list[dict], inputs: list[GateInput]) -> list[list[Check]]:
    if [r["listing_id"] for r in results] != [x.listing.listing_id for x in inputs]:
        raise RuntimeError("gate-l1 output does not line up with its input")
    return [[Check.model_validate(c) for c in r["checks"]] for r in results]


class Layer1Process:
    """One long-lived gate-l1 process: a line in, a line out. Thread-safe; restarts once if the process died."""

    def __init__(self):
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None

    def _start(self) -> subprocess.Popen:
        return subprocess.Popen([_node(), str(LAYER1_CLI), "--contracts", str(CONTRACTS)], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
                                bufsize=1)

    def _ask(self, inputs: list[GateInput]) -> list[dict]:
        if self._proc is None or self._proc.poll() is not None:
            self._proc = self._start()
        out = []
        for x in inputs:  # one at a time: writing a batch before reading can fill both pipes and deadlock
            self._proc.stdin.write(x.model_dump_json() + "\n")
            self._proc.stdin.flush()
            out.append(self._proc.stdout.readline())
        if not all(line.strip() for line in out):
            raise RuntimeError("gate-l1 stopped answering")
        return [json.loads(line) for line in out]

    def run(self, inputs: list[GateInput]) -> list[list[Check]]:
        if not inputs:
            return []
        with self._lock:
            try:
                results = self._ask(inputs)
            except (OSError, RuntimeError, ValueError):
                self.close()
                results = self._ask(inputs)  # one restart, then let the caller fail closed
        return _checks(results, inputs)

    def close(self) -> None:
        if self._proc is not None:
            try:
                self._proc.kill()
            except OSError:
                pass
            self._proc = None


def run_layer1(inputs: list[GateInput]) -> list[list[Check]]:
    """The Layer 1 checks for each input, same order."""
    if not inputs:
        return []
    proc = subprocess.run(
        [_node(), str(LAYER1_CLI), "--contracts", str(CONTRACTS)],
        input="".join(x.model_dump_json() + "\n" for x in inputs),
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"gate-l1 failed ({proc.returncode}): {proc.stderr.strip()[:500]}")
    return _checks([json.loads(line) for line in proc.stdout.splitlines() if line.strip()], inputs)


def passed(checks: list[Check]) -> bool:
    return all(c.passed for c in checks)


def failed_rule(checks: list[Check]) -> str | None:
    return next((c.rule for c in checks if not c.passed), None)
