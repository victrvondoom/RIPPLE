import json

import pytest

from redteam import gate_stub, holdout
from redteam.config import HOLDOUT, HOLDOUT_FILE
from redteam.generate import run_spec


def add_cheap_real(repo):
    """The contract fixtures' real listings cost $175 and $699; families on unknown wallets need one within the cap."""
    from calhacks_contracts import Case, ListingMeta, Mandate
    base = repo.get_listing("R-0001").model_copy(deep=True)
    base.listing_id, base.item.price, base.checkout.amount = "R-cheap", 45.0, "45000000"
    repo.put_real(base, ListingMeta(listing_id="R-cheap", source="test"),
                  Case(listing_id="R-cheap", mandate=Mandate(product_key=base.item.product_key, max_price=60,
                                                            spend_remaining=500)))


def test_build_never_writes_to_mongo_and_is_encrypted(repo, fake_client):
    add_cheap_real(repo)
    before = {c: repo.db[c].count_documents({}) for c in ("listings", "answer_keys", "gen", "cases", "wallets")}
    meta = holdout.build(per_family=8, slice_n=3, client=fake_client(), r=repo)
    after = {c: repo.db[c].count_documents({}) for c in before}
    assert before == after
    assert set(meta["by_family"]) >= {"urgency_pressure", "lookalike_domain"}
    raw = HOLDOUT_FILE.read_bytes()
    assert b"listing_id" not in raw and b"urgency" not in raw
    with pytest.raises(RuntimeError, match="built once"):
        holdout.build(per_family=2, slice_n=1, client=fake_client(), r=repo)


def test_totals_only(repo, fake_client):
    for fam in ("too_cheap", "payment_mismatch"):
        run_spec({"spec_id": f"S-{fam}", "family": fam, "n": 30, "legit_ratio": 0.4, "mode": "mutate_real"},
                 round_=1, r=repo, client=fake_client())
    model = gate_stub.train(1)
    holdout.build(per_family=8, slice_n=3, client=fake_client(), r=repo)
    t = holdout.totals(model["model_id"], r=repo)
    assert set(t.model_dump()) == {"model_id", "recall", "fpr", "layer2_fpr", "policy_bounded_recall"}
    assert t.recall.n > 0


def test_holdout_dir_must_be_outside_repo(monkeypatch, repo):
    from redteam import config
    monkeypatch.setattr(holdout, "HOLDOUT", config.REPO / "x")
    with pytest.raises(RuntimeError, match="outside the repo"):
        holdout.build(r=repo)


def test_unavailable_without_build():
    assert not holdout.available() and holdout.totals("anything") is None
    assert not HOLDOUT_FILE.exists() and json.dumps(str(HOLDOUT))


def add_bases(repo, n):
    """n more cheap real listings, so the copy cap can be met by spreading."""
    from calhacks_contracts import Case, ListingMeta, Mandate
    for i in range(n):
        base = repo.get_listing("R-0001").model_copy(deep=True)
        base.listing_id = f"R-b{i:03d}"
        base.item.price, base.checkout.amount = 40.0 + i, str((40 + i) * 1_000_000)
        repo.put_real(base, ListingMeta(listing_id=base.listing_id, source="test"),
                      Case(listing_id=base.listing_id, mandate=Mandate(product_key=base.item.product_key,
                                                                       max_price=200, spend_remaining=500)))


def test_copies_per_base_are_capped_and_spread(repo, fake_client):
    add_cheap_real(repo)
    add_bases(repo, 40)
    meta = holdout.build(per_family=12, slice_n=3, client=fake_client(), r=repo)
    items, _ = holdout._load()
    from collections import Counter
    c = Counter(k.base_listing_id for _, _, k in items)
    assert meta["max_copies"] == max(c.values()) <= holdout.MAX_PER_BASE
    assert meta["bases"] == len(c) and meta["shortfall"] == {}
    # spread: with more bases than slots for a family, no base is reused before every eligible base is used once
    assert max(c.values()) <= -(-sum(c.values()) // len(c)) + 1


def test_few_bases_report_a_shortfall(repo, fake_client):
    add_cheap_real(repo)   # only a handful of real listings: three copies each cannot cover 12 per family
    meta = holdout.build(per_family=12, slice_n=3, client=fake_client(), r=repo, retries=1)
    assert meta["max_copies"] <= holdout.MAX_PER_BASE
    assert meta["shortfall"] and all(set(v) <= {"scam", "legit"} for v in meta["shortfall"].values())


def test_dropped_slots_are_re_requested(monkeypatch, repo, fake_client):
    add_cheap_real(repo)
    add_bases(repo, 40)
    real_run = holdout.run_spec
    seen = []

    def flaky(spec, **kw):  # every first request loses half its listings, as if the LLM dropped them
        out = real_run(spec, **kw)
        seen.append(spec["spec_id"])
        if "-r" not in spec["spec_id"]:
            out["_items"] = out["_items"][::2]
        return out
    monkeypatch.setattr(holdout, "run_spec", flaky)
    meta = holdout.build(per_family=10, slice_n=4, client=fake_client(), r=repo)
    assert any("-r1" in s for s in seen) and meta["shortfall"] == {}
    assert meta["n"] >= 10 * 2 + 4 * len(holdout.scam_families()) - 1


def test_operator_report_has_groups_and_clustered_intervals(repo, fake_client):
    add_cheap_real(repo)
    add_bases(repo, 30)
    for fam in ("too_cheap", "payment_mismatch"):
        run_spec({"spec_id": f"S-{fam}", "family": fam, "n": 30, "legit_ratio": 0.4, "mode": "mutate_real"},
                 round_=1, r=repo, client=fake_client())
    model = gate_stub.train(1)
    holdout.build(per_family=9, slice_n=3, client=fake_client(), r=repo)
    t = holdout.totals(model["model_id"], r=repo)
    assert set(t.model_dump()) == {"model_id", "recall", "fpr", "layer2_fpr", "policy_bounded_recall"}  # totals only: no rows, no seen/held-out split
    (rep,) = holdout.history(model["model_id"])
    assert holdout.HISTORY_FILE.parent == HOLDOUT
    assert set(rep["totals"]) == {"recall", "fpr", "layer2_fpr", "policy_bounded_recall"}
    assert rep["totals"]["recall"]["value"] == t.recall.value and rep["totals"]["policy_bounded_recall"]["n"] > 0
    assert set(rep["groups"]) == {"seen", "held_out"} and rep["groups"]["held_out"]["n"] > 0
    for k, ci in rep["ci95_cluster"].items():
        assert ci is None or 0 <= ci[0] <= ci[1] <= 1, k
    lo, hi = rep["ci95_cluster"]["recall"]
    assert lo <= t.recall.value <= hi
    assert rep["clusters"] < rep["n"]  # copies share a cluster


def test_bootstrap_clusters_widen_the_interval():
    rows = [{"label": "scam", "family": "too_cheap", "decision": {"decision": "skip" if g < 5 else "buy"}}
            for g in range(10) for _ in range(10)]
    pick = lambda x: x["decision"]["decision"] == "skip"
    by_row = holdout._bootstrap(rows, [str(i) for i in range(len(rows))], pick)
    by_cluster = holdout._bootstrap(rows, [str(i // 10) for i in range(len(rows))], pick)
    assert by_cluster[1] - by_cluster[0] > by_row[1] - by_row[0]
