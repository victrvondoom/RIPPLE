"""The pick, in code, so it is instant, repeatable and never touches the model.

qualified() is every Gate-approved listing whose title names the item the user asked for, once each, so Hunter never
buys something else: the grid the user picks up to five favorites from. weigh() then scores those favorites on what
their pages show: how trusted the seller is, price, reviews and condition. The best one is what Hunter offers to buy,
and each favorite's note says why in one short sentence.

Self-check: python -m app.rank (from apps/agent/api)
"""

import math
import re
from urllib.parse import urlparse

from app.llm import plain

EXCERPT = 400  # Page text right after the title, where stores show reviews, condition and price.
# Stars are averaged with PRIOR_STARS as if PRIOR_COUNT more reviews gave them, so 5 stars from 2 reviews doesn't
# beat 4.7 stars from 2,000. A listing with no reviews scores the prior.
PRIOR_STARS, PRIOR_COUNT = 4.0, 20

# "4.6 ( 1,385 )" is stars and a review count. "( 12,861 ) 99.9% positive" is seller feedback.
STARS = re.compile(r"\b([0-5](?:\.\d)?)\s*\(\s*([\d,]+)\s*\)")
POSITIVE = re.compile(r"\(\s*([\d,]+)\s*\)\s*([\d.]+)%\s*positive", re.IGNORECASE)
# How stores state condition: "Condition: New with tags", a "· Like New ·" detail, or "brand new" in the text.
CONDITION = re.compile(r"(?:condition:\s*|[·•|]\s*)(like new|new with tags|new without tags|brand new|new|"
                       r"excellent|very good|good|fair|used|pre-owned)\b|\b(brand new|new with tags|like new)\b",
                       re.IGNORECASE)
CONDITIONS = {"new": 1.0, "brand new": 1.0, "new with tags": 1.0, "new without tags": 0.95, "like new": 0.9,
              "excellent": 0.85, "very good": 0.75, "good": 0.65, "used": 0.6, "pre-owned": 0.6, "fair": 0.45}
# Resale listings state their condition. Retail listings usually don't, since they are new, so a listing that states
# none scores just under like new.
UNSTATED = 0.8

# How much each factor counts when weighing the user's favorites. They add up to 1.
FACTORS = {"seller": 0.3, "price": 0.3, "reviews": 0.25, "condition": 0.15}
MAX_FAVORITES = 5
# Seller trust by store, before what the page says about the seller. A retail store vets its sellers and takes
# returns. Resale stores don't, so they start lower. Any other store starts at UNKNOWN_STORE.
STORE_TRUST = {"amazon": 0.85, "ebay": 0.7, "depop": 0.65}
UNKNOWN_STORE = 0.5
FIRST_PARTY = 1.0  # The store sells it itself, e.g. seller "Amazon.com".
# eBay feedback this low or lower is no trust, 100% is full trust. A new seller's percentage counts for less:
# trust moves from the store's base toward the percentage as feedback grows, reaching it at FEEDBACK_FULL ratings.
FEEDBACK_FLOOR, FEEDBACK_FULL = 90.0, 1000


def stem(word: str) -> str:
    """"jackets" -> "jacket", "dresses" -> "dress", "dress" -> "dress", so singular and plural match."""
    word = word.lower()
    if re.search(r"(ss|ch|sh|x)es$", word):
        return word[:-2]
    return word[:-1] if word.endswith("s") and not word.endswith("ss") else word


def words(text: str) -> set[str]:
    return {stem(w) for w in re.findall(r"[a-z0-9]+", text.lower())}


def is_item(query: str, title: str) -> bool:
    """True when the title names the product: the last word of the search, e.g. "jacket" for "fleece jacket"."""
    product = re.findall(r"[a-z0-9]+", query.lower())
    return bool(product) and stem(product[-1]) in words(title)


def excerpt(page: dict | None) -> str:
    """The page text right after the title, where reviews and condition are."""
    text, h1 = (page or {}).get("text") or "", (page or {}).get("h1") or ""
    start = text.find(h1) + len(h1) if h1 and h1 in text else 0
    return text[start:start + EXCERPT]


def facts(page: dict | None) -> dict:
    """Stars and review count (or seller feedback as stars), and condition, as the page states them."""
    text, out = excerpt(page), {"stars": None, "reviews": 0, "feedback": None, "condition": None}
    if m := POSITIVE.search(text):
        out["feedback"], out["reviews"] = float(m.group(2)), int(m.group(1).replace(",", ""))
        out["stars"] = out["feedback"] / 20
    elif (m := STARS.search(text)) and int(m.group(2).replace(",", "")) > 0:
        out["stars"], out["reviews"] = float(m.group(1)), int(m.group(2).replace(",", ""))
    if m := CONDITION.search(text):
        out["condition"] = (m.group(1) or m.group(2)).lower()
    return out


def note(price: float, limit: float | None, f: dict) -> str:
    """"Like new, 4.6 stars from 260 reviews, $27.99 of your $50 limit." """
    parts = [f["condition"].capitalize()] if f["condition"] else []
    if f["feedback"] is not None:
        parts.append(f"{f['feedback']:g}% positive seller feedback")
    elif f["stars"] is not None:
        parts.append(f"{f['stars']:g} stars from {f['reviews']:,} review{'s' if f['reviews'] != 1 else ''}")
    else:
        parts.append("no reviews yet")
    parts.append(f"${price:.2f} of your ${limit:g} limit" if limit else f"${price:.2f}")
    return plain(", ".join(parts))


def seller_trust(listing: dict, f: dict) -> float:
    """0-1: how much to trust who sells it. The store sets the base, and seller feedback moves it."""
    host = (urlparse(listing.get("store") or "").hostname or "").split(".")[0]
    base = STORE_TRUST.get(host, UNKNOWN_STORE)
    seller = (listing.get("seller") or "").lower()
    if host and seller.startswith(host):  # "Amazon.com" on mzn: the store itself.
        return FIRST_PARTY
    if f["feedback"] is None:
        return base
    shown = max(0.0, min(1.0, (f["feedback"] - FEEDBACK_FLOOR) / (100 - FEEDBACK_FLOOR)))
    weight = min(1.0, math.log10(f["reviews"] + 1) / math.log10(FEEDBACK_FULL + 1))
    return base + (shown - base) * weight


def review_score(f: dict) -> float:
    """0-1: product stars, averaged with the prior so a few reviews count for little. Seller feedback is not a product
    review, so it scores the prior here and counts toward seller trust instead."""
    if f["feedback"] is not None or f["stars"] is None:
        return PRIOR_STARS / 5
    return (f["stars"] * f["reviews"] + PRIOR_STARS * PRIOR_COUNT) / (f["reviews"] + PRIOR_COUNT) / 5


def qualified(request: dict, approved: list[tuple[dict, dict | None]]) -> list[tuple[dict, dict | None]]:
    """The approved listings that are the item asked for, cheapest first, with the same product listed twice kept
    once. Every one fits the request, so the user can choose among them on looks alone."""
    out, seen = [], set()
    for listing, page in sorted(approved, key=lambda a: a[0]["price"]):
        same = ((listing.get("title") or "").lower(), listing["price"])
        if is_item(request["query"], listing.get("title") or "") and same not in seen:
            seen.add(same)
            out.append((listing, page))
    return out


def weigh(request: dict, favorites: list[tuple[dict, dict | None]]) -> list[dict]:
    """The user's favorites, best first, as [{"listing", "score", "factors", "facts", "note"}]. Each factor is 0-1
    and `score` is their weighted sum out of 100. Price is relative: the cheapest favorite scores 1."""
    if not favorites:
        return []
    cheapest = min(l["price"] for l, _ in favorites)
    weighed = []
    for listing, page in favorites:
        f = facts(page)
        factors = {"seller": seller_trust(listing, f), "price": cheapest / listing["price"] if listing["price"] else 1.0,
                   "reviews": review_score(f), "condition": CONDITIONS.get(f["condition"], UNSTATED)}
        score = 100 * sum(FACTORS[k] * v for k, v in factors.items())
        weighed.append({"listing": listing, "score": round(score, 1), "facts": f,
                        "factors": {k: round(v, 3) for k, v in factors.items()},
                        "note": note(listing["price"], request.get("max_price"), f)})
    weighed.sort(key=lambda w: (w["score"], -w["listing"]["price"]), reverse=True)
    return weighed


if __name__ == "__main__":
    assert [stem(w) for w in ["jackets", "dresses", "dress", "boots", "hoodies", "glasses"]] == \
        ["jacket", "dress", "dress", "boot", "hoodie", "glass"]
    assert is_item("fleece jacket", "Columbia Men's Fleece Jackets") and not is_item("fleece jacket", "Fleece Joggers")
    assert is_item("wireless headphones", "Sony Wireless Headphone") and not is_item("headphones", "Gray joggers")
    mzn = {"h1": "Coat", "text": "Nav Coat Visit the Store 4.6 ( 1,385 ) $ 42 99 New $ 42 99"}
    by = {"h1": "Coat", "text": "Coat SP SPEEDGEAR ( 12,861 ) 99.9% positive US $55.00 Condition: New with tags"}
    dpp = {"h1": "Coat", "text": "Coat $11.00 incl. fee REI Co-op · Size M · Like New · black"}
    empty = {"h1": "Coat", "text": "Coat Brand : X 0.0 ( 0 ) $ 10 99"}
    assert facts(mzn) == {"stars": 4.6, "reviews": 1385, "feedback": None, "condition": None}
    assert facts(by)["feedback"] == 99.9 and facts(by)["condition"] == "new with tags"
    assert facts(dpp)["condition"] == "like new" and facts(dpp)["stars"] is None
    assert facts(empty)["stars"] is None
    assert note(9.98, None, facts({"h1": "Coat", "text": "Coat 5.0 ( 1 )"})) == "5 stars from 1 review, $9.98."
    assert note(27.99, 50, facts(dpp)) == "Like new, no reviews yet, $27.99 of your $50 limit."
    assert note(42.99, None, facts(mzn)) == "4.6 stars from 1,385 reviews, $42.99."
    request = {"query": "fleece jacket", "max_price": 50}
    good = {"title": "Fleece Jacket A", "price": 45.0}
    cheap = {"title": "Fleece Jacket B", "price": 9.0}
    other = {"title": "Fleece Joggers", "price": 48.0}
    store = "https://ebay.hntr.store"
    fresh = {"store": store, "seller": "x", "title": "Fleece Jacket", "price": 20.0}
    assert seller_trust({"store": "https://amazon.hntr.store", "seller": "Amazon.com"}, facts(mzn)) == FIRST_PARTY
    assert seller_trust(fresh, facts(by)) > seller_trust(fresh, facts(empty)) == STORE_TRUST["ebay"]
    few = {"h1": "Coat", "text": "Coat ( 3 ) 100% positive"}
    assert STORE_TRUST["ebay"] < seller_trust(fresh, facts(few)) < seller_trust(fresh, facts(by))
    assert review_score(facts(mzn)) > review_score(facts(empty)) == review_score(facts(by)) == PRIOR_STARS / 5
    twice = {"title": "Fleece Jacket A", "price": 45.0}
    assert [l for l, _ in qualified(request, [(good, mzn), (other, mzn), (cheap, empty), (twice, empty)])] == [cheap, good]
    trusted = {"store": "https://amazon.hntr.store", "seller": "Amazon.com", "title": "Fleece Jacket C", "price": 10.0}
    w = weigh(request, [(cheap, empty), (trusted, mzn)])  # A dollar more, but sold by the store with good reviews.
    assert [x["listing"] for x in w] == [trusted, cheap] and w[1]["factors"]["price"] == 1.0, w
    assert 0 < w[1]["score"] < w[0]["score"] <= 100 and weigh(request, []) == []
    print("ok")
