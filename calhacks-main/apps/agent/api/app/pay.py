"""Checkout: buys the picked listing over x402 (v2, `exact` scheme, USDC on Base Sepolia), the same flow as
scripts/test-checkout.mjs and @x402/fetch, in the six steps the UI shows.

1. Start checkout: POST the listing's checkout URL with a shipTo and no payment. The store answers 402.
2. Get the price and payment address from the PAYMENT-REQUIRED header.
3. Double-check before paying, in code: network and asset allowlisted (contracts/allowlist.json), amount equals the
   listed price, payTo equals the store.json wallet, and the price is within the user's limit.
4. Approve the exact amount: sign an EIP-3009 TransferWithAuthorization for exactly that amount to that wallet.
   Signing moves no funds; the key never leaves this process. Needs BUYER_PRIVATE_KEY, else the run stops here.
5. Send the payment: POST again with the PAYMENT-SIGNATURE header. The store has the x402.org facilitator verify
   and settle it (the facilitator pays gas, so the buyer needs USDC but no ETH).
6. Order confirmed: the 200 body is the order; the PAYMENT-RESPONSE header carries the transaction hash.

Self-check: python -m app.pay (from apps/agent/api)
"""

import base64
import json
import os
import secrets
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import httpx
from calhacks_contracts.families import allowlist
from eth_account import Account

POLICY = allowlist()
NETWORK = POLICY["networks"][0]  # Base Sepolia.
CHAIN_ID = int(NETWORK.split(":")[1])
USDC = POLICY["assets"][NETWORK]  # Circle's USDC on Base Sepolia.
UNIT = 10 ** POLICY["usdc_decimals"]
EXPLORER = "https://sepolia.basescan.org"
# ponytail: one fixed ship-to until users enter their own; nothing ships on testnet.
SHIP_TO = {"name": os.environ.get("SHIP_TO_NAME", "Hunter Demo"),
           "address": os.environ.get("SHIP_TO_ADDRESS", "1 Market St, San Francisco, CA")}

TRANSFER_WITH_AUTHORIZATION = [
    {"name": "from", "type": "address"}, {"name": "to", "type": "address"}, {"name": "value", "type": "uint256"},
    {"name": "validAfter", "type": "uint256"}, {"name": "validBefore", "type": "uint256"},
    {"name": "nonce", "type": "bytes32"},
]


def buyer_address() -> str | None:
    key = os.environ.get("BUYER_PRIVATE_KEY", "").strip()
    try:
        return Account.from_key(key).address if key else None
    except ValueError:
        return "invalid key"


def b64json(value: str) -> dict:
    return json.loads(base64.b64decode(value))


def sign_payment(key: str, required: dict, now: int | None = None) -> dict:
    """The x402 v2 PaymentPayload for the first accepted requirement, signed with `key`."""
    req = required["accepts"][0]
    account = Account.from_key(key)
    now = int(time.time()) if now is None else now
    authorization = {"from": account.address, "to": req["payTo"], "value": req["amount"], "validAfter": "0",
                     "validBefore": str(now + req["maxTimeoutSeconds"]), "nonce": "0x" + secrets.token_hex(32)}
    signed = Account.sign_typed_data(
        key,
        domain_data={"name": req["extra"]["name"], "version": req["extra"]["version"], "chainId": CHAIN_ID,
                     "verifyingContract": req["asset"]},
        message_types={"TransferWithAuthorization": TRANSFER_WITH_AUTHORIZATION},
        message_data={**authorization, "value": int(authorization["value"]),
                      "validAfter": int(authorization["validAfter"]), "validBefore": int(authorization["validBefore"]),
                      "nonce": bytes.fromhex(authorization["nonce"][2:])},
    )
    signature = signed.signature.hex()
    return {"x402Version": required["x402Version"], "payload": {"authorization": authorization,
            "signature": signature if signature.startswith("0x") else "0x" + signature},
            "resource": required.get("resource"), "accepted": req, "extensions": required.get("extensions")}


def double_check(req: dict, price: float, store_pay_to: str | None, max_price: float | None) -> str | None:
    """Why this 402 must not be paid, or None when it matches the listing, the store and the limit."""
    if req.get("scheme") != "exact" or req.get("network") != NETWORK:
        return f"the store asked for {req.get('scheme')} on {req.get('network')}, not USDC on Base Sepolia"
    if (req.get("asset") or "").lower() != USDC.lower():
        return "the store asked to be paid in a token that isn't USDC"
    if req.get("amount") != str(round(price * UNIT)):
        return f"the store asked for {int(req.get('amount') or 0) / UNIT:.2f} USDC but listed {price:.2f}"
    if not store_pay_to or (req.get("payTo") or "").lower() != store_pay_to.lower():
        return "the payment address doesn't match the wallet the store publishes"
    if max_price is not None and price > max_price:
        return f"{price:.2f} USDC is over your ${max_price:.2f} limit"
    return None


def step(index: int, state: str, detail: str) -> dict:
    return {"type": "checkout", "step": index, "state": state, "detail": detail}


async def checkout(client: httpx.AsyncClient, listing: dict, store: dict | None,
                   max_price: float | None) -> AsyncIterator[dict]:
    """Yields `checkout` step events (state done|failed|blocked), then `receipt` once paid. Stops at the first
    step that can't complete, so a failure never leads to a signature."""
    name, price, url = listing.get("storeName") or "the store", listing["price"], listing["checkoutUrl"]
    body = {"shipTo": SHIP_TO}
    res = await client.post(url, json=body)
    if res.status_code != 402 or not res.headers.get("payment-required"):
        yield step(0, "failed", f"{name} answered {res.status_code} instead of asking for payment.")
        return
    yield step(0, "done", f"Asked {name} for this listing.")

    required = b64json(res.headers["payment-required"])
    req = required["accepts"][0]
    amount = int(req["amount"]) / UNIT
    yield step(1, "done", f"{name} asked for {amount:.2f} USDC.")

    if problem := double_check(req, price, (store or {}).get("payTo"), max_price):
        yield step(2, "failed", f"Hunter stopped: {problem}.")
        return
    yield step(2, "done", "Store, price, wallet and limit all match." if max_price is not None
               else "Store, price and wallet all match.")

    key = os.environ.get("BUYER_PRIVATE_KEY")
    if not key:
        yield step(3, "blocked", "No wallet key is set, so nothing was paid.")
        return
    payload = sign_payment(key, required)
    yield step(3, "done", f"{amount:.2f} USDC from your Hunter wallet.")

    header = base64.b64encode(json.dumps(payload).encode()).decode()
    res = await client.post(url, json=body, headers={"PAYMENT-SIGNATURE": header})
    if res.status_code != 200:
        reason = ""
        if res.headers.get("payment-required"):
            reason = b64json(res.headers["payment-required"]).get("error") or ""
        yield step(4, "failed", f"The payment didn't go through ({res.status_code}{': ' + reason if reason else ''}).")
        return
    settlement = b64json(res.headers["payment-response"]) if res.headers.get("payment-response") else {}
    tx = settlement.get("transaction")
    yield step(4, "done", "Confirmed on Base Sepolia.")

    order = res.json()
    yield step(5, "done", f"{name} confirmed the order.")
    yield {"type": "receipt", "item": listing.get("title"), "store": name, "amount": amount, "network": "Base Sepolia",
           "from": settlement.get("payer") or payload["payload"]["authorization"]["from"], "to": req["payTo"],
           "order": order.get("orderId"), "paidAt": datetime.now(UTC).isoformat(), "txHash": tx,
           "explorer": f"{EXPLORER}/tx/{tx}" if tx else None}


if __name__ == "__main__":
    from eth_account.messages import encode_typed_data

    key = "0x" + "11" * 32  # Fixed test key, never funded.
    required = {"x402Version": 2, "resource": {"url": "https://x/api/checkout/a"}, "accepts": [{
        "scheme": "exact", "network": NETWORK, "amount": "5000000", "asset": USDC,
        "payTo": "0x45fE928DaA6A16362cd51DD25660Bf540c16c862", "maxTimeoutSeconds": POLICY["max_timeout_s"],
        "extra": {"name": "USDC", "version": "2"}}]}
    p = sign_payment(key, required, now=1_000)
    auth = p["payload"]["authorization"]
    assert (auth["value"], auth["validAfter"], auth["validBefore"], auth["to"]) == ("5000000", "0", "1120", required["accepts"][0]["payTo"])
    assert p["accepted"] == required["accepts"][0] and p["x402Version"] == 2 and len(auth["nonce"]) == 66
    message = encode_typed_data(
        domain_data={"name": "USDC", "version": "2", "chainId": CHAIN_ID, "verifyingContract": USDC},
        message_types={"TransferWithAuthorization": TRANSFER_WITH_AUTHORIZATION},
        message_data={**auth, "value": 5000000, "validAfter": 0, "validBefore": 1120, "nonce": bytes.fromhex(auth["nonce"][2:])})
    assert Account.recover_message(message, signature=p["payload"]["signature"]) == Account.from_key(key).address

    req, wallet = required["accepts"][0], required["accepts"][0]["payTo"]
    assert double_check(req, 5.0, wallet, 10) is None
    assert "limit" in double_check(req, 5.0, wallet, 4)
    assert "listed" in double_check(req, 4.99, wallet, None)
    assert "address" in double_check(req, 5.0, "0x" + "22" * 20, None)
    assert "USDC" in double_check({**req, "asset": "0x" + "33" * 20}, 5.0, wallet, None)
    print("ok")
