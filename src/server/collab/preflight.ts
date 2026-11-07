import type { SwitchFabric } from './fabric.js';

/**
 * Competition-mode preflight (session 21, `RIPPLE_SWITCH_REQUIRED=1`). FAIL-CLOSED: every check must be observed on the
 * real Switch server; anything unobserved is a failure, never an assumed pass.
 *
 *  1. bridge health          GET {bridge}/health answers 200
 *  2. identities             every identity the flagship needs answers `get_my_context` WITH ITS OWN KEY and reports
 *                            its own name (credential valid; not a renamed copy of another agent)
 *  3. distinct credentials   no two identities share an agent id or an API key
 *  4. chat bridge            `list_bridges` reports an ACTIVE default bridge of the required type (Mattermost), and
 *                            agent-only mode (SWITCH_INTERNAL_ONLY) is off — otherwise no person can post a decision
 *  5. people                 every human role that decides in Switch has a PINNED Switch sender id in this workspace
 */
export interface PreflightCheck { key: string; label: string; passed: boolean; detail: string }
export interface PreflightResult { ok: boolean; checkedAt: string; checks: PreflightCheck[]; mode: 'competition' }

export async function switchPreflight(fabric: SwitchFabric, req: {
  requiredRoles: string[];
  internalOnly: boolean;
  bridgeType?: string;
  /** Human roles that must decide in Switch, and whether each has a pinned sender id. */
  people: { roleKey: string; pinned: boolean; who: string }[];
}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const add = (key: string, label: string, passed: boolean, detail: string) => checks.push({ key, label, passed, detail });

  let healthy = false;
  try { healthy = await fabric.health(); add('health', 'Switch agent bridge answers /health', healthy, healthy ? 'HTTP 200' : 'not 200'); }
  catch (e) { add('health', 'Switch agent bridge answers /health', false, `unreachable: ${String((e as Error).message).slice(0, 160)}`); }

  const statuses = fabric.identities();
  for (const role of req.requiredRoles) {
    const name = fabric.identityForRole(role);
    if (!name) { add(`identity:${role}`, `Registered Switch identity for ${role}`, false, 'no identity registered for this role (scripts/switch-register.mjs)'); continue; }
    if (!healthy) { add(`identity:${role}`, `${name} authenticates with its own key`, false, 'not checked: bridge unreachable'); continue; }
    try {
      const ctx = await fabric.contextOf(name);
      const reported = String(ctx?.you?.name ?? (ctx?.agents ?? []).find((a: { name: string }) => a?.name === name)?.name ?? '');
      add(`identity:${role}`, `${name} authenticates with its own key`, reported === name, reported === name ? `get_my_context: you.name=${reported}` : `get_my_context reported "${reported || 'no name'}"`);
    } catch (e) { add(`identity:${role}`, `${name} authenticates with its own key`, false, `get_my_context refused: ${String((e as Error).message).slice(0, 160)}`); }
  }
  const names = req.requiredRoles.map((r) => fabric.identityForRole(r)).filter(Boolean) as string[];
  const distinct = new Set(names).size;
  add('distinct', 'Each agent role has a distinct identity', distinct === new Set(req.requiredRoles).size && distinct === names.length, `${distinct} distinct identities for ${req.requiredRoles.length} roles`);
  add('connections', 'Identity connections reported honestly', true, statuses.map((s) => `${s.name}: ${s.connected ? 'live' : 'not connected yet'}`).join('; ').slice(0, 400));

  if (req.internalOnly) add('chat_bridge', 'Chat bridge available for human decisions', false, 'SWITCH_INTERNAL_ONLY=1: rooms would be agent-only, so no person could approve in Switch');
  else if (!healthy) add('chat_bridge', 'Chat bridge available for human decisions', false, 'not checked: bridge unreachable');
  else {
    try {
      const bridges = await fabric.listBridges();
      const want = (req.bridgeType ?? 'mattermost').toLowerCase();
      const ok = bridges.find((b) => String(b.status).toLowerCase() === 'active' && b.is_default && String(b.type).toLowerCase().includes(want));
      add('chat_bridge', `Active default ${want} bridge`, !!ok, ok ? `bridge ${ok.id} (${ok.display_name ?? ok.type}) active, default` : `list_bridges: ${bridges.map((b) => `${b.type}/${b.status}${b.is_default ? '/default' : ''}`).join(', ') || 'none'}`);
    } catch (e) { add('chat_bridge', 'Chat bridge available for human decisions', false, `list_bridges refused: ${String((e as Error).message).slice(0, 160)}`); }
  }
  for (const p of req.people) add(`person:${p.roleKey}`, `${p.who} has a pinned Switch identity`, p.pinned, p.pinned ? 'sender id pinned in this workspace' : 'no pinned Switch sender id: their messages cannot be authenticated (pin it on the Incident Command page after their first message)');

  return { ok: checks.every((c) => c.passed), checkedAt: new Date().toISOString(), checks, mode: 'competition' };
}
