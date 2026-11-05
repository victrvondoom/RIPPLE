# Red-team loop + Gate: implementation plan

Scope: the **Gate** (green on the architecture page) and the **red-team loop** (purple). Where this plan and the
site disagree, this plan wins (3–5k listings per round, holdout split by attack family, two-layer Gate).

Work runs in two git worktrees after a short shared step:

| Worktree | Branch | Owns |
|---|---|---|
| `../calhacks-gate` | `feat/gate` | `gate/` (Layer 1 TS, Layer 2 Python features/train/eval/serve) |
| `../calhacks-redteam` | `feat/redteam` | `redteam/` (Bitdeer generator, holdout, MCP server, coordinator, guards, strategist) |
| both branch from | `feat/contracts` | `contracts/` (shared formats, written first) |

---

## Part 1: Blockers

Each blocker has a status: **DECIDED** (this plan picks a default; override if you disagree),
**NEEDS YOU** (only you or a teammate can unblock), or **TEST** (we verify it during the build).

### A. From other parts of the system

**A1. Where does the Gate run at purchase time? (Wallet part) DECIDED, confirm with wallet owner**
- *Plain version:* the plan puts the wallet in TypeScript (viem), but the agent backend in this repo is Python.
  The Gate has to sit between them, so we need to know which process asks it "may I pay?".
- *Why it matters:* it decides what language each Gate layer is written in and how the wallet calls it.
- *Default:* Layer 1 is a TypeScript library (`gate/layer1`) the wallet imports. Layer 2 (the risk model)
  is Python, exposed as `score(snapshot)` and an optional `POST /gate/risk` route the wallet calls.
  If Layer 2 can't be reached, the purchase is refused. Neither layer is needed by the red-team loop
  to be wired into the wallet, so this only blocks final integration.

**A2. What does Scout hand the Gate? (Scout part) DECIDED, tell Scout owner**
- *Plain version:* the Gate needs one fixed package of facts for each purchase it judges.
- *Why:* if Scout sends something different from what the Gate was trained on, the Gate judges garbage.
- *Default:* the **Snapshot** format in `contracts/snapshot.schema.json`. It's simply what a shopper sees:
  `store.json`, the item page with reviews, the decoded 402 terms, plus the user's rules (max price,
  budget left). Live and generated listings use the same format, so the same Gate code runs on both.

**A3. Who tracks money already spent? (Wallet part) DECIDED**
- *Plain version:* the spending-cap rule needs "how much have I spent so far", and the Gate keeps no memory.
- *Default:* the wallet keeps the spending record and passes `budget_remaining_usd` into each Snapshot.

**A4. Scam stores served over real x402 (Storefront part, plan B6/B7) NEEDS YOU, but not blocking**
- *Plain version:* to test the full payment path, someone has to serve generated scam stores that send
  back real 402s with the attacker's wallet in them.
- *Why it isn't blocking:* the loop judges Snapshots offline first (the site's "nothing reaches a
  storefront"). End-to-end runs are a stretch goal.
- *Need to know:* who builds the `/s/{storeId}/...` route and by when. Also, what are `apps/store-a/b/c`
  for (honest comparison stores?) and what are their `payTo` wallets?

**A5. Market medians (Listings/Apify part) NEEDS YOU (token) or DECIDED fallback**
- *Plain version:* "too cheap" only means something next to a normal price. Medians come from
  eBay sold listings, which haven't been scraped yet (there's no `medians/` folder).
- *Why:* the price feature and the "too cheap" attack both depend on it. Needed by about hour 1:30.
- *Default:* if `APIFY_TOKEN` isn't available, use Pixel Cart's own catalog prices as the medians
  (`contracts/market_medians.json`, labelled `source: catalog-fallback`) and switch to the real list later.

**A6. Known-seller list (Wallet/Storefront parts) DECIDED**
- *Plain version:* the Gate keeps a list of real sellers and their wallets, so it can spot a wallet that
  looks almost the same but isn't.
- *Default:* `contracts/known_sellers.json` starts with Pixel Cart (`seller_pixelcart_001`,
  `0x45fE…c862`), plus any store-a/b/c wallets once we have them.

**A7. CRS seller verification (CRS part) DECIDED: skip for now**
- *Plain version:* the plan marks CRS as optional and never says what its API returns.
- *Default:* no CRS feature. The registry has room for a `crs_verified` feature later.

### B. Between the Gate and the red team

**B1. One listing format for both sides DECIDED: written first, in `contracts/`**
- *Plain version:* the attack factory makes listings and the Gate reads them. If they disagree on
  the format by even one field name, nothing works.
- *Fix:* a JSON Schema plus 6–8 hand-written example Snapshots, committed before either worktree starts.
  A Python model (pydantic) and a TS type both mirror it, and both test against the same examples.

**B2. The known-seller rule clashes with honest new sellers DECIDED**
- *Plain version:* the plan's Layer 1 says "pay only wallets on the known list". The plan *also* wants honest
  new sellers to get through (B4). Both can't be hard rules, or every new seller is blocked and the
  false-block rate explodes.
- *Fix:* Layer 1 hard-blocks only (a) a 402 wallet that differs from the store's own `store.json` and
  (b) a wallet that's a **lookalike** of a known wallet. An unknown but distinct wallet goes to Layer 2,
  which weighs seller age, reviews and so on.

**B3. The features the coordinator writes must also run at purchase time DECIDED (confirmed: Layer 2 in Python)**
- *Plain version:* the coordinator writes new feature code in Python (`gate/features/*.py`). The plan
  (G4) wanted the model to run inside TypeScript. Every new Python feature would then need a TypeScript
  twin, kept identical by hand, every round.
- *Fix:* Layer 2 (features + model) runs in Python, both for training and at purchase time. TypeScript runs
  Layer 1 only. One copy of the code means no drift. G4's "versioned model JSON, replay R1/R2/R3" still holds.

**B4. Labels must be trustworthy DECIDED**
- *Plain version:* if we ask an LLM to "write a scam" and "write a legit listing", it sometimes writes the
  wrong one. Mislabelled data teaches the Gate wrong lessons and makes the catch rate meaningless.
- *Fix:* **code decides the label and applies the structural attack** (price cut, lookalike wallet, 402
  mismatch, seller age, checkout-ID swap). The LLM only writes text: store names, titles, descriptions and
  reviews. For text tactics (prompt injection, urgency, fake reviews) the LLM must quote the scam text in
  `tactic_evidence`, and code checks that the quote actually appears in the listing.
  Each Bitdeer call mixes scam and legit slots, so writing style can't give the answer away.

**B5. How the red team calls the Gate (training/eval interface) DECIDED**
- *Plain version:* the coordinator's tools have to run the Gate's training and scoring. Both sides need to agree
  on the commands and what they print.
- *Fix:* three CLIs with fixed JSON output, defined in `contracts/interfaces.md`: `gate-train`, `gate-eval`
  and `gate-l1` (Node). Until the real ones exist, the red team uses a stub that prints the same JSON.

**B6. Keeping the holdout honest DECIDED + TEST (see C3 for why this matters)**
- *Plain version:* the headline number is "catch rate on scams the system never saw". If the coordinator can
  read those scams, or tune against that number, the result is fake.
- *Fix (defence in depth):*
  1. Holdout lives **outside the repo** (`../calhacks-holdout/`) and is **encrypted**. The key is given only to
     the MCP server process, never to the droid's environment.
  2. The holdout contains (a) one or two whole attack families that are never generated for training, and
     (b) seen families written by a model never used for training (Nemotron).
  3. The coordinator has **no tool** that scores the holdout. Holdout totals are computed automatically, only
     when a model is promoted, and promotion is decided on validation metrics in code. It therefore can't
     tune itself against the holdout.
  4. A guard hook blocks paths outside the coordinator's folder, plus Task, FetchUrl and Skill misuse (C3).

**B7. Rules for features the coordinator writes DECIDED**
- *Plain version:* the coordinator writes new Python features, and a bad one could crash training, call the
  internet, or break the "price falls → risk can't fall" guarantee.
- *Fix:* a small plugin API. `@feature(name, monotone=-1|0|1)` registers a pure function `(snapshot, ctx) -> float`.
  `gate-train` runs a feature self-test first (deterministic, finite, no network). Any failure means
  training fails and the round reverts. Monotonic directions come from the decorator.

**B8. One fixed definition of every metric and of "promotion" DECIDED**
- *Catch rate (recall)* = scams the Gate skips ÷ all scams. *False-block rate (FPR)* = legit listings skipped ÷ all legit.
  Both are reported for the **full Gate** (Layer 1 + Layer 2) and for **Layer 2 alone**. Layer 1 catches the
  structural families 100% by design, so the learning story is told on Layer 2.
- *Attack success (per round)* = this round's fresh attacks scored by **last round's** model, before retraining.
  This is the "red team vs. Gate" number.
- *Promotion (C6, enforced in code):* validation recall improves, validation FPR ≤ 2%, and no family drops
  more than 5 points. Otherwise revert.
- *Baseline R0:* Layer 1 plus logistic regression on 3 features, trained on the seed batch.

### C. Environment, accounts, SDK

**C1. Bitdeer keys aren't in this machine's environment NEEDS YOU**
- `BITDEER_API_KEY` and `BITDEER_KEY_GLM` were set in an earlier shell but aren't set now
  (not in user-level env either). Put them in a gitignored `.env` at the repo root, or set them user-level.

**C2. Bitdeer test results not recorded NEEDS YOU (or we re-run, about 5 min)**
- The test code exists, but its printed results weren't saved. From the code, the risks are: strict JSON-schema
  mode causing runaway whitespace on some models, the unknown rate limit, and **refusals** on scam-writing prompts
  (marked "test by hand"; result unknown).
- *Default:* JSON-object mode, then our own pydantic validation, batches of 15, 16 concurrent requests with
  backoff. Prompts frame the work as security test data, and code (not the LLM) applies the dangerous parts
  (wallet swaps etc.), which lowers refusal risk. We re-run `bitdeer_smoke.py` and `bitdeer_followup.py` first.

**C3. Earlier test sessions show three ways the holdout can leak DECIDED (fixes in B6) + TEST**

What the logged sessions show:
- **The permission handler alone does not stop reading.** With read tools enabled and only the handler in place,
  the coordinator read the canary from both holdout files (session `6b0e318e`). Reads don't trigger a permission
  request at high autonomy.
- With the PreToolUse hook on, reads were blocked. The model then **tried workarounds**: it started an `explorer`
  subagent through `Task`, called `FetchUrl` on `file:///…` (refused by the tool), and loaded the `agent-browser`
  Skill. It's **unverified** whether the hook also covers tool calls made *inside* subagents.
- The old hook blocks any input containing the word "holdout", which also blocked harmless Task calls.
- *Fix:* encryption plus a path-based hook, a Task allowlist (`attack-strategist` only), `FetchUrl`, `WebSearch`
  and `Skill` disabled, and a canary leak test in the test suite (`redteam/tests/test_isolation.py`) that is also
  shown in the demo.

**C4. In-process MCP server is broken on this machine DECIDED**
- `create_sdk_mcp_server()` dropped the first request, so we use a stdio MCP server (already proven in the tests).

**C5. Python deps DECIDED**
- `lightgbm` isn't installed. `gate/` and `redteam/` each get a uv project (Python 3.13). `redteam` depends on
  `gate` by path.

**C6. Coordinator model DECIDED: Bitdeer DeepSeek-V4.1-Flash**
- The tests ran the coordinator on Bitdeer `DeepSeek-V4.1-Flash` through `--settings`, and that worked. The
  alternative is a Factory-hosted model (more reliable over long multi-step rounds, but it uses Factory credits).
- *Default:* DeepSeek-V4.1-Flash on Bitdeer, with a `--model` flag to switch. Droid is already logged in through
  the keyring, so `FACTORY_API_KEY` isn't needed locally.

**C7. Budget NEEDS YOU**
- The Bitdeer balance is unknown. `bitdeer_budget.py` projects the cost. Each round also has a hard token cap
  (C8), and generation stops cleanly when the cap is reached.

---

## Revision 3 (Oct 24): CRS removed

CRS is no longer part of the process (user decision). Seller trust is now the known-wallet list plus the unknown-seller
cap:

- **Known wallet** (on `known_sellers`): trusted at any price within the user's max price and budget.
- **Unknown wallet:** paid only up to `unknown_seller_cap_usd` ($100); Layer 2 then decides. Above $100, Layer 1 skips
  (`L1_UNKNOWN_SELLER_CAP`). `L1_SELLER_UNTRUSTED` is gone.
- **Layer 2:** loses `crs_verified` and `crs_days_verified`; it keeps `known_wallet` and `payto_age_days`.
- **Families:** `lookalike_payto` and `unknown_seller` (was `unverified_seller`) reach Layer 2 when priced within the
  cap. `legit_new_verified_seller` is now `legit_new_seller`.
- **Data:** the attack factory and the holdout no longer create CRS records; generated sellers only get a wallet
  first-seen date.

Where this document mentions CRS below, it is historical.

**Promotion bound (dry-run finding):** the 2% false-block bound now applies to `layer2_fpr`, the trained model's false
blocks among legit listings that pass Layer 1. On the scraped data, Layer 1's cap skips about 9% of honest real listings
(unknown wallets over $100) by design. Counted in the bound, that made every model unpromotable. Those policy blocks are
still reported in `fpr` and `fpr_real`.

## Revision 2 (Oct 24): issue #1 contracts and MongoDB

This revision supersedes Part 2 and every place below that mentions the `Snapshot` format, Pixel Cart reference data or
`data/rounds/` files. Parts 1, 3, 4 and 5 still describe the structure of the work; where they disagree with this
section, this section wins.

**What changed and why**

| Before | Now | Why |
|---|---|---|
| One `Snapshot` record carrying label, family and generator info | Issue #1 `Listing` (minimal, shared by real and synthetic) + `AnswerKey` + `GenInfo`, stored apart | The Gate can't tell real from synthetic by format, and labels can't leak into features |
| Store stats in the listing (rating, sellingSince, review dates) | Dropped. Trust comes from references the Gate looks up: known sellers, CRS, market median, wallet first-seen | The attacker writes everything in a listing; only references are unforgeable |
| Unknown sellers go to Layer 2 | Layer 1: pay only known wallets **or** CRS-verified sellers, and CRS-only sellers only up to `unknown_seller_cap_usd` | Issue #1 task 1 recommendation |
| Reference data and listings in JSON files built around Pixel Cart | All data in MongoDB (`redteam` database); real listings enter only through `contracts-ingest` | User decision: MongoDB is the data source |
| Generator writes listings from templates | `AttackSpec.mode = mutate_real` (change one thing in a real listing, recorded in `attack_diff`) is the main mode; `generate` is secondary | Real listings as the base stop the Gate learning generator style |
| `spoofed_store_name` held out | `lookalike_domain` held out (the Listing has no store name; the same trick lives in `seller.domain`) | Keeps the user's choice of holdout under the new shape |
| Coordinator writes the round report | Coordinator writes `CoordinatorOutput`; code fills metrics, promotion decision and cost into `RoundReport` | The LLM can't invent the headline numbers |
| Holdout totals hidden from the coordinator | `RoundInput.holdout_totals` gives it totals for the current model only, per issue #1 | Issue #1; promotion still uses validation only |
| New metrics | `fpr_real` (false blocks on real listings), `adaptive_recall` (white-box attacks), Wilson intervals on every rate | Issue #1 |

**Data flow**

```
contracts-ingest (real listings, known sellers, CRS stand-in, medians) --> MongoDB redteam.*
coordinator --AttackSpec--> generate_attacks --mutate_real / generate--> Repo.put_synthetic --> MongoDB
gate-train / gate-eval read listings + cases + references from MongoDB, answer keys only for scoring
holdout: built once from MongoDB real listings + held-out families, encrypted outside the repo, scored in memory
```

**Open items carried by this revision**
- MongoDB is empty. Nothing can be trained on real data until real listings, known sellers and medians are ingested.
- `lookalike_domain` is held out, but issue #1 lists "domain closeness to known stores" as an essential Layer 2 feature.
  Keeping both means the holdout tests a feature we designed for that trick, which weakens the "never seen" claim.
- CRS has no API yet: `crs_results` is a stand-in collection (`source: "stub"`).
- Domain age (issue #1 Layer 2) has no data source yet and is left out.

## Part 2: Shared contracts

See `contracts/interfaces.md` (rewritten for issue #1). The original Snapshot-based Part 2 is in git history
(`docs: add red-team loop and gate implementation plan`).

---

## Part 3: Gate worktree (`feat/gate`)

```
gate/
  layer1/                     TypeScript, npm workspace "@calhacks/gate-layer1"
    package.json              deps: none at runtime; dev: typescript, tsx, @types/node
    src/types.ts              Snapshot, Layer1Result, RuleId (mirrors contracts)
    src/x402.ts               decodePaymentRequired(header) -> accepts[0] (handles the live v2 header)
    src/lookalike.ts          isLookalike(a, b): same first4/last4 hex (case-insensitive), a != b
    src/rules.ts              checkLayer1(snapshot, ctx) -> {pass, failures}
    src/cli.ts                JSONL stdin -> JSONL stdout (gate-l1)
    test/rules.test.ts        node:test over contracts/examples + the captured live 402 header
  pyproject.toml              uv project "gate"; deps: lightgbm, scikit-learn, numpy, pandas, pydantic, pyyaml, jsonschema
  gatepy/
    contracts.py              pydantic Snapshot, Decision; load contracts/*.json
    context.py                Ctx: medians, known_sellers, injection patterns, now()
    registry.py               @feature decorator, discover features/*.py, self_test()
    dataset.py                load JSONL -> DataFrame; feature cache keyed by (snapshot hash, feature code hash)
    layer1_bridge.py          batch-call `node gate/layer1/dist/cli.js` for offline scoring
    train.py                  gate-train
    evaluate.py               gate-eval (full gate = L1 bridge + L2), metrics, per-family, top-3 via pred_contrib
    model_io.py               save/load model JSON; promoted.json pointer
    serve.py                  score(snapshot) -> Decision; optional FastAPI router POST /gate/risk
  features/                   <- the coordinator may edit these
    price.py                  price_ratio (monotone -1), below_median_flag, amount_vs_listed
    seller.py                 seller_age_years (-1), review_count, store_rating, reviewcount_mismatch
    reviews.py                review_dup_max (token Jaccard), unverified_frac, review_date_span_days, review_len_mean
    injection.py              injection_hits (regex), zero_width_chars, imperative_to_agent
    payment.py                payto_known, payto_min_hamming_to_known, payto_store_match
    text.py                   urgency_hits, store_name_similarity_to_known (with different sellerId)
  train_config.yaml           <- the coordinator may edit this: model kind, params, enabled features, threshold rule (max_fpr 0.02)
  models/                     r0.json …, promoted.json
  tests/                      pytest: registry self-test, determinism, monotonic sweep, metric math, eval on examples
```

**Layer 1 rules** (`RuleId`), each a pure check, all must pass:

| Rule | Check |
|---|---|
| `L1_PAYTO_MISMATCH` | `payment_required.payTo` == `store.payTo` (case-insensitive) |
| `L1_PAYTO_LOOKALIKE` | payTo is not a lookalike of any `known_sellers[].payTo` (identical is fine) |
| `L1_AMOUNT_MISMATCH` | amount == round(item.priceUsd × 10^6) |
| `L1_OVER_MAX` | item.priceUsd ≤ mandate.max_price_usd |
| `L1_OVER_BUDGET` | item.priceUsd ≤ mandate.budget_remaining_usd |
| `L1_NETWORK` / `L1_ASSET` | network and asset on `allowlist.json` |
| `L1_TIMEOUT` | maxTimeoutSeconds ≤ 120 |
| `L1_ITEM_MISMATCH` | checkout_item_id == item.id |
| `L1_SCHEME` | scheme == "exact" |

**Layer 2 training:** LightGBM binary (`objective=binary`, small trees, `monotone_constraints` from the registry,
`deterministic=true`, fixed seed). Threshold = the lowest risk cut whose validation FPR (Layer 2 alone, on legit rows that pass L1) is ≤ 2%.
`logreg` is kept as the R0 baseline and as a fallback model kind.

**Order of work (gate):**
1. `layer1` rules + CLI + tests, all passing on the examples and the live 402 header. *(~1h)*
2. `registry` + the six feature modules + `self_test`; pytest determinism and monotonic tests. *(~1h)*
3. `train.py`, `evaluate.py`, `model_io.py`; R0 baseline from the examples plus the first seed batch from the red team (or a local fake batch). *(~1h)*
4. `serve.py` + `POST /gate/risk`; decision JSON with top 3. *(~30m)*

## Part 4: Red-team worktree (`feat/redteam`)

```
redteam/
  pyproject.toml              uv project "redteam"; deps: gate (path), openai, mcp, droid-sdk, pydantic, cryptography, python-dotenv
  redteam/
    config.py                 paths (DATA=data/, HOLDOUT=../calhacks-holdout/), model ids, budgets
    bitdeer.py                OpenAI client to api-inference.bitdeer.ai; semaphore(16); backoff on 429/5xx; token tally
    prompts.py                one mixed-slot prompt: N slots, each tagged {family | legit_*} with text-only instructions
    mutate.py                 code-applied structure per family (price, payTo, seller age, review dates, checkout id, spoofed names)
    validate.py               pydantic Snapshot + tactic_evidence substring check; retry once, then drop (B2)
    generate.py               generate(spec) -> data/rounds/R{n}/{batch}.jsonl; rotates GLM-5.3-Flash / DeepSeek-V4.1-Flash; records model+temp
    holdout.py                build_holdout() (run once by us) -> ../calhacks-holdout/holdout.jsonl.enc; holdout_totals(model_id)
    splits.py                 train/val assignment (val = 20% of each batch, by hash); holdout families excluded from specs
    mcp_server.py             stdio FastMCP server: the coordinator's only window on the world
    guard_hook.py             PreToolUse: path-based, Task allowlist, edit allowlist; logs to data/guard.log
    coordinator.py            one droid-sdk Session per round; RoundReport output; resume by session id
    report.py                 rounds table R0..Rn (attack success, val, holdout totals, budget) for the demo/dashboard
  factory/settings.json       customModels: GLM-5.3, GLM-5.3-Flash, DeepSeek-V4.1-Flash (Bitdeer), apiKey ${BITDEER_*}
  tests/
    test_mutate.py            each family mutation produces what it claims; labels set by code
    test_validate.py
    test_isolation.py         canary probe: holdout-shaped file outside cwd + Task/FetchUrl/Skill attempts; pass = no leak
gate/.factory/                (coordinator cwd is gate/)
  droids/attack-strategist.md custom:GLM-5.3-(Bitdeer)-0; no file tools; returns JSON list of attack ideas
  hooks.json                  written at runtime by coordinator.py (absolute python path), gitignored
```

**MCP tools** (C2, adjusted for B6):

| Tool | Does | Notes |
|---|---|---|
| `get_status()` | current promoted model, last val metrics per family, family coverage, budget left | |
| `generate_attacks(spec)` | B1 spec → bulk Bitdeer generation → batch id + counts + drops | rejects holdout families, caps n, checks budget |
| `score_round(round)` | last promoted model on this round's fresh attacks = **attack success** | |
| `inspect_failures(round, limit)` | misses + false blocks grouped by family and top-3 features, with text snippets | val/train rows only |
| `train_gate(round)` | runs `gate-train` on all train rows so far | returns the val metrics |
| `eval_gate(model_id, split)` | `split ∈ {train, val}` only | **no holdout** |
| `promote_model(model_id)` | applies the C6 rule in code; on success records holdout totals | the coordinator can't override it |
| `render_store`, `run_agent_batch` | return "not available" until the storefront route (A4) exists | stretch |

**Coordinator session** (`python -m redteam.coordinator --round N [--resume SID] [--model ...]`):
- `Session(cwd=gate/, model=…, SessionConfig(autonomy=HIGH, mcp_servers=[stdio redteam], disabled_tools=[Execute, FetchUrl, WebSearch, Skill, …automation tools]))`,
  runtime `--settings redteam/factory/settings.json`, env = only `BITDEER_*` (no holdout key).
- `on_permission`: edits only `features/*` and `train_config.yaml`; MCP only `redteam___*`; everything else is cancelled.
- Hook: deny any path outside `gate/`; deny edits outside the allowlist; deny `Task` unless `subagent_type == "attack-strategist"`.
- Prompt: the round's goal, the rules, the tool order (status → strategist → generate → score → inspect → edit features → train → promote).
- `output=RoundReport` (C4: round, failures_by_cluster, new_attack_specs, feature_changes, train_params, metrics).
- Saves `data/rounds/R{n}/{report.json, session_id, usage.json, calls.jsonl}`. Per-round caps: wall time and tokens (C8).

**Order of work (red team):**
1. `bitdeer.py`, `prompts.py`, `mutate.py`, `validate.py`, `generate.py`; re-run the smoke tests; produce a **seed batch** (~300) for the gate side. *(~1.25h)*
2. `holdout.py` + `splits.py`; build the encrypted holdout (~600 listings). *(~30m)*
3. `mcp_server.py` against a **stub** `gate-train`/`gate-eval` that prints contract-shaped JSON. *(~1h)*
4. `guard_hook.py`, `coordinator.py`, strategist droid, `test_isolation.py`. *(~1.25h)*
5. Join: switch the stub for the real gate CLIs; run R1 → R3; `report.py`. *(~1h)*

## Part 5: Timeline and join points

```
0:00 ─ feat/contracts (together) ───────────────────────────────────────────────
0:45 ─ worktrees created
        gate:     layer1 ──> features+registry ──> train/eval ──> serve
        redteam:  generator ─> seed batch (~1:45) ─> holdout ─> MCP(stub) ─> coordinator+guards
1:45 ─ JOIN 1: red team hands the seed batch to the gate side (data/rounds/R0/)
3:30 ─ JOIN 2: merge feat/gate into feat/redteam; swap the stub for real CLIs; R0 baseline
4:30 ─ rounds R1 → R3 (each: fresh attacks → score → fix features → train → promote/revert)
5:30 ─ demo assets: rounds table, guard log of blocked holdout attempts, R1/R2/R3 replay
```

Stretch, in order: bge-m3 embedding features (cached, G2) → storefront scam route + `run_agent_batch` over real
x402 (A4) → Apify medians (A5) → CRS → dashboard.
