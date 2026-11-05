"use client";
import { useState } from "react";
import { RoomFeed } from "@/components/RoomFeed";
import { Card, cx } from "@/components/ui";

const KINDS = [["", "All"], ["confirmation", "Human yes"], ["decision", "AI decisions"], ["paypal", "PayPal"], ["escrow", "Escrow"], ["trip", "Trips"], ["flight-search", "Searches"], ["status", "Agent status"]] as const;

export function ActivityClient() {
  const [kind, setKind] = useState("");
  return (
    <Card strong>
      <div role="tablist" aria-label="Filter" className="mb-5 flex flex-wrap gap-1">
        {KINDS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={cx("rounded-full px-3 py-1.5 text-sm", kind === k ? "btn-primary font-semibold" : "text-mut hover:bg-[var(--line)]")}>{l}</button>
        ))}
      </div>
      <RoomFeed key={kind} kind={kind || undefined} limit={200} tall />
    </Card>
  );
}
