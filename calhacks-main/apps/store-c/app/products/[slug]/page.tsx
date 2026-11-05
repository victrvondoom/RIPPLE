import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Heart, PRERENDERED_ITEMS, formatUsd, percentOff } from "@calhacks/common";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ProductCard from "@/components/ProductCard";
import { Shield, Truck } from "@/components/Icons";
import { getItem, itemsOf } from "@/lib/catalog";

// The top item pages are built ahead of time and the rest render on request, so this route can wait on its params.
export const instant = false;

const PHOTOS = 6;

export async function generateStaticParams() {
  return (await itemsOf()).slice(0, PRERENDERED_ITEMS).map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({ params }: PageProps<"/products/[slug]">): Promise<Metadata> {
  const item = await getItem((await params).slug);
  return { title: item ? `${item.title} | dpp` : "dpp" };
}

export default async function ProductPage({ params }: PageProps<"/products/[slug]">) {
  const item = await getItem((await params).slug);
  if (!item) notFound();

  const { seller } = item;
  // More from the same brand comes first, then the rest of the catalog.
  const others = (await itemsOf()).filter((other) => other.id !== item.id);
  const more = [...others.filter((other) => other.brand === item.brand), ...others.filter((other) => other.brand !== item.brand)].slice(0, 5);
  const attrs = [item.brand, item.size && `Size ${item.size}`, item.condition, item.colour].filter(Boolean);

  return (
    <>
      <Header />
      <main className="page">
        <nav className="crumbs">
          <Link href="/">Home</Link>
          {item.category && (
            <>
              <span>›</span>
              <span>{item.category}</span>
            </>
          )}
          {item.brand && (
            <>
              <span>›</span>
              <span>{item.brand}</span>
            </>
          )}
        </nav>

        <div className="product">
          <div className="gallery">
            {item.images.slice(0, PHOTOS).map((image, index) => (
              <img key={`${index}-${image}`} src={image} alt={index === 0 ? item.title : ""} />
            ))}
          </div>

          <aside className="details">
            <h1>{item.title}</h1>
            <div className="price-line">
              <b>{formatUsd(item.price)}</b>
              <span className="muted">incl. marketplace fee</span>
            </div>
            {item.originalPrice && (
              <div className="markdown">
                <s className="muted">{formatUsd(item.originalPrice)}</s>
                <span className="off">{percentOff(item.price, item.originalPrice)}% OFF</span>
              </div>
            )}
            <p className="attrs">{attrs.join(" • ")}</p>

            <div className="actions">
              <button type="button" className="btn-buy">
                Buy Now
              </button>
              <button type="button" className="btn-bag">
                Add to Bag
              </button>
              <button type="button" className="btn-like" aria-label="Like">
                <Heart size={18} />
              </button>
            </div>

            <div className="assurance">
              <div>
                <Shield />
                <p>
                  All purchases through dpp are covered by Buyer Protection. <u>Learn More</u>
                </p>
              </div>
              <div>
                <Truck />
                <p>
                  This seller often ships in <b>2 days</b>
                </p>
              </div>
            </div>

            <div className="seller">
              <span className="avatar" aria-hidden>
                {seller.initials}
              </span>
              <div>
                <b>{seller.handle}</b>
                {seller.location && <p className="muted">{seller.location}</p>}
              </div>
            </div>
            <div className="seller-btns">
              <span className="btn-ghost">Visit Shop</span>
              <span className="btn-ghost">Ask a Question</span>
            </div>

            <div className="description">
              <p>{item.description}</p>
            </div>
          </aside>
        </div>

        <section className="section">
          <h2>You May Also Like</h2>
          <div className="grid">
            {more.map((other) => (
              <ProductCard key={other.id} item={other} />
            ))}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
