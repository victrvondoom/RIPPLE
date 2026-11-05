import "server-only";
import { NextResponse, connection, type NextRequest } from "next/server";
import { withX402, x402ResourceServer } from "@x402/next";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import allowlist from "../../../contracts/allowlist.json";
import { formatUsd } from "./format";
import { marketListings, searchItems, type Marketplace } from "./market";

// Every store takes USDC on the Base Sepolia testnet, and the x402.org facilitator checks and settles each payment.
// The network and the payment timeout come from contracts/allowlist.json, the same policy the Gate and the agent check.
export const PAYMENT = {
  network: allowlist.networks[0] as `${string}:${string}`,
  currency: "USDC",
  maxTimeoutSeconds: allowlist.max_timeout_s,
} as const;

// A listing is a store item reduced to what checkout needs. The key is the ID the store already puts in its item URLs.
export type Listing = {
  key: string;
  title: string;
  price: number;
  inStock: boolean;
  seller: string;
  path: string;
};

// Each store describes itself once, and the same checkout runs on top of it. The listings load from the scraped catalog.
export type Merchant = {
  name: string;
  // The marketplace the listings were scraped from. A catalog search ranks that marketplace's listings by the query.
  marketplace: Marketplace;
  listings: () => Promise<Listing[]>;
};

type ShipTo = { name: string; address: string };

const facilitator = new HTTPFacilitatorClient({
  url: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
});

const paymentServer = new x402ResourceServer(facilitator).register(PAYMENT.network, new ExactEvmScheme());

export function payTo(): string {
  const address = process.env.STORE_PAY_TO;
  if (!address) throw new Error("STORE_PAY_TO is not set");
  return address;
}

function checkoutUrl(listing: Listing): string {
  return `/api/checkout/${encodeURIComponent(listing.key)}`;
}

async function listingAt(merchant: Merchant, path: string): Promise<Listing | undefined> {
  const key = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
  return (await merchant.listings()).find((listing) => listing.key === key);
}

// A listing planted as a payment_mismatch scam (redteam.plant) charges more at checkout than its page shows.
// Every store keys its items by the marketplace ID, the same ID the scraped listing carries.
async function chargedPrice(merchant: Merchant, listing: Listing): Promise<number> {
  const market = (await marketListings(merchant.marketplace)).find((entry) => entry.source.externalId === listing.key);
  return market?.item.checkoutPrice ?? listing.price;
}

function isShipTo(value: unknown): value is ShipTo {
  const v = value as ShipTo;
  return typeof v?.name === "string" && v.name.trim() !== "" && typeof v?.address === "string" && v.address.trim() !== "";
}

// This is the lowest and highest price among the listings in stock.
function priceRange(listings: Listing[]) {
  const prices = listings.filter((listing) => listing.inStock).map((listing) => listing.price);
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

// POST /api/checkout/{key} answers 402 with the price and wallet, then 200 with the order once paid.
export function checkoutRoute(merchant: Merchant) {
  // This runs only after the payment is verified. The payment settles only if this returns a status below 400.
  async function placeOrder(req: NextRequest): Promise<NextResponse<unknown>> {
    const listing = (await listingAt(merchant, req.nextUrl.pathname))!;
    const body = await req.json().catch(() => null);
    if (!isShipTo(body?.shipTo)) {
      return NextResponse.json({ error: "A shipTo name and address are required." }, { status: 400 });
    }

    return NextResponse.json({
      orderId: `ord_${crypto.randomUUID()}`,
      status: "confirmed",
      item: { key: listing.key, title: listing.title },
      amount: await chargedPrice(merchant, listing),
      currency: PAYMENT.currency,
      store: merchant.name,
      seller: listing.seller,
      shipTo: body.shipTo,
    });
  }

  const paidCheckout = withX402(
    placeOrder,
    {
      "/api/checkout/[id]": {
        accepts: {
          scheme: "exact",
          network: PAYMENT.network,
          payTo: () => payTo(),
          price: async (ctx) => formatUsd(await chargedPrice(merchant, (await listingAt(merchant, ctx.path))!)),
          maxTimeoutSeconds: PAYMENT.maxTimeoutSeconds,
        },
        description: `${merchant.name} checkout`,
        mimeType: "application/json",
      },
    },
    paymentServer,
  );

  return async function POST(req: NextRequest) {
    const listing = await listingAt(merchant, req.nextUrl.pathname);
    if (!listing) return NextResponse.json({ error: "Item not found." }, { status: 404 });
    if (!listing.inStock) return NextResponse.json({ error: "Item is out of stock." }, { status: 409 });
    return paidCheckout(req);
  };
}

// GET /api/catalog lists every listing with where to view it and where to buy it.
// GET /api/catalog?q=fleece lists only the listings closest to the query, best first, so an agent can crawl what the shopper asked for.
export function catalogRoute(merchant: Merchant) {
  return async function GET(req: NextRequest) {
    const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
    const listings = await searchItems(merchant.marketplace, query, await merchant.listings(), (listing) => listing.key);
    return Response.json({
      store: merchant.name,
      currency: PAYMENT.currency,
      items: listings.map((listing) => ({ ...listing, checkoutUrl: checkoutUrl(listing) })),
    });
  };
}

// GET /.well-known/store.json tells an agent who it is paying and where the endpoints are.
export function storeInfoRoute(merchant: Merchant) {
  return async function GET() {
    // The wallet comes from the environment, so this runs per request instead of at build time.
    await connection();
    const listings = await merchant.listings();
    return Response.json({
      name: merchant.name,
      sellers: [...new Set(listings.map((listing) => listing.seller))],
      payTo: payTo(),
      network: PAYMENT.network,
      currency: PAYMENT.currency,
      priceRange: priceRange(listings),
      endpoints: {
        catalog: "/api/catalog",
        checkout: "/api/checkout/{key}",
      },
    });
  };
}
