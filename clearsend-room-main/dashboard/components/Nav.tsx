"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cx } from "./ui";

const LINKS = [
  ["/", "Room"],
  ["/plan", "Plan a trip"],
  ["/escrow", "Escrow"],
  ["/trips", "Trips"],
  ["/activity", "Activity"],
  ["/switch", "Switch setup"],
  ["/judges", "Judges"],
] as const;

function ThemeToggle() {
  const [theme, setTheme] = useState<string | null>(null);
  useEffect(() => setTheme(document.documentElement.dataset.theme ?? "dark"), []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    setTheme(next);
  };
  return (
    <button onClick={flip} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} className="glass grid size-9 place-items-center rounded-full text-sm">
      {theme === "light" ? "☾" : "☀"}
    </button>
  );
}

export function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const active = (h: string) => (h === "/" ? path === "/" : path.startsWith(h));
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
          <span className="btn-primary grid size-8 place-items-center rounded-xl text-sm">CS</span>
          ClearSend <span className="gradient-text">Room</span>
        </Link>
        <nav aria-label="Main" className="ml-6 hidden items-center gap-1 lg:flex">
          {LINKS.map(([h, l]) => (
            <Link key={h} href={h} aria-current={active(h) ? "page" : undefined} className={cx("rounded-full px-3 py-1.5 text-sm transition", active(h) ? "bg-[var(--line)] font-semibold" : "text-mut hover:text-[var(--fg)]")}>
              {l}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden rounded-full bg-warn px-3 py-1 text-xs font-semibold c-warn sm:inline">PayPal sandbox</span>
          <ThemeToggle />
          <button className="glass grid size-9 place-items-center rounded-full lg:hidden" aria-expanded={open} aria-label="Menu" onClick={() => setOpen(!open)}>
            ☰
          </button>
        </div>
      </div>
      {open && (
        <nav aria-label="Mobile" className="grid gap-1 border-t border-line px-4 py-3 lg:hidden">
          {LINKS.map(([h, l]) => (
            <Link key={h} href={h} className={cx("rounded-xl px-3 py-2 text-sm", active(h) && "bg-[var(--line)] font-semibold")}>
              {l}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
