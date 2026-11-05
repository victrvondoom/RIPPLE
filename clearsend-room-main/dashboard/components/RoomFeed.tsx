"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Badge, cx, Skeleton } from "./ui";

type Item = { id: string; at: string; kind: string; subject: string; actor: string; summary: string };

const KIND: Record<string, { tone: "ok" | "warn" | "bad" | "acc" | "mut"; label: string }> = {
  paypal: { tone: "warn", label: "PayPal" },
  decision: { tone: "ok", label: "AI decision" },
  confirmation: { tone: "acc", label: "Human yes" },
  escrow: { tone: "acc", label: "Escrow" },
  trip: { tone: "acc", label: "Trip" },
  "flight-search": { tone: "mut", label: "Search" },
  status: { tone: "mut", label: "Agent status" },
  system: { tone: "mut", label: "System" },
};

function isAgent(actor: string) {
  return /^(agent|openrouter:|nvidia:|web$)/i.test(actor);
}

function href(subject: string) {
  if (subject.startsWith("trip_")) return `/trips/${subject}`;
  return null;
}

/** Transcript-style mirror of what the agent and people did. Polls the real activity log. */
export function RoomFeed({ limit = 30, kind, subject, poll = 10_000, tall }: { limit?: number; kind?: string; subject?: string; poll?: number; tall?: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ limit: String(limit), ...(kind ? { kind } : {}), ...(subject ? { subject } : {}) });
      const r = await api<{ items: Item[] }>(`/api/activity?${q}`);
      setItems(r.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [limit, kind, subject]);
  useEffect(() => {
    load();
    const t = setInterval(load, poll);
    return () => clearInterval(t);
  }, [load, poll]);

  if (error && !items) return <div role="alert" className="rounded-2xl bg-bad p-4 text-sm c-bad">Activity unavailable: {error}</div>;
  if (!items)
    return (
      <div className="space-y-3" aria-busy>
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}
      </div>
    );
  if (!items.length)
    return (
      <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-mut">
        The room is quiet. Nothing is seeded, so this stays empty until someone talks to <code>@clearsend</code> in chat or uses <b>Plan a trip</b> / <b>New escrow</b> here.
      </div>
    );
  const ordered = [...items].reverse();
  return (
    <ol className={cx("space-y-3 overflow-y-auto pr-1", tall ? "max-h-[70vh]" : "max-h-[460px]")} aria-label="Room activity">
      <AnimatePresence initial={false}>
        {ordered.map((a) => {
          const agent = isAgent(a.actor);
          const k = KIND[a.kind] ?? { tone: "mut" as const, label: a.kind };
          const link = href(a.subject);
          return (
            <motion.li key={a.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={cx("flex gap-3", !agent && "flex-row-reverse")}>
              <div className={cx("grid size-8 shrink-0 place-items-center rounded-full text-xs font-bold", agent ? "btn-primary" : "bg-[var(--line)]")} aria-hidden>
                {agent ? "CS" : a.actor.slice(0, 2).toUpperCase()}
              </div>
              <div className={cx("max-w-[85%] rounded-2xl px-4 py-2.5", agent ? "glass rounded-tl-sm" : "bg-acc rounded-tr-sm")}>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-mut">
                  <b className="text-[var(--fg)]">{agent ? "ClearSend agent" : a.actor}</b>
                  {agent && a.actor !== "agent" && <span>{a.actor}</span>}
                  <Badge tone={k.tone}>{k.label}</Badge>
                  <time dateTime={a.at}>{new Date(a.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" })} WAT</time>
                </div>
                <div className="mt-1 text-sm">{a.summary}</div>
                <div className="mt-1 font-mono text-[10px] text-mut">{link ? <a className="underline" href={link}>{a.subject}</a> : a.subject}</div>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
