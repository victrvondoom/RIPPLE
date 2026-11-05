import "server-only";
import { MongoClient, type Db } from "mongodb";

// Every store shares one MongoDB client per server process. The client is kept on globalThis, so hot reloads in dev do not open a new pool each time.
// Only the connected client is kept, never a pending promise: a "use cache" function may not await a promise created outside it.
const cache = globalThis as typeof globalThis & { mongo?: MongoClient };

export async function mongo(): Promise<MongoClient> {
  if (cache.mongo) return cache.mongo;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const client = await new MongoClient(uri, { appName: "calhacks" }).connect();
  // Two cold calls can connect at once. The first to finish is kept and the other is closed.
  if (cache.mongo) {
    await client.close();
    return cache.mongo;
  }
  cache.mongo = client;
  return client;
}

// Each store keeps its data in a database named after itself.
export async function database(name: string): Promise<Db> {
  return (await mongo()).db(name);
}
