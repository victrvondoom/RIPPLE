import { ButtonLink, Card, PageHeader } from "@/components/ui";

export const metadata = { title: "PayPal cancelled" };

export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string; id?: string }> }) {
  const { kind, id } = await searchParams;
  return (
    <>
      <PageHeader eyebrow="PayPal sandbox" title="Payment cancelled">Nothing was charged. The order stays unapproved and can be approved later from the same link.</PageHeader>
      <Card className="max-w-xl">
        <p className="font-mono text-xs text-mut">{kind ?? "record"} · {id ?? "unknown"}</p>
        <div className="mt-4 flex gap-3">
          <ButtonLink href={kind === "trip" && id ? `/trips/${id}` : "/escrow"}>Back to the {kind === "trip" ? "trip" : "escrow"}</ButtonLink>
          <ButtonLink href="/" variant="ghost">Room</ButtonLink>
        </div>
      </Card>
    </>
  );
}
