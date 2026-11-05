# Gate

Two layers decide whether the wallet may pay; both must say yes. The input is the issue #1 `GateInput` (mandate +
the listing the Gate fetched itself + references it looked up itself); the output is a `GateDecision`. Contracts:
`../contracts/interfaces.md`.

| Layer | Where | What |
|---|---|---|
| 1 | `layer1/` (TypeScript) | Fixed rules, never learned: 402 wallet matches `store.json`; a known wallet, or an unknown wallet priced within `unknown_seller_cap_usd` ($100); amount equals price; max price; spend remaining; network and asset allowlist; checkout item; product matches the mandate; 402 timeout |
| 2 | `gatepy/` + `features/` (Python) | LightGBM risk score, run only when Layer 1 passes and only able to turn buy into skip. Monotone in price and trust signals, fixed threshold, top-3 reasons |

## Deployed model: r3-be84bc

The Gate service ships `r3-be84bc` (`../gates/CURRENT`): `r2-f0bfbd` plus one red-team round with the `store_clone`
family, run after `r2-f0bfbd` let every mzn Official Outlet listing through on the live stores. Card:
`../gates/r3-be84bc/CARD.md`.

Live stores (the Gate service reading each listing itself, 5 searches, 25 listings per store):

| Store | Listings | r2-f0bfbd skipped | r3-be84bc skipped |
|---|---|---|---|
| mzn, by, dpp (real) | 304 | 1.3% (3 timeouts, 1 `payment_coercion`) | 0% |
| mzn Official Outlet (scam) | 105 | 0% | **100%** |

Benchmark (the fixed 444-row test set, which has no store clones): accuracy 90.7% [88–94] (r2 91.8%), seen-family
scams caught 85.6% [79–91] (88.1%), model false blocks 1.8% (1.8%), risk AUC 0.965 (0.954). The figures for `r2-f0bfbd`
below are kept for comparison.

## Previous model: r2-f0bfbd

The Gate service ships `r2-f0bfbd` (`../gates/CURRENT`). It was promoted in round 2 of seed 1 of a three-seed red-team
validation. It was the only candidate of 9 across the three seeds to beat the baseline (`r0-ac1d79`) under
coverage-aware promotion, with about 25 validation scams per family. Seeds 2 and 3 kept the baseline. It was trained on
804 rows using 21 features: the 17 below plus `payment_coercion`, `untrusted_deep_discount`, `review_paraphrase_mass`
and `review_dup_long_frac`. Its threshold is 0.857, set on out-of-fold scores (5 folds by base listing) of the legit
train and calibrate rows. Full card: `../gates/r2-f0bfbd/CARD.md`; every version: `../gates/history.json`.

Benchmark: a fixed test set of 444 rows built from locked-test listings, never trained on, scored on both layers.
Brackets are 95% cluster-bootstrap intervals over base listings.

| Metric | Baseline r0-ac1d79 | **r2-f0bfbd** | n |
|---|---|---|---|
| Accuracy (seen scams + legit) | 86.9% [83–90] | **91.8%** [89–94] | 389 |
| Scams caught, seen families | 75.6% [68–83] | **88.1%** [81–93] | 160 |
| Honest listings skipped by Layer 2 | 1.4% [0–3] | 1.8% [0–4] | 229 |
| Honest listings skipped by Layer 1 ($100 unknown-seller cap) | 3.9% [2–7] | 3.9% [2–7] | 229 |
| Real scraped listings skipped (both layers) | 7.6% [4–13] | 9.1% [4–14] | 132 |
| Layer 2 risk AUC | 0.941 | **0.954** | |
| Scams caught, held-out families (`urgency_pressure`, `lookalike_domain`) | 8.6% [0–21] | 11.4% [3–22] | 35 |
| `unknown_seller` scams caught (policy-bounded, within the $100 cap) | 5.0% | 0.0% | 20 |

Skip rate by scam family (20 test rows each, except `urgency_pressure` with 15):

| Family | Baseline | r2-f0bfbd |
|---|---|---|
| `bait_and_switch`, `hidden_text`, `lookalike_payto`, `payment_mismatch`, `product_switch` | 100% | 100% |
| `fake_reviews` | 35% | **85%** |
| `prompt_injection` | 45% | **85%** |
| `too_cheap` | 25% | 35% |
| `urgency_pressure` (held out) | 7% | 27% |
| `lookalike_domain` (held out) | 10% | 0% |
| `unknown_seller` (policy-bounded) | 5% | 0% |

Honest families stay at or near zero. `legit_mixed_reviews`, `legit_new_seller` and `legit_plain` are at 0%,
`legit_real_discount` fell from 11% to 0%, and `legit_rewrite` rose from 0% to 6%.

On the encrypted operator holdout (122 scams generated with different models and never shown to the coordinator), the
results are:

| Holdout metric | r2-f0bfbd | Baseline |
|---|---|---|
| Recall | 54.1% | 53.3% |
| Seen families | 82.5% | 77.5% |
| Held-out families | 0.0% | 7.1% |
| Layer 2 false blocks | 2.1% | 0.7% |

Limits:
- Families the coordinator never trained against are still mostly missed, so new scam types need new red-team rounds.
- `unknown_seller` scams under $100 pass by design. Only Layer 1's cap bounds what they can take, so they are
  reported apart from recall.

## Data

Everything is read from MongoDB through `calhacks_contracts.db.Repo` (`MONGODB_URI` from `.env.local`, database
`MONGODB_DB_REDTEAM`, default `redteam`): `listings`, `cases` (mandates) and the reference collections. Answer keys are
read only to label and score; they never reach a feature. Holdout families in the database are refused. The Gate
never writes to MongoDB.

## Layer 2 features (`features/`, the coordinator may edit these and `train_config.yaml`)

| Module | Features |
|---|---|
| `price.py` | `price_ratio` (price / median, neutral 1.0 without a median), `price_too_low`, `has_median` |
| `trust.py` | `known_wallet`, `payto_age_days` |
| `domain.py` | `domain_known`, `domain_similarity_to_known` (exact match excluded) |
| `payment.py` | `payto_lookalike` (same first/last 4 hex as a known wallet), `payto_affix_match` |
| `injection.py` | `injection_hits_text`, `injection_hits_reviews`, `imperative_to_agent` (after removing invisible characters and NFKC folding) |
| `hidden.py` | `hidden_chars` (zero-width/format characters), `mixed_script_words` (homoglyphs) |
| `reviews.py` | `review_count`, `review_similarity_max` (cached embeddings via `features/_text.EMBEDDINGS` when present, else word overlap), `review_len_mean` |

Each is `@feature(name, monotone=-1|0|1)` on a pure `GateInput -> float`. `gate-train` self-tests every feature on
`contracts/tests/fixtures` plus a sample of training rows and exits 2 on failure. Ages are measured against
`GATE_AS_OF` (default: the process start date), recorded in each model file.

Before any feature module is imported, `gatepy.sandbox` checks every file in `features/` statically: imports only from
an allowlist (math, re, unicodedata, itertools, the contract models, `gatepy.registry`/`gatepy.clock`, `features._text`),
no `open`/`exec`/`eval`/`getattr`/`__import__`, no private or dunder attributes, no frame walking, no `'__'` strings. A
violation raises `FeaturePolicyError` (the CLIs exit 2) and nothing in `features/` runs. This matters because the
coordinator writes these files and the red-team MCP server scores the holdout in-process.

## Commands

```sh
# from the repo root; on this machine uv needs UV_SYSTEM_CERTS=1 (TLS interception)
npm test -w @calhacks/gate-layer1                      # Layer 1 tests
node gate/layer1/src/cli.ts < gate_inputs.jsonl         # gate-l1: {"listing_id", "checks"} per line

uv run --project gate gate-train --round 0 --config gate/configs/r0_baseline.yaml
uv run --project gate gate-train --round 1 [--query '{"family": {"$ne": "legit_plain"}}']
uv run --project gate gate-eval --model promoted --split val [--ids ids.txt] [--rows]
cd gate && uv run pytest                                # mongomock, never Atlas
```

## Notes for the red-team loop

- In-process scoring (used for the holdout, which never enters MongoDB):
  `gatepy.evaluate.evaluate(model, [(Listing, Case | None, AnswerKey), ...], refs)` where `refs` is a
  `calhacks_contracts.db.ReferenceSet` (e.g. `repo.reference_snapshot().overlay(wallets=...)`).
- `gatepy.evaluate.evaluate_repo(model_id, repo, split, ids, query, with_rows, models_dir)` is `gate-eval` as a function,
  for callers that already hold a `Repo` (e.g. an in-memory test database).
- `gatepy.model_io.load(model_id)`, `set_promoted(model_id, val=..., holdout=...)`; the promotion rule (C6) belongs to redteam.
- On revert, call `gatepy.model_io.restore_features("promoted")`: features are edited in place, so a rejected
  candidate's code would otherwise stay live. Each model file carries its feature sources.
- Rows are split by base listing (`calhacks_contracts.splits`), so every copy of one listing sits on one side:
  **train** (70%) and **calibrate** (10%) fit Layer 2 on rows that pass Layer 1. The threshold is the lowest risk cut
  whose false blocks on those rows' legit part are at most `threshold.max_fpr`, scored **out of fold** (5 folds grouped
  by base listing, so no row is scored by a model that saw its base listing). That uses every fitted legit row, not
  the few dozen in calibrate, so one borderline listing can't swing the cut. **val** (20%) is reported as
  `val_metrics` and used for promotion. The model file's `threshold_rule` records the rule and row count. `gate-eval --split train|calibrate|val|all`.
- Metrics: policy-bounded scam families (`families.json` `policy_bounded`, today `unknown_seller`) are excluded from
  `recall` / `layer2_recall` and reported as `policy_bounded_recall`; `per_family` still lists them.
- `gatepy.serve.Gate(...).score(GateRequest)` / `make_router()` (`POST /gate/risk`) are for the wallet. The Gate fetches
  the listing by `proposal.listing_id` and looks up references itself; any error is a 503 "skip".
- `gatepy.app` is the deployable service (`gate/Dockerfile`, built from the repo root): `POST /decide`, `GET /health`,
  `GET /version`, with Layer 1 kept in one long-lived Node process (`layer1_bridge.Layer1Process`). With
  `GATE_STORES` set there are two passes. `POST /screen` (every listing a search finds) takes the page the store
  crawler read and adds the Gate's own cached catalog and `store.json` (refreshed in the background), so it fetches
  nothing per listing. `POST /decide` (once, before paying) has `gatepy.live` read the listing from the live store
  itself: `proposal.listing_id` is the item page URL; the catalog gives title, price and seller, `store.json` the wallet, the page its text plus hidden text
  (`gatepy.page`, a copy of the store crawler's extractor), and an unpaid checkout POST the real 402. References are
  the `GATE_KNOWN_STORES` wallets and domains and the median price of their closest title matches. Stores under
  `GATE_HOSTED_SUFFIX` are named `<label>.com`, the way training names marketplace sites. It loads
  `GATE_MODEL_ID` (default `../gates/CURRENT`) and refuses to start if `gate/features` doesn't match the model's
  feature-code hash. `uv run --project gate --extra serve uvicorn --factory gatepy.app:create_app --port 8080`.
- `gate-release export <id> --models DIR` writes a model and its exact feature code to `../gates/<id>/`;
  `gate-release install [id]` puts them into `gate/models` and `gate/features` (the Docker build does this);
  `gate-release verify [id]` checks the hash. See `../gates/README.md`.
