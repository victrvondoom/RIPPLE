# Hunter chat run (Scout + live search)

[← Back to the README](../README.md)

A new chat in the agent web app is one live run: the browser opens `GET /chat?prompt=` on the agent API as an
`EventSource`, and the stages fill in as events arrive. The Scout is the LLM (Bitdeer, `zai-org/GLM-5.3-Flash`,
OpenAI-compatible at `https://api-inference.bitdeer.ai/v1`); it never touches money.

1. **Understand** (`app/scout.py`): the model reads the request and returns JSON with `item`, `query` (1-3 title
   words), `max_price`, `gender` (men|women|null), `size` and 2-4 `thoughts`, all validated in code. Sent as
   `thought` and `instruction` events.
   - **Clarifying questions:** when a detail that changes which listings fit is missing, the model returns a
     `question` with 2-5 options instead, and the run waits for the answer before searching: for clothing, men's or
     women's first, then the size. Never price, never something already said, one at a time, at most 2. Items that
     aren't worn get none. The answer goes back to the model, which can settle both at once ("for my girlfriend, she
     wears a small").
   - **No repeated questions:** the model is told the item the user named is final, and code drops any question,
     here or when narrowing, with an option the user already said in the request or an earlier answer
     (`scout.settled`): "Jacket or sweatshirt?" after "find me a sweatshirt", or "Men's or women's?" after "a men's
     hoodie". Words under 3 letters don't count, so a size never settles a question by accident.
   - **Why these two:** search words match anywhere in a title, so gender can't go in the query ("men" matches
     "women"). Code filters instead (`scout.fits`): it drops titles only for the other gender (whole words, so
     "Men Women" unisex titles stay) and titles that state only other sizes (`scout.sizes` reads "Size L",
     "sz S M L XL", "Mens Medium", "(Medium)", "2X-Large", ranges as every size; titles with no size stay). Measured
     on the 617 hosted titles: the gender answer removes 23-50% of a search's results, and 182 titles state a size.
     With either filter on, the actor is asked for 50 listings per store instead of 25.
2. **Search and check:** the live search above with that query and limit, 25 listings per store, and a Gate
   `verdict` per listing. If a query finds nothing, it is retried with its first word dropped ("warm fleece jacket",
   then "fleece jacket", then "jacket"), with a `search` event per query. Page text stays on the server for the Scout.
   Listings over the limit or filtered out above never reach the feed.
3. **Narrow:** approved listings whose title doesn't name the item (the query's last word, `rank.qualified`) are
   dropped first, so a sweatshirt search never offers jackets. With 4 or more left, the model looks at up to 60 of
   the cheapest and may ask which direction to take when they split into 2-4 clearly different groups (brand, style,
   type). Each option names the listings it keeps, and code drops options that keep nothing or everything. The UI
   shows each option's count plus **No Preference**. Choosing an option keeps only its listings
   (`narrow {kept, total}`); No Preference or a typed answer keeps them all. Measured: "warm fleece jacket under $50"
   (men's, M) split 63 safe listings into classic brand fleece 37, sherpa 6, tactical 13.
4. **Pick favorites:** every remaining listing with a photo of its own, the same product listed twice kept once,
   goes to the browser as `qualified {items: [{id, image, ...}]}` (all of them if none has a photo). A photo that
   fails to load, or loads narrower than 40px, drops out of the grid, so it never shows an empty tile. The UI shows them as a grid of photos only under
   "Qualified Items", 4 a row and 2 rows a page, with a pager under it. Hovering a photo lifts it slightly (2.5%)
   while the others ease back and fade a little. Only transform and opacity animate, so the layout never moves and
   the motion runs on the GPU; edge photos grow inward so the grid never clips them. The hovered photo is kept in
   state, so crossing the gap between photos never resets it, and Amazon and eBay photos load at 600px instead of
   1500px. The user
   picks up to 5 (each shows the order it was picked in) and clicks Compare, which sends
   `POST /chat/{id}/select {"ids": [...]}`; the stream echoes `selected {ids}`.
5. **Weigh** (`rank.weigh`, in code): each favorite gets four 0-1 factors from its page, and a score out of 100:
   seller trust 30% (the store's base: mzn 0.85, by 0.7, dpp 0.65, others 0.5; 1.0 when the store sells it itself,
   e.g. seller "Amazon.com"; by seller feedback moves it toward its percentage as ratings grow), price 30% (the
   cheapest favorite's price over this one's), reviews 25% (stars averaged with 4.0 as if from 20 more reviews) and
   condition 15%. Sent best first as `pick {picks}` with the photo, score, factors, condition, stars, reviews,
   feedback and a one-line note. The UI shows each favorite's photo, title, store, rating and price, and its score as a short bar (green on the
   best one, Hunter's recommendation).
6. **Confirm:** nothing is bought automatically. The best favorite starts out chosen, and until the user confirms
   or cancels they can click another weighed favorite to choose it instead, like a radio button. The UI shows the
   chosen favorite's photo, title, price, store, seller,
   condition, reviews, score, payment method and listing link. Confirm must be clicked twice: the first
   click turns it green ("Pay 12.98 USDC") for 5 seconds, the second sends
   `POST /chat/{id}/confirm {"confirm": true, "pick": 0}`, where `pick` is the chosen favorite's place in the
   weighed list (0, the best, by default). Cancel sends `false` and the run ends `stopped` with nothing paid. The
   stream echoes `confirmed {ok, pick}`, and the API buys that favorite.
7. **Pay** (`app/pay.py`): the confirmed favorite is bought over x402 in the six steps the UI lists, each sent as a
   `checkout {step, state, detail}` event: start checkout (POST with a ship-to, the store answers 402), read the price
   and wallet from `PAYMENT-REQUIRED`, double-check in code (network and asset as in
   `contracts/allowlist.json`, amount equals the listed price, `payTo` equals the store.json wallet, within the
   limit), sign an EIP-3009 `TransferWithAuthorization` for exactly
   that amount with `BUYER_PRIVATE_KEY`, POST again with `PAYMENT-SIGNATURE`, and read the order and the transaction
   hash (`PAYMENT-RESPONSE`). A `receipt` event (with the item's `image`) follows a real payment, and the receipt
   shows that photo. The facilitator pays gas, so the wallet needs
   USDC but no ETH. Without `BUYER_PRIVATE_KEY` the run stops at "Approve the Exact Amount" (`state: blocked`) and
   nothing is signed. A failed check stops before signing.
   - Verified without paying: all four stores answer a correct v2 402, and a payload signed by `app/pay.py` with an
     unfunded key was rejected by the x402.org facilitator's `/verify` only for insufficient USDC balance.
8. **End:** `end` with `status: bought`, `ready` (everything checked, no wallet key) or `stopped`.

- **Answering:** a run opens with `run {id}`. A question is `question {stage: understand|pick, text, options,
  counts?, images?}`; the browser sends the answer to `POST /chat/{id}/answer` with `{"text": "..."}`, and the stream echoes it
  as `answer {stage, question, text}` before going on. Answers, favorites and the go-ahead share one inbox per run,
  and a step drops replies meant for an earlier one (a double click). While it waits the stream sends a `ping`
  every 15s so proxies keep it open, and after 15 minutes without a reply it ends with an `error`. Waiting runs live
  in the API process's memory, so the API must run as a single instance. The chat badge reads "Needs Your Answer"
  while Hunter waits on a question, the grid or the confirmation.
- **Question card:** like Claude's question picker, a column of numbered options in Title Case with "Something
  Else..." as the last row for typing your own answer. A number key picks that option. Narrowing options also show
  how many listings each keeps and a photo of one of them: the first photo on that listing's page that no other safe
  listing's page shows (item pages also show related items and banners). Rows without a photo show a no-image icon.
- **Reasoning:** GLM-5.3-Flash streams its thinking as `reasoning_content`, which is long working notes ("Max
  price: null"). `app/llm.py` splits it into sentences as they complete and forwards only short plain ones as
  `reasoning {stage: understand|pick, text}` events, speaking to the user ("The user wants" becomes "You want").
  The UI shows just the latest sentence in the active stage, each one replacing the last. Asking for brief thinking
  or for no thinking did not shorten it (measured 650-2000 characters either way). Reasoning counts against
  `max_tokens`, so calls allow 6000 (at 600 the answer came back empty).
- **UI** (`apps/agent/web`): the same stages, summaries and receipt as the scripted demo it replaced
  ("192 Safe · 59 Scams Blocked", "mzn · 8.50 USDC", "Paid 8.50 USDC"), filled from the stream. Found listings
  join the feed one every 55ms and are checked one every 70ms (checking starts once every found listing is on screen),
  and each checkout step appears once its event arrives, with its detail shown only when the step stopped the
  payment. The request shows as one card with the item and a chip per detail (Men's, Size M, Under $40), and each
  answer as the question with the reply as a chip. Resale titles show without bullets and hashtags. Blocked rows show "Fake Store Website", "Hidden
  Instructions", "Too Cheap to Be Real" and similar. Listings over the user's limit are left out of the stream, as a
  price filter; the Gate and the checkout double-check still enforce the limit. The receipt shows the item's photo,
  the amount with a Paid tag, the title, store and time, then the order id and a Basescan link. The store gives no
  delivery date, so there is no "Arrives" row.
- A run lives in its chat view: leaving a chat mid-run ends the stream and coming back starts it over. Finished runs
  are kept with the chat and shown without streaming again.
- **Back:** a small "‹ Back" sits above whatever Hunter is waiting on, whenever there is a step to return to, and
  sends `POST /chat/{id}/back`. The API treats it as a reply: from the go-ahead it shows the grid again (with the
  favorites picked before still picked), from the grid the last narrowing question, from a narrowing question the one
  before it, and from the first step after the search the last question before it, after which the search runs
  again. A question before the search goes back to the one before it. The stream sends `back {to: understand|pick,
  keep}` so the browser keeps the first `keep` answers and resets everything after them.
- **Motion:** each stage's content animates its height as it changes (a question answered, the grid giving way to
  the weighing), the confirm card stays in place while only its content crossfades when the chosen favorite changes,
  and Confirm keeps one width when it turns into "Pay 12.98 USDC". Reduced motion turns all of it off.
- **Automatic** (sidebar, above Settings): a switch for buying without confirming, off and disabled for now.
- **Measured** (local agent API, warm Standby Actor): first reasoning at 0.7s, request understood at 1.7-1.9s, first
  listing about 0.3-2.6s later, search and checks done by 5-12s, picks at 9.7-18.9s. The pick call takes 4-7s.
- Self-check: `uv run python -m app.scout` (from `apps/agent/api`).
