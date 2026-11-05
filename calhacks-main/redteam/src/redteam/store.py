"""The red team's MongoDB handle, plus round bookkeeping on top of calhacks_contracts.db.Repo.

Round membership: every synthetic listing's GenInfo.spec_id points at a `specs` document carrying its round.
Real listings (answer key family "real") belong to every round.

Tests: REDTEAM_MONGOMOCK=1 makes repo() an in-memory mongomock database seeded from contracts/tests/fixtures
(used by subprocess tests such as the stdio MCP server test). Never set it for real runs.

Local dry runs: REDTEAM_LOCAL_STORE=<dir> makes repo() an in-memory database loaded from <dir>/<collection>.jsonl;
flush() writes it back (atomically, one file per collection) and reload() drops the in-memory copy so the next repo()
reads the files again. Nothing touches MongoDB in this mode.
"""
import json
import os
import threading
from pathlib import Path
from collections import Counter
from collections.abc import Iterable
from datetime import datetime, timezone

from calhacks_contracts import AnswerKey, Case, KnownSeller, Listing
from calhacks_contracts.db import Repo, get_db
from calhacks_contracts.families import CONTRACTS_DIR
from calhacks_contracts.splits import split_of

_repo: Repo | None = None


def local_dir() -> Path | None:
    d = os.environ.get("REDTEAM_LOCAL_STORE")
    return Path(d) if d else None


def repo() -> Repo:
    global _repo
    if _repo is None:
        if local_dir():
            _repo = load_local(local_dir())
        elif os.environ.get("REDTEAM_MONGOMOCK") == "1":
            _repo = seeded_mock_repo()
        else:
            _repo = Repo(get_db())
            _repo.ensure_indexes()
    return _repo


def set_repo(r: Repo | None) -> None:
    global _repo
    _repo = r


def _patch_mongomock():
    """mongomock can't take pymongo 4.10+ ReplaceOne objects in bulk_write; apply them one by one."""
    import mongomock
    from pymongo import ReplaceOne

    def _bulk_write(self, requests, ordered=True, **_):
        for r in requests:
            assert isinstance(r, ReplaceOne)
            self.replace_one(r._filter, r._doc, upsert=r._upsert)

    mongomock.collection.Collection.bulk_write = _bulk_write
    return mongomock


def empty_local_repo() -> Repo:
    return Repo(_patch_mongomock().MongoClient()["redteam_local"])


def load_local(d: Path) -> Repo:
    r = empty_local_repo()
    for f in sorted(Path(d).glob("*.jsonl")):
        docs = [json.loads(line) for line in f.read_text(encoding="utf-8").splitlines() if line.strip()]
        if docs:
            r.db[f.stem].insert_many(docs)
    return r


_FLUSH_LOCK = threading.Lock()


def write_local(r: Repo, d: Path) -> None:
    d = Path(d)
    d.mkdir(parents=True, exist_ok=True)
    with _FLUSH_LOCK:  # tool calls can run in parallel threads
        for name in r.db.list_collection_names():
            body = "".join(json.dumps(doc, default=str, ensure_ascii=False) + "\n" for doc in r.db[name].find())
            tmp = d / f".{name}.{os.getpid()}.{threading.get_ident()}.tmp"
            tmp.write_text(body, encoding="utf-8", newline="\n")
            os.replace(tmp, d / f"{name}.jsonl")


def flush() -> None:
    """Local dry runs only: write the in-memory store back to REDTEAM_LOCAL_STORE."""
    if local_dir() and _repo is not None:
        write_local(_repo, local_dir())


def reload() -> None:
    """Local dry runs only: forget the in-memory copy so the next repo() re-reads the files another process wrote."""
    global _repo
    if local_dir():
        _repo = None


def seeded_mock_repo() -> Repo:
    """mongomock Repo holding the contracts test fixtures as real listings and references (tests only)."""
    mongomock = _patch_mongomock()
    from calhacks_contracts.ingest import ingest_listings

    r = Repo(mongomock.MongoClient()["redteam_mock"])
    fx = CONTRACTS_DIR / "tests" / "fixtures"
    refs = json.loads((fx / "references.json").read_text(encoding="utf-8"))
    for k in refs["known_sellers"]:
        r.put_known_seller(KnownSeller.model_validate(k))
        r.touch_wallet(k["pay_to"], "2000-01-01")
    for m in refs["market_medians"]:
        r.put_median(m["product_key"], m["condition"], m["median"], m["n"], "fixture", "2026-10-24")
    rows = json.loads((fx / "real_listings.json").read_text(encoding="utf-8"))
    ingest_listings(r, [json.dumps(x) for x in rows], "fixture")
    return r


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------- specs and rounds ----------
def record_spec(r: Repo, spec: dict, round_: int, summary: dict) -> None:
    r.db.specs.replace_one({"_id": spec["spec_id"]},
                           {"_id": spec["spec_id"], "round": round_, "spec": spec, "summary": summary, "at": now()},
                           upsert=True)


def spec_ids_for(r: Repo, rounds: Iterable[int] | None) -> list[str] | None:
    if rounds is None:
        return None
    return [d["_id"] for d in r.db.specs.find({"round": {"$in": list(rounds)}}, {"_id": 1})]


def save_round(r: Repo, round_: int, **fields) -> None:
    r.db.rounds.update_one({"_id": round_}, {"$set": {**fields, "updated_at": now()}}, upsert=True)


def get_round(r: Repo, round_: int) -> dict | None:
    return r.db.rounds.find_one({"_id": round_})


def all_rounds(r: Repo) -> list[dict]:
    return list(r.db.rounds.find().sort("_id", 1))


# ---------- evaluation items ----------
def listing_ids(r: Repo, *, rounds: Iterable[int] | None = None, include_real: bool = True,
                split: str = "all") -> list[str]:
    """Listing ids for the given rounds (synthetic via their specs) plus real listings, filtered by split."""
    ids: set[str] = set()
    specs = spec_ids_for(r, rounds)
    q = {} if specs is None else {"spec_id": {"$in": specs}}
    ids.update(d["_id"] for d in r.db.gen.find(q, {"_id": 1}))
    if include_real:
        ids.update(r.real_listing_ids())
    if split == "all":
        return sorted(ids)
    splits = split_map(r, ids)
    return sorted(i for i in ids if splits[i] == split)


def split_map(r: Repo, ids: Iterable[str]) -> dict[str, str]:
    """listing id -> train/calibrate/val, grouped by base listing (a synthetic row goes with its real base)."""
    ids = list(ids)
    base = {d["_id"]: d.get("base_listing_id") for d in r.db.answer_keys.find({"_id": {"$in": ids}},
                                                                             {"base_listing_id": 1})}
    return {i: split_of(i, base.get(i)) for i in ids}


def items(r: Repo, ids: list[str]) -> list[tuple[Listing, Case, AnswerKey]]:
    """(Listing, Case, AnswerKey) triples for scoring. Listings without a case or answer key are skipped."""
    listings = {l.listing_id: l for l in r.listings(ids)}
    cases = r.cases(ids)
    keys = {k.listing_id: k for k in r.answer_keys({"_id": {"$in": ids}})}
    return [(listings[i], cases[i], keys[i]) for i in ids if i in listings and i in cases and i in keys]


def coverage(r: Repo) -> dict[str, int]:
    from calhacks_contracts.families import holdout_families
    held = holdout_families()  # never in the shared store anyway; filtered so the coordinator can't see the names
    return dict(sorted(Counter(d["family"] for d in r.db.answer_keys.find({}, {"family": 1})
                               if d["family"] not in held).items()))
