import { PageHeader } from "@/components/ui";
import { PlanTrip } from "./PlanTrip";

export const metadata = { title: "Plan a trip" };

export default function Page() {
  return (
    <>
      <PageHeader eyebrow="Same flow as the chat room" title={<>Plan a trip, <span className="gradient-text">pay with PayPal</span></>}>
        Search real flight data, pick one, add travellers, see every fee, then confirm in your own words before a PayPal sandbox order exists.
      </PageHeader>
      <PlanTrip />
    </>
  );
}
