"""Client for the store-crawler Standby Actor (apps/agent/api/actor): yields its search events live."""

import json
import os
from collections.abc import AsyncIterator

import httpx

# The three real stores plus the mzn Official Outlet scam lookalike, so the Gate sees scams in every search.
REAL_STORES = ["https://amazon.hntr.store", "https://ebay.hntr.store", "https://depop.hntr.store"]
STORES = [*REAL_STORES, "https://amazon-outlet.hntr.store"]


def actor_url() -> str:
    url = os.environ.get("APIFY_ACTOR_URL")
    if not url:
        raise RuntimeError("APIFY_ACTOR_URL missing: the Standby URL, or http://localhost:4321 for a local actor")
    return url.rstrip("/")


async def search(client: httpx.AsyncClient, query: str, max_per_store: int = 0) -> AsyncIterator[dict]:
    """Events from the actor (listing, store, page, error, done) as they arrive. See actor/src/search.py."""
    stores = os.environ.get("STORE_URLS")
    params = {"q": query, "max": max_per_store, "stores": stores or ",".join(STORES)}
    token = os.environ.get("APIFY_TOKEN")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with client.stream("GET", f"{actor_url()}/search", params=params, headers=headers) as res:
        res.raise_for_status()
        async for line in res.aiter_lines():
            if line:
                yield json.loads(line)
