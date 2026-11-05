import json

import numpy as np
import pytest
from calhacks_contracts import AnswerKey, Case, Listing, RoundMetrics

from gatepy import GATE_DIR
from gatepy.dataset import GateInputError, featurize, load_examples
from gatepy.evaluate import evaluate, evaluate_examples
from gatepy.evaluate import main as eval_main
from gatepy.model_io import load
from gatepy.registry import feature, select
from gatepy.selftest import fixture_inputs, fixture_refs
from gatepy.train import main as train_main
from gatepy.train import pick_threshold, train

from conftest import fresh_repo
from expand import seed


def test_lightgbm_trains_and_meets_fpr_rule(trained):
    assert trained["model_id"].startswith("r1-") and trained["kind"] == "lightgbm"
    val = RoundMetrics.model_validate(trained["val"])
    assert val.fpr.value <= 0.1
    assert val.recall.value >= 0.7
    assert val.layer1_catches > 0
    assert val.adaptive_recall is not None
    assert 0 < trained["threshold"] <= 1


def test_r0_baseline_trains(baseline):
    assert baseline["model_id"].startswith("r0-") and baseline["kind"] == "logreg"
    assert baseline["features"] == ["price_ratio", "known_wallet", "injection_hits_text"]
    RoundMetrics.model_validate(baseline["val"])


def test_model_id_is_deterministic(trained, repo, tmp_path):
    again = train(1, GATE_DIR / "train_config.yaml", out=tmp_path, repo=repo)
    assert again["model_id"] == trained["model_id"]


def test_model_file_records_provenance(trained, models_dir):
    meta = load(trained["model_id"], models_dir).meta
    for key in ("model_id", "round", "kind", "features", "monotone", "threshold", "booster", "coef",
                "train_data_hash", "feature_code_hash", "created_at", "as_of", "val_metrics", "feature_sources"):
        assert key in meta
    assert len(meta["monotone"]) == len(meta["features"])
    assert "price.py" in meta["feature_sources"]


def test_eval_rows_carry_gate_decisions(trained, models_dir, repo):
    model = load(trained["model_id"], models_dir)
    out = evaluate_examples(model, load_examples(repo), repo.reference_snapshot(), with_rows=True)
    m = RoundMetrics.model_validate(out["metrics"])
    # unknown_seller is policy-bounded: reported apart, not in recall
    assert m.policy_bounded_recall is not None
    assert m.recall.n + m.policy_bounded_recall.n + m.fpr.n == 350
    assert "unknown_seller" in m.per_family
    assert m.fpr_real.n == 90
    l1 = [r for r in out["rows"] if r["decision"]["decided_by"] == "layer1"]
    assert l1 and all(r["decision"]["failed_rule"] and r["decision"]["risk_score"] is None for r in l1)
    l2 = [r for r in out["rows"] if r["decision"]["risk_score"] is not None]
    assert l2 and all(1 <= len(r["decision"]["top_reasons"]) <= 3 for r in l2)
    assert all(r["decision"]["model_version"] == trained["model_id"] for r in out["rows"])
    assert all(len(r["decision"]["checks"]) == 10 for r in out["rows"])


def test_per_family_has_layer1_families_fully_caught(trained, models_dir, repo):
    model = load(trained["model_id"], models_dir)
    m = RoundMetrics.model_validate(evaluate_examples(model, load_examples(repo), repo.reference_snapshot())["metrics"])
    for fam in ("payment_mismatch", "bait_and_switch", "product_switch"):  # lookalike/unknown sellers under the cap reach Layer 2
        assert m.per_family[fam].value == 1.0, fam
    # layer2_fpr counts only legit listings that pass Layer 1, so it never exceeds what the full Gate blocks
    assert m.layer2_fpr is not None and m.layer2_fpr.n <= m.fpr.n and m.layer2_fpr.k <= m.fpr.k


def test_risk_never_falls_as_price_falls(trained, models_dir, inputs):
    """G3: monotone constraint on price_ratio, checked by sweeping the price of one listing."""
    model = load(trained["model_id"], models_dir)
    feats = select(model.features)
    risks = []
    for factor in np.linspace(0.1, 1.5, 15):
        x = inputs["R-0001"].model_copy(deep=True)
        x.listing.item.price = round(175 * factor, 2)
        risks.append(float(model.predict_risk(featurize([x], feats))[0]))
    assert all(a >= b - 1e-12 for a, b in zip(risks, risks[1:])), risks


def test_in_process_evaluate_for_holdout_tuples(trained, models_dir):
    """The red-team MCP server scores the decrypted holdout like this, with no database."""
    model = load(trained["model_id"], models_dir)
    items = []
    for x in fixture_inputs():
        lid = x.listing.listing_id
        label = "legit" if lid.startswith("R-") or lid in ("S-0008", "S-0009") else "scam"
        items.append((Listing.model_validate(x.listing.model_dump()), Case(listing_id=lid, mandate=x.mandate),
                      AnswerKey(listing_id=lid, label=label, family="real" if lid.startswith("R-") else "too_cheap")))
    out = evaluate(model, items, fixture_refs(), with_rows=True)
    assert len(out["rows"]) == 12
    RoundMetrics.model_validate(out["metrics"])


def test_pick_threshold():
    legit = np.array([0.01, 0.02, 0.05, 0.1, 0.9] + [0.0] * 95)
    t = pick_threshold(legit, 0.02)
    assert (legit >= t).sum() <= 2 and t <= 0.1 + 1e-6
    assert pick_threshold(np.array([]), 0.02) == 0.5


def test_train_fails_on_broken_feature(repo, tmp_path, monkeypatch):
    import gatepy.train as train_mod
    from gatepy.registry import discover

    def discover_with_broken():
        discover()

        @feature("t_broken")
        def t_broken(x):
            return float("inf")

    monkeypatch.setattr(train_mod, "discover", discover_with_broken)
    cfg = tmp_path / "cfg.yaml"
    cfg.write_text("kind: logreg\nfeatures: [price_ratio, t_broken]\n", encoding="utf-8")
    with pytest.raises(GateInputError, match="self-test failed: t_broken"):
        train(1, cfg, out=tmp_path, repo=repo)
    cfg.write_text("kind: logreg\nfeatures: [price_ratio, no_such_feature]\n", encoding="utf-8")
    with pytest.raises(GateInputError, match="unknown features"):
        train(1, cfg, out=tmp_path, repo=repo)


def test_train_needs_both_labels(tmp_path):
    r = fresh_repo("only_real")
    seed(r, n_real=20, n_synth=0)
    with pytest.raises(GateInputError, match="need scam and legit"):
        train(1, out=tmp_path, repo=r)


def test_clis_print_json_and_exit_codes(trained, repo, models_dir, capsys, monkeypatch, tmp_path):
    monkeypatch.setattr("gatepy.train.get_repo", lambda: repo)
    monkeypatch.setattr("gatepy.evaluate.get_repo", lambda: repo)
    monkeypatch.setattr("gatepy.evaluate.load", lambda mid, _dir=None: load(mid, models_dir))
    assert train_main(["--round", "1", "--out", str(models_dir)]) == 0
    assert json.loads(capsys.readouterr().out)["model_id"] == trained["model_id"]
    assert eval_main(["--model", trained["model_id"], "--split", "val"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert set(out) == {"model_id", "metrics"}
    ids = tmp_path / "ids.txt"
    ids.write_text("RT-0001\nST-0004\n", encoding="utf-8")
    assert eval_main(["--model", trained["model_id"], "--ids", str(ids), "--rows"]) == 0
    assert [r["listing_id"] for r in json.loads(capsys.readouterr().out)["rows"]] == ["RT-0001", "ST-0004"]
    assert eval_main(["--model", "no-such-model"]) == 2
    assert "error" in json.loads(capsys.readouterr().out)
    assert train_main(["--round", "1", "--query", "{bad json"]) == 2
    assert "error" in json.loads(capsys.readouterr().out)
