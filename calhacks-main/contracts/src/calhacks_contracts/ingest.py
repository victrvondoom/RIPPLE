"""Load real listings and reference data into MongoDB.

  contracts-ingest listings FILE.jsonl --source apify:ebay   # lines: Listing, or {"listing", "meta"?, "mandate"?}
  contracts-ingest known-sellers FILE.json                   # [KnownSeller, ...]
  contracts-ingest medians FILE.json --source NAME           # [{"product_key", "condition", "median", "n"}, ...]
  contracts-ingest stats                                     # document count per collection

Real listings are recorded as honest (answer key: legit / real). Each gets a default mandate for offline evaluation:
product_key = its own, max_price = max(price, median) * --max-price-factor, spend_remaining = --spend.
"""
import argparse, json, sys
from datetime import datetime, timezone
from pathlib import Path

from calhacks_contracts.db import Repo, get_db
from calhacks_contracts.gate import Case, KnownSeller, Mandate
from calhacks_contracts.listing import Listing, ListingMeta


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def default_mandate(listing: Listing, median: float | None, factor: float, spend: float) -> Mandate:
    return Mandate(product_key=listing.item.product_key,
                   max_price=round(max(listing.item.price, median or 0) * factor, 2), spend_remaining=spend)


def ingest_listings(repo: Repo, lines, source: str, factor: float = 1.25, spend: float = 100.0) -> tuple[int, list[str]]:
    refs = repo.reference_snapshot()
    ok, errors = 0, []
    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
            body = raw.get("listing", raw)
            listing = Listing.model_validate(body)
            meta = ListingMeta.model_validate({"listing_id": listing.listing_id, "source": source,
                                               "fetched_at": _now(), **(raw.get("meta") or {})})
            mandate = (Mandate.model_validate(raw["mandate"]) if raw.get("mandate") else
                       default_mandate(listing, refs.median(listing.item.product_key, listing.item.condition),
                                       factor, spend))
            repo.put_real(listing, meta, Case(listing_id=listing.listing_id, mandate=mandate))
            ok += 1
        except Exception as e:  # keep going; report every bad line
            errors.append(f"line {n}: {type(e).__name__}: {str(e)[:200]}")
    return ok, errors


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="contracts-ingest")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("listings"); p.add_argument("file"); p.add_argument("--source", required=True)
    p.add_argument("--max-price-factor", type=float, default=1.25); p.add_argument("--spend", type=float, default=100.0)
    sub.add_parser("known-sellers").add_argument("file")
    p = sub.add_parser("medians"); p.add_argument("file"); p.add_argument("--source", required=True)
    sub.add_parser("stats")
    a = ap.parse_args(argv)

    repo = Repo(get_db())
    repo.ensure_indexes()
    out: dict = {}
    if a.cmd == "listings":
        with open(a.file, encoding="utf-8") as f:
            ok, errors = ingest_listings(repo, f, a.source, a.max_price_factor, a.spend)
        out = {"ingested": ok, "errors": errors[:50], "n_errors": len(errors)}
    elif a.cmd == "known-sellers":
        rows = [KnownSeller.model_validate(r) for r in json.loads(Path(a.file).read_text(encoding="utf-8"))]
        for r in rows:
            repo.put_known_seller(r)
            repo.touch_wallet(r.pay_to, "2000-01-01")
        out = {"known_sellers": len(rows)}
    elif a.cmd == "medians":
        rows = json.loads(Path(a.file).read_text(encoding="utf-8"))
        built = _now()
        for r in rows:
            repo.put_median(r["product_key"], r["condition"], float(r["median"]), int(r.get("n", 0)), a.source, built)
        out = {"market_medians": len(rows)}
    out["counts"] = repo.counts()
    print(json.dumps(out, indent=1))
    return 1 if out.get("n_errors") else 0


if __name__ == "__main__":
    sys.exit(main())
