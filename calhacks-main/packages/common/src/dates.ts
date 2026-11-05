import { cacheLife } from "next/cache";

const DAY = 24 * 60 * 60 * 1000;

// Delivery estimates count forward from today, like "Wed, Oct 28". Today is cached for an hour, so built pages keep their dates in the static shell.
export async function daysFromToday(days: number[]): Promise<string[]> {
  "use cache";
  cacheLife("hours");
  const now = Date.now();
  return days.map((offset) => new Date(now + offset * DAY).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }));
}
