"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toaster";
import { ErrorBox, Money, SandboxNote } from "@/components/ui";
import { api, findCred, saveCred } from "@/lib/client";

/** Payer controls. Shown only on the device that holds the trip's private link (?t= or saved locally). */
export function TripActions({ id, state, total, currency }: { id: string; state: string; total: number; currency: string }) {
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const [token, setToken] = useState<string | null>(null);
  const [approveUrl, setApproveUrl] = useState<string | null>(null);
  const [conf, setConf] = useState({ by: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = sp.get("t");
    if (t && /^[0-9a-f]{64}$/.test(t)) {
      saveCred({ kind: "trip", id, token: t });
      setToken(t);
    } else {
      const c = findCred("trip", id);
      if (c) setToken(c.token);
    }
  }, [sp, id]);

  useEffect(() => {
    if (!token || state !== "awaiting_payment") return;
    api<{ trip: { order?: { approveUrl?: string } } }>(`/api/trips/${id}`, { headers: { "x-trip-token": token } }).then((r) => setApproveUrl(r.trip.order?.approveUrl ?? null)).catch(() => {});
  }, [token, state, id]);

  if (state === "paid") return <p className="mt-4 rounded-2xl bg-ok p-3 text-sm c-ok">Paid in PayPal sandbox. Ticket issuance is not available (search-only provider).</p>;
  if (!token) return <p className="mt-4 text-xs text-mut">Payer controls appear only with the private trip link the agent posted in the room.</p>;

  async function run(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ approveUrl?: string }>(path, { body: body ?? {}, headers: { "x-trip-token": token! }, idempotent: true });
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 space-y-3">
      {error && <ErrorBox>{error}</ErrorBox>}
      {state === "quoted" && (
        <>
          <p className="text-sm font-semibold">Would you like me to book this and pay with your PayPal account?</p>
          <input aria-label="Your name" className="field w-full rounded-xl px-3.5 py-2.5 text-sm" placeholder="Your name" value={conf.by} onChange={(e) => setConf({ ...conf, by: e.target.value })} />
          <input aria-label="Your answer" className="field w-full rounded-xl px-3.5 py-2.5 text-sm" placeholder="yes, book it" value={conf.text} onChange={(e) => setConf({ ...conf, text: e.target.value })} />
          <button disabled={busy || !conf.by.trim() || !conf.text.trim()} onClick={async () => { const r = await run(`/api/trips/${id}/pay`, { confirmation: { ...conf, platform: "web" } }); if (r?.approveUrl) window.location.href = r.approveUrl; }} className="btn-paypal w-full rounded-full py-3 font-bold disabled:opacity-50">
            Pay <Money amount={total} currency={currency} /> with PayPal (sandbox)
          </button>
        </>
      )}
      {state === "awaiting_payment" && (
        <>
          {approveUrl && <a href={approveUrl} className="btn-paypal block w-full rounded-full py-3 text-center font-bold">Approve in PayPal (sandbox)</a>}
          <button disabled={busy} onClick={async () => { if (!confirm(`Capture ${total} ${currency} from the approved PayPal sandbox order?`)) return; const r = await run(`/api/trips/${id}/capture`); if (r) { toast({ tone: "ok", title: "Payment captured (sandbox)" }); router.refresh(); } }} className="glass w-full rounded-full py-3 text-sm font-semibold">
            {busy ? "Working…" : "I approved it, capture the payment"}
          </button>
        </>
      )}
      <SandboxNote />
    </div>
  );
}
