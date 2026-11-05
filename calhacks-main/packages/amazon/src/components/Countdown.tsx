"use client";

import { useEffect, useState } from "react";

// The clock restarts on every visit, so the deal never actually ends.
export default function Countdown({ seconds = 899 }: { seconds?: number }) {
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    const timer = setInterval(() => setLeft((value) => (value > 0 ? value - 1 : seconds)), 1000);
    return () => clearInterval(timer);
  }, [seconds]);

  const hours = String(Math.floor(left / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((left % 3600) / 60)).padStart(2, "0");
  const secs = String(left % 60).padStart(2, "0");
  return <span className="countdown">{`${hours}:${minutes}:${secs}`}</span>;
}
