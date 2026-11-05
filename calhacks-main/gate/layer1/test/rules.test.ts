import assert from "node:assert/strict";
import { test } from "node:test";
import { RULE_IDS, checkLayer1, decodePaymentRequired, failedRule, isLookalike, loadContext } from "../src/index.ts";
import type { GateInput } from "../src/index.ts";
import { byId, fixtureInputs } from "./fixtures.ts";

const ctx = loadContext();
const failures = (x: GateInput) => checkLayer1(x, ctx).checks.filter((c) => !c.passed).map((c) => c.rule);

// Captured from POST https://calhacks.micahtid.com/api/checkout/tetris-gb (x402 v2, 2026-10-24).
const LIVE_HEADER =
  "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9jYWxoYWNrcy5taWNhaHRpZC5jb20vYXBpL2NoZWNrb3V0L3RldHJpcy1nYiIsImRlc2NyaXB0aW9uIjoiUGl4ZWwgQ2FydCBSZXRybyBjaGVja291dCIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRzIjpbeyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJhbW91bnQiOiIyNTAwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4NDVmRTkyOERhQTZBMTYzNjJjZDUxREQyNTY2MEJmNTQwYzE2Yzg2MiIsIm1heFRpbWVvdXRTZWNvbmRzIjoxMjAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIifX1dfQ==";

// Expected Layer 1 failures for every contract fixture. Unknown wallets are paid only up to the $100 cap.
const EXPECTED: Record<string, string[]> = {
  "R-0001": [],
  "R-0002": [],
  "S-0001": ["L1_PAYTO_MISMATCH", "L1_UNKNOWN_SELLER_CAP"],
  "S-0002": ["L1_UNKNOWN_SELLER_CAP"], // $175 lookalike wallet: unknown and over the cap
  "S-0003": ["L1_ITEM_MISMATCH"],
  "S-0004": [], // $49 unknown wallet: under the $100 cap, so Layer 2 decides
  "S-0005": [],
  "S-0006": [],
  "S-0007": [],
  "S-0008": [],
  "S-0009": ["L1_UNKNOWN_SELLER_CAP"],
  "S-0010": ["L1_PRODUCT_MISMATCH"],
};

test("every fixture has an expectation", () => {
  assert.deepEqual(fixtureInputs().map((x) => x.listing.listing_id).sort(), Object.keys(EXPECTED).sort());
});

for (const [id, want] of Object.entries(EXPECTED)) {
  test(`fixture ${id}`, () => {
    const r = checkLayer1(byId(id), ctx);
    assert.equal(r.listing_id, id);
    assert.deepEqual(r.checks.map((c) => c.rule), [...RULE_IDS], "every rule reports, in RULE_IDS order");
    assert.deepEqual(failures(byId(id)), want);
    assert.equal(failedRule(r), want[0] ?? null);
  });
}

test("an unknown wallet above the cap is blocked", () => {
  const x = byId("S-0004");
  x.listing.item.price = 150;
  x.listing.checkout.amount = "150000000";
  x.mandate.max_price = 500;
  assert.deepEqual(failures(x), ["L1_UNKNOWN_SELLER_CAP"]);
});

test("an unknown wallet under the cap passes", () => {
  const x = byId("S-0004");
  x.listing.item.price = 20;
  x.listing.checkout.amount = "20000000";
  assert.deepEqual(failures(x), []);
});

test("a known wallet is not capped", () => {
  const x = byId("R-0002"); // $699 from a known wallet
  assert.deepEqual(failures(x), []);
});

test("a lookalike of a known wallet is still an unknown wallet", () => {
  const x = byId("S-0002");
  x.listing.item.price = 50;
  x.listing.checkout.amount = "50000000";
  assert.deepEqual(failures(x), []); // reaches Layer 2, whose lookalike features must catch it
});

test("known wallet match is case-insensitive", () => {
  const x = byId("R-0001");
  x.listing.checkout.pay_to = x.listing.checkout.pay_to.toLowerCase() as `0x${string}`;
  assert.deepEqual(failures(x), []);
});

test("amount must equal the listed price", () => {
  const x = byId("R-0001");
  x.listing.checkout.amount = "175000001";
  assert.deepEqual(failures(x), ["L1_AMOUNT_MISMATCH"]);
  x.listing.checkout.amount = "175.0"; // unparseable: the charge is unknown, so it also fails max price and budget
  assert.deepEqual(failures(x), ["L1_AMOUNT_MISMATCH", "L1_OVER_MAX", "L1_OVER_BUDGET"]);
});

test("an inflated 402 amount counts against max price and budget", () => {
  const x = byId("R-0001");
  x.listing.checkout.amount = "9000000000";
  assert.deepEqual(failures(x), ["L1_AMOUNT_MISMATCH", "L1_OVER_MAX", "L1_OVER_BUDGET"]);
});

test("mandate max price and spend remaining", () => {
  const x = byId("R-0001");
  x.mandate.max_price = 100;
  assert.deepEqual(failures(x), ["L1_OVER_MAX"]);
  const y = byId("R-0001");
  y.mandate.spend_remaining = 50;
  assert.deepEqual(failures(y), ["L1_OVER_BUDGET"]);
  const z = byId("R-0001");
  z.mandate.max_price = 175;
  assert.deepEqual(failures(z), []);
});

test("network, asset and timeout allowlists", () => {
  const x = byId("R-0001");
  x.listing.checkout.network = "eip155:8453";
  assert.deepEqual(failures(x), ["L1_NETWORK", "L1_ASSET"]);
  const y = byId("R-0001");
  y.listing.checkout.asset = "0x0000000000000000000000000000000000000001";
  assert.deepEqual(failures(y), ["L1_ASSET"]);
  for (const t of [9999, 0]) {
    const z = byId("R-0001");
    z.listing.checkout.max_timeout_seconds = t;
    assert.deepEqual(failures(z), ["L1_TIMEOUT"]);
  }
  const w = byId("R-0001");
  w.listing.checkout.max_timeout_seconds = null;
  assert.deepEqual(failures(w), []);
});

test("live 402 header decodes accepts[0] into a Checkout", () => {
  const co = decodePaymentRequired(LIVE_HEADER);
  assert.deepEqual(co, {
    pay_to: "0x45fE928DaA6A16362cd51DD25660Bf540c16c862",
    amount: "2500000",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    item_id: "tetris-gb",
    max_timeout_seconds: 120,
  });
  assert.equal(decodePaymentRequired(LIVE_HEADER, "other").item_id, "other");
});

test("lookalike keeps first and last 4 hex but differs", () => {
  const known = "0x1111aAaA2222bBbB3333cCcC4444dDdD5555eEe1";
  assert.equal(isLookalike("0x1111" + "9".repeat(32) + "eee1", known), true);
  assert.equal(isLookalike(known.toLowerCase(), known), false);
  assert.equal(isLookalike("0xdeadBEEF00000000000000000000000000c0ffee", known), false);
});
