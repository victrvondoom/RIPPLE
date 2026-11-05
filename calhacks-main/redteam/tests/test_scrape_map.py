"""The scrape -> issue #1 snapshot mapper, on hand-written scrape documents (no network, no MongoDB)."""
import json
import random
from collections import Counter

from calhacks_contracts import Listing

from redteam import mutate, scrape_map

AS_OF = "2026-10-24"


def doc(i, mkt="ebay", seller="bob", price=40.0, cond="good", brand="Columbia Sportswear", category="Jackets",
        title="Columbia thermal jacket", rating=4.9, reviews=120, pos=None, desc="Warm. ​Tested."):
    return {"id": f"{mkt}-{i}", "source": {"marketplace": mkt, "url": f"https://www.{mkt}.com/itm/{i}", "externalId": str(i)},
            "store": {"name": seller.title(), "sellerId": seller, "rating": rating, "reviewCount": reviews,
                      "itemsSold": None, "positivePercent": pos, "location": None},
            "item": {"title": title, "price": price, "condition": cond, "description": desc, "listPrice": None,
                     "brand": brand, "category": category, "attributes": {"Size": "M"}, "bullets": None, "stock": 1,
                     "rating": None, "ratingCount": None, "ratingBreakdown": None, "stats": None},
            "reviews": [{"author": "a", "date": "Past month", "rating": 5, "body": f"great {j}"} for j in range(25)]}


def test_map_doc_fields():
    l, meta, s = scrape_map.map_doc(doc(1), AS_OF)
    assert isinstance(l, Listing)
    assert l.seller.id == "ebay:bob" and l.seller.domain == "ebay.com"
    assert l.seller.pay_to == l.checkout.pay_to == scrape_map.wallet("ebay:bob")
    assert l.item.product_key == "columbia:jacket" and l.item.condition == "used"
    assert l.checkout.amount == "40000000" and l.checkout.item_id == l.item.id == "ebay-1"
    assert "​" in l.item.text and "Size: M" in l.item.text  # raw text kept
    assert len(l.reviews) == 20
    assert meta.source == "scrape:ebay" and meta.fetched_at == AS_OF


def test_conditions_types_brands_and_fallback_seller_id():
    cases = {"acceptable": "poor", None: "used", "like_new": "like_new", "new": "new", "weird": "used"}
    for raw, want in cases.items():
        assert scrape_map.map_doc(doc(2, cond=raw), AS_OF)[0].item.condition == want
    assert scrape_map.type_key("Vest", "Puffer vest") == "vest"
    assert scrape_map.type_key("Fashion Hoodies", "Thermal hoodie") == "hoodie"
    assert scrape_map.type_key(None, "Mens thermal fleece") == "fleece"
    assert scrape_map.brand_key("The North Face") == "the-north-face" and scrape_map.brand_key("Unbranded") == "unbranded"
    d = doc(3, mkt="amazon", seller="x")
    d["store"]["sellerId"], d["store"]["name"] = None, "Amazon.com"
    assert scrape_map.map_doc(d, AS_OF)[0].seller.id == "amazon:amazon-com"


def test_build_splits_by_seller_and_derives_references():
    docs = [doc(i, seller=f"s{i % 40}", price=20 + i % 7 * 15, reviews=(i % 40) * 10, rating=4.9 if i % 3 else 4.0,
                cond="new" if i % 2 else "good")
            for i in range(200)]
    docs.append({**doc(999), "item": {**doc(999)["item"], "price": None}})
    snap = scrape_map.build(docs, AS_OF)
    assert snap["drops"] == {"no price": 1}
    train, locked = snap["sides"]["train"], snap["sides"]["locked_test"]
    tr_sellers = {l.seller.id for l in train["listings"]}
    lk_sellers = {l.seller.id for l in locked["listings"]}
    assert tr_sellers and lk_sellers and not tr_sellers & lk_sellers  # a seller's listings stay on one side
    assert 0.1 < len(lk_sellers) / (len(tr_sellers) + len(lk_sellers)) < 0.35
    assert 0 < len(snap["known"]) <= scrape_map.KNOWN_TOP
    assert len(snap["known_all"]) == len(tr_sellers | lk_sellers)
    # medians come from the train side only
    locked_only = {(l.item.product_key, l.item.condition) for l in locked["listings"]}
    for m in snap["medians"]:
        if m["level"] == "product":
            n_train = sum(1 for l in train["listings"]
                          if (l.item.product_key, l.item.condition) == (m["product_key"], m["condition"]))
        else:
            t = m["product_key"].split(":", 1)[1]
            n_train = sum(1 for l in train["listings"]
                          if l.item.product_key.endswith(":" + t) and l.item.condition == m["condition"])
        assert m["n"] == n_train >= scrape_map.MIN_SALES
    assert locked_only  # (keys may overlap; counts above prove locked listings were not counted)
    # cases: own product, 25% headroom over max(price, median), $500 budget
    for c, l in zip(train["cases"], train["listings"]):
        assert c.mandate.product_key == l.item.product_key and c.mandate.spend_remaining == 500
        assert c.mandate.max_price >= round(l.item.price * 1.25, 2)
    assert train["wallets"] == {}  # no wallet history unless asked for


def test_type_level_median_fallback():
    docs = [doc(i, seller=f"s{i}", brand=f"brand{i % 30}", price=40 + i, cond="new") for i in range(60)]
    snap = scrape_map.build(docs, AS_OF)
    levels = Counter(m["level"] for m in snap["medians"])
    assert levels["type"] > 0
    keys = {l.item.product_key for s in snap["sides"].values() for l in s["listings"]}
    assert keys <= {m["product_key"] for m in snap["medians"]}  # every key has a market reference


def test_write_and_summary(tmp_path):
    docs = [doc(i, seller=f"s{i % 25}", price=30 + i % 5 * 30) for i in range(80)]
    snap = scrape_map.build(docs, AS_OF)
    manifest = scrape_map.write(snap, scrape_map.summarize(snap, len(docs), AS_OF, []), tmp_path)
    assert (tmp_path / "train" / "listings.jsonl").exists() and (tmp_path / "locked_test" / "cases.jsonl").exists()
    saved = json.loads((tmp_path / "manifest.json").read_text())
    assert saved["mapping_version"] == scrape_map.MAPPING_VERSION and saved["hashes"] == manifest["hashes"]
    trust = saved["sides"]["train"]["trust"]
    assert set(trust) <= {"known", "unknown_within_cap", "unknown_over_cap"}
    assert sum(trust.values()) == saved["sides"]["train"]["listings"]


def test_fresh_sellers_stay_on_the_base_marketplace():
    base, _, _ = scrape_map.map_doc(doc(5), AS_OF)
    seller, sim = mutate.fresh_seller(random.Random(1), base)
    assert seller["domain"] == "ebay.com" and seller["id"].startswith("ebay:")
    assert not sim.wallets  # no invented wallet history (A5)


def test_no_wallet_history_by_default():
    docs = [doc(i, seller=f"s{i % 20}") for i in range(60)]
    plain = scrape_map.build(docs, AS_OF)
    assert all(side["wallets"] == {} for side in plain["sides"].values())
    with_hist = scrape_map.build(docs, AS_OF, wallet_history=True)
    assert any(side["wallets"] for side in with_hist["sides"].values())
