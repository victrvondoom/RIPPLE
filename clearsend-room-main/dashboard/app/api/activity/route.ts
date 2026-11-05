import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteActivity, listActivity, record } from "@/lib/activity";
import { hasServiceKey, requireServiceKey } from "@/lib/auth";
import { body, fail, parse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const limit = Math.min(500, Math.max(1, Number(u.searchParams.get("limit") ?? 200) || 200));
    const items = await listActivity(limit, u.searchParams.get("subject") ?? undefined, u.searchParams.get("kind") ?? undefined);
    // Public view drops the raw data payloads; the service key sees everything.
    return NextResponse.json({ ok: true, count: items.length, items: hasServiceKey(req) ? items : items.map(({ data: _d, ...rest }) => (void _d, rest)) });
  } catch (e) {
    return fail(e, "GET /api/activity");
  }
}

const Status = z.object({
  subject: z.string().trim().min(1).max(64),
  summary: z.string().trim().min(1).max(500),
  step: z.enum(["search", "choose", "confirm", "pay", "funded", "submitted", "verified", "release", "paid-out", "info", "blocked"]).default("info"),
  actor: z.string().trim().min(1).max(80).default("agent"),
  room: z.string().trim().max(120).optional(),
});

// The agent posts a structured status line (what it just did / is waiting on) from the room.
export async function POST(req: Request) {
  const denied = requireServiceKey(req);
  if (denied) return denied;
  try {
    const s = parse(Status, await body(req));
    const item = await record({ kind: "status", subject: s.subject, actor: s.actor, summary: s.summary, data: { step: s.step, room: s.room } });
    return NextResponse.json({ ok: true, item });
  } catch (e) {
    return fail(e, "POST /api/activity");
  }
}

// Test cleanup: delete by id or subject. Service key only.
export async function DELETE(req: Request) {
  const denied = requireServiceKey(req);
  if (denied) return denied;
  try {
    const u = new URL(req.url);
    const id = u.searchParams.get("id") ?? undefined;
    const subject = u.searchParams.get("subject") ?? undefined;
    if (!id && !subject) return NextResponse.json({ ok: false, error: "Pass ?id= or ?subject=", code: "BAD_REQUEST" }, { status: 400 });
    return NextResponse.json({ ok: true, deleted: await deleteActivity({ id, subject }) });
  } catch (e) {
    return fail(e, "DELETE /api/activity");
  }
}
