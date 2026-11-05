import { searchItems } from "@calhacks/common/market";
import Header from "./components/Header";
import Footer from "./components/Footer";
import ProductCard from "./components/ProductCard";
import { itemsOf } from "./items";
import type { Store } from "./types";

// Results come from /s?k=<query>, so the URL is the search and can be shared or revisited. Atlas ranks the titles by meaning.
export default async function SearchPage({ store, query }: { store: Store; query: string }) {
  const results = await searchItems("amazon", query, await itemsOf(store), (item) => item.id);

  return (
    <>
      <Header store={store} query={query} />
      <main className="home">
        <h1 className="block-title">
          {results.length.toLocaleString("en-US")} results for &quot;{query}&quot;
        </h1>
        {results.length === 0 ? (
          <p className="muted">No results. Try checking your spelling or using more general terms.</p>
        ) : (
          <div className="product-grid">
            {results.map((item) => (
              <ProductCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </main>
      <Footer company={store.company} />
    </>
  );
}
