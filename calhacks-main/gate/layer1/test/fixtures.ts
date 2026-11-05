// Builds GateInputs from contracts/tests/fixtures (fictional, test-only data).
import { readFileSync } from "node:fs";
import type { GateInput, KnownSeller, Listing, Mandate } from "../src/index.ts";

const FIX = new URL("../../../contracts/tests/fixtures/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, FIX), "utf8"));

interface Refs {
  known_sellers: KnownSeller[];
  market_medians: { product_key: string; condition: string; median: number }[];
}

const refs = read("references.json") as Refs;

export function toInput(listing: Listing, mandate: Mandate): GateInput {
  const median = refs.market_medians.find(
    (m) => m.product_key === listing.item.product_key && m.condition === listing.item.condition,
  );
  return {
    mandate,
    listing,
    references: {
      known_sellers: refs.known_sellers,
      market_median: median?.median ?? null,
      pay_to_first_seen: null,
    },
  };
}

export function fixtureInputs(): GateInput[] {
  const real = (read("real_listings.json") as { listing: Listing; mandate: Mandate }[]).map((r) =>
    toInput(r.listing, r.mandate),
  );
  const synth = (read("synthetic.json") as { synthetic: { listing: Listing }; case: { mandate: Mandate } }[]).map((r) =>
    toInput(r.synthetic.listing, r.case.mandate),
  );
  return [...real, ...synth];
}

export function byId(id: string): GateInput {
  const x = fixtureInputs().find((i) => i.listing.listing_id === id);
  if (!x) throw new Error(`no fixture ${id}`);
  return structuredClone(x);
}
