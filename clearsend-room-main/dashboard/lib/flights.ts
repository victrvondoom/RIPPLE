// Flight search from open data + optional Sky-Scrapper (RapidAPI).
// Rule: a price only ever comes from a provider response. Open-data results carry fare: null ("fare unavailable").

export type FlightOption = {
  id: string;
  source: "sky-scrapper" | "openflights" | "opensky";
  priced: boolean;
  fare: { amount: number; currency: string } | null;
  fareLabel: string;
  airline: string;
  flightNumber?: string;
  origin: string;
  destination: string;
  departure?: string;
  arrival?: string;
  stops: number;
  equipment?: string;
  note?: string;
};

export type SourceStatus = { source: string; status: "ok" | "empty" | "disabled" | "error"; message: string; count: number };

type Airport = { iata: string; icao: string; name: string; city: string; country: string };
type Airline = { name: string; iata: string; icao: string; active: boolean };

const OF = "https://raw.githubusercontent.com/jpatokal/openflights/master/data";
let ofCache: { at: number; airports: Map<string, Airport>; airlines: Map<string, Airline>; routes: string[] } | null = null;

function csv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => (s === "\\N" ? "" : s));
}

async function text(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url.split("/").pop()} HTTP ${r.status}`);
  return r.text();
}

async function openflights() {
  if (ofCache && Date.now() - ofCache.at < 12 * 3600_000) return ofCache;
  const [ap, al, rt] = await Promise.all([text(`${OF}/airports.dat`), text(`${OF}/airlines.dat`), text(`${OF}/routes.dat`)]);
  const airports = new Map<string, Airport>();
  for (const l of ap.split("\n")) {
    const c = csv(l);
    if (c[4] && c[4].length === 3) airports.set(c[4], { iata: c[4], icao: c[5], name: c[1], city: c[2], country: c[3] });
  }
  const airlines = new Map<string, Airline>();
  for (const l of al.split("\n")) {
    const c = csv(l);
    const a = { name: c[1], iata: c[3], icao: c[4], active: c[7] === "Y" };
    if (c[0]) airlines.set(c[0], a);
    if (a.iata && (!airlines.has(a.iata) || a.active)) airlines.set(a.iata, a);
  }
  ofCache = { at: Date.now(), airports, airlines, routes: rt.split("\n") };
  return ofCache;
}

export async function airport(code: string) {
  const { airports } = await openflights();
  return airports.get(code.toUpperCase()) ?? null;
}

async function searchOpenFlights(o: string, d: string): Promise<FlightOption[]> {
  const { routes, airlines } = await openflights();
  const out: FlightOption[] = [];
  for (const l of routes) {
    const c = l.split(",");
    if (c[2] !== o || c[4] !== d) continue;
    const al = airlines.get(c[1]) ?? airlines.get(c[0]);
    out.push({
      id: `of-${c[0]}-${o}-${d}`,
      source: "openflights",
      priced: false,
      fare: null,
      fareLabel: "fare unavailable",
      airline: al?.name || c[0],
      origin: o,
      destination: d,
      stops: Number(c[7] || 0),
      equipment: c[8]?.trim() || undefined,
      note: "Route from OpenFlights routes.dat (historical route database, last updated 2014). Schedule only: verify the airline still flies it.",
    });
  }
  return out;
}

async function openskyToken(): Promise<string | null> {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`OpenSky auth HTTP ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function searchOpenSky(o: Airport, d: Airport): Promise<FlightOption[]> {
  // OpenSky only has flights that already happened (batch-processed, roughly the previous day).
  // We use the last observed 48h of departures on this airport pair as a real schedule pattern.
  const end = Math.floor(Date.now() / 1000) - 3600;
  const begin = end - 2 * 86400;
  const token = await openskyToken();
  const r = await fetch(`https://opensky-network.org/api/flights/departure?airport=${o.icao}&begin=${begin}&end=${end}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`OpenSky HTTP ${r.status}`);
  const flights = (await r.json()) as { icao24: string; callsign: string | null; firstSeen: number; lastSeen: number; estArrivalAirport: string | null }[];
  return flights
    .filter((f) => f.estArrivalAirport === d.icao)
    .map((f) => ({
      id: `os-${f.icao24}-${f.firstSeen}`,
      source: "opensky" as const,
      priced: false,
      fare: null,
      fareLabel: "fare unavailable",
      airline: (f.callsign ?? "").trim().slice(0, 3) || "unknown operator",
      flightNumber: (f.callsign ?? "").trim() || undefined,
      origin: o.iata,
      destination: d.iata,
      departure: new Date(f.firstSeen * 1000).toISOString(),
      arrival: new Date(f.lastSeen * 1000).toISOString(),
      stops: 0,
      note: "Observed by OpenSky ADS-B in the last 48h (callsign is ICAO). Shows the real daily pattern, not a bookable fare.",
    }));
}

type J = Record<string, unknown>;
const rec = (v: unknown): J => (v && typeof v === "object" ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rapid(path: string, key: string): Promise<J> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`https://sky-scrapper.p.rapidapi.com${path}`, {
      headers: { "x-rapidapi-key": key, "x-rapidapi-host": "sky-scrapper.p.rapidapi.com" },
      cache: "no-store",
    });
    if (r.status === 429) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    const j = rec(await r.json().catch(() => ({})));
    if (!r.ok) throw new Error(`Sky-Scrapper HTTP ${r.status}: ${String(j.message ?? "")}`.trim());
    return j;
  }
  throw new Error("Sky-Scrapper rate limit / quota exceeded (HTTP 429 after retries)");
}

async function skyPlace(code: string, key: string) {
  const j = await rapid(`/api/v1/flights/searchAirport?query=${encodeURIComponent(code)}&locale=en-US`, key);
  for (const item of arr(j.data)) {
    const p = rec(rec(rec(item).navigation).relevantFlightParams);
    if (String(p.skyId ?? rec(item).skyId).toUpperCase() === code && p.entityId) return { skyId: String(p.skyId), entityId: String(p.entityId) };
  }
  return null;
}

async function searchSky(o: string, d: string, date: string, currency: string, adults: number): Promise<FlightOption[] | null> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return null;
  const [a, b] = await Promise.all([skyPlace(o, key), skyPlace(d, key)]);
  if (!a || !b) throw new Error(`Sky-Scrapper could not resolve ${!a ? o : d}`);
  const qs = new URLSearchParams({ originSkyId: a.skyId, destinationSkyId: b.skyId, originEntityId: a.entityId, destinationEntityId: b.entityId, date, adults: String(adults), cabinClass: "economy", currency, market: "en-US", countryCode: "US", sortBy: "best" });
  let data: J;
  try {
    data = rec((await rapid(`/api/v2/flights/searchFlightsComplete?${qs}`, key)).data);
  } catch (e) {
    if (String(e).includes("429")) throw e;
    data = rec((await rapid(`/api/v1/flights/searchFlights?${qs}`, key)).data);
  }
  return arr(data.itineraries).slice(0, 15).map((it) => {
    const i = rec(it);
    const leg = rec(arr(i.legs)[0]);
    const seg = rec(arr(leg.segments)[0]);
    const carrier = rec(arr(rec(leg.carriers).marketing)[0]);
    const raw = Number(rec(i.price).raw);
    const priced = Number.isFinite(raw) && raw > 0;
    return {
      id: `sky-${String(i.id)}`,
      source: "sky-scrapper" as const,
      priced,
      fare: priced ? { amount: raw, currency } : null,
      fareLabel: priced ? `${raw.toFixed(2)} ${currency} (Sky-Scrapper live fare, ${adults} adult${adults > 1 ? "s" : ""})` : "fare unavailable",
      airline: String(carrier.name ?? "unknown"),
      flightNumber: seg.flightNumber ? `${String(rec(seg.marketingCarrier).alternateId ?? "")}${String(seg.flightNumber)}` : undefined,
      origin: o,
      destination: d,
      departure: leg.departure ? String(leg.departure) : undefined,
      arrival: leg.arrival ? String(leg.arrival) : undefined,
      stops: Number(leg.stopCount ?? 0),
      note: "Live itinerary from Sky-Scrapper (RapidAPI). Price is the provider's quote at search time.",
    };
  });
}

export async function searchFlights(input: { origin: string; destination: string; date: string; currency?: string; adults?: number }) {
  const o = input.origin.trim().toUpperCase();
  const d = input.destination.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(o) || !/^[A-Z]{3}$/.test(d)) throw new Error("origin and destination must be 3-letter IATA airport codes");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("date must be YYYY-MM-DD");
  const currency = (input.currency ?? "USD").toUpperCase();
  const adults = Math.max(1, Math.min(9, input.adults ?? 1));
  const sources: SourceStatus[] = [];
  const options: FlightOption[] = [];

  const run = async (source: string, fn: () => Promise<FlightOption[] | null>) => {
    try {
      const res = await fn();
      if (res === null) sources.push({ source, status: "disabled", message: "not configured", count: 0 });
      else {
        options.push(...res);
        sources.push({ source, status: res.length ? "ok" : "empty", message: res.length ? `${res.length} result(s)` : "no results", count: res.length });
      }
    } catch (e) {
      sources.push({ source, status: "error", message: e instanceof Error ? e.message : String(e), count: 0 });
    }
  };

  let oa: Airport | null = null;
  let da: Airport | null = null;
  await run("openflights", async () => {
    [oa, da] = await Promise.all([airport(o), airport(d)]);
    if (!oa || !da) throw new Error(`Unknown airport ${!oa ? o : d} in OpenFlights airports.dat`);
    return searchOpenFlights(o, d);
  });
  await Promise.all([
    run("sky-scrapper", () => searchSky(o, d, input.date, currency, adults)),
    run("opensky", async () => (oa && da ? searchOpenSky(oa, da) : Promise.reject(new Error("airports unresolved")))),
  ]);

  const order = { "sky-scrapper": 0, opensky: 1, openflights: 2 } as const;
  options.sort((a, b) => order[a.source] - order[b.source] || (a.fare?.amount ?? 1e12) - (b.fare?.amount ?? 1e12));
  return {
    query: { origin: o, destination: d, date: input.date, currency, adults },
    airports: { origin: oa, destination: da },
    priced: options.filter((x) => x.priced).length,
    options: options.map((x, i) => ({ ...x, ref: i + 1 })),
    sources,
    rule: "Only options with priced=true can be booked and paid. Schedule-only options are labelled 'fare unavailable' and must never be given a price.",
  };
}
