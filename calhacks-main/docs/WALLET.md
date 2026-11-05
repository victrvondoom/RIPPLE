# Wallet (Settings and Transactions)

[← Back to the README](../README.md)

The agent web app reads Hunter's wallet (`AGENT_WALLET` in `apps/agent/web/lib/wallet.ts`) live from Base Sepolia
through the agent API (`app/wallet.py`):

- `GET /wallet/{address}`: the USDC balance, read on chain with `eth_call` on `https://sepolia.base.org`, and every
  USDC transfer in or out (`hash`, `at`, `direction` sent|received, `amount`, `counterparty`, `explorer`), newest
  first, from the Blockscout API (`https://base-sepolia.blockscout.com`, no key needed, up to 250 transfers).
- `POST /wallet/{address}/fund`: test USDC from the CDP faucet (`request_faucet`, Base Sepolia). Measured: 1 USDC a
  request, landing within a few seconds. The faucet rate-limits each address; its refusal comes back as the `detail`.
- **Settings** shows the balance and an Add Funds button, then reads the balance again until the funds land.
- **Transactions** lists the real payments (item photo and name, counterparty, time, amount, Basescan link), with
  totals spent and left. Only payments since `SINCE` (`components/Transactions.tsx`, 2026-10-24 22:30 UTC) are
  listed: earlier test payments are cleared from the page and stay on chain. A payment's photo and name come from the
  saved chat whose receipt has the same transaction hash; payments without one show "Sent" and a no-image icon.
- Self-check: `uv run python -m app.wallet` (from `apps/agent/api`).
