"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Card, ErrorBox, SandboxNote } from "@/components/ui";
import { api, loadCreds } from "@/lib/client";

export function ReturnClient() {
  const sp = useSearchParams();
  const toast = useToast();
  const kind = sp.get("kind") === "escrow" ? "escrow" : "trip";
  const id = sp.get("id") ?? "";
  const [cred, setCred] = useState<{ token: string; role?: string } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = loadCreds().find((x) => x.kind === kind && x.id === id && (x.kind === "trip" || x.role === "payer"));
    setCred(c ? { token: c.token, role: "role" in c ? c.role : undefined } : null);
  }, [kind, id]);

  const view = kind === "trip" ? `/trips/${id}` : cred?.role ? `/escrow/${id}?role=payer&token=${cred.token}` : "/escrow";

  async function capture() {
    if (!cred) return;
    setBusy(true);
    setError(null);
    try {
      const headers: Record<string, string> = kind === "trip" ? { "x-trip-token": cred.token } : { "x-escrow-role": "payer", "x-escrow-token": cred.token };
      await api(kind === "trip" ? `/api/trips/${id}/capture` : `/api/escrow/${id}/capture`, { body: {}, headers, idempotent: true });
      setDone(true);
      toast({ tone: "ok", title: kind === "trip" ? "Trip paid (sandbox)" : "Escrow funded (sandbox)" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!/^(trip|esc)_[a-z0-9]+$/.test(id)) return <ErrorBox>Missing or invalid record id in the return link.</ErrorBox>;
  return (
    <Card strong className="max-w-2xl">
      <div className="font-mono text-xs text-mut">{kind} · {id}</div>
      {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
      {done ? (
        <p className="mt-4 rounded-2xl bg-ok p-4 c-ok">{kind === "trip" ? "Captured. The trip is paid." : "Captured. Money is held in escrow until the verifier approves the release."}</p>
      ) : cred === undefined ? null : cred ? (
        <button onClick={capture} disabled={busy} className="btn-primary mt-4 w-full rounded-full py-3 font-semibold disabled:opacity-60">{busy ? "Capturing…" : kind === "trip" ? "Capture payment" : "Capture into escrow"}</button>
      ) : (
        <p className="mt-4 text-sm text-mut">This device does not hold the payer link for this {kind}. Go back to the room and tell <code>@clearsend</code> “paid”; the agent captures it.</p>
      )}
      <div className="mt-4 flex items-center justify-between">
        <SandboxNote />
        <Link href={view} className="text-sm underline">Open the {kind}</Link>
      </div>
    </Card>
  );
}
