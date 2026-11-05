import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { ReturnClient } from "./ReturnClient";

export const metadata = { title: "PayPal approved" };

export default function Page() {
  return (
    <>
      <PageHeader eyebrow="PayPal sandbox" title={<>You approved the payment. <span className="gradient-text">One last step.</span></>}>
        PayPal has your approval, but no money moves until the payment is captured. Capture it here, or tell the agent “paid” in the room.
      </PageHeader>
      <Suspense fallback={<Skeleton className="h-40" />}><ReturnClient /></Suspense>
    </>
  );
}
