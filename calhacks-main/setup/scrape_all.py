"""Scrape Amazon, eBay and Depop at once in one process, so every Apify run shares one gate
(5 runs and 16 GB across the account, see apify_common.Gate).

Usage (from anywhere): python setup/scrape_all.py [--count N] [--continue]
"""

from concurrent.futures import ThreadPoolExecutor

import scrape_amazon
import scrape_depop
import scrape_ebay
from apify_common import QUERY, parse_args, run

SCRAPERS = (scrape_amazon.SPEC, scrape_ebay.SPEC, scrape_depop.SPEC)


def main() -> None:
    args = parse_args(f"Scrape Amazon, eBay and Depop listings for {QUERY!r} into MongoDB, in parallel.")

    def one(spec: dict) -> str:
        try:
            run(**spec, count=args.count, resume=args.resume)
            return "done"
        except BaseException as e:  # SystemExit from a scraper ends only that marketplace
            return f"failed: {e}"

    with ThreadPoolExecutor(max_workers=len(SCRAPERS)) as pool:
        results = dict(zip((s["marketplace"] for s in SCRAPERS), pool.map(one, SCRAPERS)))
    print("\n== summary")
    for marketplace, result in results.items():
        print(f"{marketplace:7} {result}")
    if any(r != "done" for r in results.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
