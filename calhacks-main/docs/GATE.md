# Gate

[← Back to the README](../README.md)

Two layers decide whether the wallet may pay; both must say yes. Details: [`gate/README.md`](../gate/README.md).

- **Layer 1** (`gate/layer1`, TypeScript, fixed rules that are never learned): checkout wallet matches `store.json`; a known
  wallet, or an unknown wallet priced within `unknown_seller_cap_usd` ($100); 402 amount equals
  the price; price within max price and spend remaining; network and asset allowlisted; checkout item and product match the
  listing and the mandate; 402 timeout at most 120s. `node gate/layer1/src/cli.ts < gate_inputs.jsonl`. It is an npm
  workspace: `npm run test:gate-l1`; root `npm run build` / `npm run lint` typecheck it.
  `L1_SELLER_UNTRUSTED` stays a valid (deprecated) `RuleId` so older verdicts still validate; Layer 1 no longer runs it.
- **Layer 2** (`gate/gatepy` + `gate/features`, Python): a LightGBM risk score that runs only when Layer 1 passes and can
  only turn a buy into a skip. Features from issue #1: price vs median, known wallet and wallet age,
  domain and wallet lookalikes, injection and hidden-text scores, review similarity. Each decision carries its top 3 reasons.
  Feature files are checked statically before import (`gatepy.sandbox`): no file, env, network or object-graph access.
- **Data:** training and evaluation read listings, mandates and references from MongoDB (`MONGODB_DB_REDTEAM`); answer keys
  are used only for scoring. Rows split by base listing into train + calibrate (fit, and the threshold from out-of-fold scores) / val (promotion);
  unknown-seller scams are reported apart as `policy_bounded_recall`. `uv run --project gate gate-train --round N`, `uv run --project gate gate-eval --model promoted`.
- **Purchase time:** `gatepy.serve` scores a `GateRequest` (`POST /gate/risk`), fetching the listing and references itself
  and failing closed.
- **Gate service** (`gatepy.app`, `gate/Dockerfile`): the Gate as its own Railway service, separate from the agent API.
  `POST /decide` (`GateRequest` -> `GateDecision`), `GET /health`, `GET /version`; Layer 1 in one long-lived Node
  process. The image installs the deployed model and its exact feature code from `gates/` and refuses to start if
  they don't match. With `GATE_STORES` set it reads each listing from the live store itself (catalog, item page,
  `store.json`, the unpaid 402) and needs no database. The image pins LightGBM to one OpenMP thread per prediction
  (`OMP_NUM_THREADS=1`). Railway settings and the release procedure: [`gates/README.md`](../gates/README.md).
- **Gate archive** (`gates/`): every kept model with its own feature code, card and benchmark; `gates/CURRENT` is the
  deployed one (`r3-be84bc`: on the live stores it skipped 105/105 mzn Official Outlet listings and 0/304 real ones;
  on the benchmark 90.7% accuracy and 1.8% model false blocks; full figures in `gate/README.md`). `uv run --project gate gate-release export|install|verify`.
