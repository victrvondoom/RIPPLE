import type { Metadata } from "next";
import { queryOf } from "@calhacks/common";
import { searchItems } from "@calhacks/common/market";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ItemCard from "@/components/ItemCard";
import { itemsOf } from "@/lib/catalog";

// Results depend on the query in the URL, so this route can wait on its search params.
export const instant = false;

export async function generateMetadata({ searchParams }: PageProps<"/sch">): Promise<Metadata> {
  return { title: `${queryOf((await searchParams)._nkw)} for sale | by` };
}

// Results come from /sch?_nkw=<query>, so the URL is the search and can be shared or revisited. Atlas ranks the titles by meaning.
export default async function SearchPage({ searchParams }: PageProps<"/sch">) {
  const query = queryOf((await searchParams)._nkw);
  const results = await searchItems("ebay", query, await itemsOf(), (item) => item.itemNumber);

  return (
    <>
      <Header categories={false} query={query} />
      <main className="page">
        <section className="row">
          <div className="row-head">
            <div>
              <h2>{query}</h2>
              <p>{results.length.toLocaleString("en-US")} results</p>
            </div>
          </div>
          {results.length === 0 ? (
            <p>No exact matches found. Try checking your spelling or using more general terms.</p>
          ) : (
            <div className="cards">
              {results.map((item) => (
                <ItemCard key={item.id} item={item} showWas shipping />
              ))}
            </div>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
