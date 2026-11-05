import type { Metadata } from "next";
import { queryOf } from "@calhacks/common";
import { searchItems } from "@calhacks/common/market";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ProductCard from "@/components/ProductCard";
import { itemsOf } from "@/lib/catalog";

// Results depend on the query in the URL, so this route can wait on its search params.
export const instant = false;

export async function generateMetadata({ searchParams }: PageProps<"/search">): Promise<Metadata> {
  return { title: `${queryOf((await searchParams).q)} | dpp` };
}

// Results come from /search?q=<query>, so the URL is the search and can be shared or revisited. Atlas ranks the titles by meaning.
export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const query = queryOf((await searchParams).q);
  const results = await searchItems("depop", query, await itemsOf(), (item) => item.slug);

  return (
    <>
      <Header query={query} />
      <main className="page">
        <section className="section">
          <h2>
            {results.length.toLocaleString("en-US")} results for &quot;{query}&quot;
          </h2>
          {results.length === 0 ? (
            <p>Nothing matches yet. Try a brand, a category, or a size.</p>
          ) : (
            <div className="grid">
              {results.map((item) => (
                <ProductCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
