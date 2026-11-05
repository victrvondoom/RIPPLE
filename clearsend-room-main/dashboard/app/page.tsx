import { RoomFeed } from "@/components/RoomFeed";
import { Stepper } from "@/components/Stepper";
import { Badge, ButtonLink, Card, ErrorBox, Eyebrow, Money, StateBadge } from "@/components/ui";
import { listActivity } from "@/lib/activity";
import { listEscrows } from "@/lib/escrow";
import { safe } from "@/lib/safe";
import { listTrips } from "@/lib/trips";
import { escrowStep, tripStep, WORKFLOW } from "@/lib/workflow";
import Link from "next/link";

export const dynamic = "force-dynamic";

const PARTIES = [
  { role: "Payer", icon: "💳", text: "Asks for a flight or opens an escrow, types the yes that creates the PayPal order, approves it in PayPal." },
  { role: "Recipient", icon: "📦", text: "Delivers the work in the thread. Gets paid by PayPal Payout to any supported country. Can never approve their own release." },
  { role: "Verifier", icon: "🛡️", text: "Reads the AI verdict criterion by criterion and types “approve release”, or asks for a refund." },
  { role: "ClearSend agent", icon: "✦", text: "OpenCode on a free model, joined to the chat by Switch. Searches, quotes, creates orders, verifies. Never moves money on its own." },
];

export default async function Home() {
  const [esc, trips, searches] = await Promise.all([safe(listEscrows), safe(listTrips), safe(() => listActivity(50, undefined, "flight-search"))]);
  const err = esc.error || trips.error;
  const counts = WORKFLOW.map(() => 0);
  counts[0] = searches.data?.length ?? 0;
  for (const t of trips.data ?? []) if (t.state !== "paid") counts[tripStep(t.state)]++;
  for (const e of esc.data ?? []) {
    const s = escrowStep(e.state);
    if (s < WORKFLOW.length) counts[s]++;
    else counts[8]++;
  }
  const waiting = (esc.data ?? []).filter((e) => ["created", "verified"].includes(e.state)).length + (trips.data ?? []).filter((t) => t.state !== "paid").length;
  const latest = [...(esc.data ?? []).map((e) => ({ kind: "escrow" as const, id: e.id, title: e.title, state: e.state, amount: e.quote.total, cur: e.payCurrency, at: e.createdAt, href: `/escrow/${e.id}` })), ...(trips.data ?? []).map((t) => ({ kind: "trip" as const, id: t.id, title: `${t.flight.airline} ${t.flight.origin} → ${t.flight.destination}`, state: t.state, amount: t.quote.total, cur: t.quote.payCurrency, at: t.createdAt, href: `/trips/${t.id}` }))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);

  return (
    <div className="space-y-14">
      <section className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="animate-rise">
          <Badge tone="acc">Switch room · OpenCode · free model · PayPal sandbox</Badge>
          <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Your AI agent, now a <span className="gradient-text">teammate</span> that pays people.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-mut">
            A payer, a recipient and a verifier share one chat channel with the ClearSend agent. Together they book flights and settle cross-border escrow through PayPal, and every step needs the right human to say yes.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <ButtonLink href="/plan">Plan a trip</ButtonLink>
            <ButtonLink href="/escrow/new" variant="ghost">Open an escrow</ButtonLink>
            <ButtonLink href="/switch" variant="ghost">Connect your chat</ButtonLink>
          </div>
        </div>
        <Card strong className="gradient-ring animate-rise">
          <div className="flex items-center justify-between">
            <Eyebrow># clearsend-room · live mirror</Eyebrow>
            <span className="flex items-center gap-1.5 text-xs text-mut"><span className="size-2 animate-pulse-ring rounded-full bg-[var(--ok)]" />polling every 10s</span>
          </div>
          <div className="mt-4">
            <RoomFeed limit={12} />
          </div>
        </Card>
      </section>

      {err && <ErrorBox>Storage unavailable: {err}</ErrorBox>}

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <Eyebrow>The workflow</Eyebrow>
            <h2 className="mt-1 font-display text-2xl font-semibold sm:text-3xl">Nine steps, three humans, one agent</h2>
          </div>
          <p className="text-sm text-mut">Numbers show live records waiting at each step.</p>
        </div>
        <Stepper counts={counts} />
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card><Eyebrow>Escrows</Eyebrow><div className="mt-2 font-display text-4xl font-semibold">{esc.data?.length ?? "–"}</div><Link className="mt-1 inline-block text-sm text-mut underline" href="/escrow">View all</Link></Card>
        <Card><Eyebrow>Trips</Eyebrow><div className="mt-2 font-display text-4xl font-semibold">{trips.data?.length ?? "–"}</div><Link className="mt-1 inline-block text-sm text-mut underline" href="/trips">View all</Link></Card>
        <Card><Eyebrow>Waiting on a human</Eyebrow><div className="mt-2 font-display text-4xl font-semibold">{err ? "–" : waiting}</div><span className="text-sm text-mut">unpaid trips, unfunded or verified escrows</span></Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <Eyebrow>Who is in the room</Eyebrow>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {PARTIES.map((p) => (
              <Card key={p.role} className="p-5">
                <div className="text-2xl" aria-hidden>{p.icon}</div>
                <div className="mt-2 font-semibold">{p.role}</div>
                <p className="mt-1 text-sm text-mut">{p.text}</p>
              </Card>
            ))}
          </div>
        </div>
        <div>
          <Eyebrow>Latest records</Eyebrow>
          <Card className="mt-3 p-2">
            {latest.length ? (
              <ul className="divide-y divide-[var(--line)]">
                {latest.map((r) => (
                  <li key={r.id}>
                    <Link href={r.kind === "escrow" ? "/escrow" : r.href} className="flex items-center gap-3 rounded-2xl p-3 transition hover:bg-[var(--line)]">
                      <span className="text-lg" aria-hidden>{r.kind === "escrow" ? "🛡️" : "✈️"}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">{r.title}</div>
                        <div className="font-mono text-[11px] text-mut">{r.id}</div>
                      </div>
                      <Money amount={r.amount} currency={r.cur} className="text-sm font-semibold" />
                      <StateBadge state={r.state} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-6 text-center text-sm text-mut">No trips or escrows yet. Nothing is seeded.</div>
            )}
          </Card>
        </div>
      </section>
    </div>
  );
}
