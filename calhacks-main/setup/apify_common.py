"""Shared helpers for the setup scrapers: env, the Apify run gate, timed actor runs, paging, MongoDB,
and the listing format.

Self-check: python setup/apify_common.py
"""

import argparse
import heapq
import itertools
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

from pymongo import MongoClient, ReplaceOne

HERE = Path(__file__).parent
DATA = HERE / "data"
QUERY = "thermal jacket"
DEFAULT_COUNT = 5

# The listing format. Every scraper fills these keys, missing ones become None.
STORE_KEYS = ("name", "sellerId", "payTo", "sellingSince", "rating",
              "reviewCount", "itemsSold", "positivePercent", "location")
ITEM_KEYS = ("title", "price", "condition", "description",
             "listPrice", "images", "brand", "category", "attributes", "bullets", "stock",
             "rating", "ratingCount", "ratingBreakdown", "stats", "hiddenText")


def load_env() -> str:
    # ponytail: minimal KEY=VALUE parser, swap for python-dotenv if we need quotes or multiline values
    for line in (HERE / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())
    token = os.environ.get("APIFY_TOKEN")
    if not token:
        raise SystemExit("APIFY_TOKEN missing in setup/.env (see setup/.env.example)")
    return token


class ApifyError(SystemExit):
    """An Apify API error response. Still a SystemExit, so an unhandled one stops the script cleanly."""

    def __init__(self, code: int, message: str):
        super().__init__(f"Apify {code}: {message}")
        self.code, self.message = code, message

    @property
    def at_account_limit(self) -> bool:
        """The run was refused, not started, because the account is at its run or memory limit."""
        return self.code == 402 and ("concurrent Actor runs" in self.message or "memory limit" in self.message)


def api(token: str, path: str, body: dict | None = None):
    """Call the Apify API. GETs retry through network blips (DNS, resets, timeouts).

    POSTs (starting a run) never retry: one that reached Apify before failing would start a second run.
    """
    req = urllib.request.Request(
        f"https://api.apify.com/v2{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    attempts = 1 if body is not None else 6
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            raise ApifyError(e.code, e.read().decode())
        except (urllib.error.URLError, OSError) as e:  # DNS failure, connection reset, timeout
            if attempt == attempts:
                raise SystemExit(f"Apify unreachable after {attempts} attempts: {e}")
            wait = 2 ** attempt  # 2, 4, 8, 16, 32s: rides out about a minute of network trouble
            print(f"network error ({e}), retrying in {wait}s")
            time.sleep(wait)


class Gate:
    """The account's Apify limits, shared by every run this process starts.

    At most SLOTS runs at once within MEMORY_MB. Each scalable run gets the largest power of two
    (up to MAX_RUN_MB) that still leaves RESERVE_MB for every other free slot, so 5 runs land at
    4+4+4+2+2 GB. Memory is free on these pay-per-event actors and buys CPU, so we use all of it.
    Lower `priority` goes first (search pages before reviews), ties in arrival order.
    Only runs started in this process are counted: run all marketplaces from scrape_all.py. Runs
    started elsewhere on the account (other people, other scripts) are handled by _start_run
    waiting and retrying when Apify refuses a start.
    """

    SLOTS, MEMORY_MB, RESERVE_MB, MAX_RUN_MB = 5, 16384, 2048, 4096  # /users/me/limits

    def __init__(self):
        self._cond = threading.Condition()
        self._free_slots, self._free_mb = self.SLOTS, self.MEMORY_MB
        self._queue: list[tuple[int, int]] = []
        self._seq = itertools.count()

    def _size(self, min_mb: int, scale: bool) -> int:
        if not scale:
            return min_mb
        available = self._free_mb - (self._free_slots - 1) * self.RESERVE_MB
        mb = self.MAX_RUN_MB
        while mb > available and mb > min_mb:
            mb //= 2
        return mb

    @contextmanager
    def run(self, min_mb: int, scale: bool = True, priority: int = 1):
        """Wait for a slot, then yield the memory (MB) to start the run with."""
        with self._cond:
            ticket = (priority, next(self._seq))
            heapq.heappush(self._queue, ticket)
            while not (self._queue[0] == ticket and self._free_slots
                       and self._size(min_mb, scale) <= self._free_mb):
                self._cond.wait()
            heapq.heappop(self._queue)
            mb = self._size(min_mb, scale)
            self._free_slots -= 1
            self._free_mb -= mb
            self._cond.notify_all()  # the next ticket in line may fit too
        try:
            yield mb
        finally:
            with self._cond:
                self._free_slots += 1
                self._free_mb += mb
                self._cond.notify_all()


GATE = Gate()


def scrape(token: str, actor: str, input: dict, noun: str, timeout: int | None = None,
           min_memory: int = 1024, scale: bool = True, priority: int = 1) -> list[dict]:
    """Start an actor run through GATE and poll its dataset, timing startup and each item.

    timeout (seconds) makes Apify stop the run; a timed-out run returns the items it got.
    min_memory is the smallest allocation the actor was tested with; with scale the gate gives it
    more when there is room. scale=False runs at exactly min_memory (eBay: its work runs elsewhere).
    """
    with GATE.run(min_memory, scale, priority) as memory:
        return _scrape(token, actor, input, noun, timeout, memory)


START_WAIT_S, START_WAIT_MAX_S = 15, 30 * 60


def _start_run(token: str, path: str, input: dict, noun: str) -> dict:
    """Start a run, waiting while the account is at its limit because of runs we don't control.

    A refused start never created a run, so retrying it cannot start a duplicate.
    """
    waited = 0
    while True:
        try:
            return api(token, path, input)["data"]
        except ApifyError as e:
            if not e.at_account_limit or waited >= START_WAIT_MAX_S:
                raise
            if waited == 0:
                print(f"{noun}: Apify account at its run limit (other runs on the account), waiting")
            time.sleep(START_WAIT_S)
            waited += START_WAIT_S


def _scrape(token: str, actor: str, input: dict, noun: str, timeout: int | None, memory: int) -> list[dict]:
    # ponytail: 1s polling, so per-item times are only accurate to ~1s
    print(f"\n== {actor} ({noun}, {memory} MB)")
    t0 = time.perf_counter()
    options = "&".join(f"{k}={v}" for k, v in (("timeout", timeout), ("memory", memory)) if v)
    run = _start_run(token, f"/acts/{actor}/runs?{options}", input, noun)
    print(f"[{time.perf_counter() - t0:6.1f}s] run {run['id']} created")

    items: list[dict] = []
    running_at = last = None
    while True:
        status = api(token, f"/actor-runs/{run['id']}")["data"]["status"]
        now = time.perf_counter()
        if running_at is None and status != "READY":
            running_at = last = now
            print(f"[{now - t0:6.1f}s] actor started (startup {now - t0:.1f}s)")

        new = api(token, f"/datasets/{run['defaultDatasetId']}/items?offset={len(items)}")
        for it in new:
            now = time.perf_counter()
            label = it.get("title") or it.get("reviewTitle") or it.get("error") or ""
            print(f"[{now - t0:6.1f}s] {noun} {len(items) + 1} (+{now - last:.1f}s)  {label[:60]}")
            items.append(it)
            last = now

        if status not in ("READY", "RUNNING"):
            break
        time.sleep(1)

    total = time.perf_counter() - t0
    print(f"[{total:6.1f}s] run {status}")
    if status == "TIMED-OUT":  # our own time limit: keep what it got
        print(f"run hit the {timeout}s time limit, keeping {len(items)} {noun} it got")
    elif status != "SUCCEEDED":
        raise SystemExit(f"Apify run ended with {status}")
    scraping = f"scraping {last - running_at:.1f}s ({(last - running_at) / len(items):.1f}s/{noun} avg), " if items else ""
    print(f"[run stats] {noun} at {memory} MB: startup {(running_at or t0) - t0:.1f}s, {scraping}"
          f"{len(items)} items, total {total:.1f}s")
    return items


def scrape_retrying(token: str, actor: str, input: dict, noun: str, attempts: int = 3, **options) -> list[dict]:
    """scrape(), retried when it comes back empty.

    eBay and Depop anti-bot blocks still end the run as SUCCEEDED with 0 results, and a fresh run
    usually gets through. A real end of results costs the extra attempts, which are cheap.
    """
    for attempt in range(1, attempts + 1):
        items = scrape(token, actor, input, noun, **options)
        if items:
            return items
        print(f"attempt {attempt}/{attempts}: no results (likely blocked), "
              f"{'retrying' if attempt < attempts else 'giving up'}")
    return []


def listing(marketplace: str, external_id: str, url: str | None,
            store: dict, item: dict, reviews: list[dict]) -> dict:
    """Build one scraped listing in the shared format. Unknown keys are a bug in the scraper."""
    unknown = (store.keys() - set(STORE_KEYS)) | (item.keys() - set(ITEM_KEYS))
    assert not unknown, f"not in the listing format: {unknown}"
    store = {**store, "payTo": os.environ.get("STORE_PAY_TO")}  # our hosted store's wallet
    return {
        "id": f"{marketplace}-{external_id}",
        "source": {"marketplace": marketplace, "url": url, "externalId": external_id},
        "store": {k: store.get(k) for k in STORE_KEYS},
        "item": {k: item.get(k) for k in ITEM_KEYS} | {"images": item.get("images") or []},
        "reviews": reviews,
    }


def collect(fetch, key, seen: set, state: dict, count: int, page_size: int | None,
            on_batch, save_state) -> bool:
    """Page through search results until `count` listings not in `seen` are collected.

    fetch(page, cap) returns the first `cap` results of a search page. state is
    {"page", "offset"}, where offset counts results already used on that page. page_size None
    means the source has no pages (Depop), so it is one list we re-read with a growing cap.
    Results shift between runs, so skipping `seen` ids is what prevents repeats; the saved
    position only avoids paying for pages we already went through.
    Returns True when the search ran out of new results.
    """
    remaining, stale_pages = count, 0
    while remaining > 0:
        cap = state["offset"] + remaining
        if page_size:
            cap = min(cap, page_size)
        items = fetch(state["page"], cap)
        fresh = list({key(it): it for it in items if key(it) not in seen}.values())
        take = fresh[:remaining]
        if take:
            on_batch(take)
            seen.update(key(it) for it in take)
            remaining -= len(take)

        leftovers = len(fresh) - len(take)
        page_done = len(items) < cap or (page_size is not None and len(items) >= page_size)
        if leftovers or not page_done:
            state = {"page": state["page"], "offset": len(items) - leftovers}
        elif not items or page_size is None:
            return True
        else:
            # ponytail: two pages in a row with nothing new means the search is exhausted (or looping)
            stale_pages = 0 if fresh else stale_pages + 1
            if stale_pages >= 2:
                return True
            state = {"page": state["page"] + 1, "offset": 0}
        save_state(state)
    return False


def mongo():
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise SystemExit("MONGODB_URI missing in setup/.env (see setup/.env.example)")
    client = MongoClient(uri)
    client.admin.command("ping")  # fail before paying for a scrape we can't store
    db = client[os.environ.get("MONGODB_DB", "calhacks")]
    db.listings.create_index("source.marketplace")
    return db


def save_listings(db, batch: list[dict]) -> None:
    db.listings.bulk_write([ReplaceOne({"_id": l["id"]}, {"_id": l["id"], **l}, upsert=True) for l in batch])


def parse_args(description: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT, help="new listings to collect per marketplace")
    parser.add_argument("--continue", dest="resume", action="store_true",
                        help="resume from the saved position and skip listings already in MongoDB")
    return parser.parse_args()


def cli(spec: dict) -> None:
    """Entry point for one marketplace's script."""
    args = parse_args(f"Scrape {spec['marketplace']} listings for {QUERY!r} into MongoDB.")
    run(**spec, count=args.count, resume=args.resume)


def run(marketplace: str, fetch, external_id, build, page_size: int | None,
        count: int, resume: bool, enrich_one=None) -> None:
    """Scrape one marketplace. Writes each batch to MongoDB as it goes, plus the search position.

    enrich_one(token, listing), if given, adds a slow extra (Amazon reviews) to one listing that is
    already saved. Those run in the background through GATE while the next search page is fetched,
    and each listing is saved again as it completes.
    """
    token = load_env()
    db = mongo()
    state_id = f"{marketplace}:{QUERY}"
    seen, state = set(), {"page": 1, "offset": 0}
    if resume:
        seen = set(db.listings.distinct("_id", {"source.marketplace": marketplace}))
        saved = db.scrape_state.find_one({"_id": state_id})
        if saved:
            state = {"page": saved["page"], "offset": saved["offset"]}
        print(f"continuing at page {state['page']} offset {state['offset']}, "
              f"{len(seen)} {marketplace} listings already in MongoDB")

    raw, listings = [], []

    def enrich_and_save(l: dict) -> None:
        enrich_one(token, l)
        save_listings(db, [l])

    # enough workers to keep every gate slot busy; GATE decides how many actually run
    with ThreadPoolExecutor(max_workers=Gate.SLOTS) as background:
        pending = []

        def on_batch(items: list[dict]) -> None:
            batch = build(token, items)
            save_listings(db, batch)
            raw.extend(items)
            listings.extend(batch)
            print(f"-> {len(batch)} {marketplace} listings saved to MongoDB ({len(listings)}/{count})")
            if enrich_one:
                pending.extend(background.submit(enrich_and_save, l) for l in batch)

        def save_state(s: dict) -> None:
            db.scrape_state.replace_one({"_id": state_id}, {"_id": state_id, **s}, upsert=True)

        exhausted = collect(lambda page, cap: fetch(token, page, cap),
                            lambda it: f"{marketplace}-{external_id(it)}",
                            seen, state, count, page_size, on_batch, save_state)
        if exhausted:
            print(f"\nsearch ran out of new {marketplace} results after {len(listings)} new listings")
        for f in pending:
            f.result()  # surface errors from the background work
    save(marketplace, raw, listings)


def save(marketplace: str, raw: list, listings: list[dict]) -> None:
    """Write this run's listings (and the raw actor output) to setup/data for inspection."""
    if not listings:  # keep the previous file instead of overwriting it with nothing
        raise SystemExit(f"no new {marketplace} listings, nothing written")
    DATA.mkdir(exist_ok=True)
    stem = f"{marketplace}-{QUERY.replace(' ', '-')}"
    # raw dump lets us fix the mapping without paying for another scrape
    (DATA / f"{stem}.raw.json").write_text(json.dumps(raw, indent=2))
    (DATA / f"{stem}.json").write_text(json.dumps(listings, indent=2))
    print()
    for l in listings:
        print(f"{l['item']['price']!s:>8}  {l['item']['condition']!s:<10} {len(l['reviews']):3} reviews  "
              f"{(l['item']['title'] or '')[:50]}")
    print(f"{len(listings)} listings -> setup/data/{stem}.json")


def condition(text: str | None) -> str | None:
    """Map a marketplace's condition wording to new | like_new | very_good | good | acceptable | renewed."""
    t = (text or "").lower().replace("_", " ")  # Depop sends codes like "used_like_new"
    rules = [  # first match wins, so "like new" is checked before "new"
        (("renew", "refurb"), "renewed"),
        (("like new", "excellent", "open box", "new without", "new other"), "like_new"),
        (("new",), "new"),
        (("very good",), "very_good"),
        (("fair", "acceptable", "poor", "parts"), "acceptable"),
        (("good", "used", "pre-owned"), "good"),
    ]
    return next((value for words, value in rules if any(w in t for w in words)), None)


def num(value) -> float | None:
    """Parse "100%", "289", "EUR 206.00", 12 -> float."""
    if isinstance(value, (int, float)):
        return float(value)
    digits = re.sub(r"[^\d.]", "", str(value or ""))
    return float(digits) if digits else None


def count(value) -> int | None:
    n = num(value)
    return int(n) if n is not None else None


def compact(values) -> list:
    return [v for v in values if v]


if __name__ == "__main__":
    assert condition("New with tags") == "new"
    assert condition("Pre-Owned") == "good"
    assert condition("Excellent condition") == "like_new"
    assert condition("Renewed - Good") == "renewed"
    assert condition("Used - Very Good") == "very_good"
    assert condition("Fair condition") == "acceptable"
    assert condition(None) is None
    assert condition("brand_new") == "new" and condition("used_like_new") == "like_new"
    assert condition("used_excellent") == "like_new" and condition("used_fair") == "acceptable"
    assert num("100%") == 100 and num("EUR 206.00") == 206 and num(None) is None
    assert count("289") == 289 and isinstance(count("289"), int) and count(None) is None
    l = listing("ebay", "1", None, {"name": "x"}, {"title": "t"}, [])
    assert l["store"]["payTo"] == os.environ.get("STORE_PAY_TO") and l["item"]["images"] == []

    def fake(pages, page_size):
        """Run collect() against fake search pages, the way run() does across two invocations."""
        seen, saved, got = set(), [{"page": 1, "offset": 0}], []

        def go(count):
            batch = []
            out = collect(lambda p, cap: pages[p - 1][:cap] if p <= len(pages) else [], lambda it: it,
                          seen, saved[-1], count, page_size, batch.extend, saved.append)
            got.append(batch)
            return out
        return go, got, saved

    go, got, saved = fake([["a1", "a2", "a3", "a4", "a5", "a6"], ["b1", "b2", "b3", "b4", "b5", "b6"]], 6)
    assert go(4) is False and got[-1] == ["a1", "a2", "a3", "a4"] and saved[-1] == {"page": 1, "offset": 4}
    assert go(4) is False and got[-1] == ["a5", "a6", "b1", "b2"] and saved[-1] == {"page": 2, "offset": 2}
    assert go(100) is True and got[-1] == ["b3", "b4", "b5", "b6"]  # ran out, no repeats

    go, got, _ = fake([["x1", "x2", "x3", "x4", "x5"]], None)  # no pages (Depop)
    assert go(3) is False and got[-1] == ["x1", "x2", "x3"]
    assert go(3) is True and got[-1] == ["x4", "x5"]

    go, got, _ = fake([["r1", "r2"]] * 50, 2)  # a search that keeps serving the same results
    assert go(10) is True and got[-1] == ["r1", "r2"]

    # Gate: 5 scalable runs fill 16 GB as 4+4+4+2+2, a fixed eBay run takes exactly its size
    from contextlib import ExitStack
    gate = Gate()
    with ExitStack() as stack:
        sizes = [stack.enter_context(gate.run(1024)) for _ in range(5)]
    assert sizes == [4096, 4096, 4096, 2048, 2048] and sum(sizes) == Gate.MEMORY_MB, sizes
    with ExitStack() as stack:
        sizes = [stack.enter_context(gate.run(128, scale=False))] + [stack.enter_context(gate.run(512)) for _ in range(4)]
    assert sizes == [128, 4096, 4096, 4096, 2048] and sum(sizes) <= Gate.MEMORY_MB, sizes

    # Gate: when full, a waiting search page (priority 0) goes before a waiting review (priority 1)
    order, held = [], ExitStack()
    for _ in range(Gate.SLOTS):
        held.enter_context(gate.run(1024))

    def wait_for_slot(name: str, priority: int) -> None:
        with gate.run(1024, priority=priority):
            order.append(name)
    review = threading.Thread(target=wait_for_slot, args=("review", 1))
    review.start()
    time.sleep(0.1)
    page = threading.Thread(target=wait_for_slot, args=("page", 0))
    page.start()
    time.sleep(0.1)
    held.close()  # free all slots: both proceed, the page first
    review.join()
    page.join()
    assert order == ["page", "review"], order

    # a start refused for the account's run limit waits and retries; any other error does not
    limit = ApifyError(402, '{"message": "By launching this job you will exceed your limit of 5 concurrent Actor runs."}')
    assert limit.at_account_limit and not ApifyError(402, "Insufficient credit").at_account_limit
    calls, real_api, START_WAIT_S = [], api, 0

    def flaky_api(token, path, body=None):
        calls.append(path)
        if len(calls) < 3:
            raise limit
        return {"data": {"id": "run1"}}
    api = flaky_api
    assert _start_run("t", "/acts/x/runs", {}, "test")["id"] == "run1" and len(calls) == 3
    api = lambda *a, **k: (_ for _ in ()).throw(ApifyError(400, "bad input"))
    try:
        _start_run("t", "/acts/x/runs", {}, "test")
        raise AssertionError("a non-limit error must not be retried")
    except ApifyError as e:
        assert e.code == 400
    api = real_api
    print("ok")
