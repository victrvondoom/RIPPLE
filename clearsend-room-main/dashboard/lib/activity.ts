import { del, indexAdd, listJson, newId, redis, setJson } from "./store";

export type ActivityKind = "paypal" | "decision" | "confirmation" | "escrow" | "trip" | "flight-search" | "status" | "system";
export type Activity = {
  id: string;
  at: string;
  kind: ActivityKind;
  subject: string; // escrow or trip id
  actor: string; // who did it: agent, or the chat username that confirmed
  summary: string;
  data?: Record<string, unknown>;
};

export async function record(a: Omit<Activity, "id" | "at">) {
  const item: Activity = { id: newId("act"), at: new Date().toISOString(), ...a };
  await setJson(`room:activity:${item.id}`, item);
  await indexAdd("room:activity", `room:activity:${item.id}`);
  return item;
}

export async function listActivity(limit = 200, subject?: string, kind?: string) {
  const all = await listJson<Activity>("room:activity", subject || kind ? 500 : limit);
  return all.filter((a) => (!subject || a.subject === subject) && (!kind || a.kind === kind)).slice(0, limit);
}

/** Delete activity entries by id or by subject (test cleanup). Returns how many were removed. */
export async function deleteActivity(filter: { id?: string; subject?: string }) {
  const all = await listJson<Activity>("room:activity", 1000);
  const hit = all.filter((a) => (filter.id && a.id === filter.id) || (filter.subject && a.subject === filter.subject));
  for (const a of hit) {
    await del(`room:activity:${a.id}`);
    await redis("ZREM", "room:activity", `room:activity:${a.id}`);
  }
  return hit.length;
}

/**
 * A human confirmation copied verbatim from the chat room.
 * The agent must pass who typed it and exactly what they typed; the server stores it in the audit log.
 */
export type HumanConfirmation = { by: string; text: string; platform?: string };

export function checkConfirmation(c: unknown, verbs: RegExp): HumanConfirmation {
  const conf = c as Partial<HumanConfirmation> | undefined;
  if (!conf || typeof conf.by !== "string" || !conf.by.trim() || typeof conf.text !== "string") {
    throw Object.assign(new Error("A human confirmation {by, text} copied from the chat room is required."), { status: 428 });
  }
  const by = conf.by.trim();
  if (/^(agent|clearsend|bot|assistant)/i.test(by)) {
    throw Object.assign(new Error("Confirmation must come from a person in the room, not the agent."), { status: 403 });
  }
  if (!verbs.test(conf.text.trim())) {
    throw Object.assign(new Error(`Confirmation text "${conf.text.slice(0, 80)}" is not an explicit approval.`), { status: 428 });
  }
  return { by, text: conf.text.trim().slice(0, 500), platform: conf.platform };
}
