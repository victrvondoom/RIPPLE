import Link from "next/link";
import { Heart, formatUsd } from "@calhacks/common";
import { itemPath, type Item } from "@/lib/catalog";

export default function ProductCard({ item }: { item: Item }) {
  return (
    <Link href={itemPath(item)} className="card">
      <div className="card-img">
        <img src={item.image} alt={item.title} />
        <span className="card-heart" aria-label="Save">
          <Heart size={20} />
        </span>
      </div>
      <span className="card-brand">{item.brand}</span>
      <span className="card-size">{item.size}</span>
      <span className="card-price">
        {item.originalPrice && <s>{formatUsd(item.originalPrice)}</s>}
        <b>{formatUsd(item.price)}</b>
      </span>
    </Link>
  );
}
