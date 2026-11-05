import { marketListings, type MarketListing } from "@calhacks/common/market";

export type Seller = {
  handle: string;
  initials: string;
  location: string | null;
};

export type Item = {
  id: string;
  slug: string;
  title: string;
  price: number;
  originalPrice?: number;
  condition: string;
  brand: string | null;
  category: string | null;
  size: string | null;
  colour: string | null;
  description: string;
  image: string;
  images: string[];
  seller: Seller;
};

const CONDITIONS: Record<string, string> = { new: "Brand New", like_new: "Like New", good: "Used - Good", acceptable: "Used - Fair" };

function toItem(listing: MarketListing): Item {
  const { item, store, source } = listing;
  return {
    id: listing.id,
    slug: source.externalId,
    title: item.title.trim(),
    price: item.price,
    originalPrice: item.listPrice && item.listPrice > item.price ? item.listPrice : undefined,
    condition: CONDITIONS[item.condition ?? ""] ?? "Used - Good",
    brand: item.brand,
    category: item.category,
    size: item.attributes.Size ?? null,
    colour: item.attributes.Colour ?? null,
    description: item.description ?? "",
    image: item.images[0],
    images: item.images,
    seller: { handle: store.name, initials: store.name.slice(0, 2).toUpperCase(), location: store.location },
  };
}

// Depop shows no sales counts, so the listings keep the order Depop's search returned them in.
export async function itemsOf(): Promise<Item[]> {
  return (await marketListings("depop")).map(toItem);
}

export async function getItem(slug: string): Promise<Item | undefined> {
  return (await itemsOf()).find((item) => item.slug === slug);
}

export function itemPath(item: Item): string {
  return `/products/${item.slug}`;
}
