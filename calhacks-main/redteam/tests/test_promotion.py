from calhacks_contracts import rate

from redteam.promotion import decide


def r(v, n=100):
    return rate(round(v * n), n).model_dump()


def m(recall, fpr, **fams):
    return {"recall": r(recall), "fpr": r(fpr), "per_family": {k: r(v) for k, v in fams.items()}}


def test_first_model_only_needs_fpr():
    assert decide(m(0.5, 0.01), None) == (True, [])
    ok, why = decide(m(0.99, 0.03), None)
    assert not ok and "false-block" in why[0]


def test_must_beat_incumbent_recall():
    ok, why = decide(m(0.80, 0.01, too_cheap=0.8), m(0.80, 0.01, too_cheap=0.8))
    assert not ok and "does not beat" in why[0]
    assert decide(m(0.81, 0.01, too_cheap=0.8), m(0.80, 0.01, too_cheap=0.8))[0]


def test_scam_family_drop_over_five_points_blocks():
    ok, why = decide(m(0.90, 0.01, too_cheap=0.94, fake_reviews=0.60), m(0.85, 0.01, too_cheap=1.0, fake_reviews=0.6))
    assert not ok and any("too_cheap recall drops" in w for w in why)
    assert decide(m(0.90, 0.01, too_cheap=0.96, fake_reviews=0.7), m(0.85, 0.01, too_cheap=1.0, fake_reviews=0.6))[0]


def test_legit_and_real_families_are_not_recall_families():
    # a rising skip rate on legit families must not count as a "recall drop" (FPR is checked separately)
    assert decide(m(0.9, 0.0, legit_plain=0.0, real=0.0), m(0.8, 0.0, legit_plain=0.2, real=0.2))[0]


def test_fpr_bound_uses_layer2_false_blocks_when_reported():
    cand = {**m(0.8, 0.07), "layer2_fpr": r(0.01)}  # 7% overall, all of it Layer 1 policy blocks
    ok, why = decide(cand, None)
    assert ok, why
    bad = {**m(0.8, 0.07), "layer2_fpr": r(0.05)}
    ok, why = decide(bad, None)
    assert not ok and "Layer 2 false-block rate" in why[0]


def test_candidate_eval_error_restores_promoted_features(monkeypatch):
    from redteam import gate_client, promotion
    restored = []
    monkeypatch.setattr(promotion, "current", lambda: {"model_id": "r1-good", "history": []})
    monkeypatch.setattr(gate_client, "evaluate", lambda *a, **k: {"error": "feature sandbox: features/x.py:1 import os"})
    monkeypatch.setattr(gate_client, "restore_features", restored.append)
    res = promotion.promote("r2-bad")
    assert res["promoted"] is False and res["decision"]["action"] == "revert"
    assert restored == ["r1-good"]
