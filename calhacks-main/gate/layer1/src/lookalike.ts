// A lookalike wallet keeps the characters people actually check (the first and last 4 hex) but differs in between.

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function isLookalike(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return false;
  return x.slice(2, 6) === y.slice(2, 6) && x.slice(-4) === y.slice(-4);
}
