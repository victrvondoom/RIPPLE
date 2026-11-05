export type Group<T> = { label: string; items: T[] };

// These labels stand for a missing value, so they never head a section.
const PLACEHOLDERS = new Set(["", "other", "unbranded", "not available", "n/a", "none"]);

// Each store ranks its items by popularity first, and every highlight is taken from the top of that list.
// So the biggest groups lead, and each group shows its most popular items in order.
export function topGroups<T>(items: T[], labelOf: (item: T) => string | null | undefined, count: number, minSize = 1): Group<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const label = labelOf(item)?.trim();
    if (!label || PLACEHOLDERS.has(label.toLowerCase())) continue;
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return [...groups]
    .map(([label, members]) => ({ label, items: members }))
    .filter((group) => group.items.length >= minSize)
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, count);
}

// Scraped labels come in any case, like "COAT" and "Coat", so they are compared in title case.
export function titleCase(text: string): string {
  return text.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// This picks round price points that split the catalog, so each "Under $X" tile has something in it and none holds everything.
export function priceTiers(prices: number[], count = 3): number[] {
  const steps = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500];
  return steps.filter((step) => prices.some((price) => price < step) && prices.some((price) => price >= step)).slice(0, count);
}

// Highlights on one page draw from the same ranked list, so this hands each item out once and no item shows up in two sections.
export function picker<T>(keyOf: (item: T) => string) {
  const used = new Set<string>();
  return (ranked: T[], count: number): T[] => {
    const picked = ranked.filter((item) => !used.has(keyOf(item))).slice(0, count);
    picked.forEach((item) => used.add(keyOf(item)));
    return picked;
  };
}
