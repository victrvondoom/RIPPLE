# Live store search (Apify Standby)

[← Back to the README](../README.md)

The chat's "Searching Stores" step reads our hosted storefronts live through an Apify Actor in Standby mode, and the
agent API streams what it finds to the browser as it arrives.

```
Browser (Vercel)  <- SSE -  agent API (Railway, FastAPI)  <- NDJSON -  store-crawler Actor (Apify Standby)  ->  storefronts
```

- **Actor** (`apps/agent/api/actor`, Python): `GET /search?stores=&q=&max=&details=` streams one JSON event per line.
  Per store it fetches `/api/catalog` and `/.well-known/store.json` in parallel, so listings go out ~250ms in while
  `store.json` (1.5-3s, it reads the wallet per request) is still loading. Then it fetches every matching item page
  (50 at a time, retries on network errors, 429 and 5xx).
  - Events: `listing` (catalog fields + absolute `url`/`checkoutUrl`), `store` (`name`, `payTo`, `network`,
    `currency`), `page` (`title`, `h1`, `text`, `images`, `hiddenText`, `jsonLd`), `error` (one store or page; the
    search goes on), `done` (counts and `ms`).
  - `q` is passed to each store's `/api/catalog?q=`, so the store ranks its own listings by meaning with Atlas Vector Search and the Actor crawls only those (at most 40 per store); empty lists everything.
  - Page extraction works on any store: it applies React's streamed-HTML swap (content arrives in `<div hidden id="S:n">`),
    joins text nodes with spaces in document order, and collects `hiddenText` (`hidden`, `sr-only`, inline
    `display:none` and similar). Text hidden by stylesheet rules is not detected.
  - Standby URLs collapse `//` in query strings, so store URLs are normalized (`https:/host` and bare hosts work).
- **Agent API** (`apps/agent/api/app`): `GET /search?q=&max=&max_price=` relays the Actor's events as SSE (`event:`
  is the event type). Searches cover `STORE_URLS`, by default mzn, by, dpp and the mzn Official Outlet scam store. If the
  Actor can't be reached, the stream sends one `error` event and ends.
- **Gate** (`app/gate.py`, a client of the Gate service in `gate/`), in two passes, both Layer 1's rules and then the
  red-teamed model (`gates/CURRENT`):
  - **Screening, every listing:** after each item's `page` the agent API sends `POST {GATE_URL}/screen` the user's
    limit, the listing's page URL and the page the Actor read, and the stream sends a `verdict` event with the
    `GateDecision` fields plus `store` and `key`. The Gate takes title, price, seller and wallet from its own cached
    catalog and `store.json`, so it contacts no store per listing.
  - **Before paying, once:** for the confirmed pick the agent API sends `POST {GATE_URL}/decide`, and the Gate reads the
    page and the store's real 402 itself. Anything but `buy` stops the purchase before checkout starts.
  - Up to 32 screenings run at once (`GATE_CONCURRENCY` in `app/main.py`), so verdicts come after their page but not
    always in page order; every verdict comes before the search's `done`.
  - A page error, a Gate error, a timeout (10 s screening, 30 s before paying) or no `GATE_URL` is a skip with
    `decided_by: null` and an `error`.
  - Whether a listing is the item asked for stays in `rank.qualified`, so the mandate's product key is the listing's own.
  - Measured locally (Gate container with `r3-be84bc`, `q=fleece jacket`, 25 per store, the stores as deployed): all
    25 outlet listings skipped, all 75 real ones bought, each verdict 0.2-0.3 s after its page, the search done when
    the crawl is (10-12 s); the check before paying took 4-5 s, nearly all of it the store's 402.
- **Measured** (agent API -> Standby, `q=fleece jacket`, 10 per store, 3 stores): first listing 0.2-0.5s, all 30 pages
  in about 2s. All 317 items take 3.0s at 4 GB and 18.5s at 1 GB: Apify gives CPU in proportion to memory, and
  parsing (~10ms a page) needs it. Standby is set to 4 GB in the Apify console. The first request after 5 minutes idle
  adds a 2.5-3.5s cold start.
- **Deploying the Actor:** `cd apps/agent/api/actor && apify push`. Version 0.2 tags each build `latest`, which is
  the build Standby serves.

| Variable | Where | Purpose |
|---|---|---|
| `APIFY_ACTOR_URL` | agent API | Standby URL (`https://lauded-crevasse--store-crawler.apify.actor`), or `http://localhost:4321` for a local Actor |
| `APIFY_TOKEN` | agent API | Apify token, sent as a Bearer header to the Standby URL |
| `STORE_URLS` | agent API | Optional comma-separated store origins (default: the four hntr.store stores) |
| `CORS_ORIGINS` | agent API | Comma-separated browser origins allowed to call the API (default `http://localhost:3000`) |
| `BITDEER_API_KEY` | agent API | Bitdeer Model Studio key for the Scout |
| `BITDEER_MODEL` | agent API | Optional model id (default `zai-org/GLM-5.3-Flash`) |
| `NEXT_PUBLIC_AGENT_API_URL` | agent web | Agent API origin, inlined at build time (default `http://localhost:8000`) |
| `BUYER_PRIVATE_KEY` | agent API | Hunter's wallet key; signs x402 payments in `app/pay.py`. Unset: runs stop before paying |
| `SHIP_TO_NAME`, `SHIP_TO_ADDRESS` | agent API | Optional ship-to sent at checkout (default a demo address; nothing ships) |
| `MONGODB_URI` | agent API | MongoDB Atlas, for saved chats (`app/chats.py`). Unset: chats are not saved |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` | agent API | Coinbase Developer Platform keys for the faucet behind Add Funds (`app/wallet.py`). Unset: only Add Funds fails |

Locally the agent API reads `apps/agent/api/.env` and the web app `apps/agent/web/.env.local`; both have a
`.env.example`. The API depends on `contracts/` (`calhacks-contracts`, a uv path dependency like in `gate/` and
`redteam/`), so Railway builds it from the repo root: root directory `/`, config file `apps/agent/api/railway.json`,
which builds `apps/agent/api/Dockerfile` and redeploys on changes under `apps/agent/api/` or `contracts/`.
