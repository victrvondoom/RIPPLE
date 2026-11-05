"""MCP tools on the issue #1 schemas: in-process round flow, and one run over real stdio like droid drives it."""
import time
import asyncio
import json
import os
import sys

import pytest
from calhacks_contracts import RoundInput

from redteam import holdout, mcp_server
from redteam.config import REPO


@pytest.fixture
def round1(monkeypatch, repo):
    monkeypatch.setenv("REDTEAM_ROUND", "1")
    monkeypatch.setenv("REDTEAM_MAX_LISTINGS", "200")
    return repo


def test_round_flow_in_process(round1, fake_client, monkeypatch):
    from redteam import bitdeer
    monkeypatch.setattr(bitdeer, "make_client", lambda: fake_client())
    held = mcp_server.generate_attacks({"family": "lookalike_domain", "n": 5})
    assert held["error"] == "unknown family 'lookalike_domain'"
    bad = mcp_server.generate_attacks({"family": "too_cheap"})
    assert "invalid AttackSpec" in bad["error"]
    for fam in ("too_cheap", "payment_mismatch", "prompt_injection"):
        g = mcp_server.generate_attacks({"family": fam, "n": 20, "legit_ratio": 0.4})
        assert g["kept"] > 12, g
    assert mcp_server.generate_attacks({"family": "too_cheap", "n": 150})["error"].startswith("round 1 listing cap")
    assert "holdout" in mcp_server.eval_gate("x", "holdout")["error"]
    assert "no promoted model" in mcp_server.score_round()["error"]

    holdout.build(per_family=6, slice_n=2, client=fake_client(), r=round1)
    t = mcp_server.train_gate()
    p = mcp_server.promote_model(t["model_id"])
    assert p["promoted"] and p["holdout_recorded"] and "holdout" not in json.dumps(p.get("candidate_val"))

    ri = RoundInput.model_validate({k: v for k, v in mcp_server.get_round_input().items() if k != "_help"})
    assert ri.current_model_id == t["model_id"] and ri.holdout_totals and ri.feature_list
    assert ri.coverage["too_cheap"] > 0 and "lookalike_domain" not in ri.coverage

    s = mcp_server.score_round()
    assert 0 <= s["attack_success"] <= 1 and s["metrics"]["recall"]["n"] > 0
    insp = mcp_server.inspect_failures()
    assert insp["model_id"] == t["model_id"] and isinstance(insp["clusters"], list)
    for c in insp["clusters"]:
        for ex in c["examples"]:
            assert set(ex["listing"]) == {"listing_id", "seller", "item", "reviews", "checkout"}

    wb = mcp_server.generate_attacks({"family": "hidden_text", "n": 10, "attacker_knowledge": "white_box"})
    assert wb["kept"] > 0
    again = mcp_server.promote_model(t["model_id"])
    assert not again["promoted"] and "does not beat" in again["decision"]["reason"]
    doc = round1.db.rounds.find_one({"_id": 1})
    assert doc["generation"]["listings"] > 0 and len(doc["promotions"]) == 2
    assert round1.db.specs.count_documents({"round": 1}) >= 4


def test_null_spec_fields_mean_defaults(round1):
    g = mcp_server.generate_attacks({"family": "payment_mismatch", "n": 5, "base_listing_ids": None,
                                     "target_weakness": None, "model": None, "mode": "mutate_real"})
    assert g.get("kept", 0) > 0, g


def test_stdio_server(tmp_path, repo, fake_client):
    pytest.importorskip("mcp")
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    holdout.build(per_family=4, slice_n=1, client=fake_client(), r=repo)
    env = {**os.environ, "REDTEAM_MONGOMOCK": "1", "REDTEAM_ROUND": "1", "BITDEER_API_KEY": "",
           "PYTHONIOENCODING": "utf-8"}

    async def go():
        params = StdioServerParameters(command=sys.executable, args=["-m", "redteam.mcp_server"], env=env, cwd=str(REPO))
        out = []
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                out.append(sorted(t.name for t in (await s.list_tools()).tools))
                for name, args in [("generate_attacks", {"spec": {"family": "urgency_pressure", "n": 4}}),
                                   ("generate_attacks", {"spec": {"family": "too_cheap", "n": 40}}),
                                   ("generate_attacks", {"spec": {"family": "payment_mismatch", "n": 40}}),
                                   ("train_gate", {}), ("get_round_input", {})]:
                    res = await s.call_tool(name, args)
                    out.append(json.loads(res.content[0].text))
                t = out[-2]
                res = await s.call_tool("promote_model", {"model_id": t["model_id"]})
                out.append(json.loads(res.content[0].text))
        return out

    tools, held, gen, gen2, train, ri, promo = asyncio.run(go())
    assert {"get_round_input", "generate_attacks", "promote_model", "eval_gate"} <= set(tools)
    assert held["error"] == "unknown family 'urgency_pressure'"
    assert gen["kept"] > 0 and gen["drops_by_family"].get("legit_mixed_reviews", 0) >= 0
    assert train["model_id"].startswith("r1-stub"), train
    assert ri["round"] == 1 and "attack_families" in ri["_help"]
    assert promo["promoted"] and promo["holdout_recorded"]


def test_generate_calls_are_capped_to_stay_under_the_mcp_timeout(round1):
    big = mcp_server.generate_attacks({"family": "too_cheap", "n": mcp_server.MAX_CALL_LISTINGS + 1})
    assert "split it" in big["error"]
    wordy = mcp_server.generate_attacks({"family": "prompt_injection", "n": mcp_server.MAX_CALL_LLM + 5,
                                         "legit_ratio": 0})
    assert "text rewrites" in wordy["error"]


def test_a_second_generate_call_while_one_runs_is_refused_at_once(round1):
    assert mcp_server._GEN_LOCK.acquire(blocking=False)  # stands in for a call already running
    try:
        t0 = time.monotonic()
        busy = mcp_server.generate_attacks({"family": "too_cheap", "n": 4})
        assert "one at a time" in busy["error"] and time.monotonic() - t0 < 1
    finally:
        mcp_server._GEN_LOCK.release()
    assert "error" not in mcp_server.generate_attacks({"family": "too_cheap", "n": 4})


def test_generate_calls_carry_a_time_budget_under_the_droid_limit(round1, monkeypatch):
    seen = {}
    real = mcp_server.run_spec

    def spy(*a, **kw):
        seen.update(kw)
        return real(*a, **kw)
    monkeypatch.setattr(mcp_server, "run_spec", spy)
    mcp_server.generate_attacks({"family": "too_cheap", "n": 4})
    assert 0 < seen["time_budget"] <= 150
