import { useState } from 'react';
import { api, fmtTime, useApi } from '../api';
import { Banner, ErrorView, Loading, useAction } from '../components/ui';
import type { Me } from '../App';

export function SettingsPage({ me, onWorkspaceDeleted }: { me: Me; onWorkspaceDeleted: () => void }) {
  const { data, error, loading, reload } = useApi<any>('/settings');
  const { data: auditData } = useApi<any>('/workspace/audit', 8000);
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState('');
  const [activeTab, setActiveTab] = useState<'system' | 'audit'>('system');

  if (loading) return <Loading />;
  if (error) return <ErrorView error={error} retry={reload} />;

  const owner = me.user.role === 'owner';
  const manager = me.user.role === 'manager';

  const exportData = async () => {
    const r = await run('exp', () => api('GET', '/workspace/export'), 'Export downloaded');
    if (r) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
      a.download = `ripple-export-${me.workspace.name.replace(/\s+/g, '-').toLowerCase()}.json`;
      a.click();
    }
  };

  const auditEvents = auditData?.events || [];

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <h1>Settings & Workspace Governance</h1>
          <p className="muted" style={{ margin: 0 }}>
            Workspace: <strong>{me.workspace.name}</strong> · Role: <span className="badge b-ok">{me.user.role}</span>
          </p>
          <ChangePassword />
        </div>
        <div className="studio-nav-tabs">
          <button className={activeTab === 'system' ? 'active' : ''} onClick={() => setActiveTab('system')}>
            ⚙️ System & Connectors
          </button>
          <button className={activeTab === 'audit' ? 'active' : ''} onClick={() => setActiveTab('audit')}>
            📜 Workspace Audit Log ({auditEvents.length})
          </button>
        </div>
      </div>

      {activeTab === 'system' ? (
        <>
          {/* Active User Session & Authority */}
          <div className="card elevated" style={{ marginBottom: 16 }}>
            <h2>Fiduciary Authority & User Privileges</h2>
            <div className="grid g3">
              <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--line)' }}>
                <div className="small muted">Authenticated User</div>
                <strong style={{ fontSize: 14, color: 'var(--ink-bright)' }}>{me.user.name}</strong>
                <div className="small muted">{me.user.email}</div>
              </div>
              <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--line)' }}>
                <div className="small muted">Assigned Role & Level</div>
                <strong style={{ fontSize: 14, color: '#10b981' }}>{me.user.title} ({me.user.role})</strong>
                <div className="small muted">{me.user.department || 'Executive'}</div>
              </div>
              <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--line)' }}>
                <div className="small muted">Separation of Duties Status</div>
                <strong style={{ fontSize: 14, color: owner || manager ? '#38bdf8' : 'var(--muted)' }}>
                  {owner ? 'Full Owner Governance' : manager ? 'Manager Approval Authority' : 'Read-Only Viewer'}
                </strong>
                <div className="small muted">Enforced server-side via session tokens</div>
              </div>
            </div>
          </div>

          {/* Collaboration Gateway */}
          <div className="card elevated">
            <h2>Collaboration Gateway & Switch Integration</h2>
            <Banner
              tone={data.collab.mode === 'switch' ? 'ok' : 'warn'}
              title={data.collab.mode === 'switch' ? 'Switch adapter configured' : 'LOCAL development mode (Switch is NOT connected)'}
            >
              {data.collab.detail}
            </Banner>
            <p className="small muted">
              Switch integration status: <em>Protocol adapter tested against documented mock specifications</em>. To bind to an active enterprise Switch environment, supply <span className="mono">SWITCH_BRIDGE_URL</span>, <span className="mono">SWITCH_AGENT_ID</span>, and <span className="mono">SWITCH_AGENT_API_KEY</span> in environment variables.
            </p>
          </div>

          {/* Model Provider */}
          <div className="card elevated">
            <h2>Model Provider & Zero-Hallucination Policy</h2>
            <p className="small" style={{ lineHeight: 1.5 }}>
              Provider: <strong style={{ color: 'var(--ink-bright)' }}>{data.provider.name}</strong> ({data.provider.kind}).
              {data.provider.kind === 'deterministic'
                ? ' All agent outputs are rule-based, deterministic, and verifiable. Set ANTHROPIC_API_KEY to enable optional natural language re-wording on client emails (factual data is cryptographically verified to survive).'
                : ' Model wording is used only for outbound communication drafts; all numbers and dates are checked by verifiers.'}
            </p>
          </div>

          {/* Sandboxed Connectors & Fault Injection */}
          <div className="card flush elevated">
            <div style={{ padding: '16px 20px 0' }}>
              <h2>External Connectors & Failure Recovery</h2>
              <p className="small muted">
                Connectors are strictly local dry-run outboxes: no external email, money, or documents are transmitted.
              </p>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Connector</th>
                    <th>Mode</th>
                    <th>Observed Behavior</th>
                    <th>Dev Fault Injection</th>
                  </tr>
                </thead>
                <tbody>
                  {data.connectors.map((c: any) => (
                    <tr key={c.key}>
                      <td>
                        <strong>{c.name}</strong>
                        <div className="small muted mono">{c.key}</div>
                      </td>
                      <td>
                        <span className="badge b-warn">{c.mode}</span>
                      </td>
                      <td className="small" style={{ maxWidth: 380 }}>
                        {c.description}
                      </td>
                      <td>
                        {owner ? (
                          <label className="inline" style={{ margin: 0 }}>
                            <input
                              type="checkbox"
                              checked={c.fail_next}
                              onChange={async (e) => {
                                await run('f' + c.key, () =>
                                  api('POST', `/settings/connectors/${c.key}/fail-next`, { enabled: e.target.checked })
                                );
                                reload();
                              }}
                            />
                            Arm failure next run
                          </label>
                        ) : (
                          <span className="muted small">Owner only</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Data Export & Deletion */}
          <div className="card elevated" style={{ marginTop: 16 }}>
            <h2>Workspace Data Governance</h2>
            {owner ? (
              <>
                <p className="small muted">Export complete cryptographic workspace ledger (all missions, baselines, and evidence).</p>
                <button disabled={busy === 'exp'} onClick={exportData} style={{ marginBottom: 16 }}>
                  📥 Export Complete Workspace Data (JSON)
                </button>

                <h3 style={{ color: 'var(--bad)', marginTop: 16 }}>Danger Zone: Delete Workspace</h3>
                <p className="small muted">
                  Permanently destroys all missions, evidence records, artifacts, and user accounts in this tenant. Type <strong>{me.workspace.name}</strong> to confirm.
                </p>
                <div className="row">
                  <input
                    style={{ maxWidth: 320 }}
                    aria-label="Confirm workspace name"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Type exact workspace name..."
                  />
                  <button
                    className="danger"
                    disabled={confirm !== me.workspace.name}
                    onClick={async () => {
                      if (await run('del', () => api('DELETE', '/workspace', { confirmName: confirm }), 'Workspace deleted')) {
                        onWorkspaceDeleted();
                      }
                    }}
                  >
                    Permanently Delete Workspace
                  </button>
                </div>
              </>
            ) : (
              <p className="muted small">Only the workspace owner holds export and tenant deletion authority.</p>
            )}
          </div>
        </>
      ) : (
        /* Workspace Audit Log Viewer */
        <div className="card flush elevated">
          <div style={{ padding: '16px 20px 0' }} className="row between">
            <div>
              <h2>Immutable Workspace Audit Trail ({auditEvents.length} Recent Events)</h2>
              <p className="small muted">
                Authoritative chronological record of all administrative logins, approvals, mission changes, and fault injections.
              </p>
            </div>
            <button className="sm" onClick={() => reload()}>
              🔄 Refresh
            </button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Actor</th>
                  <th>Event Type</th>
                  <th>Summary & Description</th>
                  <th>Scope</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((ev: any) => (
                  <tr key={ev.id}>
                    <td className="mono small">{fmtTime(ev.created_at)}</td>
                    <td>
                      <strong>{ev.actor}</strong>
                      <div className="small muted">{ev.actor_kind}</div>
                    </td>
                    <td>
                      <span className="badge b-info mono" style={{ fontSize: 10 }}>{ev.type}</span>
                    </td>
                    <td className="small" style={{ maxWidth: 420 }}>
                      {ev.summary}
                    </td>
                    <td className="small muted">
                      {ev.mission_id ? (
                        <a href={`#/mission/${ev.mission_id}`}>Mission</a>
                      ) : (
                        <span>Tenant Global</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!auditEvents.length && <div style={{ padding: 20 }} className="muted small">No audit events recorded yet.</div>}
        </div>
      )}
    </>
  );
}

/** Session 20: change your own password (current password required; your other sessions are signed out). */
function ChangePassword() {
  const [open, setOpen] = useState(false); const [cur, setCur] = useState(''); const [next, setNext] = useState('');
  const { busy, run } = useAction();
  if (!open) return <button className="sm" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>Change password</button>;
  return <form className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }} onSubmit={async (e) => { e.preventDefault(); const r = await run('pw', () => api('POST', '/auth/password', { current: cur, next }), 'Password changed; your other sessions were signed out'); if (r) { setOpen(false); setCur(''); setNext(''); } }}>
    <input type="password" aria-label="Current password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
    <input type="password" aria-label="New password" placeholder="New password (8+)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} />
    <button className="primary sm" type="submit" disabled={!cur || next.length < 8 || busy === 'pw'}>Save</button>
    <button className="sm" type="button" onClick={() => setOpen(false)}>Cancel</button>
  </form>;
}
