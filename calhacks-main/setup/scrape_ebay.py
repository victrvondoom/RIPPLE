"""Scrape eBay listings for QUERY into MongoDB in the listing format.

Usage (from anywhere): python setup/scrape_ebay.py [--count N] [--continue]
To run alongside Amazon and Depop, use scrape_all.py so all runs share one Apify gate.
"""

from html.parser import HTMLParser
from urllib.parse import quote_plus

from apify_common import QUERY, cli, compact, condition, count, listing, num, scrape_retrying

PAGE_SIZE = 60  # set with _ipg, and caps each run so the actor never crosses into the next page
ACTOR = "dtrungtin~ebay-search-scraper"  # Apify Store "eBay Search Scraper", detail pages on by default
FEEDBACK_STARS = {"positive": 5, "neutral": 3, "negative": 1}


class _Text(HTMLParser):
    """Collect visible text from the seller's description HTML."""

    def __init__(self):
        super().__init__()
        self.parts, self._skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip and data.strip():
            self.parts.append(data.strip())


def html_text(html: str | None) -> str | None:
    if not html:
        return None
    parser = _Text()
    parser.feed(html)
    return "\n".join(parser.parts) or None


def to_listing(it: dict) -> dict:
    specifics = dict(it.get("itemSpecifics") or {})
    # "Condition" holds eBay's full definition text, keep only the label before the colon
    if "Condition" in specifics:
        specifics["Condition"] = specifics["Condition"].split(":")[0]
    positive = num(it.get("sellerFeedbackPercent"))
    return listing(
        "ebay", external_id(it), it.get("url"),
        store={
            "name": it.get("seller"),
            "sellerId": it.get("seller"),
            "rating": round(positive / 20, 1) if positive is not None else None,  # % positive on a 5-star scale
            "reviewCount": count(it.get("sellerFeedbackCount")),
            "positivePercent": positive,
            "location": it.get("itemLocation"),
        },
        item={
            "title": it.get("title"),
            "price": num(it.get("price")),
            "condition": condition(it.get("condition") or specifics.get("Condition")),
            # ponytail: the actor's descriptionHtml has been an empty iframe shell, so fall back to the subtitle
            "description": html_text(it.get("descriptionHtml")) or it.get("subTitle") or None,
            "listPrice": num(it.get("wasPrice")),
            "images": it.get("images") or compact([it.get("image")]),
            "brand": it.get("brand") or specifics.get("Brand"),
            "category": it.get("type") or specifics.get("Type"),
            "attributes": specifics,
            "stock": count(it.get("available")),
            "stats": {"sold": count(it.get("sold"))},
        },
        # eBay shows seller feedback, not product reviews
        reviews=[
            {
                "author": f.get("username"),
                "date": f.get("date"),
                "rating": FEEDBACK_STARS.get(f.get("rating")),
                # ponytail: comment field name is undocumented, check the raw dump and fix if empty
                "body": f.get("comment") or f.get("text") or "",
                "verified": f.get("verifiedPurchase"),
            }
            for f in it.get("sellerFeedbacks") or []
        ],
    )


def external_id(it: dict) -> str:
    return str(it["itemNumber"])


def fetch(token: str, page: int, cap: int) -> list[dict]:
    url = f"https://www.ebay.com/sch/i.html?_nkw={quote_plus(QUERY)}&_pgn={page}&_ipg={PAGE_SIZE}"
    # fixed 128 MB: this run is a thin wrapper, the browser work runs on the actor developer's account
    items = scrape_retrying(token, ACTOR, {"startUrls": [{"url": url}], "maxItems": cap}, f"ebay listing[p{page}]",
                            min_memory=128, scale=False, priority=0)
    return [it for it in items if it.get("itemNumber")]


SPEC = {"marketplace": "ebay", "fetch": fetch, "external_id": external_id, "page_size": PAGE_SIZE,
        "build": lambda token, items: [to_listing(it) for it in items]}

if __name__ == "__main__":
    cli(SPEC)
