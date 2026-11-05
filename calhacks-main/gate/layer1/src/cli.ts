// gate-l1: JSONL GateInput on stdin -> one {"listing_id", "checks"} line per input on stdout, same order.
// Usage: node gate/layer1/src/cli.ts [--contracts contracts/] < gate_inputs.jsonl
import { createInterface } from "node:readline";
import { loadContext } from "./context.ts";
import { checkLayer1 } from "./rules.ts";
import type { GateInput } from "./types.ts";

const i = process.argv.indexOf("--contracts");
const ctx = loadContext(i > 0 ? process.argv[i + 1] : undefined);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  process.stdout.write(JSON.stringify(checkLayer1(JSON.parse(line) as GateInput, ctx)) + "\n");
}
