"use client";

import { useEffect, useState } from "react";

const MINUTE = 60 * 1000;

// Same-day orders close at midnight in the shopper's time zone. The time left depends on their clock, so the whole note appears after the page loads.
function untilMidnight(): string {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const minutes = Math.ceil((midnight.getTime() - now.getTime()) / MINUTE);
  return `${Math.floor(minutes / 60)} hrs ${minutes % 60} mins`;
}

export default function Cutoff() {
  const [left, setLeft] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setLeft(untilMidnight());
    tick();
    const timer = setInterval(tick, MINUTE);
    return () => clearInterval(timer);
  }, []);

  return (
    left && (
      <>
        . Order within <span className="green">{left}</span>
      </>
    )
  );
}
