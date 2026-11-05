import asyncio
import json
import logging
import os
import re
import secrets
import time
from collections import Counter
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).resolve().parents[1] / ".env")  # Local secrets; Railway sets real env vars instead.

from app import chats, gate, pay, rank, refund, scout, wallet  # noqa: E402
from app.llm import LLMError  # noqa: E402
from app.search import search  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    # No read timeout: search and LLM streams stay open while the work runs.
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=None)) as client:
        app.state.client = client
        if os.environ.get("MONGODB_URI"):
            await chats.setup()
        yield


log = logging.getLogger("hunter")
app = FastAPI(title="Hunter", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


@app.get("/chats")
async def list_chats(owner: str = Query(pattern=chats.ID)) -> list[dict]:
    """The owner's saved chats, newest first."""
    return await chats.list_chats(owner)


@app.put("/chats/{chat_id}")
async def save_chat(chat_id: str, chat: chats.Chat) -> dict:
    """Saves a finished chat, or replaces it when the same owner saves it again."""
    if not re.fullmatch(chats.ID, chat_id):
        raise HTTPException(400, "not a chat id")
    if not await chats.save(chat_id, chat):
        raise HTTPException(403, "This chat belongs to someone else.")
    return {"ok": True}


@app.delete("/chats/{chat_id}", status_code=204)
async def delete_chat(chat_id: str, owner: str = Query(pattern=chats.ID)) -> None:
    if not await chats.delete(chat_id, owner):
        raise HTTPException(404, "No such chat.")


@app.get("/health")
def health() -> dict[str, str | None]:
    """`buyer` is the address BUYER_PRIVATE_KEY signs for (public, never the key), or null when it isn't set."""
    return {"status": "ok", "buyer": pay.buyer_address()}


def checked(address: str) -> str:
    if not wallet.ADDRESS.match(address):
        raise HTTPException(400, "not a wallet address")
    return address


@app.get("/wallet/{address}")
async def wallet_info(address: str) -> dict:
    """The wallet's USDC balance and every USDC transfer in or out of it on Base Sepolia, newest first."""
    client = app.state.client
    try:
        return {"address": checked(address), "balance": await wallet.balance(client, address),
                "transactions": await wallet.transfers(client, address)}
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Base Sepolia couldn't be read: {e!r}") from e


@app.post("/wallet/{address}/fund")
async def wallet_fund(address: str) -> dict:
    """Test USDC from the CDP faucet. The faucet's own refusal (e.g. its rate limit) comes back as the detail."""
    try:
        return await wallet.fund(checked(address))
    except HTTPException:
        raise
    except Exception as e:  # Missing CDP credentials, faucet limit, network errors.
        raise HTTPException(502, getattr(e, "error_message", None) or str(e) or repr(e)) from e


def sse(event: dict) -> str:
    return f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"


def failure(e: Exception) -> str:
    """What went wrong, in a sentence the user can read. The full error goes to the server log."""
    if isinstance(e, LLMError):
        return f"The model didn't answer ({e}). Try again."
    if isinstance(e, httpx.HTTPError):
        try:
            url = str(e.request.url)
        except RuntimeError:  # The error was raised before a request was made.
            url = ""
        where = "the store search" if "apify" in url or ":4321" in url else "a service"
        return f"Lost the connection to {where} ({type(e).__name__}). Try again."
    return f"Something went wrong ({type(e).__name__}: {e}). Try again."


def stream(events: AsyncIterator[dict]) -> StreamingResponse:
    async def body():
        try:
            async for event in events:
                yield sse(event)
        except Exception as e:  # Actor, model or a bug: tell the client why, then end, instead of dropping the stream.
            log.exception("stream failed")
            yield sse({"type": "error", "message": failure(e), "error": repr(e)})

    # X-Accel-Buffering stops proxies from holding events back until the stream ends.
    return StreamingResponse(body(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


GATE_CONCURRENCY = 32  # Gate screenings at once. Each takes milliseconds; this only bounds a search's burst.


async def judged(query: str, max_per_store: int, max_price: float | None) -> AsyncIterator[dict]:
    """The actor's search events, plus a `verdict` (GateDecision fields + store, key) from the Gate's screening of
    each item whose page loaded (gate.screen, with the page the actor read), or a skip for each page error. Decisions run GATE_CONCURRENCY at a time, so a verdict comes
    after its page but not always in page order, and every verdict comes before the search's done event."""
    out: asyncio.Queue[dict | None] = asyncio.Queue()
    limit = asyncio.Semaphore(GATE_CONCURRENCY)
    listings: dict[tuple[str, str], dict] = {}

    async def verdict(event: dict) -> None:
        if event["type"] == "page":
            async with limit:
                decision = await gate.screen(app.state.client, listings[event["store"], event["key"]], event["page"],
                                             max_price)
        else:
            decision = gate.unavailable(event["error"])
        await out.put({"type": "verdict", "store": event["store"], "key": event["key"], **decision})

    async def crawl() -> None:
        done = None
        try:
            async with asyncio.TaskGroup() as tg:
                async for event in search(app.state.client, query, max_per_store):
                    if event["type"] == "done":
                        done = event
                        continue
                    await out.put(event)
                    if event["type"] == "listing":
                        listings[event["store"], event["key"]] = event
                    elif event["type"] in ("page", "error") and "key" in event:
                        tg.create_task(verdict(event))
            if done is not None:
                await out.put(done)
        finally:
            await out.put(None)

    task = asyncio.create_task(crawl())
    try:
        while (event := await out.get()) is not None:
            yield event
        await task  # Surfaces a search error instead of ending the stream silently.
    finally:
        task.cancel()


async def found(query: str, max_per_store: int, max_price: float | None) -> AsyncIterator[dict]:
    """judged(), retried with the first word dropped while a search finds no listings, since the model's query
    can be more specific than store titles ("warm fleece jacket" -> "fleece jacket" -> "jacket").
    A `search` event names each query tried."""
    words = query.split()
    while True:
        yield {"type": "search", "query": " ".join(words)}
        held, hit = [], False
        async for event in judged(" ".join(words), max_per_store, max_price):
            hit = hit or event["type"] == "listing"
            if hit:
                for e in held:
                    yield e
                held = []
                yield event
            else:
                held.append(event)  # Store and error events before the first listing.
        if hit or len(words) <= 1:
            for e in held:
                yield e
            return
        words = words[1:]


@app.get("/search")
async def search_stream(q: str = "", max: int = Query(0, ge=0, description="Max listings per store, 0 for all"),
                        max_price: float | None = Query(None, gt=0, description="The user's limit, checked by the Gate")):
    """Server-sent events, one per actor event, named by its type (listing, store, page, error, done),
    plus a `verdict` after each item's page or page error."""
    return stream(judged(q, max, max_price))


# A run waiting on the user keeps its stream open: a ping goes out while it waits so proxies don't close it, and it
# gives up after ANSWER_TIMEOUT. The user's replies arrive in the run's inbox as (kind, value): an answer to a question
# (POST /chat/{id}/answer), the favorites picked from the grid (POST /chat/{id}/select) and the go-ahead to pay
# (POST /chat/{id}/confirm).
# ponytail: runs live in this process's memory, so this needs a single API instance.
PING_S = 15
ANSWER_TIMEOUT = 15 * 60
NARROW_MIN = 4  # Fewer approved listings than this are not worth a question.
NO_PREFERENCE = "No Preference"  # Always offered when narrowing. It keeps every listing.
RUNS: dict[str, asyncio.Queue[tuple[str, object]]] = {}


class NoAnswer(Exception):
    """The user never replied, so the run ends."""


class Back(Exception):
    """The user went back a step instead of replying."""


class Answer(BaseModel):
    text: str = Field(min_length=1, max_length=200)


class Selection(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=rank.MAX_FAVORITES)


class Confirmation(BaseModel):
    confirm: bool
    pick: int = Field(0, ge=0, lt=rank.MAX_FAVORITES)  # Which weighed favorite, best first. The best by default.


async def deliver(run_id: str, kind: str, value: object) -> dict:
    if (queue := RUNS.get(run_id)) is None:
        raise HTTPException(404, "This chat is over or isn't waiting for you.")
    await queue.put((kind, value))
    return {"ok": True}


@app.post("/chat/{run_id}/answer")
async def answer(run_id: str, body: Answer) -> dict:
    """The user's answer to the question a running chat is waiting on."""
    return await deliver(run_id, "answer", body.text.strip())


@app.post("/chat/{run_id}/select")
async def select(run_id: str, body: Selection) -> dict:
    """The 1-5 qualified items the user likes most, by the ids the `qualified` event gave them."""
    return await deliver(run_id, "select", list(dict.fromkeys(body.ids)))


@app.post("/chat/{run_id}/back")
async def back(run_id: str) -> dict:
    """Goes back one step from whatever the chat is waiting on: the question before, or the grid from the go-ahead."""
    return await deliver(run_id, "back", None)


@app.post("/chat/{run_id}/confirm")
async def confirm(run_id: str, body: Confirmation) -> dict:
    """The user's go-ahead to buy the favorite they chose (the best one unless they picked another), or false to buy
    nothing."""
    return await deliver(run_id, "confirm", {"ok": body.confirm, "pick": body.pick})


async def wait(run_id: str, kind: str, result: dict) -> AsyncIterator[dict]:
    """Waits for the user's next reply of `kind`, sending a `ping` while it waits, and keeps it in result["value"].
    Raises Back when the user goes back instead. Replies of other kinds are stale (a double click on an earlier step)
    and dropped. Raises NoAnswer if none came."""
    queue = RUNS[run_id]
    deadline = time.monotonic() + ANSWER_TIMEOUT
    while time.monotonic() < deadline:
        try:
            got, value = await asyncio.wait_for(queue.get(), PING_S)
        except TimeoutError:
            yield {"type": "ping"}
            continue
        if got == "back":
            raise Back
        if got == kind:
            result["value"] = value
            return
    yield {"type": "error", "message": "No answer came, so Hunter stopped."}
    raise NoAnswer


def drain(run_id: str) -> None:
    """Drops replies sent before the step that is about to wait, so a double click can't answer it."""
    queue = RUNS[run_id]
    while not queue.empty():
        queue.get_nowait()


async def ask(run_id: str, stage: str, text: str, options: list[str], **per_option) -> AsyncIterator[dict]:
    """Sends a `question`, then waits for the answer. Ends with an `answer` event.
    `per_option` lists ride along, one value per option (counts, images)."""
    drain(run_id)
    yield {"type": "question", "stage": stage, "text": text, "options": options, **per_option}
    reply = {}
    async for event in wait(run_id, "answer", reply):
        yield event
    yield {"type": "answer", "stage": stage, "question": text, "text": reply["value"]}


async def relay(stage: str, steps: AsyncIterator[tuple[str, object]], result: dict) -> AsyncIterator[dict]:
    """Sends a Scout step's thinking as `reasoning` events and keeps its final value in result["value"]."""
    async for kind, value in steps:
        if kind == "reasoning":
            yield {"type": "reasoning", "stage": stage, "text": value}
        else:
            result["value"] = value


def photos(approved: list[tuple[dict, dict | None]]) -> dict[int, str | None]:
    """Each safe listing's own photo, by id(listing): the first photo on its page that no other safe listing's page
    shows. Item pages also show related items and banners, so a photo shared with another page isn't the listing's."""
    pages = {id(listing): page or {} for listing, page in approved}
    shown = Counter(image for page in pages.values() for image in dict.fromkeys(page.get("images") or []))
    return {key: next((i for i in page.get("images") or [] if shown[i] == 1), None) for key, page in pages.items()}


def previews(photo: dict[int, str | None], options: list[dict]) -> list[str | None]:
    """One photo per narrowing option: the own photo of the first listing it keeps that has one."""
    return [next(filter(None, (photo.get(id(l)) for l in o["keep"])), None) for o in options]


def remaining(options: list[dict], approved: list[tuple[dict, dict | None]]) -> list[dict]:
    """The options that still split what an earlier answer kept: each keeps some listings, but not all of them."""
    alive = {id(listing) for listing, _ in approved}
    kept = [{**o, "keep": [l for l in o["keep"] if id(l) in alive]} for o in options]
    return [o for o in kept if 0 < len(o["keep"]) < len(alive)]


def brief(listing: dict) -> dict:
    return {k: listing.get(k) for k in ("store", "storeName", "key", "title", "price", "seller", "url")}


def offer(weighed: dict, photo: dict[int, str | None]) -> dict:
    """One weighed favorite as the UI shows it: the listing, its photo, its score and what the page says about it."""
    f = weighed["facts"]
    return {**brief(weighed["listing"]), "image": photo.get(id(weighed["listing"])), "note": weighed["note"],
            "score": weighed["score"], "factors": weighed["factors"], "condition": f["condition"],
            "stars": None if f["feedback"] is not None else f["stars"], "reviews": f["reviews"],
            "feedback": f["feedback"]}


@app.get("/chat")
async def chat(prompt: str = Query(min_length=1, max_length=1000),
               max: int = Query(25, ge=1, le=100, description="Max listings per store")):
    """One chat turn as server-sent events, in the order the UI shows them:

    run {id}  first; answers to this run's questions go to POST /chat/{id}/answer, and POST /chat/{id}/back goes
        back a step from any of them
    reasoning {stage: understand|pick, text}  the model's thinking, streamed as it arrives
    question {stage: understand|pick, text, options, counts?, images?}, then answer {stage, question, text}
        Hunter asks before searching when a hard requirement is missing (who it is for, size, the model it must
        fit), and again before picking when the safe listings split into clearly different directions (style,
        color). Each stage asks at most two questions, back to back. Pick stage only: counts, the listings each
        option keeps, and images, a photo of one of them or null (see previews()). images has no entry for the
        last option, No Preference, since it has no photo of its own. ping events keep the stream open
        while it waits.
    title {text}  the chat's name, which is the item as the model named it. Sent again only if the name changes.
    thought {text}, instruction {item, query, max_price, gender, size}  the request as the model read it
    search {query}, listing, store, verdict, error, done  the live search and the Gate (pages are not forwarded)
    narrow {kept, total}  how many safe listings the answer to the second question kept
    qualified {items: [{id, image, listing fields}]}  every safe listing that is the item and has a photo: the grid
        the user picks 1-5 favorites from. The run waits for POST /chat/{id}/select. Empty: nothing to buy.
    selected {ids}  the favorites, echoed
    pick {picks: [listing fields + image, note, score, factors, condition, stars, reviews, feedback]}  the favorites
        weighed in code (app/rank.weigh), best first. The run then waits for POST /chat/{id}/confirm.
    back {to: understand|pick, keep}  the user went back a step: keep the first `keep` answers and redo from that
        stage. understand: the search runs again after the question; pick: a narrowing question or the grid again
    confirmed {ok, pick}  the user's go-ahead (true) or no (false, then the run ends stopped), and which weighed
        favorite they chose: 0, the best one, unless they picked another
    checkout {step: 0-5, state: done|failed|blocked, detail}  buying the best pick over x402 (app/pay.py)
    receipt {item, image, store, amount, network, from, to, order, paidAt, txHash, explorer}  only once paid
    end {status: bought|ready|stopped}  ready: checked and ready to pay, but no BUYER_PRIVATE_KEY is set
    Listings over the user's limit, made only for the other gender, or stating only other sizes are left out of the
    stream (scout.fits).
    """
    client = app.state.client
    run_id = secrets.token_urlsafe(8)
    RUNS[run_id] = asyncio.Queue()
    answers: list[dict] = []

    async def events():
        try:
            async for event in run():
                yield event
        except NoAnswer:
            yield {"type": "end", "status": "stopped"}
        finally:
            RUNS.pop(run_id, None)

    async def asked(stage: str, text: str, options: list[str], reply: dict, **per_option) -> AsyncIterator[dict]:
        """ask(), keeping the answer in reply["text"]. Raises Back if the user goes back instead."""
        async for event in ask(run_id, stage, text, options, **per_option):
            yield event
            if event["type"] == "answer":
                reply["text"] = event["text"]

    async def run():
        yield {"type": "run", "id": run_id}
        title = None
        # Questions before the search: the ones answered, in order, and the ones still to ask. Each keeps the reading
        # of the request (`base`) it came from, so answers can be filled into it in code.
        done: list[dict] = []
        pending: list[dict] = []
        while True:
            request = None
            while request is None:
                if not pending:
                    got = {}
                    async for event in relay("understand", scout.understand(client, prompt, answers), got):
                        yield event
                    base = got["value"]
                    if base["item"] != title:
                        title = base["item"]
                        yield {"type": "title", "text": title}
                    if not base["questions"]:
                        request = base
                        break
                    pending = [{"question": q, "base": base} for q in base["questions"]]  # Asked back to back.
                question, reply = pending[0]["question"], {}
                try:
                    async for event in asked("understand", question["text"], question["options"], reply):
                        yield event
                except Back:  # Ask the question before this one again.
                    if done:
                        pending.insert(0, done.pop())
                        answers.pop()
                        yield {"type": "back", "to": "understand", "keep": len(answers)}
                    continue
                item = pending.pop(0)
                answers.append({"question": question["text"], "answer": reply["text"]})
                done.append(item)
                item["reply"] = reply["text"]
                if not pending:
                    # Men's or women's and size answers are set in code. Only other answers need the model to read
                    # the request again, which happens on the next pass with no questions pending.
                    batch = [d for d in done if d["base"] is item["base"]]
                    request = scout.fill(item["base"], [d["question"] for d in batch], [d["reply"] for d in batch])

            for thought in request["thoughts"]:
                yield {"type": "thought", "text": thought}
            yield {"type": "instruction", **{k: request[k] for k in ("item", "query", "max_price", "gender", "size")}}

            listings, pages, stores, approved, hidden = {}, {}, {}, [], set()
            limit = request["max_price"]
            # The gender and size filters drop listings after the actor finds them, so it is asked for twice as many.
            wanted = max * 2 if request["gender"] or request["size"] else max
            async for event in found(request["query"], wanted, limit):
                at = event.get("store"), event.get("key")
                if event["type"] == "page":
                    pages[at] = event["page"]  # Kept for the Scout, not sent: the verdict is what the UI needs.
                    continue
                if event["type"] == "store":
                    stores[event["store"]] = event
                if event["type"] == "listing":
                    listings[at] = event
                    # Over the user's limit, for the other gender or in other sizes is a filter, not a scam: the feed
                    # only shows what Hunter could buy. The Gate's L1_OVER_MAX and the checkout double-check still
                    # enforce the limit.
                    if (limit is not None and event["price"] > limit) or not scout.fits(request, event.get("title") or ""):
                        hidden.add(at)
                        continue
                if event["type"] == "verdict":
                    if at in hidden:
                        continue
                    if event["decision"] == "buy":
                        approved.append((listings[at], pages.get(at)))
                yield event

            # Only listings that are the item asked for can be bought, so the rest never reach a question or the grid.
            photo = photos(approved)
            outcome = {}
            async for event in decide(request, rank.qualified(request, approved), photo, stores, bool(done), outcome):
                yield event
            if not outcome.get("back"):
                return
            # Back from the first step after the search: ask the last question before it again, then search again.
            pending = [done.pop()]
            answers.pop()
            yield {"type": "back", "to": "understand", "keep": len(answers)}

    def narrowed(base: list, questions: list[dict], replies: dict[int, str], upto: int) -> list:
        """The listings the narrowing answers before question `upto` keep. An option's label keeps that option's
        listings, and anything typed instead keeps them all."""
        kept = base
        for k in sorted(r for r in replies if r < upto):
            options = remaining(questions[k]["options"], kept)
            if chosen := next((o for o in options if o["label"].lower() == replies[k].lower()), None):
                ids = {id(l) for l in chosen["keep"]}
                kept = [(l, p) for l, p in kept if id(l) in ids]
        return kept

    async def decide(request: dict, base: list, photo: dict, stores: dict, can_leave: bool,
                     outcome: dict) -> AsyncIterator[dict]:
        """The steps after the search, in order: each narrowing question, the grid, then the go-ahead and payment.
        Back at any step returns to the one before it. Back from the first one sets outcome["back"] when there is a
        question before the search to go back to."""
        limit = request["max_price"]
        narrowing = {"value": []}
        if len(base) >= NARROW_MIN:
            safe = [listing for listing, _ in base]
            async for event in relay("pick", scout.narrow(client, prompt, answers, safe), narrowing):
                yield event
        questions = narrowing["value"]
        replies: dict[int, str] = {}
        grid_at, confirm_at = len(questions), len(questions) + 1

        def asks(k: int) -> bool:
            """Whether narrowing question k is asked: only while it still splits what the answers before it kept."""
            return len(remaining(questions[k]["options"], narrowed(base, questions, replies, k))) >= 2

        def before(i: int) -> int:
            """The step before step i that the user saw, or -1 for none."""
            j = i - 1
            while 0 <= j < grid_at and not asks(j):
                j -= 1
            return j

        i = 0
        while True:
            approved = narrowed(base, questions, replies, i)
            try:
                if i < grid_at:
                    if not asks(i):
                        i += 1
                        continue
                    options = remaining(questions[i]["options"], approved)
                    reply = {}
                    async for event in asked("pick", questions[i]["text"], [o["label"] for o in options] + [NO_PREFERENCE],
                                             reply, counts=[len(o["keep"]) for o in options] + [len(approved)],
                                             images=previews(photo, options)):
                        yield event
                    replies[i] = reply["text"]
                    i += 1
                    continue

                # The grid: the qualified listings with a photo of their own, since the user picks favorites by look.
                # When none has one, they all go, so there is still something to pick from.
                grid = [a for a in approved if photo.get(id(a[0]))] or approved
                if len(approved) < len(base):
                    yield {"type": "narrow", "kept": len(approved), "total": len(base)}
                yield {"type": "qualified",
                       "items": [{"id": str(n), "image": photo.get(id(l)), **brief(l)} for n, (l, _) in enumerate(grid)]}
                if not grid:
                    yield {"type": "pick", "picks": []}
                    yield {"type": "end", "status": "stopped"}
                    return
                drain(run_id)
                chosen = {}
                async for event in wait(run_id, "select", chosen):
                    yield event
                ids = [n for n in chosen["value"] if n.isdigit() and int(n) < len(grid)][:rank.MAX_FAVORITES] or ["0"]
                yield {"type": "selected", "ids": ids}
                i = confirm_at

                weighed = rank.weigh(request, [grid[int(n)] for n in ids])
                yield {"type": "pick", "picks": [offer(w, photo) for w in weighed]}

                # Nothing is bought until the user says so.
                drain(run_id)
                go = {}
                async for event in wait(run_id, "confirm", go):
                    yield event
            except Back:
                j = before(i)
                if j < 0:
                    if can_leave:
                        outcome["back"] = True
                        return
                    continue  # Nothing before this step: show it again.
                for k in [k for k in replies if k >= j]:
                    del replies[k]
                yield {"type": "back", "to": "pick", "keep": len(answers) + len(replies)}
                i = j
                continue

            ok, choice = go["value"]["ok"], go["value"]["pick"]
            choice = choice if choice < len(weighed) else 0
            yield {"type": "confirmed", "ok": ok, "pick": choice}
            if not ok:
                yield {"type": "end", "status": "stopped"}
                return

            best = weighed[choice]["listing"]
            status, receipt = "stopped", None
            # The Gate's full check, once, right before paying: it reads the page and the store's real 402 itself.
            final = await gate.judge(client, best, limit)
            if final["decision"] != "buy":
                why = final.get("failed_rule") or final.get("error") or "the risk model"
                yield pay.step(0, "failed", f"The Gate stopped this purchase ({why}).")
                yield {"type": "end", "status": status}
                return
            async for event in pay.checkout(client, best, stores.get(best["store"]), limit):
                if event["type"] == "receipt":
                    event = {**event, "image": photo.get(id(best))}
                    status, receipt = "bought", event
                elif event["state"] == "blocked":
                    status = "ready"  # Everything checked out; only the wallet key is missing.
                yield event
            if receipt and refund.store_key():
                refund.schedule(client, receipt["from"], receipt["amount"])
            yield {"type": "end", "status": status}
            return

    return stream(events())
