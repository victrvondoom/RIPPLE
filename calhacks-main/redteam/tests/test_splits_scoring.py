"""Grouped splits on the red-team side, and policy-bounded families reported apart from recall."""
from calhacks_contracts.splits import split_of

from redteam import scoring, store


def test_listing_ids_split_by_base(repo):
    from redteam.generate import run_spec
    run_spec({"spec_id": "S-g", "family": "payment_mismatch", "n": 30, "legit_ratio": 0, "mode": "mutate_real"},
             round_=1, r=repo, client=None)
    keys = {k.listing_id: k for k in repo.answer_keys()}
    for side in ("train", "calibrate", "val"):
        for i in store.listing_ids(repo, split=side):
            assert split_of(i, keys[i].base_listing_id) == side
    allids = store.listing_ids(repo)
    assert sorted(sum((store.listing_ids(repo, split=s) for s in ("train", "calibrate", "val")), [])) == allids


def row(fam, label, decision, by=None):
    return {"listing_id": fam, "label": label, "family": fam, "attacker_knowledge": None,
            "decision": {"decision": decision, "decided_by": by}}


def test_policy_bounded_families_are_reported_apart():
    rows = [row("too_cheap", "scam", "skip", "layer2"), row("too_cheap", "scam", "buy"),
            row("unknown_seller", "scam", "buy"), row("unknown_seller", "scam", "buy"),
            row("unknown_seller", "scam", "skip", "layer1"), row("real", "legit", "buy")]
    m = scoring.metrics(rows)
    assert m.recall.n == 2 and m.recall.value == 0.5           # unknown_seller excluded
    assert m.layer2_recall.n == 2
    assert m.policy_bounded_recall.n == 3 and m.policy_bounded_recall.k == 1
    assert m.layer1_catches == 1                               # Layer 1 catches still count every scam
    assert scoring.metrics([row("too_cheap", "scam", "buy")]).policy_bounded_recall is None
