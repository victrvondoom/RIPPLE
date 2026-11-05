// The one workflow everyone in the room follows. Shared by the dashboard and the role views.
export const WORKFLOW = [
  { key: "search", label: "Search flights", hint: "Open data + live fares" },
  { key: "choose", label: "Choose", hint: "Pick one option" },
  { key: "confirm", label: "Confirm", hint: "A person types yes" },
  { key: "pay", label: "Pay with PayPal", hint: "Sandbox approve + capture" },
  { key: "funded", label: "Escrow funded", hint: "Held by PayPal" },
  { key: "submitted", label: "Deliverable submitted", hint: "Recipient posts work" },
  { key: "verified", label: "AI verified", hint: "Free model, per criterion" },
  { key: "release", label: "Human release", hint: "Verifier approves" },
  { key: "paid-out", label: "Paid out", hint: "PayPal Payout" },
] as const;
export type StepKey = (typeof WORKFLOW)[number]["key"];

/** Index of the step a trip is waiting on (all earlier steps are done). */
export function tripStep(state: string): number {
  return state === "quoted" ? 2 : state === "awaiting_payment" ? 3 : state === "paid" ? 4 : 2;
}
/** Index of the step an escrow is waiting on. Escrows skip flight search/choose. */
export function escrowStep(state: string): number {
  return ({ created: 3, funded: 5, submitted: 6, verified: 7, rejected: 5, released: 9, refunded: 9 } as Record<string, number>)[state] ?? 3;
}

export const STATE_TONE: Record<string, "ok" | "warn" | "bad" | "acc" | "mut"> = {
  created: "acc", quoted: "acc", awaiting_payment: "warn", funded: "acc", submitted: "warn", verified: "ok", paid: "ok", released: "ok", rejected: "bad", refunded: "mut", cancelled: "mut",
};
