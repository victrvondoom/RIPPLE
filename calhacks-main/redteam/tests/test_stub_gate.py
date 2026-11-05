import json

import pytest
from calhacks_contracts import Case, GateDecision, RoundMetrics, SyntheticListing
from calhacks_contracts.families import CONTRACTS_DIR

from redteam import gate_stub, scoring, store
from redteam.generate import run_spec

FIX = CONTRACTS_DIR / "tests" / "fixtures"


@pytest.fixture
def fixture_synthetic(repo):
    rows = json.loads((FIX / "synthetic.json").read_text(encoding="utf-8"))
    items = [(SyntheticListing.model_validate(x["synthetic"]), Case.model_validate(x["case"])) for x in rows]
    return items


def decide_first_failure(syn, case, refs):
    checks = gate_stub.layer1(gate_stub.gate_input(syn.listing, case, refs))
    return next((c.rule for c in checks if not c.passed), None)


def test_layer1_rules_on_contract_fixtures(repo, fixture_synthetic):
    refs = repo.reference_snapshot()
    got = {s.listing.listing_id: decide_first_failure(s, c, refs) for s, c in fixture_synthetic}
    assert got["S-0001"] == "L1_PAYTO_MISMATCH"
    assert got["S-0002"] == "L1_UNKNOWN_SELLER_CAP"         # $175 lookalike wallet: unknown and over the cap
    assert got["S-0003"] == "L1_ITEM_MISMATCH"
    assert got["S-0010"] == "L1_PRODUCT_MISMATCH"
    assert got["S-0004"] is None                            # unknown wallet selling $49, under the $100 cap
    assert got["S-0008"] is None and got["S-0005"] is None   # known seller: Layer 1 passes, Layer 2 decides
    assert got["S-0009"] == "L1_UNKNOWN_SELLER_CAP"         # unknown wallet above unknown_seller_cap_usd


def train_some(repo, fake_client):
    for fam in ("too_cheap", "hidden_text", "payment_mismatch", "fake_reviews"):
        run_spec({"spec_id": f"S-{fam}", "family": fam, "n": 40, "legit_ratio": 0.4, "mode": "mutate_real"},
                 round_=1, r=repo, client=fake_client())
    return gate_stub.train(1)


def test_train_and_evaluate_shapes(repo, fake_client):
    out = train_some(repo, fake_client)
    assert "error" not in out, out
    assert out["model_id"].startswith("r1-stub") and out["n_train"] > 0 and out["n_val"] > 0
    # grouped split: every copy of one base listing sits on the same side as its base
    from calhacks_contracts.splits import split_of
    by_base = {}
    for k in repo.answer_keys():
        by_base.setdefault(k.base_listing_id or k.listing_id, set()).add(split_of(k.listing_id, k.base_listing_id))
    assert all(len(v) == 1 for v in by_base.values())
    RoundMetrics.model_validate(out["val"])
    ev = gate_stub.evaluate(out["model_id"], split="val", rows=True)
    RoundMetrics.model_validate(ev["metrics"])
    assert ev["rows"] and all(GateDecision.model_validate(x["decision"]) for x in ev["rows"])
    assert ev["metrics"]["layer1_catches"] > 0
    assert ev["metrics"]["fpr_real"]["n"] >= 0


def test_scoring_metrics():
    def row(label, family, decision, by=None, know=None):
        return {"listing_id": "x", "label": label, "family": family, "attacker_knowledge": know,
                "decision": {"decision": decision, "decided_by": by}}
    rows = [row("scam", "too_cheap", "skip", "layer2", "white_box"), row("scam", "too_cheap", "buy", None, "white_box"),
            row("scam", "payment_mismatch", "skip", "layer1"), row("legit", "real", "skip", "layer2"),
            row("legit", "real", "buy"), row("legit", "legit_plain", "buy")]
    m = scoring.metrics(rows)
    assert m.recall.k == 2 and m.recall.n == 3
    assert m.layer1_catches == 1 and m.layer2_recall.k == 1 and m.layer2_recall.n == 2
    assert m.fpr_real.value == 0.5 and m.fpr.k == 1 and m.fpr.n == 3
    assert m.adaptive_recall.value == 0.5
    assert len(scoring.misses(rows)) == 2


def test_eval_items_for_listings_outside_mongo(repo, fake_client):
    out = train_some(repo, fake_client)
    held = run_spec({"spec_id": "H-x", "family": "urgency_pressure", "n": 6, "legit_ratio": 0, "mode": "mutate_real"},
                    round_=0, r=repo, client=fake_client(), write=False, allow_holdout=True, id_prefix="H")
    refs = repo.reference_snapshot().overlay(wallets=held["_refs"].wallets)
    items = [(s.listing, c, s.answer_key) for s, c in held["_items"]]
    ev = gate_stub.evaluate_items(out["model_id"], items, refs)
    assert ev["metrics"]["recall"]["n"] == len(items) > 0
    assert store.listing_ids(repo, split="all") and not any(i.startswith("H") for i in store.listing_ids(repo))
