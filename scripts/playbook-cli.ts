/**
 * Self-encoding room capture (Level 3, capability 6) as a CLI, for cross-language verification of the
 * local fallback playbook composer. Reads a JSON case topology on stdin (the same shape the engine
 * passes to SwitchCollab.captureResolvedPlaybook) and prints `{ yaml }` — the reusable `version: 2`
 * template document. Used by the pytest suite (tests_py/test_switch_level3.py) against the SAME
 * TypeScript composer the adapter runs — never a re-implementation.
 *
 *   npx tsx scripts/playbook-cli.ts < case.json
 */
import { composeResolvedPlaybook, type PlaybookRoom } from '../src/server/collab/playbook.js';
import { readFileSync } from 'node:fs';

interface Args {
  caseId: string;
  intake: PlaybookRoom;
  opsVerify?: PlaybookRoom;
  financeSettle?: PlaybookRoom;
  followUpsCommands?: string[];
  gatewayExport?: string | null;
  capturedAt: string;
}

async function main() {
  const a = JSON.parse(readFileSync(0, 'utf-8')) as Args;
  const yaml = `${a.gatewayExport ? `# Gateway export: ${a.gatewayExport}\n` : '# Gateway /rooms/{id}/yaml needs a human session; this document is the LOCAL fallback self-encoding composed from the rooms the adapter recorded.\n'}${composeResolvedPlaybook({
    caseId: a.caseId, intake: a.intake, opsVerify: a.opsVerify, financeSettle: a.financeSettle,
    followUpsCommands: a.followUpsCommands, gatewayExport: a.gatewayExport ?? null, capturedAt: a.capturedAt,
  })}`;
  console.log(JSON.stringify({ yaml }));
}
void main();
