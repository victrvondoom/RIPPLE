// A live Hunter run, built from the agent API's GET /chat event stream (apps/agent/api/app/main.py).
// The stream arrives in bursts; `advance` releases rows into the feed one tick at a time so the list moves at a
// steady pace, and only starts checking rows once every found row is on screen.

import { api } from "./api";

export type Row = { id: number; at: string; title: string; store: string; price: number; verdict?: "buy" | "skip"; reason?: string };

// One qualified listing in the grid the user picks favorites from. Only its photo is shown.
export type GridItem = { id: string; at: string; title: string; store: string; price: number; image: string | null };

export type Pick = {
  at: string; title: string; store: string; price: number; url: string | null; note: string;
  // Weighed favorites only. Picks saved before the grid have none of these.
  image?: string | null; seller?: string | null; score?: number;
  // Each weighing factor, 0-1 (app/rank.py FACTORS).
  factors?: Record<"seller" | "price" | "reviews" | "condition", number>;
  condition?: string | null; stars?: number | null; reviews?: number; feedback?: number | null;
};

// One checkout step from app/pay.py. "blocked" means Hunter stopped on purpose (no wallet key on the server).
export type Step = { state: "done" | "failed" | "blocked"; detail: string };

export type Receipt = {
  item: string; store: string; amount: number; network: string; from: string; to: string;
  order: string; paidAt: string; txHash: string | null; explorer: string | null; image?: string | null;
};

// Hunter asks before searching ("understand") when a detail that changes what to buy is missing, and before
// picking ("pick") when the safe listings split into clearly different directions. The run waits for the answer.
// Pick stage only: `counts` is how many safe listings each option keeps, `images` a photo of one of them (or null).
export type Question = {
  stage: "understand" | "pick";
  text: string;
  options: string[];
  counts?: number[];
  images?: (string | null)[];
};

export type Answer = { stage: Question["stage"]; question: string; text: string };

// Stages: 0 understand, 1 search, 2 gate, 3 pick (grid, then weighing), 4 confirm and pay, 5 finished.
export type Run = {
  stage: 0 | 1 | 2 | 3 | 4 | 5;
  runId?: string;
  // The chat's name: the item, as the model named it while reading the request.
  title?: string;
  question?: Question;
  answers: Answer[];
  // How many safe listings the answer to the "pick" question kept.
  narrowed?: { kept: number; total: number };
  // The latest short sentence of the model's thinking per stage. Each one replaces the last.
  reasoning: { understand: string; pick: string };
  thoughts: string[];
  instruction?: {
    item: string; query: string; max_price: number | null; gender?: "men" | "women" | null; size?: string | null;
  };
  rows: Row[];
  scraped: number;
  gated: number;
  searchDone: boolean;
  // Every safe listing that is the item, then the ids of the favorites the user picked from them.
  qualified?: GridItem[];
  selected?: string[];
  // After going back, the favorites picked before (by `at`), so the grid shows them picked again.
  reselect?: string[];
  // How many times the user went back. The UI uses it to know a Back has landed.
  backs?: number;
  // The weighed favorites, best first.
  picks?: Pick[];
  picked: boolean;
  // Which weighed favorite the user chose, best first. Unset means the best one, the default.
  choice?: number;
  // The user's answer to "buy it?": undefined while Hunter waits.
  confirmed?: boolean;
  steps: Step[];
  paid: number; // checkout steps shown so far

  receipt?: Receipt;
  status?: "bought" | "ready" | "stopped";
  error?: string;
};

export const START: Run = {
  stage: 0, reasoning: { understand: "", pick: "" }, answers: [], thoughts: [], rows: [], scraped: 0, gated: 0,
  searchDone: false, picked: false, steps: [], paid: 0,
};

// True once the shown checkout steps end the payment: all six done, or one failed or was blocked.
export const checkoutOver = (run: Run) =>
  run.paid === 6 || (run.paid > 0 && run.steps[run.paid - 1]?.state !== "done");

// The checkout steps the UI lists, in app/pay.py order. Details come from the stream as each step finishes.
export const CHECKOUT = (store: string) => [
  `Start Checkout at ${store}`,
  "Get the Price and Payment Address",
  "Double-Check Before Paying",
  "Approve the Exact Amount",
  "Send the Payment",
  "Order Confirmed",
];

type Verdict = {
  decision: "buy" | "skip";
  decided_by: string | null;
  failed_rule: string | null;
  top_reasons: { feature: string; contribution: number }[];
};

// The Gate's Layer 1 rules (contracts RULE_IDS) and Layer 2 features (gate/features), as the feed names them.
const RULES: Record<string, string> = {
  L1_OVER_MAX: "Over Your Limit",
  L1_OVER_BUDGET: "Over Your Limit",
  L1_PAYTO_MISMATCH: "Wrong Payment Address",
  L1_UNKNOWN_SELLER_CAP: "Unknown Seller Over $100",
  L1_AMOUNT_MISMATCH: "Price Changed at Checkout",
  L1_ITEM_MISMATCH: "Not the Listed Item",
  L1_PRODUCT_MISMATCH: "Not the Listed Item",
};
const FEATURES: [RegExp, string][] = [
  [/^(injection_|imperative_to_agent|hidden_chars|mixed_script_words)/, "Hidden Instructions"],
  [/^payment_coercion$/, "Pushy Payment Request"],
  [/^(price_|untrusted_deep_discount|has_median)/, "Too Cheap to Be Real"],
  [/^(domain_|bargain_on_imitation_domain$|known_wallet_wrong_domain$)/, "Fake Store Website"],
  [/^payto_(lookalike|affix_match)$/, "Wrong Payment Address"],
  [/^(known_wallet|payto_age_days)$/, "Unknown Seller"],
  [/^review_/, "Fake Reviews"],
];

// What a skipped row says in the feed. Over the user's limit is not a scam, so it gets its own label. A Layer 2 skip
// is named after the reason that raised its risk the most (top_reasons can also hold reasons that lowered it).
export function reasonLabel(v: Verdict): string {
  if (v.failed_rule) return RULES[v.failed_rule] ?? "Failed a Safety Check";
  const feature = v.top_reasons.find((r) => r.contribution > 0)?.feature ?? "";
  const label = FEATURES.find(([pattern]) => pattern.test(feature))?.[1];
  return v.decided_by ? (label ?? "Looks Risky") : "Couldn't Check";
}

// Small words that stay lowercase inside a title.
const MINOR = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of", "on", "or", "the", "to", "vs", "with",
]);

// "is this for men's or women's?" -> "Is This for Men's or Women's?". Each part of "sherpa-lined" or
// "outdoor/technical" is capitalized, small words stay lowercase unless they come first or last, and words that
// already have capitals ("XL", "iPhone") keep them.
export function titleCase(text: string): string {
  const words = text.trim().split(/\s+/);
  return words
    .map((word, i) =>
      word.replace(/[A-Za-z][\w'\u2019]*/g, (part) =>
        part !== part.toLowerCase() || (MINOR.has(part) && i > 0 && i < words.length - 1)
          ? part
          : part[0].toUpperCase() + part.slice(1),
      ),
    )
    .join(" ");
}

// "•The North Face fleece #outdoor #hiking" -> "The North Face fleece": resale titles carry bullets and hashtags.
export const cleanTitle = (title: string | null | undefined) =>
  (title ?? "").replace(/#[\w-]+/g, "").replace(/^[\s•·*-]+/, "").replace(/\s{2,}/g, " ").trim();

// "mzn, Inc." -> "mzn", "mzn Outlet Ltd." -> "mzn Outlet".
export const storeLabel = (name: string | null | undefined) => (name ?? "Unknown Store").replace(/,?\s+(Inc|Ltd)\.?$/, "");

const at = (e: { store: string; key: string }) => `${e.store}|${e.key}`;

// Applies one stream event. Unknown events (store, search, page errors) change nothing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(run: Run, type: string, e: any): Run {
  switch (type) {
    case "run":
      return { ...run, runId: e.id };
    case "question":
      return {
        ...run,
        question: { stage: e.stage, text: e.text, options: e.options, counts: e.counts, images: e.images },
      };
    case "answer":
      return {
        ...run,
        question: undefined,
        answers: [...run.answers, { stage: e.stage, question: e.question, text: e.text }],
        reasoning: { ...run.reasoning, [e.stage]: "" },
      };
    case "narrow":
      return { ...run, narrowed: { kept: e.kept, total: e.total } };
    case "reasoning":
      return { ...run, reasoning: { ...run.reasoning, [e.stage]: e.text } };
    case "thought":
      return { ...run, thoughts: [...run.thoughts, e.text] };
    case "instruction":
      return {
        ...run,
        instruction: { item: e.item, query: e.query, max_price: e.max_price, gender: e.gender, size: e.size },
      };
    case "listing":
      return {
        ...run,
        stage: run.stage === 0 ? 1 : run.stage,
        rows: [...run.rows, { id: run.rows.length, at: at(e), title: cleanTitle(e.title), store: storeLabel(e.storeName), price: e.price }],
      };
    case "verdict": {
      const rows = run.rows.map((row) =>
        row.at === at(e) ? { ...row, verdict: e.decision, reason: e.decision === "skip" ? reasonLabel(e) : undefined } : row,
      );
      return { ...run, rows };
    }
    case "done":
      return { ...run, searchDone: true, stage: run.stage === 0 ? 1 : run.stage };
    case "qualified":
      return {
        ...run,
        qualified: e.items.map((i: GridItem & { store: string; key: string; storeName: string }) => ({
          id: i.id, at: at(i), title: cleanTitle(i.title), store: storeLabel(i.storeName), price: i.price, image: i.image,
        })),
      };
    case "selected":
      return { ...run, selected: e.ids };
    case "pick":
      return {
        ...run,
        picks: e.picks.map((p: Pick & { store: string; key: string; storeName: string }) => ({
          ...p, at: at(p), title: cleanTitle(p.title), store: storeLabel(p.storeName),
        })),
      };
    case "back": {
      // Before the search: everything after the kept answers starts over, and the search runs again.
      const backs = (run.backs ?? 0) + 1;
      if (e.to === "understand")
        return { ...START, runId: run.runId, title: run.title, answers: run.answers.slice(0, e.keep), backs };
      // After it: the narrowing question or the grid comes again. Favorites picked before stay picked.
      const picked = run.qualified?.filter((i) => run.selected?.includes(i.id)).map((i) => i.at);
      return {
        ...run, stage: 3, backs, answers: run.answers.slice(0, e.keep), question: undefined, narrowed: undefined,
        qualified: undefined, selected: undefined, reselect: picked?.length ? picked : run.reselect, picks: undefined,
        picked: false, choice: undefined, confirmed: undefined, reasoning: { ...run.reasoning, pick: "" },
      };
    }
    case "confirmed":
      return { ...run, confirmed: e.ok, choice: e.pick ?? run.choice };
    case "checkout": {
      const steps = [...run.steps];
      steps[e.step] = { state: e.state, detail: e.detail };
      return { ...run, steps };
    }
    case "title":
      return { ...run, title: e.text };
    case "receipt":
      return { ...run, receipt: { ...e, item: cleanTitle(e.item) } };
    case "end":
      return { ...run, status: e.status };
    case "error":
      // A per-store error leaves the run going. An error with nothing in it is the connection dropping, e.g. the
      // agent API restarting mid-run.
      if (e.store) return run;
      return {
        ...run,
        error:
          e.message ??
          (e.error ? `Something went wrong (${e.error}). Try again.` : "Lost the connection to Hunter. Start a new chat to try again."),
      };
    default:
      return run;
  }
}

// Sends the user's answer to the question the run is waiting on. The run shows it once the stream echoes it back.
export const answer = (runId: string, text: string) => api(`/chat/${runId}/answer`, { method: "POST", json: { text } });

// Goes back one step from whatever the run is waiting on. The run resets once the stream sends `back`.
export const goBack = (runId: string) => api(`/chat/${runId}/back`, { method: "POST" });

// The 1-5 grid items the user likes most, by id. Hunter weighs them and offers the best one.
export const select = (runId: string, ids: string[]) => api(`/chat/${runId}/select`, { method: "POST", json: { ids } });

// The user's go-ahead to buy the offered item, or false to buy nothing.
export const confirmPurchase = (runId: string, confirm: boolean, pick: number) =>
  api(`/chat/${runId}/confirm`, { method: "POST", json: { confirm, pick } });

// True while the run waits on the user: a question, the grid, or the go-ahead to pay.
export const waiting = (run: Run) =>
  Boolean(run.question) ||
  (Boolean(run.qualified?.length) && !run.selected) ||
  (Boolean(run.picks?.length) && Boolean(run.selected) && run.confirmed === undefined);

// One pacing tick: reveal the next found row, or mark the next row checked once its verdict is in.
export function advance(run: Run): Run {
  if (run.stage === 1) {
    if (run.scraped < run.rows.length) return { ...run, scraped: run.scraped + 1 };
    if (!run.searchDone) return run;
    return { ...run, stage: run.rows.length ? 2 : 5 };
  }
  if (run.stage === 2) {
    if (run.gated < run.rows.length) return run.rows[run.gated].verdict ? { ...run, gated: run.gated + 1 } : run;
    return { ...run, stage: 3 };
  }
  return run;
}

export const counts = (rows: Row[]) => {
  const blocked = rows.filter((r) => r.verdict === "skip").length;
  return { safe: rows.length - blocked, blocked, stores: new Set(rows.map((r) => r.store)).size };
};
