"""The red team against the real Gate (gate/): train, evaluate, promote with holdout totals, restore feature code on
revert, the feature sandbox, stub leftovers, and one round over real stdio. In-memory database, fake Bitdeer client."""
import asyncio
import json
import os
import sys

import pytest
from calhacks_contracts import GateDecision, RoundInput, RoundMetrics

from redteam import gate_client, holdout, promotion, roundstate
from redteam.config import GATE_DIR, MODELS_DIR, REPO
from redteam.generate import run_spec

FEATURES = GATE_DIR / "features"
CONFIG = GATE_DIR / "train_config.yaml"
FAMILIES = ("too_cheap", "hidden_text", "payment_mismatch", "fake_reviews", "prompt_injection")


@pytest.fixture
def real(monkeypatch):
    """Real backend; gate/features and train_config.yaml are restored byte-for-byte afterwards."""
    monkeypatch.setattr(gate_client, "GATE_BACKEND", "real")
    saved = {p: p.read_bytes() for p in [*FEATURES.glob("*.py"), CONFIG]}
    yield
    for p in FEATURES.glob("*.py"):
        if p not in saved:
            p.unlink()
    for p, b in saved.items():
        p.write_bytes(b)


def seed(repo, fake_client, round_=1, n=40):
    for fam in FAMILIES:
        run_spec({"spec_id": f"S{round_}-{fam}", "family": fam, "n": n, "legit_ratio": 0.4, "mode": "mutate_real"},
                 round_=round_, r=repo, client=fake_client())


def test_train_evaluate_promote_with_holdout(repo, fake_client, real):
    seed(repo, fake_client)
    holdout.build(per_family=6, slice_n=2, client=fake_client(), r=repo)
    t = gate_client.train(1)
    assert "error" not in t, t
    assert "-stub-" not in t["model_id"] and (MODELS_DIR / f"{t['model_id']}.json").exists()
    RoundMetrics.model_validate(t["val"])

    ev = gate_client.evaluate(t["model_id"], split="val", rows=True)
    RoundMetrics.model_validate(ev["metrics"])
    assert ev["rows"] and all(GateDecision.model_validate(r["decision"]) for r in ev["rows"])
    assert {r["decision"]["model_version"] for r in ev["rows"]} == {t["model_id"]}

    p = promotion.promote(t["model_id"], holdout.totals)
    assert p["promoted"], p
    assert p["holdout_recorded"]
    state = json.loads((MODELS_DIR / "promoted.json").read_text())
    assert state["model_id"] == t["model_id"] and state["history"][-1]["round"] == 1
    assert set(state["history"][-1]["holdout"]) == {"model_id", "recall", "fpr", "layer2_fpr", "policy_bounded_recall"}

    ri = roundstate.build_round_input(2)
    RoundInput.model_validate(ri.model_dump())
    assert ri.current_model_id == t["model_id"] and ri.holdout_totals and ri.holdout_totals.recall.n > 0
    assert "price_ratio" in ri.feature_list


def test_refused_candidate_restores_promoted_feature_code(repo, fake_client, real):
    seed(repo, fake_client)
    a = gate_client.train(1)
    assert promotion.promote(a["model_id"])["promoted"]
    price = FEATURES / "price.py"
    original = price.read_text(encoding="utf-8")
    price.write_text(original + "\n# coordinator edit that does not help\n", encoding="utf-8")
    b = gate_client.train(2)
    assert "error" not in b and b["model_id"] != a["model_id"], b
    res = promotion.promote(b["model_id"])
    assert not res["promoted"] and res["decision"]["action"] == "revert"
    assert "coordinator edit" not in price.read_text(encoding="utf-8")
    assert json.loads((MODELS_DIR / "promoted.json").read_text())["model_id"] == a["model_id"]


def test_sandbox_blocks_training_and_holdout_scoring(repo, fake_client, real):
    seed(repo, fake_client)
    holdout.build(per_family=4, slice_n=1, client=fake_client(), r=repo)
    a = gate_client.train(1)
    assert promotion.promote(a["model_id"])["promoted"]
    marker = MODELS_DIR / "leaked.txt"
    leak = FEATURES / "zz_leak.py"
    leak.write_text(f"import pathlib\npathlib.Path({str(marker)!r}).write_text('x')\n", encoding="utf-8")
    assert "feature sandbox" in gate_client.train(2)["error"]
    with pytest.raises(RuntimeError, match="feature sandbox"):
        holdout.totals(a["model_id"], r=repo)
    assert not marker.exists()
    res = promotion.promote("r2-missing")
    assert not res["promoted"]


def test_leftover_stub_model_is_refused(repo, fake_client, real):
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    (MODELS_DIR / "promoted.json").write_text(json.dumps({"model_id": "r1-stub-abc123", "history": []}))
    assert "stub model" in gate_client.train(1)["error"]
    assert "stub model" in gate_client.evaluate("promoted", split="val")["error"]


def test_stdio_round_on_the_real_gate(repo, fake_client, real):
    pytest.importorskip("mcp")
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    holdout.build(per_family=4, slice_n=1, client=fake_client(), r=repo)
    env = {**os.environ, "REDTEAM_MONGOMOCK": "1", "REDTEAM_ROUND": "1", "REDTEAM_GATE": "real",
           "BITDEER_API_KEY": "", "PYTHONIOENCODING": "utf-8", "HOLDOUT_KEY": holdout.key_for_mcp_env()}

    async def go():
        params = StdioServerParameters(command=sys.executable, args=["-m", "redteam.mcp_server"], env=env, cwd=str(REPO))
        out = {}
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()

                async def call(name, args):
                    return json.loads((await s.call_tool(name, args)).content[0].text)
                for fam, n in (("too_cheap", 40), ("payment_mismatch", 40), ("hidden_text", 20)):
                    out[fam] = await call("generate_attacks", {"spec": {"family": fam, "n": n}})
                out["train"] = await call("train_gate", {})
                out["promote"] = await call("promote_model", {"model_id": out["train"]["model_id"]})
                out["score"] = await call("score_round", {})
                out["inspect"] = await call("inspect_failures", {})
                out["ri"] = await call("get_round_input", {})
        return out

    out = asyncio.run(go())
    assert all(out[f]["kept"] > 0 for f in ("too_cheap", "payment_mismatch", "hidden_text")), out
    assert "-stub-" not in out["train"]["model_id"], out["train"]
    assert out["promote"]["promoted"] and out["promote"]["holdout_recorded"], out["promote"]
    assert 0 <= out["score"]["attack_success"] <= 1
    assert isinstance(out["inspect"]["clusters"], list)
    assert out["ri"]["current_model_id"] == out["train"]["model_id"] and out["ri"]["holdout_totals"]
