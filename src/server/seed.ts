import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Db, nowIso, uid } from './db/db.js';
import type { PackRegistry } from './packs/registry.js';

export const hashPassword = (pw: string) => { const salt = randomBytes(16); return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`; };
export function verifyPassword(pw: string, stored: string) {
  const [, saltHex, hashHex] = stored.split('$'); if (!saltHex || !hashHex) return false;
  const h = scryptSync(pw, Buffer.from(saltHex, 'hex'), 32); const e = Buffer.from(hashHex, 'hex');
  return h.length === e.length && timingSafeEqual(h, e);
}

export const DEMO_USERS = [
  { email: 'sam@harborvine.example', name: 'Sam Rivera', role: 'owner', department: 'Operations', title: 'Owner & Escrow Controller', map: ['escrow_controller', 'depgate_owner', 'ev_venue_av'] as string[] },
  { email: 'maya@harborvine.example', name: 'Maya Chen', role: 'manager', department: 'Event Management', title: 'Operations Lead & Commander', map: ['human_manager', 'human_pm', 'human_owner', 'sre_lead', 'data_steward', 'incident_commander', 'ev_speaker_keynote'] },
  { email: 'luis@harborvine.example', name: 'Luis Ortega', role: 'member', department: 'Kitchen', title: 'Head Chef', map: ['human_chef'] },
  { email: 'priya@harborvine.example', name: 'Priya Nair', role: 'member', department: 'Procurement', title: 'Procurement & Escrow Lead', map: ['human_buyer'] },
  { email: 'dan@harborvine.example', name: 'Dan Okafor', role: 'member', department: 'Service', title: 'Service & Engineering Lead', map: ['human_service', 'lead_engineer'] },
  { email: 'vera@harborvine.example', name: 'Vera Holt', role: 'viewer', department: 'Finance', title: 'Observer (read-only)', map: [] },
  // --- run-of-show pack (event day): the lead planner publishes; the panel lead confirms the panel's slot ---
  { email: 'alex@harborvine.example', name: 'Alex Morgan', role: 'manager', department: 'Event Management', title: 'Lead Planner', map: ['ev_lead_planner'] },
  { email: 'jamie@harborvine.example', name: 'Jamie Okoro', role: 'member', department: 'Program', title: 'Panel Lead', map: ['ev_panel_lead'] },
  // --- people for the other workflow packs (same workspace, same engine) ---
  { email: 'ana@harborvine.example', name: 'Ana Silva', role: 'member', department: 'Agency Delivery', title: 'Delivery Lead', map: ['human_lead'] },
  { email: 'ravi@harborvine.example', name: 'Ravi Menon', role: 'member', department: 'Finance', title: 'Finance Controller', map: ['human_finance', 'human_reviewer', 'revenue_controller'] },
  { email: 'tess@harborvine.example', name: 'Tess Kim', role: 'manager', department: 'Field Operations', title: 'Field Supervisor', map: ['human_supervisor'] },
  { email: 'noor@harborvine.example', name: 'Noor Haddad', role: 'manager', department: 'Platform Engineering', title: 'PR Author (owns the sealed agent session)', map: ['flip_author'] },
  { email: 'omar@harborvine.example', name: 'Omar Reyes', role: 'member', department: 'Field Operations', title: 'Incoming Technician', map: ['human_incoming', 'flip_reviewer'] },
  { email: 'jo@harborvine.example', name: 'Jo Park', role: 'member', department: 'Field Operations', title: 'Outgoing Technician', map: ['human_outgoing'] },
  { email: 'nina@harborvine.example', name: 'Nina Patel', role: 'manager', department: 'Personal', title: 'Roommate A', map: ['human_roommate_a'] },
  { email: 'leo@harborvine.example', name: 'Leo Brandt', role: 'manager', department: 'Personal', title: 'Roommate B', map: ['human_roommate_b'] },
  { email: 'cleo@harborvine.example', name: 'Cleo Vance', role: 'manager', department: 'Creator Studio', title: 'Podcast Creator', map: ['human_creator'] },
  { email: 'mia@harborvine.example', name: 'Mia Chen', role: 'manager', department: 'Project Team', title: 'Team Lead (student)', map: ['human_teamlead', 'candidate'] },
  { email: 'ben@harborvine.example', name: 'Ben Ortiz', role: 'member', department: 'Project Team', title: 'Team Member (student)', map: ['human_member', 'resume_reviewer'] },
  // --- consumer-resolution pack (RECLAIM + RESOLVE + REDEEM capabilities) ---
  { email: 'asha@harborvine.example', name: 'Asha Rao', role: 'manager', department: 'Consumer Desk', title: 'Consumer (case owner)', map: ['cr_consumer'] },
  { email: 'kai@harborvine.example', name: 'Kai Mendes', role: 'member', department: 'Consumer Advocacy', title: 'Case Reviewer (consumer advocate)', map: ['cr_case_reviewer'] },
  // --- billing-dispute pack: one company, internal departments (customers stay outside, via email) ---
  { email: 'nora@harborvine.example', name: 'Nora Fischer', role: 'manager', department: 'Finance', title: 'Finance Lead (refunds & credits)', map: ['bd_finance_lead'] },
  { email: 'eli@harborvine.example', name: 'Eli Brooks', role: 'member', department: 'Engineering', title: 'Engineering Lead (on-call)', map: ['bd_eng_lead'] },
  { email: 'sofia@harborvine.example', name: 'Sofia Lind', role: 'manager', department: 'Support', title: 'Support Lead (customer replies)', map: ['bd_support_lead'] },
] as const;

/** Creates a workspace with users, agent-role directory (from every installed pack) and connector config. */
export function seedWorkspace(db: Db, packs: PackRegistry, opts: { name: string; password: string; emailDomain?: string; extraMap?: Record<string, string[]> }) {
  const ws = uid('ws');
  db.insert('workspaces', { id: ws, name: opts.name, created_at: nowIso() });
  const ids: Record<string, string> = {};
  const hash = hashPassword(opts.password);
  for (const u of DEMO_USERS) {
    const id = uid('usr'); ids[u.email] = id;
    const email = opts.emailDomain ? u.email.replace('harborvine.example', opts.emailDomain) : u.email;
    db.insert('users', { id, workspace_id: ws, email, name: u.name, role: u.role, department: u.department, title: u.title, password_hash: hash, created_at: nowIso() });
  }
  for (const pack of packs.all()) for (const r of pack.roles) {
    const owner = DEMO_USERS.find((u) => (u.map as readonly string[]).includes(r.key));
    const mapped = owner ? ids[owner.email] : (opts.extraMap?.[r.key] ? ids[opts.extraMap[r.key][0]] : null);
    db.insert('agent_roles', { id: uid('role'), workspace_id: ws, pack_id: pack.id, key: r.key, name: r.name, kind: r.kind, responsibility: r.responsibility, user_id: r.kind === 'human' ? mapped ?? null : null });
  }
  for (const [key, name, mode] of [['document_store', 'Document store', 'local-filesystem'], ['internal_notify', 'Internal notification', 'local-outbox'], ['email_outbox', 'Email outbox (dry-run)', 'dry-run'], ['warehouse_sandbox', 'Warehouse sandbox (Reality Lab)', 'sandbox'], ['billing_sandbox', 'Billing sandbox (test ledger)', 'sandbox']]) {
    db.insert('connectors', { id: uid('con'), workspace_id: ws, key, name, mode, config: '{}', fail_next: 0 });
  }
  return { workspaceId: ws, userIds: ids };
}

/**
 * Idempotent: for an existing workspace, adds any missing demo users (demo workspace only) and any missing
 * agent-role rows for every installed pack. Lets an existing database pick up newly installed packs.
 */
export function syncDirectory(db: Db, packs: PackRegistry) {
  for (const ws of db.all('SELECT id FROM workspaces')) {
    if (!db.get("SELECT 1 x FROM connectors WHERE workspace_id=? AND key='warehouse_sandbox'", ws.id)) db.insert('connectors', { id: uid('con'), workspace_id: ws.id, key: 'warehouse_sandbox', name: 'Warehouse sandbox (Reality Lab)', mode: 'sandbox', config: '{}', fail_next: 0 });
    if (!db.get("SELECT 1 x FROM connectors WHERE workspace_id=? AND key='billing_sandbox'", ws.id)) db.insert('connectors', { id: uid('con'), workspace_id: ws.id, key: 'billing_sandbox', name: 'Billing sandbox (test ledger)', mode: 'sandbox', config: '{}', fail_next: 0 });
    const isDemo = !!db.get("SELECT 1 x FROM users WHERE workspace_id=? AND email='maya@harborvine.example'", ws.id);
    if (isDemo) {
      const pw = db.get("SELECT password_hash h FROM users WHERE workspace_id=? AND email='maya@harborvine.example'", ws.id)!.h;
      for (const u of DEMO_USERS) if (!db.get('SELECT 1 x FROM users WHERE workspace_id=? AND email=?', ws.id, u.email))
        db.insert('users', { id: uid('usr'), workspace_id: ws.id, email: u.email, name: u.name, role: u.role, department: u.department, title: u.title, password_hash: pw, created_at: nowIso() });
    }
    for (const pack of packs.all()) for (const r of pack.roles) {
      if (db.get('SELECT 1 x FROM agent_roles WHERE workspace_id=? AND pack_id=? AND key=?', ws.id, pack.id, r.key)) continue;
      const owner = isDemo ? DEMO_USERS.find((u) => (u.map as readonly string[]).includes(r.key)) : undefined;
      const user = owner ? db.get('SELECT id FROM users WHERE workspace_id=? AND email=?', ws.id, owner.email) : undefined;
      db.insert('agent_roles', { id: uid('role'), workspace_id: ws.id, pack_id: pack.id, key: r.key, name: r.name, kind: r.kind, responsibility: r.responsibility, user_id: r.kind === 'human' ? user?.id ?? null : null });
    }
  }
}
