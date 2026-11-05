import json
from pathlib import Path

import mongomock
import pytest
from pydantic import ValidationError

from calhacks_contracts import (
    Case, GateDecision, KnownSeller, Listing, Mandate, RoundInput, SyntheticListing, rate,
)
from calhacks_contracts.db import Repo
from calhacks_contracts.export import main as export_main
from calhacks_contracts.families import families, holdout_families, label_of, legit_hard
from calhacks_contracts.ingest import ingest_listings
from calhacks_contracts.splits import split_of

FIX = Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


@pytest.fixture
def repo():
    r = Repo(mongomock.MongoClient()["redteam_test"])
    refs = load("references.json")
    for k in refs["known_sellers"]:
        r.put_known_seller(KnownSeller.model_validate(k))
    for m in refs["market_medians"]:
        r.put_median(m["product_key"], m["condition"], m["median"], m["n"], "fixture", "2026-10-24")
    return r


def test_fixtures_validate_and_labels_match_families():
    for row in load("synthetic.json"):
        s = SyntheticListing.model_validate(row["synthetic"])
        Case.model_validate(row["case"])
        assert s.answer_key.label == label_of(s.answer_key.family)
        assert s.answer_key.family not in holdout_families()
    for row in load("real_listings.json"):
        Listing.model_validate(row["listing"])


def test_listing_rejects_extra_fields_so_labels_cannot_leak():
    d = load("real_listings.json")[0]["listing"]
    with pytest.raises(ValidationError):
        Listing.model_validate({**d, "label": "scam"})
    with pytest.raises(ValidationError):
        Listing.model_validate({**d, "item": {**d["item"], "rating": 4.5}})


def test_listing_field_limits():
    d = load("real_listings.json")[0]["listing"]
    with pytest.raises(ValidationError):
        Listing.model_validate({**d, "reviews": ["x"] * 21})
    with pytest.raises(ValidationError):
        Listing.model_validate({**d, "checkout": {**d["checkout"], "amount": "1.5"}})
    with pytest.raises(ValidationError):
        Listing.model_validate({**d, "item": {**d["item"], "condition": "Good"}})


def test_families_file_is_consistent():
    fams = families()
    assert holdout_families() <= fams.keys()
    assert set(legit_hard()) <= fams.keys()
    assert all(f["label"] in ("scam", "legit") for f in fams.values())
    assert label_of("real") == "legit"


def test_gate_decision_caps_top_reasons():
    reasons = [{"feature": f"f{i}", "value": 0, "contribution": 0} for i in range(4)]
    with pytest.raises(ValidationError):
        GateDecision.model_validate({"decision": "skip", "decided_by": "layer2", "top_reasons": reasons})


def test_round_input_accepts_nested_report():
    RoundInput.model_validate({"round": 1, "budget": {"usd": 1, "tokens": 1000, "minutes": 5},
                               "current_model_id": None})


def test_rate_wilson_interval():
    r = rate(9, 10)
    assert r.value == 0.9 and 0.55 < r.lo < 0.6 and 0.98 < r.hi <= 1
    assert rate(0, 0).hi == 1.0


def test_split_is_deterministic_grouped_and_three_way():
    assert split_of("S-0001") == split_of("S-0001")
    vals = [split_of(f"x-{i}") for i in range(2000)]
    assert 300 < vals.count("val") < 500 and 120 < vals.count("calibrate") < 280
    # copies of one base listing always share its side
    for b in (f"R-{i}" for i in range(50)):
        assert {split_of(f"S-{b}-{j}", b) for j in range(5)} == {split_of(b)}


def test_policy_bounded_families():
    from calhacks_contracts.families import policy_bounded_families
    assert policy_bounded_families() == {"unknown_seller"}


def test_repo_round_trip_and_references(repo):
    for row in load("synthetic.json"):
        repo.put_synthetic([(SyntheticListing.model_validate(row["synthetic"]), Case.model_validate(row["case"]))])
    l = repo.get_listing("S-0004")
    assert l is not None and l.item.price == 49.0
    assert repo.db.listings.find_one({"_id": "S-0004"}).keys() == {"_id", *Listing.model_fields}
    refs = repo.reference_snapshot().for_listing(l)
    assert l.checkout.pay_to.lower() not in {k.pay_to.lower() for k in refs.known_sellers}  # unknown wallet
    assert refs.market_median == 180.0
    assert len(refs.known_sellers) == 2
    keys = {k.listing_id: k for k in repo.answer_keys({"label": "scam"})}
    assert "S-0001" in keys and "S-0008" not in keys
    assert repo.case("S-0010").mandate.product_key == "headphones-sony-wh1000xm5-black"


def test_median_falls_back_to_any_condition(repo):
    snap = repo.reference_snapshot()
    assert snap.median("lego-75192-millennium-falcon", "used") == 690.0
    assert snap.median("unknown-product", "used") is None


def test_ingest_real_listings(repo):
    lines = [json.dumps(r) for r in load("real_listings.json")] + ["{not json", json.dumps({"listing_id": "bad"})]
    ok, errors = ingest_listings(repo, lines, "fixture")
    assert ok == 2 and len(errors) == 2
    assert {k.family for k in repo.answer_keys()} == {"real"}
    assert set(repo.real_listing_ids()) == {"R-0001", "R-0002"}
    assert repo.db.wallets.find_one({"_id": "0x1111aaaa2222bbbb3333cccc4444dddd5555eee1"})
    assert repo.db.listing_meta.find_one({"_id": "R-0001"})["source"] == "fixture"


def test_overlay_adds_simulated_references(repo):
    snap = repo.reference_snapshot().overlay(
        wallets={"0xABCDEF0000000000000000000000000000000001": "2026-10-23"})
    assert snap.wallets["0xabcdef0000000000000000000000000000000001"] == "2026-10-23"
    assert "0xabcdef0000000000000000000000000000000001" not in repo.reference_snapshot().wallets


def test_mandate_validation():
    with pytest.raises(ValidationError):
        Mandate(product_key="x", max_price=0, spend_remaining=1)


def test_exported_schemas_are_current():
    assert export_main(["--check"]) == 0


def test_deprecated_seller_untrusted_rule_still_validates_for_the_agent_mock():
    from calhacks_contracts import GateDecision
    d = GateDecision(decision="skip", decided_by="layer1", failed_rule="L1_SELLER_UNTRUSTED",
                     checks=[{"rule": "L1_SELLER_UNTRUSTED", "passed": False, "detail": "unknown store"}])
    assert d.failed_rule == "L1_SELLER_UNTRUSTED"
