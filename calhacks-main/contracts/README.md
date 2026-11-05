# Shared contracts (red team + Gate)

[← Back to the README](../README.md)

`contracts/` holds the schemas from issue #1 as the `calhacks-contracts` uv package (pydantic models, a TypeScript mirror in
`contracts/ts/`, generated JSON Schemas in `contracts/schemas/`) plus the MongoDB access layer. Details:
[`interfaces.md`](interfaces.md); plan: [`docs/plans/redteam-gate.md`](../docs/plans/redteam-gate.md).

- **One `Listing` shape** for real listings, synthetic listings and the Gate's input. A synthetic listing's answer key
  (label, family, attack diff) and generator info are stored in separate collections the Gate never reads.
- **All data lives in MongoDB** (`redteam` database): listings, cases (mandates), answer keys, and the references the Gate
  looks up itself: known sellers, market medians, wallet first-seen dates.
- **Getting real data in:**

  ```sh
  cd contracts
  uv run contracts-ingest listings FILE.jsonl --source apify:ebay   # Listing per line
  uv run contracts-ingest known-sellers FILE.json
  uv run contracts-ingest medians FILE.json --source apify:ebay-sold
  uv run contracts-ingest stats
  uv run pytest                                                     # tests use mongomock, not Atlas
  ```

- **Attack families** (`contracts/families.json`): Layer 1 catches payment mismatch, bait-and-switch and product
  switch by rule. Layer 2 handles lookalike wallets and unknown sellers within the cap, too-cheap, prompt injection, hidden
  text, fake reviews and store clones (`store_clone`, modelled on the mzn Official Outlet: a lookalike of a known
  store's domain paid to that store's own wallet, 2-12% of the median price, and an LLM-written note telling AI
  shopping assistants to skip checks).
  `urgency_pressure` and `lookalike_domain` are held out of training entirely, for the final exam. `store_clone`
  overlaps `lookalike_domain` (both imitate a known domain), so held-out recall on `lookalike_domain` is no longer a
  clean measure from the round that adds it.
- **Seller trust:** a **known wallet** (on the known-seller list) is trusted. An **unknown wallet** is paid only up to `unknown_seller_cap_usd` ($100, `contracts/allowlist.json`), and Layer 2 then decides; $100 covers about 92% of the scraped listings. CRS is not used.

On this network uv may need `UV_SYSTEM_CERTS=1` (TLS interception).
