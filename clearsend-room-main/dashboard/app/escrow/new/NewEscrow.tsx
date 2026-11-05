"use client";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Card, ErrorBox, Eyebrow, Money, Row, SandboxNote, Skeleton } from "@/components/ui";
import { api, saveCred } from "@/lib/client";

type Quote = { midRate: number; rateSource: string; converted: number; fxSpreadCost: number; platformFee: number; total: number; payCurrency: string };
const label = "mb-1.5 block text-xs font-semibold text-mut";
const field = "field w-full rounded-xl px-3.5 py-2.5 text-sm";

export function NewEscrow() {
  const toast = useToast();
  const [f, setF] = useState({ title: "", spec: "", criteria: "", amount: "50", currency: "USD", payCurrency: "USD", payerName: "", payerEmail: "", recipientName: "", recipientEmail: "", recipientCountry: "", verifierName: "" });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string> | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    const amt = Number(f.amount);
    if (!(amt > 0) || !/^[A-Z]{3}$/.test(f.currency) || !/^[A-Z]{3}$/.test(f.payCurrency)) return;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ quote: Quote }>(`/api/quote?amount=${amt}&from=${f.currency}&to=${f.payCurrency}`);
        setQuote(r.quote);
        setQErr(null);
      } catch (e) {
        setQErr((e as Error).message);
        setQuote(null);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [f.amount, f.currency, f.payCurrency]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ escrow: { id: string }; links: Record<string, string> }>("/api/escrow", { body: { ...f, amount: Number(f.amount), criteria: f.criteria.split("\n").map((s) => s.trim()).filter(Boolean), platform: "web" } });
      const tok = new URL(r.links.payer).searchParams.get("token");
      if (tok) saveCred({ kind: "escrow", id: r.escrow.id, role: "payer", token: tok });
      setLinks(r.links);
      toast({ tone: "ok", title: "Escrow created", body: "Share each link with its person only." });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (links)
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <Card strong className="gradient-ring max-w-3xl">
          <Eyebrow>Escrow created · send each person their own link</Eyebrow>
          <ul className="mt-4 space-y-3">
            {(["payer", "recipient", "verifier"] as const).map((r) => (
              <li key={r} className="glass rounded-2xl p-4">
                <div className="flex items-center justify-between gap-3">
                  <b className="capitalize">{r}</b>
                  <div className="flex gap-2">
                    <button className="rounded-full border border-line px-3 py-1 text-xs" onClick={() => { navigator.clipboard.writeText(links[r]); toast({ tone: "info", title: `${r} link copied` }); }}>Copy</button>
                    {r === "payer" && <a className="btn-primary rounded-full px-3 py-1 text-xs font-semibold" href={links[r]}>Open (you)</a>}
                  </div>
                </div>
                <p className="mt-1 text-xs text-mut">{r === "payer" ? "Funds the escrow with PayPal, can request a refund." : r === "recipient" ? "Submits the deliverable, receives the PayPal payout." : "Reads the AI verdict and approves the release."}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-mut">Links are HMAC-signed. Anyone with a link acts as that role, so send them privately (DM in the room).</p>
        </Card>
      </motion.div>
    );

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1.3fr_0.9fr]">
      <div className="space-y-6">
        <Card strong className="space-y-4">
          <Eyebrow>What must be delivered</Eyebrow>
          <div><label className={label} htmlFor="t">Title</label><input id="t" required minLength={3} className={field} placeholder="3-slide pitch deck" value={f.title} onChange={set("title")} /></div>
          <div><label className={label} htmlFor="s">Specification</label><textarea id="s" required minLength={10} rows={4} className={field} placeholder="Describe the work precisely. The AI verifier only judges against this." value={f.spec} onChange={set("spec")} /></div>
          <div><label className={label} htmlFor="c">Acceptance criteria (one per line)</label><textarea id="c" rows={3} className={field} placeholder={"Exactly 3 slides\nIncludes market size with a source"} value={f.criteria} onChange={set("criteria")} /></div>
        </Card>
        <Card strong className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Eyebrow>Who is involved</Eyebrow></div>
          <div><label className={label} htmlFor="pn">Payer name (you)</label><input id="pn" required className={field} value={f.payerName} onChange={set("payerName")} /></div>
          <div><label className={label} htmlFor="pe">Payer email (optional)</label><input id="pe" type="email" className={field} value={f.payerEmail} onChange={set("payerEmail")} /></div>
          <div><label className={label} htmlFor="rn">Recipient name</label><input id="rn" required className={field} value={f.recipientName} onChange={set("recipientName")} /></div>
          <div><label className={label} htmlFor="re">Recipient PayPal email (sandbox)</label><input id="re" type="email" required className={field} value={f.recipientEmail} onChange={set("recipientEmail")} /></div>
          <div><label className={label} htmlFor="rc">Recipient country</label><input id="rc" required className={field} placeholder="Ghana" value={f.recipientCountry} onChange={set("recipientCountry")} /></div>
          <div><label className={label} htmlFor="vn">Verifier name</label><input id="vn" required className={field} value={f.verifierName} onChange={set("verifierName")} /></div>
        </Card>
      </div>
      <div className="space-y-6 lg:sticky lg:top-24 lg:self-start">
        <Card strong className="gradient-ring">
          <Eyebrow>Amount & live FX</Eyebrow>
          <div className="mt-3 grid grid-cols-[1fr_auto] gap-3">
            <div><label className={label} htmlFor="a">Recipient gets</label><input id="a" type="number" min="1" max="10000" step="0.01" required className={field} value={f.amount} onChange={set("amount")} /></div>
            <div><label className={label} htmlFor="cu">Currency</label><input id="cu" maxLength={3} className={`${field} w-24`} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></div>
          </div>
          <div className="mt-3"><label className={label} htmlFor="pcu">Payer pays in</label><input id="pcu" maxLength={3} className={`${field} w-24`} value={f.payCurrency} onChange={(e) => setF({ ...f, payCurrency: e.target.value.toUpperCase() })} /></div>
          <div className="mt-4">
            {qErr ? <ErrorBox>{qErr}</ErrorBox> : !quote ? <Skeleton className="h-36" /> : (
              <>
                <Row k={`Mid rate ${quote.midRate.toFixed(4)} · ${quote.rateSource}`} v={<Money amount={quote.converted} currency={quote.payCurrency} />} />
                <Row k="FX spread 1.2%" v={<Money amount={quote.fxSpreadCost} currency={quote.payCurrency} />} />
                <Row k="Platform fee 2.5%" v={<Money amount={quote.platformFee} currency={quote.payCurrency} />} />
                <Row strong k="Payer pays" v={<Money amount={quote.total} currency={quote.payCurrency} className="font-display text-2xl" />} />
              </>
            )}
          </div>
          <p className="mt-3 text-xs text-mut">PayPal sandbox payouts support USD, EUR, GBP and others, not NGN/GHS/KES; pay out in a supported currency.</p>
          {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
          <button disabled={busy} className="btn-primary mt-4 w-full rounded-full py-3 font-semibold disabled:opacity-60">{busy ? "Creating…" : "Create escrow & get links"}</button>
          <div className="mt-3"><SandboxNote /></div>
        </Card>
      </div>
    </form>
  );
}
