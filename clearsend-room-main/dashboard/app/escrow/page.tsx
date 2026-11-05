import { ButtonLink, Card, Empty, ErrorBox, Money, PageHeader, StateBadge, fmtTime } from "@/components/ui";
import { Stepper } from "@/components/Stepper";
import { listEscrows } from "@/lib/escrow";
import { safe } from "@/lib/safe";
import { escrowStep } from "@/lib/workflow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Escrow" };

export default async function EscrowList() {
  const { data, error } = await safe(listEscrows);
  return (
    <>
      <PageHeader eyebrow="Cross-border escrow" title="Escrows" actions={<ButtonLink href="/escrow/new">New escrow</ButtonLink>}>
        Money is held by PayPal until the AI verifier checks the deliverable against the written spec <b>and</b> the verifier approves. Details open only with each person&apos;s signed link.
      </PageHeader>
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && !data.length && <Empty title="No escrows yet">Open one here, or in the room: <code>@clearsend open an escrow: 50 USD to Ada in Ghana for a 3-slide deck, verifier Tunde</code>.</Empty>}
      <div className="space-y-4">
        {data?.map((e) => (
          <Card key={e.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-display text-xl font-semibold">{e.title}</div>
                <div className="text-sm text-mut">{e.amount} {e.currency} to {e.recipient.country} · payer pays <Money amount={e.quote.total} currency={e.payCurrency} /> · <span className="font-mono text-xs">{e.id}</span></div>
              </div>
              <div className="text-right"><StateBadge state={e.state} /><div className="mt-1 text-xs text-mut">{fmtTime(e.createdAt)}</div></div>
            </div>
            <div className="mt-4"><Stepper current={escrowStep(e.state)} compact skip={[0, 1]} /></div>
            <p className="mt-3 text-xs text-mut">Last: {e.timeline.at(-1)?.note}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
