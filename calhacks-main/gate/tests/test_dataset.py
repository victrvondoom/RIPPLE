import pytest
from calhacks_contracts import AnswerKey, Listing
from calhacks_contracts.listing import ListingMeta

from gatepy.dataset import GateInputError, default_case, load_examples, to_inputs

from conftest import fresh_repo
from expand import seed


def test_load_examples_from_mongo(repo):
    ex = load_examples(repo)
    assert len(ex) == 350
    assert [e.id for e in ex] == sorted(e.id for e in ex)
    assert {e.key.family for e in ex} >= {"real", "too_cheap", "legit_new_seller"}
    inputs = to_inputs(ex[:5], repo.reference_snapshot())
    assert all(x.references.known_sellers for x in inputs)


def test_query_filters_answer_keys(repo):
    ex = load_examples(repo, {"family": "real"})
    assert ex and all(e.key.family == "real" for e in ex)


def test_holdout_family_in_database_is_refused():
    r = fresh_repo("holdout_leak")
    seed(r, n_real=5, n_synth=0)
    r.put_answer_keys([AnswerKey(listing_id="RT-0000", label="scam", family="urgency_pressure")])
    with pytest.raises(GateInputError, match="holdout"):
        load_examples(r)


def test_missing_case_gets_default_mandate():
    r = fresh_repo("no_case")
    seed(r, n_real=3, n_synth=0)
    r.db.cases.delete_many({})
    ex = load_examples(r)
    assert len(ex) == 3
    l = ex[0].listing
    assert ex[0].case.mandate.product_key == l.item.product_key
    assert ex[0].case.mandate.max_price == round(l.item.price * 1.25, 2)


def test_default_case():
    l = Listing.model_validate({
        "listing_id": "x", "seller": {"id": "s", "domain": "d", "pay_to": "0x" + "1" * 40},
        "item": {"id": "i", "product_key": "p", "condition": "used", "price": 10, "text": "t"},
        "checkout": {"pay_to": "0x" + "1" * 40, "amount": "10000000", "network": "n", "asset": "0x" + "2" * 40,
                     "item_id": "i"}})
    assert default_case(l).mandate.max_price == 12.5
    ListingMeta(listing_id="x", source="t")
