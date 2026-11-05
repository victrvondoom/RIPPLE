import Link from "next/link";
import Price from "./Price";
import Stars from "./Stars";
import { itemPath } from "../catalog";
import type { Item } from "../types";

export default function ProductCard({ item, label }: { item: Item; label?: string }) {
  return (
    <Link href={itemPath(item)} className="product-card">
      <div className="product-img">
        <img src={item.image} alt={item.title} />
      </div>
      <span className="clamp-2 link-title">{item.title}</span>
      {label && <span className="muted small">{label}</span>}
      <span className="rating-line">
        <Stars rating={item.rating} size={14} />
        <span className="link small">{item.ratingCount.toLocaleString("en-US")}</span>
      </span>
      <Price amount={item.price} size="sm" />
    </Link>
  );
}
