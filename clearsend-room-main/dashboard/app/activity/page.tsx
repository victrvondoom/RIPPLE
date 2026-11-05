import { PageHeader } from "@/components/ui";
import { ActivityClient } from "./ActivityClient";

export const metadata = { title: "Activity" };

export default function Page() {
  return (
    <>
      <PageHeader eyebrow="Audit log" title="Decisions, confirmations & PayPal">
        Every agent decision, verbatim human yes, PayPal sandbox order, capture, payout and refund, as written by the server. Live, unseeded.
      </PageHeader>
      <ActivityClient />
    </>
  );
}
