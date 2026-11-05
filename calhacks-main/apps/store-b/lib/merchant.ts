import type { Merchant } from "@calhacks/common/x402";
import { itemPath, itemsOf } from "./catalog";

// Checkout uses the eBay item number, the same ID that is in each item URL.
export const merchant: Merchant = {
  name: "by Inc.",
  marketplace: "ebay",
  listings: async () =>
    (await itemsOf()).map((item) => ({ key: item.itemNumber, title: item.title, price: item.price, inStock: item.available > 0, seller: item.seller.name, path: itemPath(item) })),
};
