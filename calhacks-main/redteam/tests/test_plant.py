"""redteam.plant: a seeded 5% pick per marketplace, one allowed change each, marked, and fully reversible."""
import copy
import re

import mongomock

from redteam import plant


def _doc(i: int, mkt: str, reviews: bool) -> dict:
    return {"id": f"{mkt}-{i}", "source": {"marketplace": mkt, "url": "u", "externalId": str(i)},
            "store": {"name": "Shop"},
            "item": {"title": f"Fleece Jacket {i}", "price": 40.0 + i % 7, "condition": "new", "brand": "Acme",
                     "category": "Jackets", "description": "Warm fleece jacket. Zip front. Two pockets.",
                     "images": [f"https://img/{i}.jpg"], "attributes": {}},
            "reviews": [{"author": "a", "date": "2026-01-02", "rating": 4, "body": "Good."}] if reviews else []}


def test_plant_marks_mutates_and_undoes():
    coll = mongomock.MongoClient()["calhacks"].listings
    docs = [_doc(i, m, m != "depop") for m in plant.MARKETPLACES for i in range(100)]
    coll.insert_many(copy.deepcopy(docs))
    before = {d["id"]: d for d in coll.find({}, {"_id": 0})}

    read = list(coll.find(plant.SELLABLE, {"item.images": 0}))
    new_docs = plant.updates(read, plant.plan(read, 0.05, seed=1), seed=1)
    assert len(new_docs) == 15 and plant.summary(new_docs)["by_marketplace"] == {"amazon": 5, "ebay": 5, "depop": 5}
    for d in new_docs:
        d["item"]["images"] = before[d["id"]]["item"]["images"]
    assert plant.apply(coll, new_docs) == 15
    assert plant.apply(coll, new_docs) == 0  # already planted: never applied twice

    planted = list(coll.find({"scam": {"$exists": True}}))
    assert len(planted) == 15 and len(plant.key(coll)) == 15
    fams = {d["scam"]["family"] for d in planted}
    assert fams >= {"too_cheap", "hidden_text", "prompt_injection", "payment_mismatch", "urgency_pressure"}
    assert all(d["scam"]["family"] != "fake_reviews" for d in planted if d["source"]["marketplace"] == "depop")
    for d in planted:
        o = before[d["id"]]
        assert d["item"]["title"] == o["item"]["title"] and d["item"]["images"] == o["item"]["images"]
        fam = d["scam"]["family"]
        if fam == "too_cheap":
            assert d["item"]["price"] < 0.5 * o["item"]["price"]
        elif fam == "payment_mismatch":
            assert d["item"]["checkoutPrice"] > d["item"]["price"] == o["item"]["price"]
        elif fam == "hidden_text":
            assert plant.mutate.unhide(d["item"]["description"]) != d["item"]["description"]
        elif fam == "prompt_injection":
            text = d["item"]["description"] + " ".join(r["body"] for r in d["reviews"])
            assert any(p.search(text) for p in plant._INJECT)
        elif fam == "fake_reviews":
            assert len(d["reviews"]) >= 3 and all(r["rating"] == 5 for r in d["reviews"])
        else:
            assert d["item"]["description"].startswith(o["item"]["description"]) and re.search(r"\b(left|last|final|one)\b", d["item"]["description"], re.I)

    assert plant.undo(coll) == 15
    assert {d["id"]: d for d in coll.find({}, {"_id": 0})} == before
