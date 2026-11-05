"""Rows split by base listing (train / calibrate / val), the threshold picked on out-of-fold scores of the fitted rows
(never on val), policy-bounded families reported apart from recall."""
from collections import defaultdict

import numpy as np
from calhacks_contracts import AnswerKey, Case, GateDecision, Listing, Mandate, RoundMetrics
from calhacks_contracts.families import policy_bounded_families

from gatepy import GATE_DIR, dataset
from gatepy.dataset import Example, featurize, load_examples, to_inputs
from gatepy.evaluate import round_metrics
from gatepy.layer1_bridge import passed, run_layer1
from gatepy.model_io import load
from gatepy.registry import select
from gatepy.splits import group_of
from gatepy.train import pick_threshold, train

from conftest import fresh_repo
from expand import seed


def test_every_base_listing_sits_on_exactly_one_side(repo):
    sides = defaultdict(set)
    for e in load_examples(repo):
        sides[group_of(e.id, e.key.base_listing_id)].add(e.split)
    assert sides and all(len(s) == 1 for s in sides.values())
    counts = defaultdict(int)
    for e in load_examples(repo):
        counts[e.split] += 1
    assert set(counts) == {"train", "calibrate", "val"}


def test_model_is_fitted_on_train_and_calibrate_and_counts_each_side(trained, models_dir, repo):
    meta = load(trained["model_id"], models_dir).meta
    ex = load_examples(repo)
    l1 = run_layer1(to_inputs(ex, repo.reference_snapshot()))
    assert meta["n_train"] == sum(e.split in ("train", "calibrate") and passed(c) for e, c in zip(ex, l1))
    assert meta["n_calibrate"] == sum(e.split == "calibrate" for e in ex)
    assert meta["n_val"] == sum(e.split == "val" for e in ex)


def test_threshold_comes_from_out_of_fold_scores_never_val(tmp_path, monkeypatch, repo):
    """pick_threshold receives one out-of-fold score per legit fitted row (train + calibrate, passing Layer 1)."""
    from gatepy import train as train_mod
    seen = []
    real_pick = train_mod.pick_threshold
    monkeypatch.setattr(train_mod, "pick_threshold", lambda risk, max_fpr: seen.append(len(risk)) or real_pick(risk, max_fpr))
    out = train_mod.train(1, GATE_DIR / "train_config.yaml", out=tmp_path, repo=repo)
    meta = load(out["model_id"], tmp_path).meta
    ex = load_examples(repo)
    l1 = run_layer1(to_inputs(ex, repo.reference_snapshot()))
    fitted_legit = sum(e.split in ("train", "calibrate") and passed(c) and e.key.label == "legit" for e, c in zip(ex, l1))
    val_legit = sum(e.split == "val" and passed(c) and e.key.label == "legit" for e, c in zip(ex, l1))
    assert seen == [fitted_legit] == [meta["threshold_rule"]["n"]] and fitted_legit != val_legit
    assert meta["threshold_rule"]["on"].startswith("out-of-fold")


def test_out_of_fold_scores_never_come_from_a_model_that_saw_the_base_listing():
    from gatepy.train import oof_risk
    rng = np.random.default_rng(0)
    groups = [f"G{i // 3}" for i in range(120)]           # 40 base listings, 3 copies each
    y = np.array([int(g[1:]) % 2 for g in groups])         # label is a property of the base listing
    X = rng.normal(size=(120, 2))                           # features carry no signal
    from types import SimpleNamespace
    fs = [SimpleNamespace(name="a", monotone=0), SimpleNamespace(name="b", monotone=0)]
    risk = oof_risk("logreg", X, y, groups, fs, {})
    assert not np.isnan(risk).any()
    # memorizing copies would separate the classes; out of fold, noise features can't
    from sklearn.metrics import roc_auc_score
    assert roc_auc_score(y, risk) < 0.75


def test_threshold_rests_on_every_fitted_legit_row(tmp_path):
    """The old calibrate-only rule picked the cut from ~50 legit rows, so one high scorer could move it from 0.43 to
    0.97. Out-of-fold scoring uses every legit row the model was fitted on."""
    r = fresh_repo("stable_threshold")
    seed(r, n_real=120, n_synth=240, seed_=5)
    a = train(1, GATE_DIR / "train_config.yaml", out=tmp_path / "a", repo=r)
    meta = load(a["model_id"], tmp_path / "a").meta
    assert meta["threshold_rule"]["n"] >= 100


def _ex(i, family, label):
    l = Listing.model_validate({
        "listing_id": f"L{i}", "seller": {"id": "s", "domain": "d.example", "pay_to": "0x" + "1" * 40},
        "item": {"id": "i", "product_key": "p", "condition": "used", "price": 10.0, "text": "t"}, "reviews": [],
        "checkout": {"pay_to": "0x" + "1" * 40, "amount": "10000000", "network": "eip155:84532",
                     "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "item_id": "i"}})
    return Example(l, Case(listing_id=l.listing_id, mandate=Mandate(product_key="p", max_price=20, spend_remaining=50)),
                   AnswerKey(listing_id=l.listing_id, label=label, family=family))


def _d(skip, by="layer2"):
    return GateDecision(decision="skip" if skip else "buy", decided_by=by if skip else None)


def test_policy_bounded_families_are_reported_apart():
    bounded = next(iter(policy_bounded_families()))
    ex = [_ex(0, "too_cheap", "scam"), _ex(1, "too_cheap", "scam"), _ex(2, bounded, "scam"), _ex(3, bounded, "scam"),
          _ex(4, bounded, "scam"), _ex(5, "real", "legit")]
    ds = [_d(True), _d(False), _d(True), _d(False), _d(False), _d(False)]
    m = RoundMetrics.model_validate(round_metrics(ex, ds).model_dump())
    assert (m.recall.k, m.recall.n) == (1, 2)                # too_cheap only
    assert (m.layer2_recall.k, m.layer2_recall.n) == (1, 2)
    assert (m.policy_bounded_recall.k, m.policy_bounded_recall.n) == (1, 3)
    assert m.per_family[bounded].n == 3                       # still listed per family
    assert round_metrics(ex[:2] + ex[5:], ds[:2] + ds[5:]).policy_bounded_recall is None
