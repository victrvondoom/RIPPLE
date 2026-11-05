import { notFound } from "next/navigation";
import { Heart, formatUsd, percentOff, topGroups } from "@calhacks/common";
import { daysFromToday } from "@calhacks/common/dates";
import Header from "./components/Header";
import Footer from "./components/Footer";
import Price from "./components/Price";
import ProductCard from "./components/ProductCard";
import Stars from "./components/Stars";
import { Avatar, Flag, Pin, Share } from "./components/Icons";
import { itemsOf } from "./items";
import type { Item, Store } from "./types";

// Amazon warns shoppers once fewer than this many are left.
const LOW_STOCK = 5;

const THUMBS = 6;

const SUBNAV = 10;

function StockLine({ item }: { item: Item }) {
  if (item.stock === 0) return <p className="stock stock-out">Currently unavailable.</p>;
  if (item.stock < LOW_STOCK) return <p className="stock stock-low">Only {item.stock} left in stock - order soon.</p>;
  return <p className="stock stock-in">In Stock</p>;
}

export default async function ItemPage({ store, id }: { store: Store; id: string }) {
  const items = await itemsOf(store);
  const item = items.find((entry) => entry.id === id);
  if (!item) notFound();

  const { listing } = store;
  // Similar items come from the same category first, then from the rest of the best sellers.
  const others = items.filter((other) => other.id !== item.id);
  const similar = [...others.filter((other) => other.category === item.category), ...others.filter((other) => other.category !== item.category)].slice(0, 5);
  const crumbs = ["Clothing, Shoes & Jewelry", item.category];
  const categories = topGroups(items, (entry) => entry.category, SUBNAV).map((group) => group.label);
  const [delivery, fast] = await Promise.all([daysFromToday(store.deliveryDays), daysFromToday(store.fastDays)]);
  const bullets = listing.leadBullet ? [listing.leadBullet, ...item.bullets] : item.bullets;
  const details = [
    ["Ships From", listing.shipsFrom],
    ["Sold By", item.soldBy],
    ["Condition", item.condition],
    ["Returns", listing.returns],
    ["Payment", listing.payment],
  ];

  return (
    <>
      <Header store={store} categories={categories} />
      <main className="dp">
        <div className="breadcrumb">
          {crumbs.map((crumb, index) => (
            <span key={crumb}>
              <span className="crumb">{crumb}</span>
              {index < crumbs.length - 1 && <span className="crumb-sep">›</span>}
            </span>
          ))}
        </div>

        <div className="dp-top">
          <div className="dp-left">
            <div className="dp-thumbs">
              {item.images.slice(0, THUMBS).map((image, index) => (
                <span key={`${index}-${image}`} className={index === 0 ? "dp-thumb active" : "dp-thumb"}>
                  <img src={image} alt="" />
                </span>
              ))}
            </div>
            <div className="dp-image">
              <div className="dp-image-actions">
                <span className="round-btn" aria-label="Share">
                  <Share />
                </span>
                <span className="round-btn" aria-label="Add to list">
                  <Heart size={20} />
                </span>
              </div>
              <img src={item.image} alt={item.title} />
              <span className="link dp-fullview">Click to See Full View</span>
            </div>
          </div>

          <div className="dp-center">
            <h1 className="dp-title">{item.title}</h1>
            <span className="link">Visit the {item.brand} Store</span>
            <div className="dp-meta">
              <b>Brand :</b> {item.brand} <span className="divider">|</span> <span className="muted">Category:</span> <span className="link">{item.category}</span>
            </div>
            <div className="rating-line">
              <span>{item.rating.toFixed(1)}</span>
              <Stars rating={item.rating} />
              <span className="link">({item.ratingCount.toLocaleString("en-US")})</span>
            </div>
            {item.boughtLastMonth && <div className="bought">{item.boughtLastMonth}</div>}
            {listing.badge}
            <hr />
            <div className="dp-savings">
              {item.listPrice && <span className="savings">-{percentOff(item.price, item.listPrice)}%</span>}
              <Price amount={item.price} size="lg" />
            </div>
            {item.listPrice && (
              <div className="muted small list-price">
                List Price: <s>{formatUsd(item.listPrice)}</s>
              </div>
            )}
            <div className="link returns">
              FREE Returns <span className="caret dark" />
            </div>
            <ul className="bullets">
              {bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
            {listing.hiddenNote && <p className="sr-only">{listing.hiddenNote}</p>}
            <div className="report link">
              <Flag />
              Report an Issue with This Product or Seller
            </div>
            <hr />
          </div>

          <aside className="buybox">
            <b className="buybox-cond">{item.condition}</b>
            <Price amount={item.price} size="lg" />
            <div className="link returns">
              FREE Returns <span className="caret dark" />
            </div>
            <p>
              FREE Delivery <b>{delivery.join(" - ")}</b>
            </p>
            <p>
              Or fastest delivery <b>{fast.join(" - ")}</b>
              {listing.deliveryNote}
            </p>
            <p className="link small deliver-to">
              <Pin size={12} color="#0f1111" />
              Delivering to {store.deliverTo}
            </p>
            <StockLine item={item} />
            {listing.urgency && <p className="urgency">{listing.urgency}</p>}
            {item.stock > 0 && (
              <>
                <div className="qty">
                  Quantity: 1 <span className="caret dark" />
                </div>
                <button type="button" className="btn-cart">
                  Add to Cart
                </button>
                <button type="button" className="btn-buy">
                  Buy Now
                </button>
              </>
            )}
            <table className="buybox-table">
              <tbody>
                {details.map(([label, value]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className={label === "Ships From" ? undefined : "link"}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <hr />
            <button type="button" className="btn-list">
              Add to List
            </button>
          </aside>
        </div>

        <section className="dp-section">
          <h2>Similar Items That May Deliver to You Quickly</h2>
          <div className="product-grid">
            {similar.map((other) => (
              <ProductCard key={other.id} item={other} label={listing.storeLabel} />
            ))}
          </div>
        </section>

        <section className="dp-section reviews">
          <div className="reviews-summary">
            <h2>Customer Reviews</h2>
            <div className="rating-line big">
              <Stars rating={item.rating} size={20} />
              <span>{item.rating.toFixed(1)} out of 5</span>
            </div>
            <p className="muted global-ratings">{item.ratingCount.toLocaleString("en-US")} global ratings</p>
            <table className="histogram">
              <tbody>
                {item.breakdown.map((percent, index) => (
                  <tr key={index}>
                    <td className="link">{5 - index} star</td>
                    <td>
                      <div className="bar">
                        <div style={{ width: `${percent}%` }} />
                      </div>
                    </td>
                    <td className="link">{percent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <hr />
            <h3>Review This Product</h3>
            <p className="review-prompt">Share your thoughts with other customers</p>
            <button type="button" className="btn-list">
              Write a Customer Review
            </button>
          </div>
          <div className="reviews-list">
            <h3>Top Reviews from the United States</h3>
            {item.reviews.map((review) => (
              <div key={`${review.author}-${review.date}`} className="review">
                <div className="review-author">
                  <Avatar />
                  {review.author}
                </div>
                <div className="rating-line">
                  <Stars rating={review.rating} />
                  <b>{review.title}</b>
                </div>
                {review.date && <p className="muted small review-meta">Reviewed in the United States on {review.date}</p>}
                <p className="small">
                  <span className="verified">Verified Purchase</span>
                </p>
                <p className="review-body">{review.body}</p>
                <p className="muted small">{review.helpful} people found this helpful</p>
                <div className="review-actions">
                  <button type="button" className="btn-helpful">
                    Helpful
                  </button>
                  <span className="muted small">Report</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
      <Footer company={store.company} />
    </>
  );
}
