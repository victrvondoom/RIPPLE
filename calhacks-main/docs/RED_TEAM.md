# Red-team loop

[← Back to the README](../README.md)

`redteam/` (uv project) makes attack listings, keeps the sealed holdout, and runs the Factory coordinator. All
listings live in MongoDB through `calhacks-contracts`; nothing is read from local data files. Full command list:
[`redteam/README.md`](../redteam/README.md).

- **Scraped-listing snapshot** (`redteam.scrape_map`): reads `calhacks.listings` (read-only) and writes a frozen local
  issue #1 snapshot (e.g. `scrape-v1`). It holds:
  - placeholder wallets per seller
  - brand + type product keys
  - the top 10 reputable sellers as known wallets
  - no wallet first-seen dates by default (no real history yet; `--wallet-history` restores the old heuristic for comparisons)
  - medians from the training side (with a type-level fallback)
  - a $500 budget per case
  - a seller-level split: ~80% training bases, ~20% locked-test bases reserved for the holdout
  `uv run --project redteam python -m redteam.scrape_map --out <dir> --as-of YYYY-MM-DD`
- **Benchmark** (`redteam.bench`): a fixed clean test set built from the snapshot's locked-test listings
  (`bench build-test`), and `bench run` to score a Gate on it: accuracy, recall, false blocks split into model and
  policy blocks, real-listing false blocks, risk AUC, held-out and policy-bounded recall reported apart, each with a
  95% cluster-bootstrap interval over base listings.
- **Artifact audit** (`redteam.audit`): checks whether generated listings can be told apart from real ones by
  anything other than the attack. Per family, a classifier on untouched traits (seller-name shape, wallet age,
  review count and length, text length) reports a grouped-CV AUC and a permutation p-value; a family fails when
  AUC > 0.6 and p < 0.05 (a tell the Gate could learn instead of the scam). Each family is compared with the real
  listings it draws bases from. The coordinator also runs it on each round's listings after the round and records the
  failing families in the round (shown in the dry-run summary).
  `uv run --project redteam python -m redteam.audit --store <local store dir>`
- **Local dry runs** (`redteam.dryrun`): the full loop against a snapshot with no MongoDB. A file-backed store
  (`REDTEAM_LOCAL_STORE`) is shared between the coordinator and the MCP server and saved after every tool call. The
  holdout is built from the snapshot's locked-test listings (including those real listings, unmodified).
  `REDTEAM_ATTACKER_KNOWLEDGE` and `REDTEAM_SEED` fix the attacker type and seed. Run each dry run from its own git
  worktree, so the coordinator's feature edits are saved per round as diffs and never touch committed code.
  `--base-store` seeds round 0 with an evenly mixed generated dataset from the same snapshot side (every seen family)
  and promotes a baseline Gate trained on it, so the coordinator's data is added on top of full coverage and its
  first candidate has an incumbent to beat; promotion then also refuses a candidate whose validation lacks any seen
  family. `--holdout-from` reuses a sealed holdout built earlier for the same snapshot:
  ```sh
  uv run --project redteam python -m redteam.dryrun init    --run DIR --snapshot SNAP [--seed N] [--knowledge white_box] [--all-known] [--base-store STORE] [--holdout-from DIR]
  uv run --project redteam python -m redteam.dryrun holdout --run DIR [--per-family 60 --slice 20]
  uv run --project redteam python -m redteam.dryrun round   --run DIR --round N [--max-listings 300]
  uv run --project redteam python -m redteam.dryrun summary --run DIR   # summary.json + summary.md
  ```
- **Attack factory** (`redteam.generate`): an `AttackSpec` in, `SyntheticListing`s out to MongoDB. The main mode,
  `mutate_real`, copies a real listing and changes one thing in code (wallet, price, checkout id, product, seller,
  domain, hidden text), recorded in the answer key's `attack_diff`. `mutate.ALLOWED_DIFF` lists the only fields each
  family may change and anything else is rejected, so a scam keeps its real seller; only seller-themed families
  (unknown seller, new honest seller, lookalikes) get a new one, named in the style of real sellers on the same
  marketplace (`mutate.styled_name`), never from a fixed pattern. Hidden-text instructions and honest discount reasons are worded by the LLM (code
  still hides the instruction); without a Bitdeer client they come from large combinatorial pools, never a few fixed
  sentences. Every LLM rewrite must keep the base listing's shape (text length within 0.7-1.4x, the same number of
  reviews), and a `legit_rewrite` control family runs honest listings through the same prompt, so LLM-written style
  shows up on both sides. Families that need wording (prompt injection,
  fake reviews, urgency, mixed reviews) get their text or reviews rewritten by Bitdeer (GLM-5.3-Flash and
  DeepSeek-V4.1-Flash in rotation). Bad LLM output is retried once, then dropped, and drops are counted per family.
- **Holdout** (`redteam.holdout`): built once from the real listings, holding the two held-out families plus a slice
  of every other family, with text written by Nemotron. No base listing gets more than 3 copies (spread over as many
  bases as there are); dropped LLM slots are re-requested twice and any shortfall is recorded. Families are
  generated 4 at a time, and each Bitdeer call is cut off after 2 minutes (5 in rounds), so slow calls can't stall it. It's stored
  encrypted outside the repo with its simulated references, never in MongoDB, and scored in memory to totals only. The
  coordinator sees recall and false blocks; the operator also gets Layer 2 false blocks, policy-bounded recall, recall
  on seen vs held-out families and 95% intervals from a bootstrap clustered by base listing
  (`holdout.v3.history.jsonl`, next to the holdout).
- **Honest measurement:** every split is by base listing (`calhacks_contracts.splits`: train 70% and calibrate 10%, both fitted on, with
  the threshold from 5-fold out-of-fold scores grouped by base listing; validation 20%), so copies of one listing never sit on both sides. Recall leaves out policy-bounded
  families (`unknown_seller`, capped by the $100 rule rather than detected) and reports them as policy-bounded recall.
  The coordinator never sees the held-out family names: they are not in its prompt, tools or coverage, asking for one
  gets the same "unknown family" error as a typo, and the guard hook blocks reading tests and whole-workspace searches.
  Attack success is recorded once per round by code: this round's scams scored with the model promoted at the round's
  start (with a 95% interval; a resumed round keeps that model); `score_round` is only a working view.
- **Coordinator** (`redteam.coordinator`): one Factory Droid SDK session per round on Bitdeer DeepSeek-V4.1-Flash, with
  a GLM-5.3 attack-strategist droid. It sees the world only through the stdio MCP tools (`get_round_input`,
  `generate_attacks`, `score_round`, `inspect_failures`, `train_gate`, `eval_gate`, `promote_model`). Droid fails an
  MCP call after 180 s and loses the server for the round, so `generate_attacks` runs one call at a time (a parallel
  call is refused at once) and each call returns within about two minutes, listing slots it had no time for as dropped. A round
  has a 20-minute window: generation and training close near its end, at most 6 `train_gate` calls are allowed, no
  family gets more than 40 new scams per round, and the session is interrupted 6 minutes after the window. The round
  input is built before the session and cached for `get_round_input`. A guard hook
  limits edits to `gate/features/<name>.py` and `gate/train_config.yaml`, and Gate subprocesses never receive the holdout key. Promotion (validation recall up, Layer 2 false blocks ≤ 2% — Layer 1 policy blocks such as unknown wallets over the cap are reported separately, no
  family down more than 5 points) and the `RoundReport` numbers are computed in code.
- **Gate backend:** the real Gate in `gate/` (path dependency). `REDTEAM_GATE=stub` selects a fast stand-in used by unit tests.

  ```sh
  uv run --project redteam python -m redteam.generate --round 1 --family too_cheap --n 40 --legit-ratio 0.4
  uv run --project redteam python -m redteam.coordinator --round 1 --max-listings 60
  uv run --project redteam python -m redteam.report
  uv run --project redteam pytest          # mongomock + fake Bitdeer client, no network
  ```
