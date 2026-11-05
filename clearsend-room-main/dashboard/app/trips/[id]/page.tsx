import { notFound } from "next/navigation";
import { Suspense } from "react";
import { RoomFeed } from "@/components/RoomFeed";
import { Stepper } from "@/components/Stepper";
import { Card, ErrorBox, Eyebrow, Money, PageHeader, Row, StateBadge, fmtTime } from "@/components/ui";
import { safe } from "@/lib/safe";
import { getTrip, maskTraveller } from "@/lib/trips";
import { tripStep } from "@/lib/workflow";
import { TripActions } from "./TripActions";

export const dynamic = "force-dynamic";

export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: t, error } = await safe(() => getTrip(id));
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!t) notFound();
  const q = t.quote;
  return (
    <>
      <PageHeader eyebrow={`Trip · ${t.id}`} title={<>{t.flight.origin} → {t.flight.destination}</>} actions={<StateBadge state={t.state} />}>
        {t.flight.airline}{t.flight.flightNumber ? ` ${t.flight.flightNumber}` : ""} · {t.searchedFor.date} · {t.searchedFor.adults} traveller{t.searchedFor.adults > 1 ? "s" : ""}
      </PageHeader>
      <Stepper current={tripStep(t.state)} compact skip={[4, 5, 6, 7, 8]} />
      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-6">
          <Card strong>
            <Eyebrow>Payment</Eyebrow>
            <div className="mt-3">
              <Row k="Fare (provider)" v={<Money amount={q.baseAmount} currency={q.baseCurrency} />} />
              <Row k={`Rate ${q.midRate.toFixed(4)} · ${q.rateSource}`} v={<Money amount={q.converted} currency={q.payCurrency} />} />
              <Row k="FX spread 1.2%" v={<Money amount={q.fxSpreadCost} currency={q.payCurrency} />} />
              <Row k="Platform fee 2.5%" v={<Money amount={q.platformFee} currency={q.payCurrency} />} />
              <Row strong k="Total" v={<Money amount={q.total} currency={q.payCurrency} className="font-display text-2xl" />} />
              <Row k="PayPal sandbox order" v={t.order ? <span className="font-mono text-xs">{t.order.id} · {t.order.status}</span> : "not created"} />
              {t.order?.captureId && <Row k="Capture" v={<span className="font-mono text-xs">{t.order.captureId}</span>} />}
            </div>
            <Suspense fallback={null}><TripActions id={t.id} state={t.state} total={q.total} currency={q.payCurrency} /></Suspense>
          </Card>
          <Card>
            <Eyebrow>Travellers (masked)</Eyebrow>
            <ul className="mt-2 space-y-1 text-sm">{t.travellers.map(maskTraveller).map((p, i) => <li key={i}>{p.fullName} · <span className="text-mut">{p.email}</span></li>)}</ul>
            <p className="mt-3 text-xs text-mut">{t.ticketing}</p>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <Eyebrow>Timeline</Eyebrow>
            <ol className="mt-3 space-y-3 border-l border-line pl-4">
              {t.timeline.map((s) => (
                <li key={s.at + s.state}><div className="flex items-center gap-2"><StateBadge state={s.state} /><span className="text-xs text-mut">{fmtTime(s.at)} · {s.by}</span></div><p className="mt-1 text-sm">{s.note}</p></li>
              ))}
            </ol>
          </Card>
          <Card><Eyebrow>Room activity for this trip</Eyebrow><div className="mt-3"><RoomFeed subject={t.id} limit={50} /></div></Card>
        </div>
      </div>
    </>
  );
}
