"""The Gate's own view of a live store listing, in two passes.

screen (POST /screen, every listing a search finds): the page text the store crawler already read comes with the
request; the title, price, seller and wallet come from the Gate's own cached copies of the store's catalog and
store.json, and the checkout is what those promise. Nothing is fetched per listing, so screening takes milliseconds.

resolve (POST /decide, the one listing about to be bought): trusts nothing the caller sends but the mandate and which
listing to judge. `proposal.listing_id` is the item page URL. From that store the Gate reads:
  /.well-known/store.json   the wallet the store says it is paid at (seller.pay_to)
  /api/catalog              the listing's title, price and seller
  the item page             its visible text plus the text hidden from humans (where prompt injection lives)
  POST its checkout URL     unpaid, so the store answers 402 with what it would really charge (checkout)
and from the known stores (GATE_KNOWN_STORES) it builds the references: those stores' wallets and domains as the
known sellers, and the median price of the listings in their catalogs whose titles share the most words with this
one as the market median. The page and the 402 are read in parallel. store.json and catalogs are cached and refreshed
in the background, so no request waits on them after startup.

Stores hosted under one shared suffix (GATE_HOSTED_SUFFIX, e.g. ".hntr.store", standing in for amazon.com, ebay.com
and depop.com) are named by their own label as "<label>.com", the way the Gate's training data names marketplace
sites. Otherwise every hosted store would look like a near-copy of every other one to the domain lookalike check.

Only stores in GATE_STORES are read. The item's product key is "{host}:{key}", the same key the caller puts in the
mandate: whether a listing is the item the user asked for is the agent's call before it asks the Gate.
"""
import base64
import json
import os
import re
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import unquote, urljoin, urlparse

import httpx
from calhacks_contracts import GateInput, GateRequest, KnownSeller, Listing, Mandate, Proposal, References
from calhacks_contracts.families import allowlist
from pydantic import BaseModel, Field

from gatepy.page import extract_page

CACHE_S = 300  # store.json and catalogs change rarely; prices are re-read from the 402 on every decision
MEDIAN_MATCHES = 5  # closest title matches per known store
TIMEOUT_S = 15
POOL = 64  # above the service's concurrent requests (uvicorn runs sync endpoints on 40 threads), so 402s never queue
SHIP_TO = {"name": "Gate check", "address": "1 Market St, San Francisco, CA"}  # the 402 comes before any order


def origins(env: str) -> list[str]:
    return [o.strip().rstrip("/") for o in (os.environ.get(env) or "").split(",") if o.strip()]


class Page(BaseModel):
    text: str = ""
    hiddenText: list[str] = []  # noqa: N815 - the store crawler's field name


class Crawled(BaseModel):
    """What the store crawler read: the catalog entry's key and the item page. Title, price and seller are only used
    when the Gate's own copy of the catalog doesn't have the listing yet."""
    key: str
    title: str = ""
    price: float = Field(gt=0)
    seller: str | None = None
    page: Page


class ScreenRequest(BaseModel):
    mandate: Mandate
    proposal: Proposal
    crawled: Crawled


def words(title: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", title.lower()))


def origin_of(url: str) -> str:
    u = urlparse(url)
    return f"{u.scheme}://{u.hostname}"


class LiveStores:
    def __init__(self, stores: list[str], known: list[str], client: httpx.Client | None = None,
                 hosted_suffix: str | None = None):
        if not stores:
            raise ValueError("GATE_STORES is empty: no store the Gate may read")
        self.stores, self.known = set(stores), [k for k in known if k in stores]
        self.client = client or httpx.Client(timeout=TIMEOUT_S, follow_redirects=True)
        self.hosted_suffix = hosted_suffix
        self._cache: dict[str, tuple[float, object]] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(POOL)  # one 402 per decision in flight, so as many as decisions served at once

    def keep_warm(self, every_s: float = CACHE_S - 60) -> None:
        """Load every store's store.json and catalog now and again before they expire, in a background thread, so
        screening never waits on a store."""
        def loop():
            while True:
                for o in sorted(self.stores):
                    for key, url, pick in ((f"store:{o}", f"{o}/.well-known/store.json", lambda d: d),
                                           (f"catalog:{o}", f"{o}/api/catalog", lambda d: d["items"])):
                        try:
                            value = pick(self._json(url))
                            with self._lock:
                                self._cache[key] = (time.monotonic(), value)
                        except Exception:  # noqa: BLE001 - a store that is down now is retried next pass
                            pass
                time.sleep(every_s)
        threading.Thread(target=loop, daemon=True, name="gate-warm").start()

    @classmethod
    def from_env(cls) -> "LiveStores":
        return cls(origins("GATE_STORES"), origins("GATE_KNOWN_STORES"),
                   hosted_suffix=os.environ.get("GATE_HOSTED_SUFFIX") or None)

    def domain(self, origin: str) -> str:
        host = urlparse(origin).hostname
        s = self.hosted_suffix
        return host[: -len(s)] + ".com" if s and host.endswith(s) and len(host) > len(s) else host

    def _cached(self, key: str, load):
        with self._lock:
            lock = self._locks.setdefault(key, threading.Lock())
        with lock:  # one load per key, however many decisions ask at once
            hit = self._cache.get(key)
            if hit and time.monotonic() - hit[0] < CACHE_S:
                return hit[1]
            value = load()
            self._cache[key] = (time.monotonic(), value)
            return value

    def _json(self, url: str) -> dict:
        res = self.client.get(url)
        res.raise_for_status()
        return res.json()

    def store_info(self, origin: str) -> dict:
        return self._cached(f"store:{origin}", lambda: self._json(f"{origin}/.well-known/store.json"))

    def catalog(self, origin: str) -> list[dict]:
        return self._cached(f"catalog:{origin}", lambda: self._json(f"{origin}/api/catalog")["items"])

    def payment_required(self, checkout_url: str) -> dict:
        res = self.client.post(checkout_url, json={"shipTo": SHIP_TO})
        header = res.headers.get("payment-required")
        if res.status_code != 402 or not header:
            raise RuntimeError(f"checkout answered {res.status_code} without a payment request")
        required = json.loads(base64.b64decode(header))
        return {**required["accepts"][0], "resource": (required.get("resource") or {}).get("url")}

    def market_median(self, title: str) -> float | None:
        mine, prices = words(title), []
        for k in self.known:
            overlap = sorted(((len(mine & words(i["title"])), i["price"]) for i in self.catalog(k)), reverse=True)
            prices += [p for n, p in overlap[:MEDIAN_MATCHES] if n]
        return round(statistics.median(prices), 2) if prices else None

    def _origin(self, url: str) -> str:
        origin = origin_of(url)
        if origin not in self.stores:
            raise PermissionError(f"{origin} is not a store the Gate reads")
        return origin

    def _item(self, origin: str, url: str) -> dict | None:
        path = urlparse(url).path
        return next((i for i in self.catalog(origin) if i.get("path") == path), None)

    def resolve(self, request: GateRequest) -> GateInput:
        url = request.proposal.listing_id
        origin = self._origin(url)
        item = self._item(origin, url)
        if item is None:
            raise LookupError(f"{url} is not in {origin}'s catalog")
        paying = self._pool.submit(self.payment_required, urljoin(origin, item["checkoutUrl"]))
        info = self.store_info(origin)
        page = self.client.get(url)
        page.raise_for_status()
        seen = extract_page(page.text)
        return self._input(request.mandate, url, origin, item, info, seen, paying.result())

    def screen(self, request: ScreenRequest) -> GateInput:
        url, c = request.proposal.listing_id, request.crawled
        origin = self._origin(url)
        item = self._item(origin, url) or {"key": c.key, "title": c.title, "price": c.price, "seller": c.seller}
        info = self.store_info(origin)
        a = allowlist()
        network = a["networks"][0]
        promised = {"payTo": info["payTo"], "amount": str(round(item["price"] * 10 ** a["usdc_decimals"])),
                    "network": network, "asset": a["assets"][network], "resource": item["key"],
                    "maxTimeoutSeconds": a["max_timeout_s"]}  # what store.json and the catalog promise
        return self._input(request.mandate, url, origin, item, info, c.page.model_dump(), promised)

    def _input(self, mandate: Mandate, url: str, origin: str, item: dict, info: dict, seen: dict,
               pay: dict) -> GateInput:
        host = urlparse(origin).hostname
        domain = self.domain(origin)
        key = item["key"]
        listing = Listing.model_validate({
            "listing_id": url,
            "seller": {"id": f"{host}:{item.get('seller') or 'unknown'}", "domain": domain, "pay_to": info["payTo"]},
            "item": {"id": key, "product_key": f"{host}:{key}", "condition": "used",  # no feature reads condition
                     "price": item["price"], "text": " ".join([seen["text"], *seen["hiddenText"]])},
            "checkout": {"pay_to": pay["payTo"], "amount": pay["amount"], "network": pay["network"],
                         "asset": pay["asset"], "item_id": unquote((pay["resource"] or "").rstrip("/").split("/")[-1]),
                         "max_timeout_seconds": pay.get("maxTimeoutSeconds")},
        })
        known = [KnownSeller(seller_id=urlparse(k).hostname, pay_to=self.store_info(k)["payTo"],
                             domain=self.domain(k)) for k in self.known]
        refs = References(known_sellers=known, market_median=self.market_median(item["title"]))
        return GateInput(mandate=mandate, listing=listing, references=refs)
