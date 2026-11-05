"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Stepper } from "@/components/Stepper";
import { useToast } from "@/components/Toaster";
import { Badge, Card, cx, ErrorBox, Eyebrow, Money, Row, SandboxNote, Skeleton } from "@/components/ui";
import { api, saveCred } from "@/lib/client";

type Option = { ref: number; id: string; source: string; priced: boolean; fare: { amount: number; currency: string } | null; fareLabel: string; airline: string; flightNumber?: string; origin: string; destination: string; departure?: string; arrival?: string; stops: number; equipment?: string; note?: string };
type Source = { source: string; status: string; message: string; count: number };
type Search = { searchId: string | null; query: { origin: string; destination: string; date: string; adults: number; currency: string }; options: Option[]; sources: Source[]; priced: number };
type Quote = { baseAmount: number; baseCurrency: string; payCurrency: string; midRate: number; appliedRate: number; rateSource: string; converted: number; platformFee: number; fxSpreadCost: number; total: number };
type Trip = { id: string; state: string; quote: Quote; flight: Option };

const tomorrow = () => new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
const label = "block text-xs font-semibold text-mut mb-1.5";
const field = "field w-full rounded-xl px-3.5 py-2.5 text-sm";

export function PlanTrip() {
  const toast = useToast();
  const router = useRouter();
  const [form, setForm] = useState({ from: "LOS", to: "LHR", date: tomorrow(), adults: 1, currency: "USD" });
  const [search, setSearch] = useState<Search | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Option | null>(null);
  const [travellers, setTravellers] = useState([{ fullName: "", email: "", dateOfBirth: "", nationality: "" }]);
  const [payCurrency, setPayCurrency] = useState("USD");
  const [trip, setTrip] = useState<{ trip: Trip; token: string } | null>(null);
  const [conf, setConf] = useState({ by: "", text: "" });
  const [filter, setFilter] = useState<"all" | "priced">("all");


  async function doSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setChosen(null);
    setTrip(null);
    setLoading("search");
    try {
      const q = new URLSearchParams({ from: form.from, to: form.to, date: form.date, adults: String(form.adults), currency: form.currency, by: "web" });
      const r = await api<Search>(`/api/flights/search?${q}`);
      setSearch(r);
      setTravellers(Array.from({ length: form.adults }, () => ({ fullName: "", email: "", dateOfBirth: "", nationality: "" })));
      toast({ tone: "info", title: `${r.options.length} options, ${r.priced} with a live fare` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function quoteTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!search?.searchId || !chosen) return;
    setError(null);
    setLoading("quote");
    try {
      const r = await api<{ trip: Trip; tripToken: string }>("/api/trips", { body: { searchId: search.searchId, ref: chosen.ref, payCurrency, travellers: travellers.map((t) => ({ ...t, nationality: t.nationality || undefined })), requestedBy: travellers[0].fullName } });
      saveCred({ kind: "trip", id: r.trip.id, token: r.tripToken });
      setTrip({ trip: r.trip, token: r.tripToken });
      setConf({ by: travellers[0].fullName, text: "" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function pay() {
    if (!trip) return;
    setError(null);
    setLoading("pay");
    try {
      const r = await api<{ approveUrl?: string }>(`/api/trips/${trip.trip.id}/pay`, { body: { confirmation: { by: conf.by, text: conf.text, platform: "web" } }, headers: { "x-trip-token": trip.token }, idempotent: true });
      toast({ tone: "ok", title: "PayPal sandbox order created", body: "Redirecting you to PayPal to approve…" });
      if (r.approveUrl) window.location.href = r.approveUrl;
      else router.push(`/trips/${trip.trip.id}`);
    } catch (e) {
      setError((e as Error).message);
      setLoading(null);
    }
  }

  const shown = (search?.options ?? []).filter((o) => filter === "all" || o.priced);
  const q = trip?.trip.quote;

  return (
    <div className="space-y-8">
      <Stepper current={trip ? 2 : chosen ? 1 : search ? 1 : 0} compact skip={[4, 5, 6, 7, 8]} />

      <Card strong>
        <form onSubmit={doSearch} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_0.7fr_0.7fr_auto] lg:items-end">
          <div><label className={label} htmlFor="from">From (IATA)</label><input id="from" className={field} value={form.from} maxLength={3} required pattern="[A-Za-z]{3}" onChange={(e) => setForm({ ...form, from: e.target.value.toUpperCase() })} /></div>
          <div><label className={label} htmlFor="to">To (IATA)</label><input id="to" className={field} value={form.to} maxLength={3} required pattern="[A-Za-z]{3}" onChange={(e) => setForm({ ...form, to: e.target.value.toUpperCase() })} /></div>
          <div><label className={label} htmlFor="date">Date</label><input id="date" type="date" className={field} value={form.date} required onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
          <div><label className={label} htmlFor="adults">Passengers</label><input id="adults" type="number" min={1} max={9} className={field} value={form.adults} onChange={(e) => setForm({ ...form, adults: Math.max(1, Math.min(9, Number(e.target.value) || 1)) })} /></div>
          <div><label className={label} htmlFor="cur">Fare currency</label><input id="cur" className={field} value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></div>
          <button disabled={loading === "search"} className="btn-primary h-[42px] rounded-xl px-6 text-sm font-semibold disabled:opacity-60">{loading === "search" ? "Searching…" : "Search flights"}</button>
        </form>
      </Card>

      {error && <ErrorBox>{error}</ErrorBox>}

      {loading === "search" && (
        <div className="space-y-3" aria-busy>
          <p className="text-sm text-mut">Querying OpenFlights, OpenSky and Sky-Scrapper. Open data can take up to 30s on a cold start.</p>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      )}

      {search && !loading && !trip && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow>Sources</Eyebrow>
            {search.sources.map((s) => (
              <Badge key={s.source} tone={s.status === "ok" ? "ok" : s.status === "error" ? "bad" : "mut"}>
                <span title={s.message}>{s.source}: {s.status === "ok" ? `${s.count}` : s.status}</span>
              </Badge>
            ))}
            <div className="ml-auto flex gap-1 rounded-full border border-line p-1 text-xs">
              {(["all", "priced"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={cx("rounded-full px-3 py-1", filter === f && "bg-[var(--line)] font-semibold")}>{f === "all" ? `All (${search.options.length})` : `Bookable (${search.priced})`}</button>
              ))}
            </div>
          </div>
          {search.sources.filter((s) => s.status === "error").map((s) => <p key={s.source} className="text-xs c-bad">{s.source}: {s.message}</p>)}
          {!search.priced && (
            <div className="rounded-2xl bg-warn p-4 text-sm c-warn">No live fare came back, so nothing here can be booked. Open-data results are real routes or flights seen in the last 48h, shown as <b>fare unavailable</b>. We never invent a price.</div>
          )}
          {!shown.length && <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-mut">No options for this filter.</div>}
          <ul className="grid gap-3 md:grid-cols-2">
            {shown.slice(0, 40).map((o) => (
              <li key={o.id}>
                <button onClick={() => o.priced && setChosen(o)} disabled={!o.priced} aria-pressed={chosen?.id === o.id} className={cx("glass w-full rounded-2xl p-4 text-left transition", o.priced ? "hover:-translate-y-0.5" : "cursor-not-allowed opacity-75", chosen?.id === o.id && "gradient-ring bg-acc")}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{o.airline}</span>{o.flightNumber && <span className="font-mono text-xs text-mut">{o.flightNumber}</span>}<Badge tone={o.source === "sky-scrapper" ? "acc" : "mut"}>{o.source}</Badge></div>
                      <div className="mt-1 text-sm text-mut">{o.origin} → {o.destination} · {o.stops ? `${o.stops} stop${o.stops > 1 ? "s" : ""}` : "nonstop"}{o.departure && ` · ${new Date(o.departure).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`}{o.equipment && ` · ${o.equipment}`}</div>
                    </div>
                    <div className="text-right">
                      {o.priced && o.fare ? <Money amount={o.fare.amount} currency={o.fare.currency} className="font-display text-xl font-semibold" /> : <span className="text-sm font-semibold text-mut">fare unavailable</span>}
                      <div className="text-[11px] text-mut">option #{o.ref}</div>
                    </div>
                  </div>
                  {o.note && <p className="mt-2 text-[11px] text-mut">{o.note}</p>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AnimatePresence>
        {chosen && !trip && (
          <motion.form initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} onSubmit={quoteTrip}>
            <Card strong className="space-y-5">
              <div>
                <Eyebrow>Step 2 · You chose option #{chosen.ref}</Eyebrow>
                <h2 className="mt-1 font-display text-2xl font-semibold">{chosen.airline} {chosen.origin} → {chosen.destination}</h2>
                <p className="text-sm text-mut">Would you like me to book this for you and pay with your PayPal account? First, who is flying?</p>
              </div>
              {travellers.map((t, i) => (
                <fieldset key={i} className="grid gap-3 sm:grid-cols-4">
                  <legend className="mb-2 text-xs font-semibold text-mut">Traveller {i + 1}</legend>
                  <input aria-label="Full name" placeholder="Full name as on passport" required className={field} value={t.fullName} onChange={(e) => setTravellers(travellers.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)))} />
                  <input aria-label="Email" type="email" placeholder="Email" required className={field} value={t.email} onChange={(e) => setTravellers(travellers.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                  <input aria-label="Date of birth" type="date" className={field} value={t.dateOfBirth} onChange={(e) => setTravellers(travellers.map((x, j) => (j === i ? { ...x, dateOfBirth: e.target.value } : x)))} />
                  <input aria-label="Nationality" placeholder="Nationality" className={field} value={t.nationality} onChange={(e) => setTravellers(travellers.map((x, j) => (j === i ? { ...x, nationality: e.target.value } : x)))} />
                </fieldset>
              ))}
              <div className="flex flex-wrap items-end gap-3">
                <div><label className={label} htmlFor="pc">You pay in</label><input id="pc" className={`${field} w-28`} maxLength={3} value={payCurrency} onChange={(e) => setPayCurrency(e.target.value.toUpperCase())} /></div>
                <button disabled={loading === "quote"} className="btn-primary rounded-xl px-6 py-2.5 text-sm font-semibold disabled:opacity-60">{loading === "quote" ? "Quoting…" : "See price breakdown"}</button>
                <button type="button" onClick={() => setChosen(null)} className="text-sm text-mut underline">Choose another</button>
              </div>
              <p className="text-xs text-mut">Traveller details are stored for this trip only and masked on public pages.</p>
            </Card>
          </motion.form>
        )}
      </AnimatePresence>

      {trip && q && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
          <Card strong>
            <Eyebrow>Price breakdown · {trip.trip.id}</Eyebrow>
            <h2 className="mt-1 font-display text-2xl font-semibold">{trip.trip.flight.airline} {trip.trip.flight.origin} → {trip.trip.flight.destination}</h2>
            <div className="mt-4">
              <Row k="Fare (provider quote)" v={<Money amount={q.baseAmount} currency={q.baseCurrency} />} />
              <Row k={`Converted at ${q.midRate.toFixed(4)} (${q.rateSource})`} v={<Money amount={q.converted} currency={q.payCurrency} />} />
              <Row k="FX spread (1.2%)" v={<Money amount={q.fxSpreadCost} currency={q.payCurrency} />} />
              <Row k="Platform fee (2.5%)" v={<Money amount={q.platformFee} currency={q.payCurrency} />} />
              <Row strong k="You pay" v={<Money amount={q.total} currency={q.payCurrency} className="font-display text-2xl" />} />
            </div>
            <p className="mt-4 text-xs text-mut">Honest limit: payment is captured in PayPal sandbox but no airline ticket is issued; this project has no ticketing API.</p>
          </Card>
          <Card strong className="gradient-ring">
            <Eyebrow>Step 3 · Your explicit yes</Eyebrow>
            <h3 className="mt-1 font-display text-xl font-semibold">Would you like me to book this and pay with your PayPal account?</h3>
            <p className="mt-1 text-sm text-mut">Type your answer in your own words, e.g. “yes, book it”. It is stored verbatim in the audit log. No PayPal order exists until you confirm.</p>
            <div className="mt-4 space-y-3">
              <div><label className={label} htmlFor="cb">Your name</label><input id="cb" className={field} value={conf.by} onChange={(e) => setConf({ ...conf, by: e.target.value })} /></div>
              <div><label className={label} htmlFor="ct">Your answer</label><input id="ct" className={field} placeholder="yes, book it" value={conf.text} onChange={(e) => setConf({ ...conf, text: e.target.value })} /></div>
              <button onClick={pay} disabled={loading === "pay" || !conf.by.trim() || !/\b(yes|confirm|book it|go ahead|proceed|pay)\b/i.test(conf.text)} className="btn-paypal flex w-full items-center justify-center gap-2 rounded-full px-6 py-3 text-base font-bold disabled:opacity-50">
                {loading === "pay" ? "Creating order…" : <>Pay <Money amount={q.total} currency={q.payCurrency} /> with PayPal (sandbox)</>}
              </button>
              <SandboxNote />
            </div>
          </Card>
        </motion.div>
      )}
    </div>
  );
}
