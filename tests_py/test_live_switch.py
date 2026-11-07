"""Scenarios A-D against the REAL local Switch server (skipped when it is not running or agents are not registered)."""
import os
import sys
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _switch_up() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:52042/health", timeout=3) as r:
            return r.status == 200 and os.path.exists(os.path.join(ROOT, "data", "switch-agents.local.json"))
    except Exception:
        return False


@pytest.mark.skipif(not _switch_up(), reason="local Switch server not running or RIPPLE agents not registered")
def test_all_scenarios_live(monkeypatch):
    import run_demo
    monkeypatch.setattr(sys, "argv", ["run_demo.py", "--all"])
    assert run_demo.main() == 0
