import Link from "next/link";
import { Heart, formatUsd } from "@calhacks/common";
import { itemPath, type Item } from "@/lib/catalog";

export default function ItemCard({ item, showWas = false, shipping = false }: { item: Item; showWas?: boolean; shipping?: boolean }) {
  return (
    <Link href={itemPath(item)} className="card">
      <div className="card-img">
        <img src={item.image} alt={item.title} />
        <span className="card-heart" aria-label="Add to watchlist">
          <Heart />
        </span>
      </div>
      <span className="card-title clamp-2">{item.title}</span>
      <span className="card-price">
        {formatUsd(item.price)}
        {showWas && item.wasPrice && <s>{formatUsd(item.wasPrice)}</s>}
      </span>
      {shipping && <span className="card-ship">Free Shipping</span>}
    </Link>
  );
}
