import { titleCase, type BaseReview } from "@calhacks/common";
import { daysFromToday } from "@calhacks/common/dates";
import { marketListings, type MarketListing } from "@calhacks/common/market";

export type Feedback = BaseReview & {
  rating: number;
};

export type Seller = {
  name: string;
  initials: string;
  feedbackScore: number | null;
  positive: string | null;
  location: string | null;
};

export type Item = {
  id: string;
  itemNumber: string;
  title: string;
  price: number;
  wasPrice?: number;
  condition: string;
  brand: string | null;
  category: string | null;
  image: string;
  images: string[];
  available: number;
  sold: number;
  description: string;
  specifics: [string, string][];
  seller: Seller;
  feedback: Feedback[];
};

// Standard shipping arrives six to ten days from today.
const DELIVERY_DAYS = [6, 10];

export async function deliveryEstimate(): Promise<string> {
  const [from, to] = await daysFromToday(DELIVERY_DAYS);
  return `Estimated between ${from} and ${to} to 68508`;
}

const CONDITIONS: Record<string, string> = { new: "New with tags", like_new: "Pre-owned - Excellent", good: "Pre-owned - Good", acceptable: "Pre-owned - Fair" };

// These scraped attributes are page chrome, like shipping and payment lines, not facts about the item.
const SKIPPED_SPECIFICS = new Set(["", "Item price", "Estimated total", "Discounts", "Shipping", "Condition"]);

const SPECIFICS = 12;

// A long value is usually a pasted paragraph, so it is left out of the specifics table.
const MAX_SPECIFIC = 60;

// eBay appends the definition to the condition, like "Pre-owned - GoodThis item has been gently used", so only the label is kept.
function conditionOf({ item }: MarketListing): string {
  const label = item.attributes.Condition?.split(/(?=This item)/)[0].trim();
  return label || CONDITIONS[item.condition ?? ""] || "Pre-owned";
}

function specificsOf({ item }: MarketListing): [string, string][] {
  return Object.entries(item.attributes)
    .filter(([key, value]) => !SKIPPED_SPECIFICS.has(key) && !key.endsWith(":") && value && value.length <= MAX_SPECIFIC)
    .slice(0, SPECIFICS);
}

const BULLET = /^[●•▪◦·]$/;
const SENTENCE_END = /[.!?:;"”]$/;
const DROP_CAP = /^[A-Z]$/;
const LONE_NUMBER = /^\d+$/;
const SYMBOLS = /^[^\w\s●•▪◦·]+$/;

// A sentence never ends on one of these words or on an open bracket, so a line that does carries on into the next.
const CONNECTOR = /(\b(a|an|the|of|to|and|or|for|with|in|on|at|by|from|as)|[(\[])$/i;

function isUpper(line: string): boolean {
  return /[A-Z]/.test(line) && line === line.toUpperCase();
}

// A break splits a sentence when the next line carries on in lowercase, when the line ends on a word like "of", when the line is a lone number
// or drop-cap letter like "2" or "O", when the next line is only a symbol like "°", or when both lines are pieces of one all-caps heading
// like "THANK" and "YOU FOR SHOPPING". A drop cap is never part of a heading, so it waits for the word it starts.
function continues(line: string, next: string): boolean {
  if (/^[a-z]/.test(next) && !SENTENCE_END.test(line)) return true;
  if (CONNECTOR.test(line) || DROP_CAP.test(line) || LONE_NUMBER.test(line) || SYMBOLS.test(next)) return true;
  return isUpper(line) && isUpper(next) && !DROP_CAP.test(next) && !SENTENCE_END.test(line);
}

// A drop cap belongs to its word, "O" + "ur" is "Our", a symbol belongs to the number before it, "360" + "°", and an open bracket
// belongs to what it opens. Everything else joins with a space.
function glue(line: string, next: string): string {
  const touching = (DROP_CAP.test(line) && /^[a-z]/.test(next)) || SYMBOLS.test(next) || /[(\[]$/.test(line);
  return touching ? `${line}${next}` : `${line} ${next}`;
}

// eBay flattens the seller's HTML into lines that break mid-sentence, so the broken sentences are joined back together.
// A lone bullet joins the line after it, and the seller's ** markdown is dropped, since it would show as asterisks.
function readable(description: string): string {
  const lines = description
    .replace(/^eBay\s*/, "")
    .replace(/\*\*/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const joined: string[] = [];
  for (const line of lines) {
    const last = joined.at(-1);
    if (last !== undefined && (BULLET.test(last) || continues(last, line))) joined[joined.length - 1] = glue(last, line);
    else joined.push(line);
  }
  return joined.join("\n");
}

function sellerOf({ store }: MarketListing): Seller {
  return {
    name: store.name,
    initials: store.name.slice(0, 2).toUpperCase(),
    feedbackScore: store.reviewCount,
    positive: store.positivePercent === null ? null : `${store.positivePercent}%`,
    location: store.location,
  };
}

function toItem(listing: MarketListing): Item {
  const { item, source } = listing;
  return {
    id: listing.id,
    itemNumber: source.externalId,
    title: item.title,
    price: item.price,
    wasPrice: item.listPrice && item.listPrice > item.price ? item.listPrice : undefined,
    condition: conditionOf(listing),
    brand: item.brand,
    category: item.category ? titleCase(item.category) : null,
    image: item.images[0],
    images: item.images,
    available: item.stock ?? 1,
    sold: item.stats?.sold ?? 0,
    description: readable(item.description ?? ""),
    specifics: specificsOf(listing),
    seller: sellerOf(listing),
    feedback: listing.reviews,
  };
}

// The listings that have sold the most come first.
export async function itemsOf(): Promise<Item[]> {
  return (await marketListings("ebay")).map(toItem).sort((a, b) => b.sold - a.sold);
}

export async function getItem(itemNumber: string): Promise<Item | undefined> {
  return (await itemsOf()).find((item) => item.itemNumber === itemNumber);
}

export function itemPath(item: Item): string {
  return `/itm/${item.itemNumber}`;
}
