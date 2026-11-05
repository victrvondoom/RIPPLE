"""Map the scraped listings (calhacks.listings, read-only) into a local issue #1 snapshot, e.g. scrape-v1.

  uv run --project redteam python -m redteam.scrape_map --out <dir>/snapshots/scrape-v1 [--as-of 2026-10-24]

Nothing is written to MongoDB. The snapshot holds two sides, split by seller:
  train/        bases for training and validation (real listings, cases, medians, wallets)
  locked_test/  bases reserved for the holdout only
plus known_sellers.json (the known-wallet list), known_sellers_all.json (the dry-4 variant: every real seller known)
and manifest.json.

Mapping (docs/plans and the dry-run handoff):
- seller.id = "{marketplace}:{sellerId or slug(store.name)}"; seller.domain = the marketplace host; the wallet is a
  deterministic placeholder sha256(seller.id)[:40], used for both seller.pay_to and checkout.pay_to.
- item.product_key = "{brand}:{type}"; item.condition: good -> used, acceptable -> poor, missing -> used.
- item.text = title + description + attributes, raw; reviews = up to 20 review bodies.
- checkout = the listed price in USDC base units on the allowlisted network and asset, 120 s timeout.
- Known wallets: the top KNOWN_TOP sellers by review count among those rated >= 4.8 (or >= 99.5% positive).
  Everyone else is an unknown wallet (paid only up to the cap). There is no CRS.
- Wallet first-seen: none by default, since we have no real wallet history (made-up dates for real wallets only
  would be a tell). --wallet-history restores the old heuristic (known -> as_of - 365 days; any rating or review
  count -> as_of - 180 days; otherwise as_of), for comparison runs only.
- Medians per (product_key, condition) from the train side only, groups of at least MIN_SALES; keys without enough
  sales fall back to their type's median per condition (level "type").
- Case per listing: its own product, max_price = max(price, median) * 1.25, spend_remaining = 500.
"""
import argparse
import hashlib
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from calhacks_contracts import Case, KnownSeller, Listing, ListingMeta, Mandate
from calhacks_contracts.families import allowlist

MAPPING_VERSION = "scrape-map/2"
KNOWN_TOP = 10
MIN_SALES = 3
PRICE_FACTOR = 1.25
SPEND = 500.0
LOCKED_SHARE = 5  # 1 in 5 sellers (~20%) go to the locked-test side

CONDITIONS = {"new": "new", "like_new": "like_new", "good": "used", "used": "used", "acceptable": "poor", "poor": "poor"}
TYPES = [("vest", r"\bvests?\b|gilet"), ("coat", r"\bcoats?\b|parka|overcoat"), ("hoodie", r"hood(ie|ed)|sweatshirt"),
         ("shirt", r"\bshirts?\b|t-shirt|tee\b|base ?layer|thermal top"), ("pants", r"\bpants\b|trousers|bottoms"),
         ("fleece", r"fleece"), ("jacket", r"jacket|shell|insulated|puffer|down\b|outerwear")]
BRAND_ALIASES = {"columbia sportswear": "columbia", "the north face": "the-north-face", "north face": "the-north-face"}


def slug(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def brand_key(brand: str | None) -> str:
    b = (brand or "").strip().lower()
    if not b or b in ("unbranded", "unknown", "n/a", "none", "generic"):
        return "unbranded"
    return BRAND_ALIASES.get(b, slug(b))


def type_key(category: str | None, title: str | None) -> str:
    hay = f"{category or ''} {title or ''}".lower()
    return next((t for t, pat in TYPES if re.search(pat, hay)), "jacket")


def wallet(seller_id: str) -> str:
    return "0x" + hashlib.sha256(seller_id.encode()).hexdigest()[:40]


def side_of(seller_id: str) -> str:
    return "locked_test" if int(hashlib.sha256(seller_id.encode()).hexdigest(), 16) % LOCKED_SHARE == 0 else "train"


def item_text(item: dict) -> str:
    attrs = "; ".join(f"{k}: {v}" for k, v in (item.get("attributes") or {}).items())
    parts = [item.get("title") or "", item.get("description") or "", attrs]
    return "\n".join(p for p in parts if p)


def map_doc(doc: dict, as_of: str) -> tuple[Listing, ListingMeta, dict]:
    """One scraped document -> (Listing, ListingMeta, seller info for references). Raises ValueError to drop."""
    src, store, item = doc["source"], doc["store"], doc["item"]
    price = item.get("price")
    if not isinstance(price, (int, float)) or price <= 0:
        raise ValueError("no price")
    mkt = src["marketplace"]
    seller_id = f"{mkt}:{store.get('sellerId') or slug(store.get('name')) or 'unknown'}"
    domain = (urlparse(src.get("url") or "").hostname or f"{mkt}.com").removeprefix("www.")
    pay_to = wallet(seller_id)
    a = allowlist()
    listing = Listing.model_validate({
        "listing_id": doc["id"],
        "seller": {"id": seller_id, "domain": domain, "pay_to": pay_to},
        "item": {"id": doc["id"], "product_key": f"{brand_key(item.get('brand'))}:{type_key(item.get('category'), item.get('title'))}",
                 "condition": CONDITIONS.get((item.get("condition") or "").lower(), "used"),
                 "price": round(float(price), 2), "text": item_text(item)},
        "reviews": [r.get("body") or "" for r in (doc.get("reviews") or [])][:20],
        "checkout": {"pay_to": pay_to, "amount": str(round(float(price) * 10 ** a["usdc_decimals"])),
                     "network": a["networks"][0], "asset": a["assets"][a["networks"][0]], "item_id": doc["id"],
                     "max_timeout_seconds": a["max_timeout_s"]},
    })
    meta = ListingMeta(listing_id=doc["id"], source=f"scrape:{mkt}", url=src.get("url"), fetched_at=as_of)
    seller = {"seller_id": seller_id, "domain": domain, "pay_to": pay_to, "reviewCount": store.get("reviewCount"),
              "rating": store.get("rating"), "positivePercent": store.get("positivePercent")}
    return listing, meta, seller


def known_list(sellers: dict[str, dict], top: int = KNOWN_TOP) -> list[KnownSeller]:
    good = [s for s in sellers.values()
            if (s["rating"] or 0) >= 4.8 or (s["positivePercent"] or 0) >= 99.5]
    good.sort(key=lambda s: (-(s["reviewCount"] or 0), s["seller_id"]))
    return [KnownSeller(seller_id=s["seller_id"], pay_to=s["pay_to"], domain=s["domain"]) for s in good[:top]
            if (s["reviewCount"] or 0) > 0]


def first_seen(seller: dict, known: set[str], as_of: date) -> str:
    if seller["pay_to"].lower() in known:
        return (as_of - timedelta(days=365)).isoformat()
    if seller["reviewCount"] or seller["rating"]:
        return (as_of - timedelta(days=180)).isoformat()
    return as_of.isoformat()


def medians_of(listings: list[Listing], keys: set[str]) -> list[dict]:
    """Medians from `listings` (the train side). Brand + type groups with at least MIN_SALES sales come first
    (level "product"). Any key in `keys` with no such group gets its type's median per condition across all brands
    (level "type"), so the price check still has a market reference."""
    groups, by_type = defaultdict(list), defaultdict(list)
    for l in listings:
        groups[(l.item.product_key, l.item.condition)].append(l.item.price)
        by_type[(l.item.product_key.split(":", 1)[1], l.item.condition)].append(l.item.price)
    rows = [{"product_key": pk, "condition": c, "median": round(statistics.median(v), 2), "n": len(v), "level": "product"}
            for (pk, c), v in sorted(groups.items()) if len(v) >= MIN_SALES]
    covered = {r["product_key"] for r in rows}
    for pk in sorted(keys - covered):
        t = pk.split(":", 1)[1]
        rows += [{"product_key": pk, "condition": c, "median": round(statistics.median(v), 2), "n": len(v), "level": "type"}
                 for (tt, c), v in sorted(by_type.items()) if tt == t and len(v) >= MIN_SALES]
    return rows


def case_for(l: Listing, med: dict[tuple[str, str], float]) -> Case:
    m = med.get((l.item.product_key, l.item.condition))
    if m is None:
        any_c = sorted(v for (pk, _), v in med.items() if pk == l.item.product_key)
        m = any_c[len(any_c) // 2] if any_c else None
    return Case(listing_id=l.listing_id, mandate=Mandate(product_key=l.item.product_key,
                                                         max_price=round(max(l.item.price, m or 0) * PRICE_FACTOR, 2),
                                                         spend_remaining=SPEND))


def build(docs: list[dict], as_of: str, wallet_history: bool = False) -> dict:
    """Pure mapping (no I/O): returns everything the snapshot files hold."""
    as_of_d = date.fromisoformat(as_of)
    mapped, drops, sellers = [], Counter(), {}
    for doc in docs:
        try:
            l, meta, s = map_doc(doc, as_of)
        except ValueError as e:
            drops[str(e)[:80]] += 1
            continue
        mapped.append((l, meta))
        sellers.setdefault(s["seller_id"], s)
    known = known_list(sellers)
    known_wallets = {k.pay_to.lower() for k in known}
    out = {"train": {"listings": [], "meta": []}, "locked_test": {"listings": [], "meta": []}}
    for l, meta in mapped:
        side = side_of(l.seller.id)
        out[side]["listings"].append(l)
        out[side]["meta"].append(meta)
    all_keys = {l.item.product_key for side in out.values() for l in side["listings"]}
    med_rows = medians_of(out["train"]["listings"], all_keys)
    med = {(m["product_key"], m["condition"]): m["median"] for m in med_rows}
    for side in out.values():
        side["cases"] = [case_for(l, med) for l in side["listings"]]
        side["wallets"] = {sellers[l.seller.id]["pay_to"].lower(): first_seen(sellers[l.seller.id], known_wallets, as_of_d)
                           for l in side["listings"]} if wallet_history else {}
    every = [KnownSeller(seller_id=s["seller_id"], pay_to=s["pay_to"], domain=s["domain"]) for s in sellers.values()]
    return {"sides": out, "known": known, "known_all": every, "medians": med_rows, "drops": dict(drops),
            "sellers": sellers, "wallet_history": wallet_history}


def summarize(snap: dict, n_docs: int, as_of: str, scrape_state: list) -> dict:
    cap = allowlist()["unknown_seller_cap_usd"]
    known = {k.pay_to.lower() for k in snap["known"]}
    sides = {}
    for name, side in snap["sides"].items():
        ls = side["listings"]
        sides[name] = {
            "listings": len(ls), "sellers": len({l.seller.id for l in ls}),
            "by_marketplace": dict(Counter(l.seller.domain for l in ls)),
            "by_condition": dict(Counter(l.item.condition for l in ls)),
            "trust": dict(Counter("known" if l.checkout.pay_to.lower() in known else
                                  ("unknown_within_cap" if l.item.price <= cap else "unknown_over_cap") for l in ls)),
            "with_median": sum(1 for l in ls if l.item.product_key in {m["product_key"] for m in snap["medians"]}),
        }
    keys = Counter(l.item.product_key for s in snap["sides"].values() for l in s["listings"])
    return {
        "mapping_version": MAPPING_VERSION, "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "as_of": as_of, "source": "calhacks.listings (read-only)", "source_docs": n_docs, "drops": snap["drops"],
        "scrape_state": scrape_state, "split": f"sha256(seller.id) % {LOCKED_SHARE} == 0 -> locked_test",
        "known_rule": f"top {KNOWN_TOP} by reviewCount among rating >= 4.8 or positivePercent >= 99.5",
        "wallet_history": snap.get("wallet_history", False),
        "known_sellers": len(snap["known"]), "all_sellers": len(snap["known_all"]),
        "medians": {"rows": len(snap["medians"]), "min_sales": MIN_SALES, "from": "train side only",
                    "by_level": dict(Counter(m["level"] for m in snap["medians"]))},
        "product_keys": {"distinct": len(keys), "top": keys.most_common(15)},
        "sides": sides,
    }


def _jsonl(path: Path, models) -> str:
    body = "".join(m.model_dump_json() + "\n" for m in models)
    path.write_text(body, encoding="utf-8", newline="\n")
    return hashlib.sha256(body.encode()).hexdigest()


def write(snap: dict, manifest: dict, out: Path) -> dict:
    hashes = {}
    for name, side in snap["sides"].items():
        d = out / name
        d.mkdir(parents=True, exist_ok=True)
        hashes[f"{name}/listings.jsonl"] = _jsonl(d / "listings.jsonl", side["listings"])
        hashes[f"{name}/meta.jsonl"] = _jsonl(d / "meta.jsonl", side["meta"])
        hashes[f"{name}/cases.jsonl"] = _jsonl(d / "cases.jsonl", side["cases"])
        (d / "wallets.json").write_text(json.dumps(side["wallets"], indent=1), encoding="utf-8")
    (out / "known_sellers.json").write_text(json.dumps([k.model_dump(mode="json") for k in snap["known"]], indent=1),
                                           encoding="utf-8")
    (out / "known_sellers_all.json").write_text(
        json.dumps([k.model_dump(mode="json") for k in snap["known_all"]], indent=1), encoding="utf-8")
    (out / "medians.json").write_text(json.dumps(snap["medians"], indent=1), encoding="utf-8")
    manifest["hashes"] = hashes
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, default=str), encoding="utf-8")
    return manifest


def read_scrape(db_name: str = "calhacks") -> tuple[list[dict], list]:
    """Read-only: one find() over calhacks.listings (images dropped) and the scrape_state documents."""
    import os

    from dotenv import load_dotenv
    from pymongo import MongoClient

    from redteam.config import REPO
    for f in (REPO / ".env.local", REPO / ".env"):
        if f.exists():
            load_dotenv(f)
    db = MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=20000, appname="calhacks-scrape-map")[db_name]
    # Listings planted as scams by redteam.plant carry a `scam` field; they are not real bases.
    docs = list(db.listings.find({"scam": {"$exists": False}}, {"item.images": 0}).sort("_id", 1))
    return docs, list(db.scrape_state.find())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--as-of", default=date.today().isoformat())
    ap.add_argument("--wallet-history", action="store_true", help="heuristic first-seen dates (comparison runs only)")
    a = ap.parse_args(argv)
    if (a.out / "manifest.json").exists():
        print(json.dumps({"error": f"{a.out} already holds a snapshot; snapshots are frozen"}))
        return 2
    docs, state = read_scrape()
    snap = build(docs, a.as_of, a.wallet_history)
    manifest = write(snap, summarize(snap, len(docs), a.as_of, state), a.out)
    print(json.dumps({k: manifest[k] for k in ("source_docs", "drops", "known_sellers", "medians", "sides")}, indent=1,
                     default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
