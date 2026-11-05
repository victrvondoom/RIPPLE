// This script buys one item from a running store with x402, the same way our agent will.
// Pass the store's base URL, and an item key if you want a specific one. Otherwise it buys the cheapest item in stock.
// Run it with BUYER_PRIVATE_KEY set to a funded testnet wallet. Without it, a new empty wallet signs the payment and the facilitator rejects it.
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const baseUrl = process.argv[2] ?? "http://localhost:3001";
const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY ?? generatePrivateKey());
console.log(`buyer ${account.address}${process.env.BUYER_PRIVATE_KEY ? "" : " (fresh, unfunded)"}`);

const catalog = await (await fetch(`${baseUrl}/api/catalog`)).json();
const item = process.argv[3]
  ? catalog.items.find((listing) => listing.key === process.argv[3])
  : catalog.items.filter((listing) => listing.inStock).sort((a, b) => a.price - b.price)[0];
if (!item) throw new Error(`No item to buy at ${baseUrl}`);
console.log(`buying ${item.title} for $${item.price} from ${catalog.store}`);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
  spendControls: { maxAmountPerPayment: "$10" }, // The client refuses payments over $1 by default, so we raise the limit.
});

const res = await fetchWithPayment(`${baseUrl}${item.checkoutUrl}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ shipTo: { name: "Test Buyer", address: "1 Market St, San Francisco, CA" } }),
});

console.log("status", res.status);
console.log("body", await res.text());
const settlement = res.headers.get("payment-response");
if (settlement) console.log("settlement", decodePaymentResponseHeader(settlement));
const required = res.headers.get("payment-required");
if (required) console.log("payment-required", JSON.parse(Buffer.from(required, "base64").toString()));
