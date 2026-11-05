import Link from "next/link";
import { Chevron, formatUsd, percentOff, picker, topGroups } from "@calhacks/common";
import Header from "./components/Header";
import Footer from "./components/Footer";
import ProductCard from "./components/ProductCard";
import { itemPath } from "./catalog";
import { itemsOf } from "./items";
import type { Item, Store } from "./types";

const TONES = ["red", "violet", "green", "dark"] as const;

// Each tile and deal card shows a grid of four.
const QUAD = 4;

const BEST_SELLERS = 20;

// A rating only counts as top rated once enough people have left one.
const MIN_RATINGS = 50;

// Every highlight comes from what is in the catalog right now. The items arrive ranked best seller first,
// and each item shows in at most one highlight, so the hero, tiles, and deal cards never repeat.
function highlightsOf(items: Item[]) {
  const pick = picker<Item>((item) => item.id);
  const hero = pick(items, 3);
  const tiles = topGroups(items, (item) => item.category, TONES.length * 2, QUAD)
    .map((group) => ({ label: group.label, items: pick(group.items, QUAD) }))
    .filter((tile) => tile.items.length === QUAD)
    .slice(0, TONES.length);
  // Deal cards only show items that are really marked down, so every badge is a real discount.
  const discounted = items.filter((item) => item.listPrice);
  const biggestCuts = [...discounted].sort((a, b) => percentOff(b.price, b.listPrice) - percentOff(a.price, a.listPrice));
  const topRated = discounted.filter((item) => item.ratingCount >= MIN_RATINGS).sort((a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount);
  const deals = [
    { title: "Deals for You", items: pick(biggestCuts, QUAD) },
    { title: "Inspired by Your Recent History", items: pick(topRated, QUAD) },
    { title: "Ending Soon", items: pick(discounted, QUAD) },
  ].filter((deal) => deal.items.length > 0);
  return { hero, tiles, deals };
}

export default async function HomePage({ store }: { store: Store }) {
  const { home } = store;
  const items = await itemsOf(store);
  const { hero, tiles, deals } = highlightsOf(items);
  const lowest = Math.min(...items.map((item) => item.price));

  return (
    <>
      <Header store={store} />
      <main className="home">
        <Link href={itemPath(items[0])} className="hero">
          <div className="hero-copy">
            <p className="hero-kicker">{home.kicker}</p>
            <h1>{home.headline(formatUsd(lowest))}</h1>
            <span className="pill-yellow">{home.cta}</span>
            <small>Terms apply.</small>
          </div>
          <div className="hero-art">
            {hero.map((item) => (
              <img key={item.id} src={item.image} alt="" />
            ))}
          </div>
        </Link>

        <section className="tiles">
          {tiles.map((tile, index) => (
            <div key={tile.label} className={`tile tile-${TONES[index]}`}>
              <h2>{home.tile(tile.label)}</h2>
              <div className="tile-quad">
                {tile.items.map((item) => (
                  <Link key={item.id} href={itemPath(item)} className="tile-box">
                    <img src={item.image} alt={item.title} />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="block">
          <h2 className="block-title">Recommended Deals for You</h2>
          <div className="deal-row">
            {deals.map((deal) => (
              <div key={deal.title} className="deal-card">
                <div className="deal-head">
                  <span>{deal.title}</span>
                  <Chevron dir="right" size={20} />
                </div>
                <div className="deal-quad">
                  {deal.items.map((item, index) => (
                    <Link key={item.id} href={itemPath(item)} className="deal-cell">
                      <div className="deal-img">
                        <img src={item.image} alt={item.title} />
                      </div>
                      <span className="deal-badge">{percentOff(item.price, item.listPrice)}% off</span>
                      <span className="deal-label">{home.dealLabels[index]}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="block">
          <div className="block-head">
            <h2 className="block-title">Best Sellers in Clothing, Shoes &amp; Jewelry</h2>
            <span className="link">See More</span>
          </div>
          <div className="product-grid">
            {items.slice(0, BEST_SELLERS).map((item) => (
              <ProductCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      </main>
      <Footer company={store.company} />
    </>
  );
}
