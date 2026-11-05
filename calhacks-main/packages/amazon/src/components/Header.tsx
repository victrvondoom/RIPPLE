import Link from "next/link";
import Logo from "./Logo";
import { Cart, Menu, Pin, Search } from "./Icons";
import type { Store } from "../types";

const NAV = ["Today's Deals", "Prime Video", "Registry", "Gift Cards", "Customer Service", "Sell", "Best Sellers", "New Releases", "Books", "Fashion"];
// The department bar lists the catalog's own biggest categories, so it follows whatever is listed.
export default function Header({ store, categories, query }: { store: Store; categories?: string[]; query?: string }) {
  return (
    <header>
      {store.banner}
      <div className="nav-belt">
        <Link href="/" className="nav-box nav-logo">
          <Logo />
        </Link>
        <div className="nav-box nav-deliver">
          <Pin />
          <span className="nav-line-2">Update Location</span>
        </div>
        <form className="nav-search" action="/s" role="search">
          <div className="nav-search-scope">
            All <span className="caret" />
          </div>
          <input type="text" name="k" defaultValue={query} placeholder="Search mzn" aria-label="Search mzn" />
          <button type="submit" aria-label="Go">
            <Search />
          </button>
        </form>
        <div className="nav-box nav-lang">
          <span className="flag" aria-hidden />
          <span className="nav-line-2">
            EN <span className="caret" />
          </span>
        </div>
        <div className="nav-box">
          <span className="nav-line-1 light">Hello, Sign In</span>
          <span className="nav-line-2">
            Account &amp; Lists <span className="caret" />
          </span>
        </div>
        <div className="nav-box">
          <span className="nav-line-1 light">Returns</span>
          <span className="nav-line-2">&amp; Orders</span>
        </div>
        <div className="nav-box nav-cart" aria-label="Cart">
          <Cart />
        </div>
      </div>
      <nav className="nav-main">
        <span className="nav-all">
          <Menu />
          All
        </span>
        {store.navHighlight && <span className="nav-highlight">{store.navHighlight}</span>}
        {NAV.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </nav>
      {categories && (
        <div className="subnav">
          <b>mzn Fashion</b>
          {categories.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      )}
    </header>
  );
}
