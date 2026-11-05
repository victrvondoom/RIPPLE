"""Search x402 storefronts and yield events as results arrive.

Per store, catalog and store.json are fetched in parallel: listings stream out as soon as the
catalog lands (~250ms) instead of waiting on store.json (1.5-3s, it reads the wallet per request).
Item pages are then fetched under one shared concurrency limit and emitted as each one finishes.

Events, in arrival order:
  {"type": "listing", "store": origin, "storeName", "key", "title", "price", ...catalog fields, "url", "checkoutUrl"}
  {"type": "store", "store": origin, "name", "payTo", "network", "currency"}
  {"type": "page", "store": origin, "key", "page": {title, h1, text, images, hiddenText, jsonLd}}
  {"type": "error", "store": origin, "key"?, "error"}
  {"type": "done", "listings", "pages", "errors", "ms"}
"""

import asyncio
import re
import time
from collections.abc import AsyncIterator
from urllib.parse import urlencode, urljoin

import httpx

from src.extract import extract_page

CATALOG_PATH = "/api/catalog"  # ponytail: every store uses the shared route; read store.json endpoints if one ever differs


def origin(store: str) -> str:
    """Normalize a store to https://host. Apify's Standby proxy collapses "//" in query strings, so
    "https://ebay.hntr.store" can arrive as "https:/ebay.hntr.store"; bare hostnames work too."""
    host = re.sub(r"^https?:/*", "", store.strip()).rstrip("/")
    scheme = "http" if store.strip().startswith("http:") else "https"
    return f"{scheme}://{host}"


def catalog_url(origin: str, query: str) -> str:
    """The store ranks its own catalog by the query (Atlas Vector Search), so only what the shopper asked for is crawled.
    An empty query lists the whole catalog."""
    return urljoin(origin, CATALOG_PATH) + (f"?{urlencode({'q': query})}" if query.strip() else "")


async def get(client: httpx.AsyncClient, url: str, attempts: int = 3) -> httpx.Response:
    """GET with retries on network errors, 429 and 5xx. Other statuses are the store's real answer."""
    for attempt in range(1, attempts + 1):
        try:
            res = await client.get(url)
            if res.status_code != 429 and res.status_code < 500:
                return res.raise_for_status()
            if attempt == attempts:
                return res.raise_for_status()
        except httpx.TransportError:
            if attempt == attempts:
                raise
        await asyncio.sleep(0.25 * 2 ** attempt)
    raise AssertionError("unreachable")


async def search(client: httpx.AsyncClient, origins: list[str], query: str = "", max_per_store: int = 0,
                 details: bool = True, concurrency: int = 50) -> AsyncIterator[dict]:
    t0 = time.perf_counter()
    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    limit = asyncio.Semaphore(concurrency)
    counts = {"listings": 0, "pages": 0, "errors": 0}

    async def emit(event: dict) -> None:
        if (counter := event["type"] + "s") in counts:
            counts[counter] += 1
        await queue.put(event)

    async def page(origin: str, item: dict) -> None:
        async with limit:
            try:
                html = (await get(client, item["url"])).text
                # ~10ms of parsing per page; in a thread it overlaps the other fetches (lxml releases the GIL)
                event = {"type": "page", "store": origin, "key": item["key"],
                         "page": await asyncio.to_thread(extract_page, html)}
            except Exception as e:  # one bad page must not end the search
                event = {"type": "error", "store": origin, "key": item["key"], "error": repr(e)}
        await emit(event)

    async def meta(origin: str) -> None:
        try:
            info = (await get(client, urljoin(origin, "/.well-known/store.json"))).json()
            await emit({"type": "store", "store": origin, **{k: info.get(k) for k in ("name", "payTo", "network", "currency")}})
        except Exception as e:
            await emit({"type": "error", "store": origin, "error": f"store.json: {e!r}"})

    async def store(origin: str) -> None:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(meta(origin))
            try:
                catalog = (await get(client, catalog_url(origin, query))).json()
            except Exception as e:
                await emit({"type": "error", "store": origin, "error": f"catalog: {e!r}"})
                return
            for item in catalog.get("items", [])[:max_per_store or None]:
                item = {**item,
                        "url": item.get("path") and urljoin(origin, item["path"]),
                        "checkoutUrl": item.get("checkoutUrl") and urljoin(origin, item["checkoutUrl"])}
                await emit({"type": "listing", "store": origin, "storeName": catalog.get("store"), **item})
                if details and item["url"]:
                    tg.create_task(page(origin, item))

    async def run() -> None:
        try:
            async with asyncio.TaskGroup() as tg:
                for origin in origins:
                    tg.create_task(store(origin))
        finally:
            await queue.put(None)

    runner = asyncio.create_task(run())
    try:
        while (event := await queue.get()) is not None:
            yield event
        await runner  # surfaces a bug in run() instead of ending the stream silently
        yield {"type": "done", **counts, "ms": round((time.perf_counter() - t0) * 1000)}
    finally:
        runner.cancel()  # client went away: stop fetching
