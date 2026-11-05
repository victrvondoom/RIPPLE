import { record, type HumanConfirmation } from "./activity";
import type { Quote } from "./fx";
import type { Decision } from "./llm";
import { del, getJson, indexAdd, listJson, newId, redis, setJson } from "./store";

export const STATES = ["created", "funded", "submitted", "verified", "rejected", "released", "refunded"] as const;
export type EscrowState = (typeof STATES)[number];

export type Escrow = {
  id: string;
  title: string;
  spec: string;
  criteria: string[];
  amount: number; // what the recipient receives
  currency: string;
  payCurrency: string;
  quote: Quote;
  payer: { name: string; email?: string };
  recipient: { name: string; email: string; country: string };
  verifier: { name: string };
  room?: { platform?: string; channel?: string };
  state: EscrowState;
  order?: { id: string; status: string; approveUrl?: string; captureId?: string };
  deliverable?: { text: string; by: string; at: string };
  decisions: Decision[];
  approvals: (HumanConfirmation & { action: string; at: string })[];
  payout?: { batchId: string; status: string };
  refund?: { id: string; status: string };
  timeline: { state: EscrowState; at: string; by: string; note: string }[];
  createdAt: string;
};

const key = (id: string) => `room:escrow:${id}`;

export class EscrowError extends Error {
  constructor(message: string, public readonly status = 409) {
    super(message);
  }
}

export async function getEscrow(id: string) {
  if (!/^esc_[a-z0-9]+$/.test(id)) return null;
  return getJson<Escrow>(key(id));
}

export async function mustGet(id: string) {
  const e = await getEscrow(id);
  if (!e) throw new EscrowError(`Escrow ${id} not found`, 404);
  return e;
}

export async function listEscrows() {
  return listJson<Escrow>("room:escrows");
}

export async function createEscrow(input: Omit<Escrow, "id" | "state" | "decisions" | "approvals" | "timeline" | "createdAt">, by: string) {
  const now = new Date().toISOString();
  const e: Escrow = { ...input, id: newId("esc"), state: "created", decisions: [], approvals: [], createdAt: now, timeline: [{ state: "created", at: now, by, note: "Escrow created in the room" }] };
  await setJson(key(e.id), e);
  await indexAdd("room:escrows", key(e.id));
  await record({ kind: "escrow", subject: e.id, actor: by, summary: `Escrow created: ${e.amount} ${e.currency} to ${e.recipient.name} (${e.recipient.country})` });
  return e;
}

/** Optimistic transition with a short lock so two room messages cannot move the same escrow twice. */
export async function transition(id: string, from: EscrowState[], fn: (e: Escrow) => Promise<{ next?: EscrowState; note: string; by: string }>) {
  const lock = await redis<string | null>("SET", `${key(id)}:lock`, "1", "NX", "EX", 60);
  if (lock !== "OK") throw new EscrowError("Another action on this escrow is in progress; retry shortly.", 423);
  try {
    const e = await mustGet(id);
    if (!from.includes(e.state)) throw new EscrowError(`Escrow is '${e.state}'; this action needs ${from.map((s) => `'${s}'`).join(" or ")}.`);
    const { next, note, by } = await fn(e);
    if (next) {
      e.state = next;
      e.timeline.push({ state: next, at: new Date().toISOString(), by, note });
    }
    await setJson(key(id), e);
    return e;
  } finally {
    await redis("DEL", `${key(id)}:lock`);
  }
}

export async function deleteEscrow(id: string) {
  await del(key(id));
  await redis("ZREM", "room:escrows", key(id));
}

/** What each party sees and can do at each state, used by the room and the dashboard alike. */
export function nextSteps(e: Escrow): Record<"payer" | "recipient" | "verifier" | "agent", string> {
  const s = e.state;
  return {
    payer:
      s === "created" ? (e.order?.approveUrl ? "Approve the PayPal sandbox payment, then tell the agent 'paid'." : "Type 'confirm fund' in the room so the agent creates the PayPal order.")
      : s === "rejected" ? "Ask for a resubmission, or type 'refund' to get the money back."
      : s === "funded" || s === "submitted" ? "Wait: money is held by PayPal (captured to the platform's sandbox account)."
      : s === "verified" ? "Nothing required. The verifier approves the release."
      : "Done.",
    recipient:
      s === "funded" ? "Post the deliverable in the room so the agent can check it."
      : s === "rejected" ? "Read the decision, fix the gaps and post again (the agent resubmits)."
      : s === "released" ? "Payout sent to your PayPal email." : s === "created" ? "Wait for the payer to fund." : "Wait.",
    verifier:
      s === "verified" ? "Read the agent's decision, then type 'approve release' in the room."
      : s === "rejected" ? "Review the agent's decision. You can override only by asking for a new submission." : "Watch the room; you approve the release.",
    agent:
      s === "created" ? "Ask the payer for explicit confirmation, then create the PayPal order."
      : s === "funded" ? "Wait for the recipient's deliverable."
      : s === "submitted" ? "Verify the deliverable against the spec and post the decision."
      : s === "verified" ? "Wait for a human 'approve release', then send the PayPal payout." : "Report the outcome.",
  };
}
