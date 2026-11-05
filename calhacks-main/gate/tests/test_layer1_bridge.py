from gatepy.layer1_bridge import failed_rule, passed, run_layer1
from gatepy.selftest import fixture_inputs


def test_bridge_runs_typescript_rules_in_order():
    xs = fixture_inputs()
    results = dict(zip([x.listing.listing_id for x in xs], run_layer1(xs)))
    assert passed(results["R-0001"]) and failed_rule(results["R-0001"]) is None
    assert failed_rule(results["S-0001"]) == "L1_PAYTO_MISMATCH"
    assert failed_rule(results["S-0002"]) == "L1_UNKNOWN_SELLER_CAP"
    assert failed_rule(results["S-0003"]) == "L1_ITEM_MISMATCH"
    assert failed_rule(results["S-0010"]) == "L1_PRODUCT_MISMATCH"
    assert len(results["R-0001"]) == 10


def test_empty_batch():
    assert run_layer1([]) == []
