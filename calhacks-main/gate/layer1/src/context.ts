import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Allowlist, Layer1Context } from "./types.ts";

export const DEFAULT_CONTRACTS = new URL("../../../contracts/", import.meta.url);

// Layer 1 reads only policy from contracts/. Known sellers arrive in each GateInput's references.
export function loadContext(contractsDir: string | URL = DEFAULT_CONTRACTS): Layer1Context {
  const file = contractsDir instanceof URL ? new URL("allowlist.json", contractsDir) : join(contractsDir, "allowlist.json");
  return { allowlist: JSON.parse(readFileSync(file, "utf8")) as Allowlist };
}
