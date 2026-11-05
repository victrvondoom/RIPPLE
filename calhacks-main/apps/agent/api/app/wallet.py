"""The wallet Hunter pays from, read live from Base Sepolia: its USDC balance (from the chain itself), every USDC
transfer in or out (from the Blockscout explorer API) and test USDC from the CDP faucet.

The faucet needs CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET. The CDP faucet rate-limits each address,
so a refused request is reported back as is.

Self-check: python -m app.wallet (from apps/agent/api)
"""

import re

import httpx

from app.pay import EXPLORER, UNIT, USDC

RPC = "https://sepolia.base.org"
BLOCKSCOUT = "https://base-sepolia.blockscout.com/api/v2"
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
BALANCE_OF = "0x70a08231"  # balanceOf(address).
MAX_PAGES = 5  # 50 transfers a page.


async def balance(client: httpx.AsyncClient, address: str) -> float:
    """USDC held right now, read with eth_call so it is never behind the explorer."""
    call = {"to": USDC, "data": BALANCE_OF + address[2:].lower().rjust(64, "0")}
    res = await client.post(RPC, json={"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [call, "latest"]})
    res.raise_for_status()
    return int(res.json()["result"], 16) / UNIT


def transfer(item: dict, address: str) -> dict:
    """One Blockscout token transfer, seen from `address`: sent or received, and with whom."""
    sent = item["from"]["hash"].lower() == address.lower()
    other = item["to" if sent else "from"]["hash"]
    return {"hash": item["transaction_hash"], "at": item["timestamp"], "direction": "sent" if sent else "received",
            "amount": int(item["total"]["value"]) / UNIT, "counterparty": other,
            "explorer": f"{EXPLORER}/tx/{item['transaction_hash']}"}


async def transfers(client: httpx.AsyncClient, address: str) -> list[dict]:
    """Every USDC transfer in or out of `address`, newest first."""
    url, params, out = f"{BLOCKSCOUT}/addresses/{address}/token-transfers", {"type": "ERC-20", "token": USDC}, []
    for _ in range(MAX_PAGES):
        res = await client.get(url, params=params)
        res.raise_for_status()
        page = res.json()
        out += [transfer(item, address) for item in page.get("items") or []]
        if not (more := page.get("next_page_params")):
            break
        params = {"type": "ERC-20", "token": USDC, **more}
    return out


async def fund(address: str) -> dict:
    """Asks the CDP faucet for test USDC to `address`. Returns the faucet's transaction."""
    from cdp import CdpClient  # Imported here so the rest of the API runs without CDP credentials.

    async with CdpClient() as cdp:
        tx = await cdp.evm.request_faucet(address=address, network="base-sepolia", token="usdc")
    tx = tx if tx.startswith("0x") else "0x" + tx
    return {"txHash": tx, "explorer": f"{EXPLORER}/tx/{tx}"}


if __name__ == "__main__":
    me, store = "0x" + "aa" * 20, "0x" + "bb" * 20
    item = {"transaction_hash": "0x01", "timestamp": "2026-10-24T05:08:03.000000Z", "total": {"value": "290000"},
            "from": {"hash": "0x" + "AA" * 20}, "to": {"hash": store}}
    assert transfer(item, me) == {"hash": "0x01", "at": "2026-10-24T05:08:03.000000Z", "direction": "sent",
                                  "amount": 0.29, "counterparty": store, "explorer": f"{EXPLORER}/tx/0x01"}
    assert transfer({**item, "from": {"hash": store}, "to": {"hash": me}}, me)["direction"] == "received"
    assert ADDRESS.match(me) and not ADDRESS.match("0x123")
    print("ok")
