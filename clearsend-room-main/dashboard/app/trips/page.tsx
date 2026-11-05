import Link from "next/link";
import { ButtonLink, Card, Empty, ErrorBox, Money, PageHeader, StateBadge, fmtTime } from "@/components/ui";
import { safe } from "@/lib/safe";
import { listTrips } from "@/lib/trips";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trips" };

export default async function Trips() {
  const { data, error } = await safe(listTrips);
  return (
    <>
      <PageHeader eyebrow="Flights" title="Trips" actions={<ButtonLink href="/plan">Plan a trip</ButtonLink>}>
        Every quote, confirmation and PayPal sandbox payment for flights booked in the room or here. Traveller details stay private.
      </PageHeader>
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && !data.length && <Empty title="No trips yet">Ask <code>@clearsend find me a flight LOS to LHR on a date</code> in the room, or use Plan a trip. Only priced options can become trips.</Empty>}
      <div className="grid gap-4 md:grid-cols-2">
        {data?.map((t) => (
          <Link key={t.id} href={`/trips/${t.id}`} className="block transition hover:-translate-y-0.5">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-display text-xl font-semibold">{t.flight.origin} → {t.flight.destination}</div>
                  <div className="text-sm text-mut">{t.flight.airline} · {t.searchedFor.date} · {t.searchedFor.adults} adult{t.searchedFor.adults > 1 ? "s" : ""}</div>
                </div>
                <StateBadge state={t.state} />
              </div>
              <div className="mt-4 flex items-end justify-between">
                <Money amount={t.quote.total} currency={t.quote.payCurrency} className="font-display text-2xl font-semibold" />
                <span className="text-xs text-mut">{fmtTime(t.createdAt)}</span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
