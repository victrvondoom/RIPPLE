import Link from "next/link";
import { Chevron, picker, topGroups } from "@calhacks/common";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ItemCard from "@/components/ItemCard";
import { itemPath, itemsOf, type Item } from "@/lib/catalog";

const HERO = 3;
const SHORTCUTS = 6;
const RECOMMENDED = 20;

// Each group is shown by its best seller that no other highlight already uses.
function leadsOf(groups: { label: string; items: Item[] }[], pick: (ranked: Item[], count: number) => Item[]) {
  return groups.flatMap((group) => pick(group.items, 1).map((item) => ({ label: group.label, item })));
}

// Every highlight comes from what is listed right now. The items arrive best seller first,
// so the hero shows the biggest categories and the shortcuts show the biggest brands.
export default async function Home() {
  const items = await itemsOf();
  const pick = picker<Item>((item) => item.id);
  const hero = leadsOf(topGroups(items, (item) => item.category, HERO), pick);
  const shortcuts = [...leadsOf(topGroups(items, (item) => item.brand, SHORTCUTS), pick), ...pick(items, 1).map((item) => ({ label: "Shop All", item }))];
  const deals = items.filter((item) => item.wasPrice);

  return (
    <>
      <Header />
      <main className="page">
        <section className="hero">
          <div className="hero-copy">
            <h1>Find Your Next Favorite Layer</h1>
            <p>Score great prices on {hero.map(({ label }) => label.toLowerCase()).join(", ")}, and more.</p>
            <span className="hero-btn">Shop Now</span>
          </div>
          <div className="hero-items">
            {hero.map(({ label, item }) => (
              <Link key={label} href={itemPath(item)} className="hero-item">
                <img src={item.image} alt={item.title} />
                <span>
                  {label} <Chevron dir="right" size={16} />
                </span>
              </Link>
            ))}
          </div>
          <div className="hero-dots" aria-hidden>
            <i className="on" />
            <i />
            <i />
            <i />
          </div>
        </section>

        <section className="row">
          <h2>Shop Top Brands</h2>
          <div className="shortcuts">
            {shortcuts.map(({ label, item }) => (
              <Link key={label} href={itemPath(item)} className="shortcut">
                <div className="shortcut-img">
                  <img src={item.image} alt="" />
                </div>
                <span>{label}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="row">
          <div className="row-head">
            <div>
              <h2>Clothing, Shoes and Accessories</h2>
              <p>Recommended for You</p>
            </div>
            <span className="u-link">See All</span>
          </div>
          <div className="cards">
            {items.slice(0, RECOMMENDED).map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </section>

        <section className="banner">
          <div>
            <h2>Shop With Confidence</h2>
            <p>Get the item you ordered or your money back with the by Money Back Guarantee.</p>
          </div>
          <span className="banner-btn">Learn More</span>
        </section>

        {deals.length > 0 && (
          <section className="row">
            <div className="row-head">
              <div>
                <h2>Today&apos;s Deals</h2>
                <p>All with Free Shipping</p>
              </div>
              <span className="u-link">See All</span>
            </div>
            <div className="cards">
              {deals.map((item) => (
                <ItemCard key={item.id} item={item} showWas />
              ))}
            </div>
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}
