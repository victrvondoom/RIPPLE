import { PageHeader } from "@/components/ui";
import { NewEscrow } from "./NewEscrow";

export const metadata = { title: "New escrow" };

export default function Page() {
  return (
    <>
      <PageHeader eyebrow="Send money abroad against a deliverable" title={<>Open an <span className="gradient-text">escrow</span></>}>
        Write what must be delivered and how it will be checked. You get three signed links, one per person. Nothing is charged until the payer confirms.
      </PageHeader>
      <NewEscrow />
    </>
  );
}
