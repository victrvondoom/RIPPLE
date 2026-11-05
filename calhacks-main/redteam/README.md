# redteam

The red-team loop from `docs/plans/redteam-gate.md` (Part 4 and Revision 2): Bitdeer attack generation from real
MongoDB listings, the sealed holdout, the MCP tools the Factory coordinator uses, the guard hook, and the coordinator.
Schemas come from `contracts/` (issue #1); data lives in MongoDB (`calhacks_contracts.db`).

Env (repo-root `.env.local` / `.env`, gitignored): `MONGODB_URI`, optional `MONGODB_DB_REDTEAM` (default `redteam`),
`BITDEER_API_KEY`, `BITDEER_KEY_GLM` (may be the same key). On this network uv may need `UV_SYSTEM_CERTS=1`.

## Commands

All commands run from the repo root. Real listings must be in MongoDB first (`contracts-ingest listings ...`).

| What | Command | Needs |
|---|---|---|
| Tests | `uv run --project redteam pytest -q redteam/tests` | nothing (mongomock, fake Bitdeer) |
| One attack spec | `uv run --project redteam python -m redteam.generate --round 1 --family too_cheap --n 40` | MongoDB; Bitdeer for LLM families |
| Spec from a file | `uv run --project redteam python -m redteam.generate --round 1 --spec spec.json` | same |
| Build the holdout (once) | `uv run --project redteam python -m redteam.holdout build [--per-family 60] [--slice 20]` | MongoDB, Bitdeer |
| Holdout totals | `uv run --project redteam python -m redteam.holdout totals --model promoted` | MongoDB |
| MCP server (droid spawns it) | `uv run --project redteam python -m redteam.mcp_server` | — |
| One coordinator round | `uv run --project redteam python -m redteam.coordinator --round 1 [--max-listings 60]` | MongoDB, Bitdeer |
| Resume a round | `... redteam.coordinator --round 1 --resume <session_id>` | same |
| Canary isolation test | `REDTEAM_LIVE=1 uv run --project redteam pytest -s redteam/tests/test_isolation.py` | Bitdeer |
| Rounds table | `uv run --project redteam python -m redteam.report` | MongoDB |
| Plant scams in the live stores (5% of `calhacks.listings`, in place, marked) | `uv run --project redteam python -m redteam.plant [--dry-run\|--key\|--undo]` | MongoDB |

## Where things go

- **MongoDB** (`redteam` database): synthetic `listings` + `answer_keys` + `gen` + `cases` (via `Repo.put_synthetic`),
  simulated `wallets` (first-seen dates) for generated sellers, `specs` (each AttackSpec, its
  round and summary) and `rounds` (generation spend, `start_model`, `attack` (attack success with its interval),
  `audit` (failing families), promotions, the RoundReport, coordinator usage).
- **`gate/models/`**: model files and `promoted.json` (history includes the holdout totals recorded on promotion).
- **`data/rounds/R{n}/`**: local logs only: `calls.jsonl` (every MCP call), `usage.json`, `events.jsonl`, `report.json`.
- **`$CALHACKS_HOLDOUT`** (default `../calhacks-holdout/`): `holdout.v3.enc` (listings, answer keys, cases and their
  simulated references, encrypted), `holdout.key`, `holdout.v3.meta.json` (counts, bases used, copies per base,
  shortfall), `holdout.v3.history.jsonl` (operator-only report per scored model: totals, seen vs held-out recall,
  clustered intervals). Never in MongoDB, never readable by the coordinator.

## How a round works

1. `coordinator.py` builds the round's `RoundInput` in code (current model, last report, coverage, validation misses,
   holdout totals for the current model, feature list) and puts it in the prompt. It notes the promoted model as the
   round's start model. Held-out family names appear nowhere the coordinator can read (`tests/test_hidden_families.py`).
2. The coordinator orders `AttackSpec`s through `generate_attacks`. The main mode, `mutate_real`, copies real listings and
   changes one thing in code; LLM families get their text rewritten by Bitdeer.
3. `score_round` scores fresh attacks against the promoted model (a working view). `inspect_failures` shows the misses.
4. It edits `gate/features/<name>.py` (real Gate only; files must pass `gatepy.sandbox`), runs `train_gate`, then `promote_model`. Code applies C6 and, on
   refusal, restores the promoted model's feature code.
5. It returns a `CoordinatorOutput`. Code then records attack success (this round's scams vs the start model, scored
   with that model's own feature code, policy-bounded families left out), audits this round's listings against real
   ones (`redteam.audit`), assembles the `RoundReport` (metrics, decision, cost) and saves it all to MongoDB.

Splits are by base listing (`calhacks_contracts.splits.split_of(id, base_listing_id)`): train 70%, calibrate 10%
(threshold only), validation 20%. Recall excludes policy-bounded families (`unknown_seller`), which are reported as
`policy_bounded_recall`; promotion compares recall without them.

## Gate backend

`redteam/src/redteam/gate_client.py` runs the real Gate in `gate/` by default (`redteam` depends on `gate` by path).
It calls the `gate-train` / `gate-eval` CLIs in a subprocess for MongoDB, with `HOLDOUT_KEY` and `CALHACKS_HOLDOUT`
removed from the environment, and calls `gatepy` in-process for an in-memory (mongomock) database and for the holdout.
Models live in `gate/models/` (`CALHACKS_MODELS`, passed on as `GATE_MODELS`); promotion goes through
`gatepy.model_io.set_promoted`, and a refused candidate's feature code is put back with `restore_features`.

- `REDTEAM_GATE=stub` selects `gate_stub.py`, a fast stand-in with the same JSON. Unit tests use it; it ignores
  `gate/features/`, so feature editing is off in stub runs.
- The real Gate refuses a leftover stub `promoted.json` (`r*-stub-*`); delete it and the stub model files first.
- The MCP server imports the Gate on its main thread at startup (`gate_client.preload`): on Windows, a first numpy or
  LightGBM import from FastMCP's worker thread deadlocks.
