import { RoomFeed } from "@/components/RoomFeed";
import { Stepper } from "@/components/Stepper";
import { Badge, Card, cx, ErrorBox, Eyebrow, Money, PageHeader, Row, StateBadge, fmtTime } from "@/components/ui";
import { getEscrow, nextSteps } from "@/lib/escrow";
import { verifyRole } from "@/lib/links";
import { safe } from "@/lib/safe";
import { escrowStep } from "@/lib/workflow";
import { EscrowActions } from "./EscrowActions";

export const dynamic = "force-dynamic";

const PARTIES = ["payer", "recipient", "verifier", "agent"] as const;

export default async function EscrowPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ role?: string; token?: string }> }) {
  const { id } = await params;
  const { role, token } = await searchParams;
  if (!role || !token) return <Card className="mx-auto max-w-xl"><div className="font-display text-xl font-semibold">401 · signed link required</div><p className="mt-2 text-sm text-mut">Open the payer, recipient or verifier link the agent posted in the room (or that you got when creating the escrow).</p></Card>;
  let ok = false;
  try {
    ok = verifyRole(id, role, token);
  } catch (e) {
    return <ErrorBox>{(e as Error).message}</ErrorBox>;
  }
  if (!ok) return <Card className="mx-auto max-w-xl"><div className="font-display text-xl font-semibold">403 · invalid link</div><p className="mt-2 text-sm text-mut">This link is not valid for role “{role}”.</p></Card>;
  const { data: e, error } = await safe(() => getEscrow(id));
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!e) return <ErrorBox>Escrow not found.</ErrorBox>;
  const steps = nextSteps(e);
  const q = e.quote;
  const names = { payer: e.payer.name, recipient: `${e.recipient.name} · ${e.recipient.country}`, verifier: e.verifier.name, agent: "ClearSend agent" };
  return (
    <>
      <PageHeader eyebrow={`Escrow · ${e.id} · you are the ${role}`} title={e.title} actions={<StateBadge state={e.state} />}>
        {e.amount} {e.currency} to {e.recipient.name} in {e.recipient.country}. Verified by AI, released by {e.verifier.name}.
      </PageHeader>
      <Stepper current={escrowStep(e.state)} compact skip={[0, 1]} />

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PARTIES.map((p) => (
          <Card key={p} className={cx("p-5", p === role && "gradient-ring bg-acc")}>
            <div className="flex items-center justify-between"><Eyebrow>{p}</Eyebrow>{p === role && <Badge tone="acc">you</Badge>}</div>
            <div className="mt-1 font-semibold">{names[p]}</div>
            <p className="mt-2 text-sm text-mut">{steps[p]}</p>
          </Card>
        ))}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_0.95fr]">
        <div className="space-y-6">
          <EscrowActions id={e.id} role={role} token={token} state={e.state} total={q.total} payCurrency={e.payCurrency} amount={e.amount} currency={e.currency} approveUrl={e.order?.approveUrl ?? null} hasOrder={Boolean(e.order)} recipient={e.recipient.name} />
          <Card>
            <Eyebrow>Specification</Eyebrow>
            <p className="mt-2 whitespace-pre-wrap text-sm">{e.spec}</p>
            {!!e.criteria.length && <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">{e.criteria.map((c) => <li key={c}>{c}</li>)}</ol>}
            <div className="mt-5"><Eyebrow>Deliverable</Eyebrow></div>
            {e.deliverable ? <div className="mt-2 rounded-2xl border border-line p-4 text-sm"><p className="whitespace-pre-wrap">{e.deliverable.text}</p><p className="mt-2 text-xs text-mut">— {e.deliverable.by}, {fmtTime(e.deliverable.at)}</p></div> : <p className="mt-2 text-sm text-mut">Not posted yet.</p>}
          </Card>
          <Card>
            <Eyebrow>AI decisions (free model, fails closed)</Eyebrow>
            {!e.decisions.length && <p className="mt-2 text-sm text-mut">No decision yet.</p>}
            {e.decisions.map((d) => (
              <div key={d.at} className="mt-4 rounded-2xl border border-line p-4">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={d.met ? "ok" : "bad"}>{d.met ? "VERIFIED" : "REJECTED"}</Badge><span className="text-xs text-mut">{d.model} · {fmtTime(d.at)}</span></div>
                <p className="mt-2 text-sm">{d.summary}</p>
                <ul className="mt-2 space-y-1 text-sm">{d.criteria.map((c) => <li key={c.criterion}><span className={c.met ? "c-ok" : "c-bad"}>{c.met ? "✓" : "✕"}</span> <b>{c.criterion}</b> <span className="text-mut">— {c.reason}</span></li>)}</ul>
              </div>
            ))}
          </Card>
        </div>
        <div className="space-y-6">
          <Card strong>
            <Eyebrow>Money</Eyebrow>
            <div className="mt-2">
              <Row k="Recipient gets" v={<Money amount={e.amount} currency={e.currency} />} />
              <Row k={`Rate ${q.midRate.toFixed(4)} · ${q.rateSource}`} v={<Money amount={q.converted} currency={e.payCurrency} />} />
              <Row k="FX spread 1.2%" v={<Money amount={q.fxSpreadCost} currency={e.payCurrency} />} />
              <Row k="Platform fee 2.5%" v={<Money amount={q.platformFee} currency={e.payCurrency} />} />
              <Row strong k="Payer pays" v={<Money amount={q.total} currency={e.payCurrency} className="font-display text-2xl" />} />
              <Row k="PayPal order" v={e.order ? <span className="font-mono text-xs">{e.order.id} · {e.order.status}</span> : "not created"} />
              <Row k="Payout" v={e.payout ? <span className="font-mono text-xs">{e.payout.batchId} · {e.payout.status}</span> : "none"} />
              {e.refund && <Row k="Refund" v={<span className="font-mono text-xs">{e.refund.id} · {e.refund.status}</span>} />}
            </div>
          </Card>
          <Card>
            <Eyebrow>Human approvals (verbatim)</Eyebrow>
            {e.approvals.length ? <ul className="mt-2 space-y-2 text-sm">{e.approvals.map((a) => <li key={a.at}><Badge tone="acc">{a.action}</Badge> <b>{a.by}</b>: “{a.text}” <span className="text-xs text-mut">{a.platform ?? ""} {fmtTime(a.at)}</span></li>)}</ul> : <p className="mt-2 text-sm text-mut">None yet.</p>}
          </Card>
          <Card>
            <Eyebrow>Timeline</Eyebrow>
            <ol className="mt-3 space-y-3 border-l border-line pl-4">{e.timeline.map((t) => <li key={t.at + t.state}><div className="flex items-center gap-2"><StateBadge state={t.state} /><span className="text-xs text-mut">{fmtTime(t.at)} · {t.by}</span></div><p className="mt-1 text-sm">{t.note}</p></li>)}</ol>
          </Card>
          <Card><Eyebrow>Room activity</Eyebrow><div className="mt-3"><RoomFeed subject={e.id} limit={60} /></div></Card>
        </div>
      </div>
    </>
  );
}
