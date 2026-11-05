# Setup

[← Back to the README](../README.md)

## Repository layout

```
apps/
  agent/api/ Python FastAPI shopping agent backend (uv, Python 3.13), port 8000
    actor/   store-crawler Apify Standby Actor (Python), port 4321 locally
  agent/web/ Next.js agent dashboard, port 3000
  store-a/   mzn, a general store (Next.js 16), port 3001
  store-b/   by, an auction marketplace, port 3002
  store-c/   dpp, a resale app, port 3003
  store-d/   mzn Official Outlet, a scam lookalike of mzn, port 3004
packages/
  common/    Shared store code: MongoDB listings, x402 checkout, highlights, page shell
  amazon/    Shared storefront used by mzn and its scam lookalike
contracts/   Shared schemas (issue #1), MongoDB access and ingestion CLI (uv package calhacks-contracts)
gate/        Payment Gate: Layer 1 (TypeScript rules), Layer 2 (LightGBM), service (gate/Dockerfile)
gates/       Released Gate models with their feature code; CURRENT is the deployed one
redteam/     Red-team loop: attack factory, MCP server, coordinator, dry runs, benchmark
docs/plans/  Red-team loop + Gate implementation plan
package.json npm workspaces for the stores + root dev scripts
```

## Running locally

Requires Node.js and [uv](https://docs.astral.sh/uv/).

```sh
npm install
npm run dev            # agent API, agent dashboard, and all four stores via concurrently
npm run dev:agent-api  # agent API only (http://localhost:8000, GET /health)
npm run dev:store-a    # one store

# store-crawler Actor locally (from apps/agent/api/actor), then set APIFY_ACTOR_URL=http://localhost:4321
uv run --no-project --python 3.13 --with-requirements requirements.txt python -m src
uv run --no-project --python 3.13 --with-requirements requirements.txt python -m src.test_extract  # self-check
npm run build          # build every workspace
npm run lint           # lint every workspace
```
