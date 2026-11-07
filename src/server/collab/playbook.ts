/**
 * Self-encoding room capture (Level 3, capability 6): compose a resolved case's Switch topology as a
 * `version: 2` template (the same surface Switch's POST /rooms/from-yaml accepts, per switch-core 0.31
 * template_v2.py). Written to playbooks/resolved-<case_id>.template.yaml when a mission completes so the
 * resolution is reusable: run it again and the same intake → ops → finance rooms come back.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PlaybookRoom { name: string; description: string; instructions: string; agents: string[]; group?: string; roles?: { name: string; instructions: string; exclusive: true }[] }
export interface ComposeArgs {
  caseId: string;
  intake: PlaybookRoom;
  opsVerify?: PlaybookRoom;
  financeSettle?: PlaybookRoom;
  followUpsCommands?: string[];
  gatewayExport?: string | null;
  capturedAt: string;
}

const q = (s: string) => JSON.stringify(s);
const block = (s: string) => s.trim().split('\n').map((l) => `      ${l}`).join('\n').trimStart();

export function composeResolvedPlaybook(a: ComposeArgs): string {
  const groupName = `ripple-${slug(a.caseId)}`;
  const resources: string[] = [];
  const links: string[] = [];
  resources.push(`  intake:\n    type: room\n    name: ${q(a.intake.name)}\n    description: ${q(a.intake.description)}\n    instructions: |\n      ${block(a.intake.instructions)}\n    agents: [${a.intake.agents.map((x) => q(x)).join(', ')}]\n    group: case`);
  if (a.opsVerify) {
    resources.push(`  ops_verify:\n    type: room\n    name: ${q(a.opsVerify.name)}\n    description: ${q(a.opsVerify.description)}\n    instructions: |\n      ${block(a.opsVerify.instructions)}\n    agents: [${a.opsVerify.agents.map((x) => q(x)).join(', ')}]\n    group: case`);
    links.push(`      {from: ops_verify, to: intake, label: intake}`);
  }
  if (a.financeSettle) {
    resources.push(`  finance_settle:\n    type: room\n    name: ${q(a.financeSettle.name)}\n    description: ${q(a.financeSettle.description)}\n    instructions: |\n      ${block(a.financeSettle.instructions)}\n    agents: [${a.financeSettle.agents.map((x) => q(x)).join(', ')}]${a.financeSettle.roles?.length ? `\n    roles:\n${a.financeSettle.roles.map((r) => `      {name: ${q(r.name)}, exclusive: true, instructions: ${q(r.instructions)}}`).join('\n')}` : ''}\n    group: case`);
    links.push(`      {from: finance_settle, to: intake, label: intake}`);
  }
  const group = a.opsVerify || a.financeSettle
    ? `  case:\n    type: group\n    name: ${q(groupName)}\n    description: ${q(`Resolved RIPPLE case ${a.caseId} (captured ${a.capturedAt.slice(0, 10)})`)}\n    links:\n${links.join('\n')}`
    : '';
  return `# Resolved-room playbook — case ${a.caseId}
# Composed by RIPPLE's Switch adapter ${a.gatewayExport ? 'from the live gateway export' : 'as a LOCAL fallback from the rooms the adapter recorded (switch-core GET /rooms/{id}/yaml needs a human gateway session; the agent key is not accepted there)'}.
# Reusable: this is a Switch template v2 document; POST it to /rooms/from-yaml to recreate the topology.
version: 2
params:
  provider: {type: provider, description: Provider the agents run on}
  machine: {type: machine, description: Machine the agents run on}
  directory: {type: directory, description: Directory for agent workspaces}
  team: {type: string, default: ripple, pattern: "^[a-z0-9][a-z0-9-]{0,30}$"}
resources:
${[...resources, group].filter(Boolean).join('\n')}
${a.followUpsCommands?.length ? `kickoff: |\n  Follow-the-conversation bootstrap for the intake room:\n${a.followUpsCommands.map((c) => `  ${c}`).join('\n')}\n` : ''}`;
}

export function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'case'; }

/** Writes playbooks/resolved-<case>.template.yaml (creates the directory). Returns the FS path. */
export function writeResolvedPlaybook(caseId: string, yaml: string, dir = 'playbooks'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `resolved-${slug(caseId)}.template.yaml`);
  writeFileSync(path, yaml, 'utf-8');
  return path;
}
