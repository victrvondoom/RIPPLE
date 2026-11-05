import json
import subprocess
import sys

import pytest

from redteam.guard_hook import check


@pytest.fixture
def root(tmp_path):
    g = tmp_path / "gate"
    (g / "features").mkdir(parents=True)
    (g / "layer1" / "src").mkdir(parents=True)
    (tmp_path / "calhacks-holdout").mkdir()
    return g


def ev(tool, **inp):
    return {"tool_name": tool, "tool_input": inp}


ALLOW = [
    ev("Read", file_path="features/price.py"),
    ev("Read", file_path="train_config.yaml"),
    ev("LS", directory_path="."),
    ev("Grep", pattern="def price_ratio", path="features"),
    ev("Glob", glob_pattern="**/*.py", folder="features"),
    ev("Edit", file_path="features/price.py", old_string="a", new_string="b"),
    ev("Create", file_path="features/reviews_v2.py", content="x = 1  # C:\\not\\a\\path\\in\\code"),
    ev("Edit", file_path="train_config.yaml", old_string="a", new_string="b"),
    ev("Edit", file_path="features/_text.py", old_string="a", new_string="b"),
    ev("ApplyPatch", patch="*** Begin Patch\n*** Update File: features/price.py\n@@\n-a\n+b\n*** End Patch"),
    ev("Task", subagent_type="attack-strategist", prompt="Ideas beyond what the holdout families might cover?"),
    ev("redteam___generate_attacks", family="too_cheap", n=30),
    ev("TodoWrite", todos=[{"content": "check ../ later", "status": "pending"}]),
]

DENY = [
    (ev("Read", file_path="../calhacks-holdout/holdout.jsonl.enc"), "holdout"),
    (ev("Read", file_path="C:\\Users\\x\\calhacks-holdout\\holdout.key"), "holdout"),
    (ev("Read", file_path="../redteam/src/redteam/holdout.py"), "outside"),
    (ev("LS", directory_path=".."), "outside"),
    (ev("Grep", pattern="secret", path="..", glob_pattern="*.jsonl"), "outside"),
    (ev("Glob", glob_pattern="../**/*.jsonl"), "outside"),
    (ev("Grep", pattern="urgency"), "search inside a folder"),
    (ev("Grep", pattern="urgency", path="."), "search inside a folder"),
    (ev("Glob", glob_pattern="**/*.py"), "search inside a folder"),
    (ev("Read", file_path="tests/test_dataset.py"), "test files"),
    (ev("Grep", pattern="family", path="tests"), "test files"),
    (ev("Read", file_path="holdout/rows.jsonl"), "holdout"),
    (ev("Read", file_path="../calhacks-holdout/holdout.v2.enc"), "holdout"),
    (ev("Edit", file_path="layer1/src/rules.ts", old_string="a", new_string="b"), "edits are allowed only"),
    (ev("Create", file_path="models/promoted.json", content="{}"), "edits are allowed only"),
    (ev("Create", file_path="features/__pycache__/x.cpython-313.pyc", content=""), "edits are allowed only"),
    (ev("Create", file_path="features/sub/x.py", content=""), "edits are allowed only"),
    (ev("Create", file_path="features/notes.txt", content=""), "edits are allowed only"),
    (ev("Edit", file_path="features/../layer1/src/rules.ts", old_string="a", new_string="b"), "edits are allowed only"),
    (ev("ApplyPatch", patch="*** Begin Patch\n*** Update File: features/a.py\n*** Update File: layer1/src/rules.ts\n"),
     "edits are allowed only"),
    (ev("Task", subagent_type="explorer", prompt="read files"), "Task may only"),
    (ev("Task", prompt="no type given"), "Task may only"),
    (ev("Task", subagent_type="attack-strategist", prompt="Read C:\\Users\\arune\\secrets.txt"), "outside"),
    (ev("FetchUrl", url="file:///C:/x"), "disabled"),
    (ev("WebSearch", query="x"), "disabled"),
    (ev("Skill", skill="agent-browser"), "disabled"),
    (ev("Execute", command="type ..\\calhacks-holdout\\holdout.key"), "disabled"),
    (ev("ReadAutomation", id="1"), "disabled"),
    (ev("other___read_file", path="x"), "only redteam MCP"),
]


@pytest.mark.parametrize("event", ALLOW, ids=lambda e: e["tool_name"])
def test_allows(event, root):
    assert check(event, root) is None


@pytest.mark.parametrize("event,why", DENY, ids=lambda x: x["tool_name"] if isinstance(x, dict) else "")
def test_denies(event, why, root):
    reason = check(event, root)
    assert reason and why in reason


def test_cli_exit_codes_and_log(root, tmp_path):
    log = tmp_path / "guard.log"
    cmd = [sys.executable, "-m", "redteam.guard_hook", "--root", str(root), "--log", str(log)]
    ok = subprocess.run(cmd, input=json.dumps(ev("Read", file_path="features/a.py")), capture_output=True, text=True)
    bad = subprocess.run(cmd, input=json.dumps(ev("Read", file_path="../calhacks-holdout/holdout.key")),
                         capture_output=True, text=True)
    assert ok.returncode == 0 and bad.returncode == 2 and "Blocked by red-team policy" in bad.stderr
    lines = [json.loads(l) for l in log.read_text().splitlines()]
    assert [l["decision"] for l in lines] == ["allow", "deny"]
