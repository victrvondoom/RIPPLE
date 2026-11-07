import { useState } from 'react';
import { useApi } from '../api';
import { ErrorView, Loading } from '../components/ui';
import { PixelAvatar } from '../components/PixelAvatars';

export function PeopleAgents() {
  const { data, error, loading, reload } = useApi<any>('/people');
  const [activeTab, setActiveTab] = useState<'roster' | 'matrix'>('roster');
  const [search, setSearch] = useState<string>('');

  if (loading && !data) return <Loading />;
  if (error) return <ErrorView error={error} retry={reload} />;

  const users = data?.users || [];
  const agents = data?.agents || [];

  const filteredUsers = users.filter((u: any) =>
    !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.role.toLowerCase().includes(search.toLowerCase()) || u.department?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredAgents = agents.filter((a: any) =>
    !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.pack_id.toLowerCase().includes(search.toLowerCase()) || a.responsibility.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <h1>People & Specialized Agents</h1>
          <p className="muted" style={{ margin: 0 }}>
            Unified collaboration registry: qualified human decision-makers paired with domain-specific agent analyzers.
          </p>
        </div>
        <div className="row">
          <input
            type="search"
            placeholder="Search people & agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <div className="studio-nav-tabs">
            <button className={activeTab === 'roster' ? 'active' : ''} onClick={() => setActiveTab('roster')}>
              👥 Team Roster
            </button>
            <button className={activeTab === 'matrix' ? 'active' : ''} onClick={() => setActiveTab('matrix')}>
              🛡️ Agent Tool Permissions
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'roster' ? (
        <>
          {/* People Grid */}
          <div style={{ marginBottom: 24 }}>
            <div className="row between" style={{ marginBottom: 10 }}>
              <h2>Human Fiduciaries & Department Leads ({filteredUsers.length})</h2>
              <span className="small muted">Hold final decision authority on consequential actions</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
              {filteredUsers.map((u: any) => (
                <div key={u.id} className="card elevated" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="row between">
                    <div className="row" style={{ gap: 12 }}>
                      <div className="agent-icon-box" style={{ width: 44, height: 44 }}>
                        <PixelAvatar type={u.role === 'owner' ? 'crown' : u.department === 'Kitchen' ? 'chef' : u.department === 'Procurement' ? 'scholar' : 'detective'} size={32} />
                      </div>
                      <div>
                        <strong style={{ fontSize: 14, color: 'var(--ink-bright)' }}>{u.name}</strong>
                        <div className="small muted">{u.title} · {u.department || 'General'}</div>
                      </div>
                    </div>
                    <span className={`badge ${u.role === 'owner' ? 'b-bad' : u.role === 'manager' ? 'b-ok' : ''}`}>
                      {u.role}
                    </span>
                  </div>

                  <div className="small" style={{ background: 'var(--surface)', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--line)' }}>
                    <div className="muted" style={{ fontSize: 10, marginBottom: 2 }}>RESPONSIBLE DOMAIN ROLES:</div>
                    <div style={{ color: 'var(--ink)' }}>
                      {u.roles?.length ? u.roles.map((r: any) => `${r.name} (${r.pack})`).join(', ') : 'No pack-specific roles assigned'}
                    </div>
                  </div>

                  <div className="row between small" style={{ marginTop: 'auto', paddingTop: 6, borderTop: '1px solid var(--line-subtle)' }}>
                    <span className="muted">Email: <span className="mono">{u.email}</span></span>
                    <span style={{ color: u.openWork ? 'var(--warn)' : 'var(--ok)', fontWeight: 600 }}>
                      {u.openWork} open task{u.openWork === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Specialized Agents Grid */}
          <div>
            <div className="row between" style={{ marginBottom: 10 }}>
              <h2>Domain Specialist Agents ({filteredAgents.length})</h2>
              <span className="small muted">Deterministic analyzers producing structured findings</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
              {filteredAgents.map((a: any) => {
                const totalRuns = a.runs?.reduce((acc: number, r: any) => acc + r.n, 0) || 0;
                return (
                  <div key={a.id} className="card elevated" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div className="row between">
                      <div className="row" style={{ gap: 10 }}>
                        <div className="agent-icon-box" style={{ width: 40, height: 40 }}>
                          <PixelAvatar type={a.key.includes('chef') ? 'chef' : a.key.includes('auditor') ? 'detective' : a.key.includes('procurement') ? 'scholar' : 'robot'} size={28} />
                        </div>
                        <div>
                          <strong style={{ fontSize: 13, color: 'var(--ink-bright)' }}>{a.name}</strong>
                          <div className="small muted">Pack: <span className="mono">{a.pack_id}</span></div>
                        </div>
                      </div>
                      <span className="badge b-info">Autonomous Agent</span>
                    </div>

                    <p className="small muted" style={{ margin: 0, lineHeight: 1.4 }}>
                      {a.responsibility}
                    </p>

                    <div className="row between small muted" style={{ marginTop: 'auto', paddingTop: 6, borderTop: '1px solid var(--line-subtle)' }}>
                      <span>Mode: <strong style={{ color: '#10b981' }}>Rule-Based</strong></span>
                      <span>Total Executions: <strong style={{ color: 'var(--ink-bright)' }}>{totalRuns}</strong></span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        /* Agent Sandbox & Tool Permissions Matrix */
        <div className="card flush elevated">
          <div style={{ padding: '16px 20px 0' }}>
            <h2>Agent Capability & Sandbox Permissions Matrix</h2>
            <p className="small muted">
              Explicit guardrails: agents propose drafts and flag risks; consequential external effects run only through local dry-run connectors with human sign-off.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent Role</th>
                  <th>Pack Domain</th>
                  <th>Allowed Read Sources</th>
                  <th>Allowed Write Connectors</th>
                  <th>Safety Constraint & Policy Limit</th>
                </tr>
              </thead>
              <tbody>
                {filteredAgents.map((a: any) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                      <div className="small muted mono">{a.key}</div>
                    </td>
                    <td className="small">{a.pack_id}</td>
                    <td className="small">
                      <span className="badge">Plan Baseline</span>{' '}
                      <span className="badge">Change Request</span>{' '}
                      <span className="badge">Human Answers</span>
                    </td>
                    <td className="small">
                      <span className="badge b-info">Local Outbox (Dry-run)</span>{' '}
                      <span className="badge b-ok">Document Store</span>
                    </td>
                    <td className="small" style={{ color: 'var(--warn)' }}>
                      {/* Session 18: the pack declares its agents' limits (labels.agentLimit); the UI no longer switches on pack id. */}
                      {a.limit ?? 'Proposes draft changes; requires fiduciary sign-off'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
