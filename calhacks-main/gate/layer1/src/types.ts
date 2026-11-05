// Contract types come from contracts/ts (issue #1); only Layer 1's own config types live here.
export type * from "../../../contracts/ts/index.ts";
export { RULE_IDS } from "../../../contracts/ts/index.ts";
import type { Check } from "../../../contracts/ts/index.ts";

/** contracts/allowlist.json */
export interface Allowlist {
  networks: string[];
  assets: Record<string, string>;
  max_timeout_s: number;
  usdc_decimals: number;
  unknown_seller_cap_usd: number;
}

export interface Layer1Context {
  allowlist: Allowlist;
}

/** One gate-l1 output line. */
export interface Layer1Result {
  listing_id: string;
  checks: Check[];
}
