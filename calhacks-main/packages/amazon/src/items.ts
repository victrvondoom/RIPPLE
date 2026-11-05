import { longDate, titleCase } from "@calhacks/common";
import { marketListings, type MarketListing } from "@calhacks/common/market";
import type { Item, Store } from "./types";

// Amazon only shows a count once stock runs low, so a listing without one is treated as well stocked.
const DEFAULT_STOCK = 20;

const BULLETS = 4;

// These attributes are filled in on almost every scraped listing, so they stand in when a listing has no description.
const FALLBACK_ATTRIBUTES = ["Fabric Type", "Fit Type", "Product Care Instructions", "Seasons"];

const CONDITIONS: Record<string, string> = { new: "New", like_new: "Used - Like New", good: "Used - Good", acceptable: "Used - Acceptable" };

// "1K+ bought in past month" becomes 1000, so listings can be ranked by it.
function boughtCount(label?: string): number {
  const match = label?.match(/([\d.]+)(K?)\+/);
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : 0;
}

// Most scraped listings have no bullets, so the first sentences of the description fill in.
function bulletsOf({ item }: MarketListing): string[] {
  if (item.bullets?.length) return item.bullets;
  const sentences = item.description?.replace(/^Product Description/, "").match(/[^.!?]+[.!?]+/g);
  if (sentences?.length) return sentences.slice(0, BULLETS).map((sentence) => sentence.trim());
  return FALLBACK_ATTRIBUTES.filter((key) => item.attributes[key]).map((key) => `${key}: ${item.attributes[key]}`);
}

function toItem(listing: MarketListing): Item {
  const { item, store, source } = listing;
  return {
    id: source.externalId,
    title: item.title,
    brand: item.brand ?? store.name,
    category: item.category ? titleCase(item.category) : "Clothing",
    image: item.images[0],
    images: item.images,
    price: item.price,
    listPrice: item.listPrice && item.listPrice > item.price ? item.listPrice : undefined,
    condition: CONDITIONS[item.condition ?? "new"] ?? "New",
    rating: item.rating ?? 0,
    ratingCount: item.ratingCount ?? 0,
    breakdown: item.ratingBreakdown ?? [0, 0, 0, 0, 0],
    boughtLastMonth: item.stats?.boughtLastMonth,
    bullets: bulletsOf(listing),
    soldBy: store.name,
    stock: item.stock ?? DEFAULT_STOCK,
    reviews: listing.reviews.map((review) => ({ ...review, date: longDate(review.date), title: review.title ?? "", helpful: review.helpful ?? 0 })),
  };
}

// The best sellers come first, ranked by how many sold last month and then by how many ratings they have.
export async function itemsOf(store: Store): Promise<Item[]> {
  const items = (await marketListings("amazon"))
    .map(toItem)
    .sort((a, b) => boughtCount(b.boughtLastMonth) - boughtCount(a.boughtLastMonth) || b.ratingCount - a.ratingCount);
  return store.adapt ? items.map(store.adapt) : items;
}
