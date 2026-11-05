export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function percentOff(price: number, listPrice?: number): number {
  return listPrice ? Math.round((1 - price / listPrice) * 100) : 0;
}

// This goes in every store footer, so the clones are never mistaken for the real sites.
export function demoNotice(brand: string): string {
  return `Demo storefront built for Cal Hacks research. Not affiliated with ${brand}.`;
}

// Scraped dates are either ISO days like "2026-10-03" or labels like "Past month". Only the ISO days are reformatted.
export function longDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
