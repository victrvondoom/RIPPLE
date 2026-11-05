import { record } from "./activity";
import type { FlightOption } from "./flights";
import type { Quote } from "./fx";
import { getJson, indexAdd, listJson, newId, redis, setJson } from "./store";

export type Traveller = { fullName: string; email: string; dateOfBirth?: string; nationality?: string; phone?: string };
export type TripState = "quoted" | "awaiting_payment" | "paid" | "cancelled";
export type Trip = {
  id: string;
  state: TripState;
  flight: FlightOption;
  searchedFor: { date: string; adults: number };
  travellers: Traveller[];
  quote: Quote;
  order?: { id: string; status: string; approveUrl?: string; captureId?: string };
  confirmation?: { by: string; text: string; at: string };
  ticketing: string;
  timeline: { state: TripState; at: string; by: string; note: string }[];
  createdAt: string;
};

const key = (id: string) => `room:trip:${id}`;

export async function getTrip(id: string) {
  if (!/^trip_[a-z0-9]+$/.test(id)) return null;
  return getJson<Trip>(key(id));
}
export async function listTrips() {
  return listJson<Trip>("room:trips");
}
export async function saveTrip(t: Trip) {
  await setJson(key(t.id), t);
}
export async function createTrip(input: Pick<Trip, "flight" | "searchedFor" | "travellers" | "quote">, by: string) {
  const now = new Date().toISOString();
  const t: Trip = {
    ...input,
    id: newId("trip"),
    state: "quoted",
    ticketing: "Not issued. Sky-Scrapper is a search API; ticket issuance needs an airline/OTA booking API that this project does not have.",
    timeline: [{ state: "quoted", at: now, by, note: `Quote: ${input.quote.total} ${input.quote.payCurrency}` }],
    createdAt: now,
  };
  await saveTrip(t);
  await indexAdd("room:trips", key(t.id));
  await record({ kind: "trip", subject: t.id, actor: by, summary: `Trip quoted: ${t.flight.airline} ${t.flight.origin}->${t.flight.destination}, ${t.quote.total} ${t.quote.payCurrency}` });
  return t;
}
export async function deleteTrip(id: string) {
  await redis("DEL", key(id));
  await redis("ZREM", "room:trips", key(id));
}
export function maskTraveller(t: Traveller): Traveller {
  const [u, d] = t.email.split("@");
  return { fullName: t.fullName, email: `${u.slice(0, 2)}***@${d ?? ""}`, nationality: t.nationality, dateOfBirth: t.dateOfBirth ? "****-**-**" : undefined };
}
