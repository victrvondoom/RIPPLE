// TypeScript mirror of contracts/src/calhacks_contracts (GitHub issue #1). Erasable syntax only, so Node 22 can
// run it without a build step. The pydantic models are the source of truth; contracts/schemas/ is generated from them.

export type Address = `0x${string}`;
export type Condition = "new" | "like_new" | "used" | "poor";
export type Label = "scam" | "legit";
export type AttackerKnowledge = "blind" | "white_box";

// ---------- Schema 1: Listing ----------
export interface Seller { id: string; domain: string; pay_to: Address }
export interface Item { id: string; product_key: string; condition: Condition; price: number; text: string }
export interface Checkout {
  pay_to: Address;
  amount: string; // USDC base units
  network: string;
  asset: Address;
  item_id: string;
  max_timeout_seconds?: number | null;
}
export interface Listing { listing_id: string; seller: Seller; item: Item; reviews: string[]; checkout: Checkout }
export interface ListingMeta { listing_id: string; source: string; url?: string | null; fetched_at?: string | null }

// ---------- Schema 3: SyntheticListing ----------
export interface AnswerKey {
  listing_id: string;
  label: Label;
  family: string;
  base_listing_id?: string | null;
  attack_diff: Record<string, string>;
  attacker_knowledge?: AttackerKnowledge | null;
}
export interface GenInfo {
  listing_id: string;
  model: string | null;
  temperature?: number | null;
  prompt_version?: string | null;
  spec_id: string;
}
export interface SyntheticListing { listing: Listing; answer_key: AnswerKey; gen: GenInfo }

// ---------- Schema 4: Gate ----------
export interface Mandate { product_key: string; max_price: number; spend_remaining: number }
export interface Proposal { listing_id: string; scout_notes?: string | null }
export interface KnownSeller { seller_id: string; pay_to: Address; domain: string }
export interface References {
  known_sellers: KnownSeller[];
  market_median?: number | null;
  pay_to_first_seen?: string | null;
}
export interface GateRequest { mandate: Mandate; proposal: Proposal; references: References }
/** A GateRequest after the Gate re-fetched the listing itself. */
export interface GateInput { mandate: Mandate; listing: Listing; references: References }

export type RuleId =
  | "L1_PAYTO_MISMATCH" | "L1_UNKNOWN_SELLER_CAP" | "L1_AMOUNT_MISMATCH" | "L1_OVER_MAX"
  | "L1_OVER_BUDGET" | "L1_NETWORK" | "L1_ASSET" | "L1_ITEM_MISMATCH" | "L1_PRODUCT_MISMATCH" | "L1_TIMEOUT"
  | "L1_SELLER_UNTRUSTED"; // deprecated: only the agent API's mock Gate emits it; not in RULE_IDS (Layer 1 never runs it)

export const RULE_IDS: readonly RuleId[] = [
  "L1_PAYTO_MISMATCH", "L1_UNKNOWN_SELLER_CAP", "L1_AMOUNT_MISMATCH", "L1_OVER_MAX",
  "L1_OVER_BUDGET", "L1_NETWORK", "L1_ASSET", "L1_ITEM_MISMATCH", "L1_PRODUCT_MISMATCH", "L1_TIMEOUT",
];

export interface Check { rule: RuleId; passed: boolean; detail?: string | null }
export interface Reason { feature: string; value: number; contribution: number }
export interface GateDecision {
  decision: "buy" | "skip";
  decided_by: "layer1" | "layer2" | null;
  failed_rule?: RuleId | null;
  risk_score?: number | null;
  threshold?: number | null;
  top_reasons: Reason[]; // at most 3
  model_version?: string | null;
  checks: Check[];
}

// ---------- Schema 2: coordinator (read-only on the TS side) ----------
export interface Rate { value: number; lo: number; hi: number; k: number; n: number }
export interface RoundMetrics {
  layer1_catches: number;
  layer2_recall: Rate;
  fpr_real: Rate;
  per_family: Record<string, Rate>;
  adaptive_recall?: Rate | null;
  recall: Rate;
  fpr: Rate;
  layer2_fpr?: Rate | null; // the trained model's false blocks; Layer 1 policy blocks excluded
  policy_bounded_recall?: Rate | null; // policy-bounded families (unknown_seller), excluded from recall
}

export interface AttackSpec {
  spec_id: string;
  family: string;
  n: number;
  legit_ratio: number;
  mode: "mutate_real" | "generate";
  base_listing_ids: string[];
  target_weakness?: string | null;
  attacker_knowledge: AttackerKnowledge;
  model?: string | null;
  temperature?: number | null;
}
