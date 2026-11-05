export default function Price({ amount, size = "md" }: { amount: number; size?: "sm" | "md" | "lg" }) {
  const [whole, fraction] = amount.toFixed(2).split(".");
  return (
    <span className={`price price-${size}`} aria-label={`$${amount.toFixed(2)}`}>
      <span className="price-symbol">$</span>
      <span className="price-whole">{whole}</span>
      <span className="price-fraction">{fraction}</span>
    </span>
  );
}
