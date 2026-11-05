import type { Metadata } from "next";
import { PRERENDERED_ITEMS } from "@calhacks/common";
import type { Merchant } from "@calhacks/common/x402";
import { itemsOf } from "./items";
import type { Item, Store } from "./types";

export function itemPath(item: Item): string {
  return `/dp/${item.id}`;
}

export async function itemParams(store: Store) {
  return (await itemsOf(store)).slice(0, PRERENDERED_ITEMS).map((item) => ({ id: item.id }));
}

export async function itemMetadata(store: Store, id: string): Promise<Metadata> {
  const item = (await itemsOf(store)).find((entry) => entry.id === id);
  return { title: item ? `${store.brand}: ${item.title} : Clothing, Shoes & Jewelry` : store.brand };
}

// The real and scam stores sell through the same x402 checkout. The company on the page is who gets paid.
export function merchantOf(store: Store): Merchant {
  return {
    name: store.company,
    marketplace: "amazon",
    listings: async () =>
      (await itemsOf(store)).map((item) => ({ key: item.id, title: item.title, price: item.price, inStock: item.stock > 0, seller: item.soldBy, path: itemPath(item) })),
  };
}
