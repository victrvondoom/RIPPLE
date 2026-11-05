"""B4: nothing the coordinator can receive names a held-out family."""
import asyncio
import json
import re

from calhacks_contracts.families import holdout_families

from redteam import coordinator, holdout, mcp_server
from redteam.config import GATE_DIR

HELD = sorted(holdout_families())


def leaks(text: str) -> list[str]:
    patterns = [re.escape(f) for f in HELD] + [re.escape(f.replace("_", " ")) for f in HELD] + [r"\burgency\b"]
    return sorted({m.group(0) for p in patterns for m in re.finditer(p, text, re.I)})


def test_nothing_the_coordinator_sees_names_a_held_out_family(monkeypatch, repo, fake_client):
    from redteam import bitdeer
    monkeypatch.setenv("REDTEAM_ROUND", "1")
    monkeypatch.setattr(bitdeer, "make_client", lambda: fake_client())
    holdout.build(per_family=4, slice_n=1, client=fake_client(), r=repo)
    seen = []
    call = lambda fn, *a, **k: seen.append(mcp_server._jsonify(fn)(*a, **k))
    call(mcp_server.get_round_input)
    for fam in ("too_cheap", "payment_mismatch", "hidden_text"):
        call(mcp_server.generate_attacks, {"family": fam, "n": 20, "legit_ratio": 0.4})
    for fam in HELD:  # asking for one must not confirm it exists
        call(mcp_server.generate_attacks, {"family": fam, "n": 5})
    t = json.loads(mcp_server._jsonify(mcp_server.train_gate)())
    seen.append(json.dumps(t))
    call(mcp_server.promote_model, t.get("model_id", "x"))
    for fn in (mcp_server.score_round, mcp_server.inspect_failures, mcp_server.get_round_input):
        call(fn)
    call(mcp_server.eval_gate, t.get("model_id", "x"), "val")
    brief = coordinator.round_input_brief(1)
    seen += [brief, coordinator.round_prompt(1, True, 300, brief), coordinator.round_prompt(1, False, 300, brief)]
    tools = asyncio.run(mcp_server.build_server().list_tools())
    seen += [json.dumps([{"name": x.name, "description": x.description, "schema": x.inputSchema} for x in tools])]
    seen += [fn.__doc__ or "" for fn in mcp_server.TOOLS]
    seen.append((GATE_DIR / ".factory" / "droids" / "attack-strategist.md").read_text(encoding="utf-8"))
    echoes = seen[4:4 + len(HELD)]  # the error repeats the name the coordinator itself typed, like any typo
    where = {i: leaks(x) for i, x in enumerate(seen) if x not in echoes and leaks(x)}
    assert not where, f"held-out family names reach the coordinator: {where}"
    assert all("unknown family" in json.loads(s).get("error", "") for s in seen[4:4 + len(HELD)])


def test_leak_detector_catches_names():
    assert leaks("try lookalike_domain next") and leaks("an URGENCY pressure trick") and not leaks("too_cheap")
