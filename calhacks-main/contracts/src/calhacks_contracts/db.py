"""MongoDB access shared by the Gate and the red-team loop.

Database `$MONGODB_DB_REDTEAM` (default `redteam`) on `$MONGODB_URI`. Env is read from the nearest `.env.local`
then `.env`, walking up from the working directory (shell variables win).

Collections (the Gate only ever reads `listings`, `cases` and the reference collections):

| Collection | One document per | Contents |
|---|---|---|
| listings | listing | `Listing` (real or synthetic; same shape, nothing that reveals which) |
| listing_meta | listing | `ListingMeta`: source, url, fetched_at |
| answer_keys | listing | `AnswerKey`: label, family, base listing, attack diff |
| gen | synthetic listing | `GenInfo`: model, temperature, prompt version, spec id |
| cases | listing | `Case`: the mandate the listing is evaluated under |
| known_sellers | seller | `KnownSeller` |
| market_medians | product_key + condition | {product_key, condition, median, n, source, built_at} |
| wallets | pay_to | {pay_to, first_seen} |
| specs | attack spec | `AttackSpec` + round + status |
| rounds | round | `RoundInput` / `RoundReport` |

Holdout listings are never written here; they stay encrypted outside the repo.
"""
import os
from collections.abc import Iterable, Iterator
from datetime import date
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient, ReplaceOne
from pymongo.database import Database

from calhacks_contracts.gate import Case, KnownSeller, References
from calhacks_contracts.listing import Listing, ListingMeta
from calhacks_contracts.synthetic import AnswerKey, GenInfo, SyntheticListing

DEFAULT_DB = "redteam"


def load_env(start: Path | None = None) -> None:
    here = (start or Path.cwd()).resolve()
    for d in (here, *here.parents):
        for name in (".env.local", ".env"):
            if (d / name).is_file():
                load_dotenv(d / name)


def get_db(uri: str | None = None, name: str | None = None) -> Database:
    load_env()
    uri = uri or os.environ.get("MONGODB_URI")
    if not uri:
        raise RuntimeError("MONGODB_URI is not set (put it in .env.local at the repo root)")
    client = MongoClient(uri, appname="calhacks-redteam", serverSelectionTimeoutMS=15000, tz_aware=False)
    return client[name or os.environ.get("MONGODB_DB_REDTEAM", DEFAULT_DB)]


def _doc(model, key: str) -> dict:
    d = model.model_dump(mode="json")
    d["_id"] = d[key]
    return d


def _strip(d: dict | None) -> dict | None:
    if d is not None:
        d = dict(d)
        d.pop("_id", None)
    return d


class Repo:
    def __init__(self, db: Database):
        self.db = db

    def ensure_indexes(self) -> None:
        self.db.market_medians.create_index([("product_key", 1), ("condition", 1)], unique=True)
        self.db.answer_keys.create_index("family")
        self.db.answer_keys.create_index("label")
        self.db.listing_meta.create_index("source")
        self.db.gen.create_index("spec_id")

    # ---------- listings ----------
    def put_listings(self, listings: Iterable[Listing], meta: Iterable[ListingMeta] = ()) -> int:
        ops = [ReplaceOne({"_id": l.listing_id}, _doc(l, "listing_id"), upsert=True) for l in listings]
        if ops:
            self.db.listings.bulk_write(ops, ordered=False)
        mops = [ReplaceOne({"_id": m.listing_id}, _doc(m, "listing_id"), upsert=True) for m in meta]
        if mops:
            self.db.listing_meta.bulk_write(mops, ordered=False)
        return len(ops)

    def put_real(self, listing: Listing, meta: ListingMeta, case: Case | None = None) -> None:
        """A real listing is assumed honest: answer key label legit, family 'real'."""
        self.put_listings([listing], [meta])
        self.put_answer_keys([AnswerKey(listing_id=listing.listing_id, label="legit", family="real")])
        self.touch_wallet(listing.seller.pay_to, (meta.fetched_at or date.today().isoformat())[:10])
        if case:
            self.put_cases([case])

    def put_synthetic(self, items: Iterable[tuple[SyntheticListing, Case]], source: str = "synthetic") -> int:
        items = list(items)
        self.put_listings([s.listing for s, _ in items],
                          [ListingMeta(listing_id=s.listing.listing_id, source=source) for s, _ in items])
        self.put_answer_keys([s.answer_key for s, _ in items])
        gops = [ReplaceOne({"_id": s.gen.listing_id}, _doc(s.gen, "listing_id"), upsert=True) for s, _ in items]
        if gops:
            self.db.gen.bulk_write(gops, ordered=False)
        self.put_cases([c for _, c in items])
        return len(items)

    def put_answer_keys(self, keys: Iterable[AnswerKey]) -> None:
        ops = [ReplaceOne({"_id": k.listing_id}, _doc(k, "listing_id"), upsert=True) for k in keys]
        if ops:
            self.db.answer_keys.bulk_write(ops, ordered=False)

    def put_cases(self, cases: Iterable[Case]) -> None:
        ops = [ReplaceOne({"_id": c.listing_id}, _doc(c, "listing_id"), upsert=True) for c in cases]
        if ops:
            self.db.cases.bulk_write(ops, ordered=False)

    def get_listing(self, listing_id: str) -> Listing | None:
        d = _strip(self.db.listings.find_one({"_id": listing_id}))
        return Listing.model_validate(d) if d else None

    def listings(self, ids: Iterable[str] | None = None) -> Iterator[Listing]:
        q = {} if ids is None else {"_id": {"$in": list(ids)}}
        for d in self.db.listings.find(q):
            yield Listing.model_validate(_strip(d))

    def answer_keys(self, query: dict | None = None) -> Iterator[AnswerKey]:
        for d in self.db.answer_keys.find(query or {}):
            yield AnswerKey.model_validate(_strip(d))

    def real_listing_ids(self) -> list[str]:
        return [d["_id"] for d in self.db.answer_keys.find({"family": "real"}, {"_id": 1})]

    def case(self, listing_id: str) -> Case | None:
        d = _strip(self.db.cases.find_one({"_id": listing_id}))
        return Case.model_validate(d) if d else None

    def cases(self, ids: Iterable[str] | None = None) -> dict[str, Case]:
        q = {} if ids is None else {"_id": {"$in": list(ids)}}
        return {d["_id"]: Case.model_validate(_strip(d)) for d in self.db.cases.find(q)}

    # ---------- references ----------
    def put_known_seller(self, s: KnownSeller) -> None:
        self.db.known_sellers.replace_one({"_id": s.seller_id}, _doc(s, "seller_id"), upsert=True)

    def put_median(self, product_key: str, condition: str, median: float, n: int, source: str, built_at: str) -> None:
        self.db.market_medians.replace_one(
            {"product_key": product_key, "condition": condition},
            {"product_key": product_key, "condition": condition, "median": median, "n": n, "source": source,
             "built_at": built_at}, upsert=True)

    def touch_wallet(self, pay_to: str, seen: str) -> None:
        """Record when a wallet was first seen (keeps the earliest date)."""
        self.db.wallets.update_one({"_id": pay_to.lower()}, {"$min": {"first_seen": seen}}, upsert=True)

    def known_sellers(self) -> list[KnownSeller]:
        return [KnownSeller.model_validate(_strip(d)) for d in self.db.known_sellers.find()]

    def reference_snapshot(self) -> "ReferenceSet":
        """Load every reference collection once, so decisions make no further database calls (G2)."""
        return ReferenceSet(
            known_sellers=self.known_sellers(),
            medians={(d["product_key"], d["condition"]): d["median"] for d in self.db.market_medians.find()},
            wallets={d["_id"]: d.get("first_seen") for d in self.db.wallets.find()},
        )

    def counts(self) -> dict[str, int]:
        return {c: self.db[c].estimated_document_count() for c in sorted(self.db.list_collection_names())}


class ReferenceSet:
    """In-memory copy of the reference collections. `for_listing` builds the Gate's `References`."""

    def __init__(self, known_sellers: list[KnownSeller], medians: dict[tuple[str, str], float],
                 wallets: dict[str, str | None]):
        self.known_sellers, self.medians, self.wallets = known_sellers, medians, wallets

    def overlay(self, wallets: dict[str, str] | None = None) -> "ReferenceSet":
        """A copy with extra simulated wallet first-seen dates (e.g. for holdout sellers that never enter the database)."""
        return ReferenceSet(self.known_sellers, self.medians,
                            {**self.wallets, **{k.lower(): v for k, v in (wallets or {}).items()}})

    def median(self, product_key: str, condition: str) -> float | None:
        if (product_key, condition) in self.medians:
            return self.medians[(product_key, condition)]
        any_cond = [v for (pk, _), v in self.medians.items() if pk == product_key]
        return sorted(any_cond)[len(any_cond) // 2] if any_cond else None

    def for_listing(self, listing: Listing) -> References:
        return References(
            known_sellers=self.known_sellers,
            market_median=self.median(listing.item.product_key, listing.item.condition),
            pay_to_first_seen=self.wallets.get(listing.checkout.pay_to.lower()),
        )
