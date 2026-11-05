import { createHmac, timingSafeEqual } from "crypto";

export type Role = "payer" | "recipient" | "verifier";
export const ROLES: Role[] = ["payer", "recipient", "verifier"];

function secret() {
  const s = process.env.ESCROW_LINK_SECRET;
  if (!s || s.length < 16) throw new Error("ESCROW_LINK_SECRET is not configured (need 16+ chars).");
  return s;
}

export function signRole(escrowId: string, role: Role) {
  return createHmac("sha256", secret()).update(`clearsend-room:${escrowId}:${role}`).digest("hex");
}

export function verifyRole(escrowId: string, role: string, token: string): boolean {
  if (!ROLES.includes(role as Role) || !/^[0-9a-f]{64}$/.test(token)) return false;
  const a = Buffer.from(signRole(escrowId, role as Role), "hex");
  const b = Buffer.from(token, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

export function roleLinks(escrowId: string) {
  return Object.fromEntries(
    ROLES.map((role) => [role, `${appUrl()}/escrow/${escrowId}?role=${role}&token=${signRole(escrowId, role)}`]),
  ) as Record<Role, string>;
}

/** Per-trip access token (the payer's private link). Lets the web flow pay and capture without the service key. */
export function signTrip(tripId: string) {
  return createHmac("sha256", secret()).update(`clearsend-room:trip:${tripId}`).digest("hex");
}

export function verifyTrip(tripId: string, token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const a = Buffer.from(signTrip(tripId), "hex");
  const b = Buffer.from(token, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function tripLink(tripId: string) {
  return `${appUrl()}/trips/${tripId}?t=${signTrip(tripId)}`;
}
