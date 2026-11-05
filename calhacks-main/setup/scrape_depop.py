"""Scrape Depop listings for QUERY into MongoDB in the listing format.

Usage (from anywhere): python setup/scrape_depop.py [--count N] [--continue]
To run alongside Amazon and eBay, use scrape_all.py so all runs share one Apify gate.
"""

from apify_common import QUERY, cli, condition, listing, scrape_retrying

# khadinakbar~depop-scraper was tried first: Depop's anti-bot (403) left it with title and description only.
ACTOR = "markdolanmoore~depop-scraper"  # Apify Store "Depop Scraper - Listings, Sellers & Brands"
INPUT = {
    "mode": "search",
    "queries": [QUERY],
    "country": "us",
    "currency": "USD",
    "enrichDetail": True,  # description, condition, location
    "includeSeller": True,  # documented to add seller stats, but returned none in testing
    "proxyConfiguration": {"useApifyProxy": True},
}


def to_listing(it: dict) -> dict:
    seller = it.get("seller") or {}
    # ponytail: Depop slugs start with the seller's handle, the only seller identity we get today
    handle = seller.get("username") or it["slug"].split("-")[0]
    return listing(
        "depop", external_id(it), it.get("url"),
        store={
            "name": handle,
            "sellerId": handle,
            "rating": seller.get("rating"),
            "reviewCount": seller.get("reviewCount"),
            "itemsSold": seller.get("itemsSold"),
            "location": it.get("location"),
        },
        item={
            "title": it.get("title"),
            "price": (it.get("price") or {}).get("amount"),
            "condition": condition(it.get("condition")),
            "description": it.get("description"),
            "listPrice": (it.get("originalPrice") or {}).get("amount"),
            "images": it.get("images") or [],
            "brand": it.get("brand"),
            "category": it.get("category"),
            "attributes": {k: v for k, v in {
                "Size": it.get("size"),
                "Colour": ", ".join(it.get("colours") or []),
            }.items() if v},
            "stock": 0 if it.get("isSold") else 1,  # Depop listings are single items
        },
        reviews=[],  # the actor returns no review text
    )


def external_id(it: dict) -> str:
    return it["slug"]


def fetch(token: str, page: int, cap: int) -> list[dict]:
    """Depop has no pages: re-read the same result list with a bigger cap and let run() skip seen ones."""
    # ponytail: so a continued run pays again for the listings it skips, Depop gives us no offset
    items = scrape_retrying(token, ACTOR, {**INPUT, "maxItems": cap}, "depop listing",
                            min_memory=512, priority=0)  # peaked at 143 MB
    return [it for it in items if it.get("slug")]


SPEC = {"marketplace": "depop", "fetch": fetch, "external_id": external_id, "page_size": None,
        "build": lambda token, items: [to_listing(it) for it in items]}

if __name__ == "__main__":
    cli(SPEC)
