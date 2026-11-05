"""Client for the Gate (gate/, its own service). Both calls answer a GateDecision from Layer 1's rules and then the
red-teamed model (gates/CURRENT):

  screen  POST {GATE_URL}/screen, for every listing a search finds: the mandate, which listing (its page URL) and the
          page the store crawler already read. The Gate adds its own cached catalog and store.json, so this takes
          milliseconds and never waits on the store.
  judge   POST {GATE_URL}/decide, once, for the listing about to be bought: the mandate and which listing only. The
          Gate reads the page and asks the store's checkout what it would really charge (the 402) itself.

Product matching stays here, before anything can be bought (rank.qualified), so the mandate names the listing's own
product key. Any error, timeout, non-200 answer or missing GATE_URL is a skip, like the Gate's own fail-closed 503.
"""

import os
from urllib.parse import urlparse

import httpx
from calhacks_contracts import GateDecision

SCREEN_TIMEOUT = 10  # Seconds. Screening reads nothing from the store.
TIMEOUT = 30  # Seconds for the check before paying: the Gate reads the store's page and asks its checkout for the 402.


def request(listing: dict, max_price: float | None) -> dict:
    """The GateRequest for one listing. Without a limit from the user there is no over-limit check."""
    limit = max_price if max_price is not None else listing["price"]
    return {"mandate": {"product_key": f"{urlparse(listing['store']).hostname}:{listing['key']}",
                        "max_price": limit, "spend_remaining": limit},
            "proposal": {"listing_id": listing["url"]},
            "references": {"known_sellers": []}}  # The Gate looks references up itself.


def unavailable(error: str) -> dict:
    """No decision means nothing was judged: skip. `error` rides alongside the GateDecision fields, like the
    verdict's store and key."""
    return {**GateDecision(decision="skip", decided_by=None).model_dump(), "error": error}


def crawled(listing: dict, page: dict) -> dict:
    """What the store crawler read, as the Gate's /screen takes it."""
    return {"key": listing["key"], "title": listing.get("title") or "", "price": listing["price"],
            "seller": listing.get("seller"),
            "page": {"text": page.get("text") or "", "hiddenText": page.get("hiddenText") or []}}


async def screen(client: httpx.AsyncClient, listing: dict, page: dict, max_price: float | None) -> dict:
    """The Gate's decision on a listing from the page the crawler read, or a skip when it can't be had."""
    return await _ask(client, "screen", listing, {**request(listing, max_price), "crawled": crawled(listing, page)},
                      SCREEN_TIMEOUT)


async def judge(client: httpx.AsyncClient, listing: dict, max_price: float | None) -> dict:
    """The Gate's full check of the listing about to be bought, or a skip when it can't be had."""
    return await _ask(client, "decide", listing, request(listing, max_price), TIMEOUT)


async def _ask(client: httpx.AsyncClient, path: str, listing: dict, body: dict, timeout: float) -> dict:
    url = os.environ.get("GATE_URL")
    if not url:
        return unavailable("GATE_URL is not set")
    if not listing.get("url"):
        return unavailable("the listing has no page to judge")
    try:
        res = await client.post(f"{url.rstrip('/')}/{path}", json=body, timeout=timeout)
        reply = res.json()
        if res.status_code != 200:
            return unavailable(reply.get("error") or f"the Gate answered {res.status_code}")
        return GateDecision.model_validate(reply).model_dump()
    except (httpx.HTTPError, ValueError) as e:  # ValueError: bad JSON, or a reply that isn't a GateDecision.
        return unavailable(f"the Gate is unreachable ({type(e).__name__})")
