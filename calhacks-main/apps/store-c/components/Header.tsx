import Link from "next/link";
import { Camera, Heart } from "@calhacks/common";
import { Bag, Search } from "./Icons";

const NAV = ["Women", "Men", "Kids", "Brands", "Sports", "Trending"];

export default function Header({ query }: { query?: string }) {
  return (
    <header className="header">
      <div className="promo">
        <b>Free Shipping on Your First Order.</b> No minimum spend. Valid 7 days from signup. T&amp;Cs apply.
      </div>
      <div className="bar">
        <Link href="/" className="logo" aria-label="dpp">
          dpp
        </Link>
        <form className="search" action="/search" role="search">
          <Search />
          <input type="text" name="q" defaultValue={query} aria-label="Search" placeholder="Search for Anything" />
          <Camera width={18} height={16} />
        </form>
        <div className="bar-actions">
          <span className="icon-btn" aria-label="Saved">
            <Heart size={24} />
          </span>
          <span className="icon-btn" aria-label="Bag">
            <Bag />
          </span>
          <span className="btn btn-dark">Sell Now</span>
          <span className="btn btn-outline">Sign Up</span>
          <span className="btn btn-text">Log In</span>
        </div>
      </div>
      <nav className="nav">
        {NAV.map((label) => (
          <span key={label}>{label}</span>
        ))}
        <span className="nav-sale">Sale</span>
      </nav>
    </header>
  );
}
