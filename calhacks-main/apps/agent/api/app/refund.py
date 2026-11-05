"""Demo refunds: after each purchase, the store wallet sends the same USDC back to Hunter, so testnet funds never run
out. The store wallet signs a transfer to Hunter and the x402.org facilitator settles it, just as it settles a
purchase, so the store wallet needs no ETH for gas.

Needs STORE_WALLET_PRIVATE_KEY, the key behind STORE_PAY_TO. Without it, purchases are not refunded.

Self-check: python -m app.refund (from apps/agent/api)
Send the store wallet's whole balance back once: python -m app.refund --all 0xHunterAddress
"""

import asyncio
import logging
import os

import httpx
from eth_account import Account

from app.pay import EXPLORER, NETWORK, POLICY, UNIT, USDC, sign_payment

FACILITATOR = os.environ.get("X402_FACILITATOR_URL", "https://x402.org/facilitator")
RESOURCE = {"url": "https://hntr.store/refund", "description": "Demo refund", "mimeType": "application/json"}
RETRIES, RETRY_S = 4, 5
PENDING: set[asyncio.Task] = set()  # Refunds still running. Holding them keeps them from being garbage collected.
log = logging.getLogger("uvicorn.error")  # Shows up in the API's own log.


def store_key() -> str | None:
    return os.environ.get("STORE_WALLET_PRIVATE_KEY", "").strip() or None


def requirement(to: str, amount: float) -> dict:
    """What a store's 402 would ask for: exactly `amount` USDC on Base Sepolia, paid to `to`."""
    return {"scheme": "exact", "network": NETWORK, "amount": str(round(amount * UNIT)), "asset": USDC, "payTo": to,
            "maxTimeoutSeconds": POLICY["max_timeout_s"], "extra": {"name": "USDC", "version": "2"}}


async def refund(client: httpx.AsyncClient, to: str, amount: float) -> dict:
    """Sends `amount` USDC from the store wallet to `to` and returns its transaction. Raises with the reason."""
    key = store_key()
    if not key:
        raise RuntimeError("STORE_WALLET_PRIVATE_KEY is not set")
    req = requirement(to, amount)
    payload = sign_payment(key, {"x402Version": 2, "accepts": [req], "resource": RESOURCE})
    res = await client.post(f"{FACILITATOR}/settle",
                            json={"x402Version": 2, "paymentPayload": payload, "paymentRequirements": req})
    settled = res.json() if res.is_success else {}
    if not settled.get("success"):
        raise RuntimeError(settled.get("errorReason") or f"the facilitator answered {res.status_code}")
    tx = settled["transaction"]
    return {"txHash": tx, "explorer": f"{EXPLORER}/tx/{tx}"}


def schedule(client: httpx.AsyncClient, to: str, amount: float) -> None:
    """Refunds in the background, so it finishes even when the chat closes its stream right after the receipt."""
    task = asyncio.create_task(refund_soon(client, to, amount))
    PENDING.add(task)
    task.add_done_callback(PENDING.discard)


async def refund_soon(client: httpx.AsyncClient, to: str, amount: float) -> None:
    """refund(), tried RETRIES times RETRY_S apart, since the purchase may not have reached the store wallet yet.
    A refund that never goes through is logged. The purchase itself still stands."""
    for attempt in range(1, RETRIES + 1):
        try:
            done = await refund(client, to, amount)
            log.info("Refunded %.2f USDC to %s: %s", amount, to, done["explorer"])
            return
        except (RuntimeError, httpx.HTTPError) as e:
            if attempt == RETRIES:
                log.warning("Refund of %.2f USDC to %s failed: %s", amount, to, e)
                return
            await asyncio.sleep(RETRY_S)


if __name__ == "__main__":
    import sys
    from pathlib import Path

    from dotenv import load_dotenv

    if sys.argv[1:2] == ["--all"]:
        from app.wallet import balance

        load_dotenv(Path(__file__).resolve().parents[1] / ".env")

        async def send_all(to: str) -> None:
            async with httpx.AsyncClient(timeout=60) as client:
                amount = await balance(client, Account.from_key(store_key()).address)
                print(f"Sending {amount:.2f} USDC to {to}.")
                print(await refund(client, to, amount))

        asyncio.run(send_all(sys.argv[2]))
    else:
        r = requirement("0x" + "ab" * 20, 2.5)
        assert (r["amount"], r["payTo"], r["asset"]) == ("2500000", "0x" + "ab" * 20, USDC)
        print("ok")
