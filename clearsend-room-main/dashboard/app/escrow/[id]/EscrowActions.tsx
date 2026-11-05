"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Card, ErrorBox, Eyebrow, Money, SandboxNote } from "@/components/ui";
import { api, saveCred } from "@/lib/client";

type P = { id: string; role: string; token: string; state: string; total: number; payCurrency: string; amount: number; currency: string; approveUrl: string | null; hasOrder: boolean; recipient: string };
const field = "field w-full rounded-xl px-3.5 py-2.5 text-sm";

export function EscrowActions(p: P) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conf, setConf] = useState({ by: "", text: "" });
  const [deliverable, setDeliverable] = useState("");

  useEffect(() => {
    if (p.role === "payer") saveCred({ kind: "escrow", id: p.id, role: "payer", token: p.token });
  }, [p.id, p.role, p.token]);

  async function act(action: string, body: unknown, ok: string) {
    setBusy(action);
    setError(null);
    try {
      const r = await api<{ approveUrl?: string; decision?: { met: boolean } }>(`/api/escrow/${p.id}/${action}`, { body: body ?? {}, headers: { "x-escrow-role": p.role, "x-escrow-token": p.token }, idempotent: true });
      toast({ tone: "ok", title: ok });
      if (action === "fund" && r.approveUrl) {
        window.location.href = r.approveUrl;
        return;
      }
      if (r.decision) toast({ tone: r.decision.met ? "ok" : "bad", title: r.decision.met ? "AI verdict: VERIFIED" : "AI verdict: REJECTED" });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const confirmInputs = (placeholder: string) => (
    <div className="grid gap-2 sm:grid-cols-2">
      <input aria-label="Your name" className={field} placeholder="Your name" value={conf.by} onChange={(e) => setConf({ ...conf, by: e.target.value })} />
      <input aria-label="Your words" className={field} placeholder={placeholder} value={conf.text} onChange={(e) => setConf({ ...conf, text: e.target.value })} />
    </div>
  );
  const c = { ...conf, platform: "web" };
  const ready = conf.by.trim() && conf.text.trim();

  let body: React.ReactNode = <p className="text-sm text-mut">Nothing for you to do right now. This page refreshes as the room moves.</p>;
  const s = p.state;
  if (p.role === "payer" && s === "created" && !p.hasOrder)
    body = (
      <>
        <p className="text-sm">Type “confirm fund” to create the PayPal sandbox order for <b><Money amount={p.total} currency={p.payCurrency} /></b>.</p>
        {confirmInputs("confirm fund")}
        <button disabled={!!busy || !ready} onClick={() => act("fund", { confirmation: c }, "PayPal sandbox order created")} className="btn-paypal w-full rounded-full py-3 font-bold disabled:opacity-50">Pay <Money amount={p.total} currency={p.payCurrency} /> with PayPal (sandbox)</button>
      </>
    );
  else if (p.role === "payer" && s === "created")
    body = (
      <>
        {p.approveUrl && <a href={p.approveUrl} className="btn-paypal block w-full rounded-full py-3 text-center font-bold">Approve in PayPal (sandbox)</a>}
        <button disabled={!!busy} onClick={() => confirm(`Capture ${p.total} ${p.payCurrency} into escrow?`) && act("capture", {}, "Captured into escrow")} className="glass w-full rounded-full py-3 text-sm font-semibold">{busy === "capture" ? "Capturing…" : "I approved it, capture into escrow"}</button>
      </>
    );
  else if (p.role === "recipient" && (s === "funded" || s === "rejected"))
    body = (
      <>
        <p className="text-sm">{s === "rejected" ? "Fix the ✕ items and submit again." : "The money is held. Submit your deliverable (text and links)."}</p>
        <textarea rows={6} className={field} aria-label="Deliverable" placeholder="Paste your deliverable or links to it" value={deliverable} onChange={(e) => setDeliverable(e.target.value)} />
        <button disabled={!!busy || deliverable.trim().length < 5} onClick={() => act("submit", { deliverable }, "Deliverable submitted")} className="btn-primary w-full rounded-full py-3 font-semibold disabled:opacity-50">{busy === "submit" ? "Submitting…" : "Submit deliverable"}</button>
      </>
    );
  else if (p.role === "verifier" && s === "submitted")
    body = (
      <>
        <p className="text-sm">Run the AI verifier. It checks every criterion against the spec, treats the deliverable as untrusted, and fails closed.</p>
        <button disabled={!!busy} onClick={() => act("verify", {}, "Verification finished")} className="btn-primary w-full rounded-full py-3 font-semibold disabled:opacity-60">{busy === "verify" ? "Free model is reading… (up to a minute)" : "Run AI verifier"}</button>
      </>
    );
  else if (p.role === "verifier" && s === "verified")
    body = (
      <>
        <p className="text-sm">Type “approve release” to pay <b><Money amount={p.amount} currency={p.currency} /></b> to {p.recipient} by PayPal Payout (sandbox).</p>
        {confirmInputs("approve release")}
        <button disabled={!!busy || !ready} onClick={() => confirm(`Release ${p.amount} ${p.currency} to ${p.recipient}? This sends a PayPal sandbox payout.`) && act("release", { confirmation: c }, "Released: payout sent")} className="btn-primary w-full rounded-full py-3 font-semibold disabled:opacity-50">{busy === "release" ? "Releasing…" : "Approve release"}</button>
      </>
    );
  const canRefund = (p.role === "payer" || p.role === "verifier") && ["funded", "submitted", "rejected"].includes(s);

  return (
    <Card strong className="gradient-ring space-y-3">
      <Eyebrow>Your next step · {p.role}</Eyebrow>
      {error && <ErrorBox>{error}</ErrorBox>}
      {body}
      {canRefund && (
        <details className="rounded-2xl border border-line p-3">
          <summary className="cursor-pointer text-sm font-semibold">Refund the payer instead</summary>
          <div className="mt-3 space-y-2">
            {confirmInputs("refund")}
            <button disabled={!!busy || !ready} onClick={() => confirm("Refund the full captured amount to the payer (sandbox)?") && act("refund", { confirmation: c }, "Refunded")} className="w-full rounded-full bg-bad py-2.5 text-sm font-semibold c-bad disabled:opacity-50">Refund</button>
          </div>
        </details>
      )}
      <SandboxNote />
    </Card>
  );
}
