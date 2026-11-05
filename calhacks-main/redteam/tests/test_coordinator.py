"""Coordinator pieces that don't need a live droid: prompt from RoundInput, code-assembled RoundReport, MCP env."""
import json

import pytest
from calhacks_contracts import CoordinatorOutput, FailureCluster, FeatureChange, RoundReport

from redteam import coordinator, holdout, mcp_server, store


@pytest.fixture
def promoted_round(monkeypatch, repo, fake_client):
    monkeypatch.setenv("REDTEAM_ROUND", "1")
    from redteam import bitdeer
    monkeypatch.setattr(bitdeer, "make_client", lambda: fake_client())
    for fam in ("too_cheap", "payment_mismatch", "hidden_text"):
        mcp_server.generate_attacks({"family": fam, "n": 30, "legit_ratio": 0.4})
    t = mcp_server.train_gate()
    mcp_server.promote_model(t["model_id"])
    return repo, t["model_id"]


def test_prompt_carries_round_input_and_rules(promoted_round):
    _, model_id = promoted_round
    brief = coordinator.round_input_brief(1)
    ri = json.loads(brief)
    assert ri["current_model_id"] == model_id and ri["feature_list"]
    assert all(len(m["listing"]["item"]["text"]) <= 300 for m in ri["misses"])
    p = coordinator.round_prompt(1, allow_edits=False, max_listings=60, brief=brief)
    assert brief in p and "lookalike_domain" not in p and "urgency_pressure" not in p
    assert "CoordinatorOutput" in p and "Feature editing is disabled" in p
    assert "from gatepy.registry import feature" in coordinator.round_prompt(1, True, 60, brief)


def test_report_is_assembled_by_code(promoted_round):
    repo, model_id = promoted_round
    out = CoordinatorOutput(failures_by_cluster=[FailureCluster(cause="cheap but verified", family="too_cheap",
                                                                count=3, example_ids=["a"])],
                            feature_changes=[FeatureChange(feature="price_ratio", action="modify", rationale="x")],
                            train_params={"num_leaves": 15})
    repo.db.rounds.update_one({"_id": 1}, {"$set": {"generation": {"tokens": 1000, "usd": 0.01, "listings": 90}}})
    rep = coordinator.assemble_report(1, out, "sess-1", {"input_tokens": 2000, "output_tokens": 500},
                                      coordinator.COORDINATOR_MODEL)
    assert isinstance(rep, RoundReport)
    assert rep.decision.action == "promote" and rep.metrics.recall.n > 0
    assert rep.cost.tokens == 3500 and rep.cost.usd > 0.01
    assert rep.failures_by_cluster[0].family == "too_cheap"


def test_report_without_output_or_promotion(monkeypatch, repo):
    """A session that never asks for a promotion still gets a report (a revert), not a crash."""
    monkeypatch.setenv("REDTEAM_ROUND", "2")
    rep = coordinator.assemble_report(2, None, None, {}, coordinator.COORDINATOR_MODEL)
    assert rep.decision.action == "revert" and "no candidate" in rep.decision.reason
    assert rep.metrics.recall.n == 0


def test_holdout_key_only_reaches_the_mcp_server(monkeypatch, repo, fake_client):
    holdout.build(per_family=2, slice_n=1, client=fake_client(), r=repo)
    cfg = coordinator.mcp_server(1, 60)
    assert cfg.env["HOLDOUT_KEY"] == holdout.key_for_mcp_env()
    assert cfg.env["REDTEAM_MAX_LISTINGS"] == "60" and cfg.env["REDTEAM_ROUND"] == "1"


def test_attack_success_uses_the_start_model_once(promoted_round, monkeypatch):
    """Code records the round's attack success with the model promoted at the round's start, whatever the coordinator
    promoted (or scored) later in the round."""
    repo, start = promoted_round
    calls = []
    real = coordinator.gate_client.evaluate_as_trained
    monkeypatch.setattr(coordinator.gate_client, "evaluate_as_trained",
                        lambda m, **k: calls.append(m) or real(m, **k))
    out = coordinator.record_attack_success(1, start)
    assert calls == [start] and out["model_id"] == start
    a = out["attack_success"]
    assert a["lo"] <= a["value"] <= a["hi"] and out["n"] == a["n"] > 0
    assert store.get_round(repo, 1)["attack"]["attack_success"]["value"] == a["value"]
    # no start model (round 1 of a fresh run): recorded as unknown, not crashed
    assert coordinator.record_attack_success(1, None) is None
    assert store.get_round(repo, 1)["attack"]["attack_success"] is None


def test_a_resumed_round_keeps_its_original_start_model(promoted_round, monkeypatch):
    repo, first = promoted_round
    assert store.get_round(repo, 2) is None
    assert coordinator.start_model_for(2) == first          # first attempt records the incumbent
    monkeypatch.setattr(coordinator.promotion, "current", lambda: {"model_id": "r2-promoted-mid-round"})
    assert coordinator.start_model_for(2) == first          # the resumed attempt keeps it
    repo.db.rounds.update_one({"_id": 3}, {"$set": {"start_model": None}}, upsert=True)
    assert coordinator.start_model_for(3) is None           # "no model at the start" is kept too
