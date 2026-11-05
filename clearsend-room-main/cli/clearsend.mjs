#!/usr/bin/env node
// ClearSend Room CLI: the only way the agent in the Switch room touches money or state.
// Zero dependencies. Talks to the dashboard API with the service key. Prints JSON.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [join(root, ".env"), join(root, "dashboard", ".env.local")]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const BASE = (process.env.CLEARSEND_API_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.CLEARSEND_API_KEY;

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    args[k] = args[k] === undefined ? v : [].concat(args[k], v);
  }
}
const list = (v) => (v === undefined ? [] : [].concat(v));
const need = (k) => {
  if (args[k] === undefined || args[k] === "true") die(`--${k} is required`);
  return args[k];
};
function die(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(2);
}
const confirmation = () => ({ by: need("confirmed-by"), text: need("confirmation"), platform: args.platform });

// Money-moving calls carry an Idempotency-Key derived from the exact request, so a repeated
// identical command (e.g. the agent retrying after a timeout) is replayed by the server, never repeated.
const MONEY = /\/(pay|capture|fund|release|refund)$/;
function idemKey(path, body) {
  if (args["idempotency-key"]) return String(args["idempotency-key"]);
  return createHash("sha256").update(`${path}|${JSON.stringify(body ?? {})}`).digest("hex").slice(0, 40);
}

async function api(method, path, body) {
  if (!KEY && method !== "GET") die("CLEARSEND_API_KEY is not set in the agent's environment");
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(KEY ? { "x-clearsend-api-key": KEY } : {}), ...(method === "POST" && MONEY.test(path) ? { "idempotency-key": idemKey(path, body) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`Cannot reach ClearSend API at ${BASE}: ${e.message}`);
  }
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  const out = { httpStatus: res.status, ...(res.headers.get("idempotent-replay") ? { replayed: true } : {}), ...json };
  console.log(JSON.stringify(out, null, 2));
  if (args.say !== undefined) console.log(`\n--- post in the room ---\n${roomLine(cmd, out)}`);
  process.exit(res.ok ? 0 : 1);
}

const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();

const commands = {
  health: () => api("GET", "/api/health"),
  flights: () => api("GET", `/api/flights/search?${q({ from: need("from"), to: need("to"), date: need("date"), adults: args.adults, currency: args.currency })}`),
  quote: () => api("GET", `/api/quote?${q({ amount: need("amount"), from: need("from"), to: need("to") })}`),
  "trip-quote": () =>
    api("POST", "/api/trips", {
      searchId: need("search"),
      ref: Number(need("option")),
      payCurrency: args["pay-currency"],
      requestedBy: args["requested-by"],
      travellers: list(args.traveller).map((t) => {
        const [fullName, email, dateOfBirth, nationality] = String(t).split("|");
        return { fullName, email, dateOfBirth, nationality };
      }),
    }),
  "trip-pay": () => api("POST", `/api/trips/${need("trip")}/pay`, { confirmation: confirmation() }),
  "trip-capture": () => api("POST", `/api/trips/${need("trip")}/capture`, {}),
  "trip-show": () => api("GET", `/api/trips/${need("trip")}`),
  "escrow-create": () =>
    api("POST", "/api/escrow", {
      title: need("title"),
      spec: need("spec"),
      criteria: list(args.criterion),
      amount: Number(need("amount")),
      currency: args.currency ?? "USD",
      payCurrency: args["pay-currency"],
      payerName: need("payer"),
      payerEmail: args["payer-email"],
      recipientName: need("recipient"),
      recipientEmail: need("recipient-email"),
      recipientCountry: need("recipient-country"),
      verifierName: need("verifier"),
      platform: args.platform,
      channel: args.channel,
      requestedBy: args["requested-by"],
    }),
  "escrow-show": () => api("GET", `/api/escrow/${need("escrow")}`),
  "escrow-list": () => api("GET", "/api/escrow"),
  "escrow-fund": () => api("POST", `/api/escrow/${need("escrow")}/fund`, { confirmation: confirmation() }),
  "escrow-capture": () => api("POST", `/api/escrow/${need("escrow")}/capture`, {}),
  "escrow-submit": () => api("POST", `/api/escrow/${need("escrow")}/submit`, { deliverable: need("deliverable"), by: need("by") }),
  "escrow-verify": () => api("POST", `/api/escrow/${need("escrow")}/verify`, {}),
  "escrow-release": () => api("POST", `/api/escrow/${need("escrow")}/release`, { confirmation: confirmation() }),
  "escrow-refund": () => api("POST", `/api/escrow/${need("escrow")}/refund`, { confirmation: confirmation() }),
  activity: () => api("GET", `/api/activity?${q({ subject: args.subject, kind: args.kind, limit: args.limit })}`),
  // Structured status line the dashboard shows in the room mirror and the workflow stepper.
  status: () =>
    api("POST", "/api/activity", {
      subject: need("subject"),
      step: args.step ?? "info",
      summary: need("summary"),
      actor: args.actor ?? "agent",
      room: args.room,
    }),
  "activity-delete": () => api("DELETE", `/api/activity?${q({ id: args.id, subject: args.subject })}`),
  "trip-delete": () => api("DELETE", `/api/trips/${need("trip")}?activity=1`),
  "escrow-delete": () => api("DELETE", `/api/escrow/${need("escrow")}?activity=1`),
};

const STEP_ICON = { search: "🔎", choose: "👉", confirm: "✋", pay: "💳", funded: "🔒", submitted: "📦", verified: "🤖", release: "✅", "paid-out": "💸", info: "ℹ️", blocked: "⛔" };
/** A short, human line the agent can paste into the chat after a command (use --say). */
function roomLine(command, r) {
  if (!r.ok) return `⛔ ${command} failed (HTTP ${r.httpStatus}): ${r.error}`;
  if (r.escrow) return `${STEP_ICON[{ created: "confirm", funded: "funded", submitted: "submitted", verified: "verified", rejected: "blocked", released: "paid-out", refunded: "info" }[r.escrow.state] ?? "info"]} Escrow ${r.escrow.id} is *${r.escrow.state}*. ${r.approveUrl ? `PayPal sandbox approve link: ${r.approveUrl}` : ""}`.trim();
  if (r.trip) return `✈️ Trip ${r.trip.id} is *${r.trip.state}* · ${r.trip.quote.total} ${r.trip.quote.payCurrency}${r.approveUrl ? ` · PayPal sandbox approve link: ${r.approveUrl}` : ""}`;
  if (r.options) return `🔎 ${r.options.length} options (${r.priced} with a live fare). Which flight would you like?`;
  if (r.item) return `${STEP_ICON[r.item.data?.step] ?? "ℹ️"} ${r.item.summary}`;
  return "✅ done";
}

if (!cmd || !commands[cmd]) {
  console.log(`usage: node cli/clearsend.mjs <command> [--flags]
commands: ${Object.keys(commands).join(", ")}
see docs/skills/*.md for the exact flags of each step
add --say to also print a one-line message for the room`);
  process.exit(cmd ? 2 : 0);
}
await commands[cmd]();
