import "server-only";
import { cacheLife } from "next/cache";
import { database } from "./db";

export type Marketplace = "amazon" | "ebay" | "depop";

export type MarketReview = {
  author: string;
  date: string;
  rating: number;
  title?: string;
  body: string;
  helpful?: number;
  verified?: boolean;
};

// This is one scraped listing as the scraper stores it. Fields a marketplace does not show are null.
export type MarketListing = {
  id: string;
  source: { marketplace: Marketplace; url: string; externalId: string };
  store: {
    name: string;
    sellerId: string | null;
    rating: number | null;
    reviewCount: number | null;
    itemsSold: number | null;
    positivePercent: number | null;
    location: string | null;
  };
  item: {
    title: string;
    price: number;
    // Set only on a planted payment_mismatch scam (redteam.plant): what the 402 demands, more than the page shows.
    checkoutPrice?: number;
    condition: string | null;
    description: string | null;
    listPrice: number | null;
    images: string[];
    brand: string | null;
    category: string | null;
    attributes: Record<string, string>;
    bullets: string[] | null;
    stock: number | null;
    rating: number | null;
    ratingCount: number | null;
    ratingBreakdown: [number, number, number, number, number] | null;
    stats: { boughtLastMonth?: string; sold?: number } | null;
  };
  reviews: MarketReview[];
};

const PHOTO_TIMEOUT = 5000;

// A photo is live when it answers with an image. Some hosts refuse HEAD, so this asks for the photo and drops the body once the headers arrive.
// A slow answer counts as live, since a timeout says more about the network than the photo.
async function loads(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PHOTO_TIMEOUT) });
    await response.body?.cancel();
    return response.ok && (response.headers.get("content-type") ?? "").startsWith("image/");
  } catch {
    return true;
  }
}

function hostOf(url: string): string {
  return new URL(url).host;
}

// Some sellers hot link photos from other sites, and those sites remove them or block outside visitors.
// A host fails for every photo at once, so each host is tested once per listing and a failing host's photos are all dropped.
async function withLivePhotos(listing: MarketListing): Promise<MarketListing> {
  const { images } = listing.item;
  const hosts = [...new Set(images.map(hostOf))];
  const live = await Promise.all(hosts.map((host) => loads(images.find((image) => hostOf(image) === host)!)));
  const liveHosts = new Set(hosts.filter((_, index) => live[index]));
  return { ...listing, item: { ...listing.item, images: images.filter((image) => liveHosts.has(hostOf(image))) } };
}

// The Atlas Vector Search index from scripts/create-vector-index.mjs. Atlas embeds the titles and the query itself.
const SEARCH_INDEX = "listings_title_vector";
const SEARCH_PATH = "item.title";
const SEARCH_LIMIT = 40;
// Atlas scans this many nearest neighbours before keeping the best SEARCH_LIMIT. Ten times the limit is the usual starting point.
const SEARCH_CANDIDATES = 400;

// The marketplace IDs of the listings that read closest to the query, best first, from one marketplace.
// Every query asks Atlas to embed the text, so the answer is kept for a while.
async function searchExternalIds(marketplace: Marketplace, query: string): Promise<string[]> {
  "use cache";
  cacheLife("hours");
  const listings = (await database("calhacks")).collection<MarketListing>("listings");
  const hits = await listings
    .aggregate<{ source: { externalId: string } }>([
      { $vectorSearch: { index: SEARCH_INDEX, path: SEARCH_PATH, query, numCandidates: SEARCH_CANDIDATES, limit: SEARCH_LIMIT, filter: { "source.marketplace": marketplace } } },
      { $project: { _id: 0, "source.externalId": 1 } },
    ])
    .toArray();
  return hits.map((hit) => hit.source.externalId);
}

// Search results in Atlas's order, drawn from the store's own items so every result is one the store can show and sell.
// Each store keys its items by the marketplace ID. An empty query returns everything, the way a bare search page does.
export async function searchItems<T>(marketplace: Marketplace, query: string, items: T[], externalIdOf: (item: T) => string): Promise<T[]> {
  if (!query) return items;
  const byId = new Map(items.map((item) => [externalIdOf(item), item]));
  return (await searchExternalIds(marketplace, query)).flatMap((id) => byId.get(id) ?? []);
}

// Every store sells the listings scraped from its own marketplace. A listing without a price or a photo cannot be sold or shown, so it is left out.
export async function marketListings(marketplace: Marketplace): Promise<MarketListing[]> {
  "use cache";
  cacheLife("hours");
  const listings = (await database("calhacks")).collection<MarketListing>("listings");
  const found = await listings.find({ "source.marketplace": marketplace, "item.price": { $gt: 0 }, "item.images.0": { $exists: true } }, { projection: { _id: 0 } }).toArray();
  return (await Promise.all(found.map(withLivePhotos))).filter((listing) => listing.item.images.length > 0);
}
