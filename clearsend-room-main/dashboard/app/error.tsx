"use client";
import { Card } from "@/components/ui";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card className="mx-auto max-w-xl text-center">
      <div className="font-display text-2xl font-semibold">Something failed</div>
      <p className="mt-2 text-sm text-mut">{error.message || "Unexpected error."} Nothing was charged: money only moves after an explicit confirmation.</p>
      <button onClick={reset} className="btn-primary mt-5 rounded-full px-5 py-2 text-sm font-semibold">Try again</button>
    </Card>
  );
}
