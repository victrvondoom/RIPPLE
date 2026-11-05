import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RULE_IDS } from "../src/index.ts";
import { fixtureInputs } from "./fixtures.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("cli maps GateInput JSONL to {listing_id, checks} JSONL, same order", () => {
  const inputs = fixtureInputs();
  const lines = inputs.map((x) => JSON.stringify(x));
  const out = spawnSync(process.execPath, [CLI], { input: lines.join("\n") + "\n\n", encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const results = out.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(results.map((r) => r.listing_id), inputs.map((x) => x.listing.listing_id));
  assert.ok(
    results.every(
      (r) => r.checks.length === RULE_IDS.length && r.checks.every((c: { passed: unknown }) => typeof c.passed === "boolean"),
    ),
  );
});
