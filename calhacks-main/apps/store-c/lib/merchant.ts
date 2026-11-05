import type { Merchant } from "@calhacks/common/x402";
import { itemPath, itemsOf } from "./catalog";

// Checkout uses the Depop slug, the same ID that is in each item URL. Every listing is a single item that is still for sale.
export const merchant: Merchant = {
  name: "dpp",
  marketplace: "depop",
  listings: async () =>
    (await itemsOf()).map((item) => ({ key: item.slug, title: item.title, price: item.price, inStock: true, seller: item.seller.handle, path: itemPath(item) })),
};
