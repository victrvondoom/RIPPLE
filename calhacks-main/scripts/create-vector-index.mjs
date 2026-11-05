// This creates the Atlas Vector Search index the storefront search pages query, once per cluster.
// Atlas embeds every listing title itself (automated embedding, Voyage AI) and keeps the embeddings current as listings change.
// Run with MONGODB_URI set, or in the repo root .env.local. Re-running updates the definition in place.
// Pass a query, like `node scripts/create-vector-index.mjs "warm jacket"`, to print the closest titles once the index is ready.
import { existsSync } from "node:fs";
import { MongoClient } from "mongodb";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not set");

// Keep these three in step with packages/common/src/market.ts.
export const INDEX = "listings_title_vector";
const PATH = "item.title";
const MODEL = "voyage-4";

const definition = {
  fields: [
    { type: "autoEmbed", modality: "text", path: PATH, model: MODEL },
    // Each store searches only its own marketplace.
    { type: "filter", path: "source.marketplace" },
  ],
};

const client = await new MongoClient(uri, { appName: "calhacks" }).connect();
const listings = client.db("calhacks").collection("listings");
const existing = (await listings.listSearchIndexes(INDEX).toArray())[0];
if (existing) {
  await listings.updateSearchIndex(INDEX, definition);
  console.log(`updated ${INDEX} (was ${existing.status})`);
} else {
  await listings.createSearchIndex({ name: INDEX, type: "vectorSearch", definition });
  console.log(`created ${INDEX}`);
}
// Embedding runs in the background. The index answers queries once it is READY and queryable.
const status = (await listings.listSearchIndexes(INDEX).toArray())[0];
console.log(`status ${status.status}, queryable ${status.queryable}`);

const query = process.argv[2];
if (query && status.queryable) {
  const hits = await listings
    .aggregate([
      { $vectorSearch: { index: INDEX, path: PATH, query, numCandidates: 100, limit: 5 } },
      { $project: { _id: 0, marketplace: "$source.marketplace", title: "$item.title", score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
  for (const hit of hits) console.log(`${hit.score.toFixed(3)}  ${hit.marketplace.padEnd(6)}  ${hit.title}`);
}
await client.close();
