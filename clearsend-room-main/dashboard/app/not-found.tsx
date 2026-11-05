import { ButtonLink, Card } from "@/components/ui";

export default function NotFound() {
  return (
    <Card className="mx-auto max-w-xl text-center">
      <div className="font-display text-2xl font-semibold">Not found</div>
      <p className="mt-2 text-sm text-mut">That page, trip or escrow does not exist (test records get cleaned up).</p>
      <ButtonLink href="/" className="mt-5">Back to the room</ButtonLink>
    </Card>
  );
}
