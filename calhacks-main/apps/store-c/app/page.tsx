import Link from "next/link";
import { picker, priceTiers, topGroups } from "@calhacks/common";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ProductCard from "@/components/ProductCard";
import { Hanger, Shield, Sparkle } from "@/components/Icons";
import { itemPath, itemsOf, type Item } from "@/lib/catalog";

const BRANDS = 6;
const POPULAR = 20;

// Every highlight comes from what is listed right now: the biggest brands, the price points that split the catalog, and the live counts.
export default async function Home() {
  const items = await itemsOf();
  // Each item shows in at most one highlight, so the hero and the brand circles never repeat a photo.
  const pick = picker<Item>((item) => item.id);
  const hero = pick(items, 3);
  const brands = topGroups(items, (item) => item.brand, BRANDS).flatMap((group) => pick(group.items, 1).map((item) => ({ label: group.label, item })));
  const prices = priceTiers(items.map((item) => item.price));
  const stats = [
    { icon: <Hanger />, title: items.length.toLocaleString("en-US"), text: "Items for Sale" },
    { icon: <Sparkle />, title: new Set(items.map((item) => item.brand)).size.toLocaleString("en-US"), text: "Brands to Shop" },
    { icon: <Shield />, title: "Buy Safely", text: "dpp Protection", link: true },
  ];

  return (
    <>
      <Header />
      <main>
        <section className="hero">
          <div className="hero-inner">
            <div className="hero-copy">
              <div className="toggle">
                <span className="on">Buy</span>
                <span>Sell</span>
              </div>
              <h1>Buy Preloved. Wear It Your Way</h1>
              <p>Together, we&apos;re keeping great clothes in circulation.</p>
              <Link href={itemPath(items[0])} className="hero-cta">
                Shop Now
              </Link>
              <div className="stats">
                {stats.map((stat) => (
                  <div key={stat.text} className="stat">
                    {stat.icon}
                    <b>{stat.title}</b>
                    <span className={stat.link ? "underline" : undefined}>{stat.text}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="hero-art">
              {hero.map((item) => (
                <img key={item.id} src={item.image} alt="" />
              ))}
            </div>
          </div>
        </section>

        <div className="page">
          <section className="section">
            <h2>Shop by Brand</h2>
            <div className="circles">
              {brands.map(({ label, item }) => (
                <Link key={label} href={itemPath(item)} className="circle">
                  <div className="circle-img">
                    <img src={item.image} alt="" />
                  </div>
                  <span>{label}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="section">
            <h2>Popular This Week</h2>
            <div className="grid">
              {items.slice(0, POPULAR).map((item) => (
                <ProductCard key={item.id} item={item} />
              ))}
            </div>
          </section>

          <section className="section">
            <h2>Shop by Price</h2>
            <div className="prices">
              {prices.map((price) => (
                <span key={price} className="price-tile">
                  Under <b>${price}</b>
                </span>
              ))}
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
