import { useState } from 'react';
import { fmtTime, useApi } from '../api';
import { Empty, ErrorView, Loading, useToast } from '../components/ui';

export function EvidencePage() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>('/evidence', 6000);
  const [filter, setFilter] = useState<'all' | 'pass' | 'fail'>('all');
  const [search, setSearch] = useState<string>('');
  const [inspectItem, setInspectItem] = useState<any | null>(null);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorView error={error} retry={reload} />;

  const evidenceList = data?.evidence || [];
  const outcomes = data?.outcomes || [];

  const filteredEvidence = evidenceList.filter((e: any) => {
    if (filter === 'pass' && !e.passed) return false;
    if (filter === 'fail' && e.passed) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!e.check_name.toLowerCase().includes(q) &&
          !e.detail?.toLowerCase().includes(q) &&
          !e.mission_title?.toLowerCase().includes(q) &&
          !e.verifier?.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  const exportEvidence = () => {
    const jsonStr = JSON.stringify({
      exportedAt: new Date().toISOString(),
      workspaceOutcomes: outcomes,
      verifiedEvidence: evidenceList
    }, null, 2);

    navigator.clipboard.writeText(jsonStr);
    toast.ok('Evidence ledger copied to clipboard as JSON bundle!');
  };

  const passCount = evidenceList.filter((e: any) => e.passed).length;
  const failCount = evidenceList.filter((e: any) => !e.passed).length;

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <h1>Evidence & Verified Outcomes</h1>
          <p className="muted" style={{ margin: 0 }}>
            Every action and deliverable is independently verified from read-backs and recorded telemetry — never accepted on an agent's claim.
          </p>
        </div>
        <div className="row">
          <button onClick={exportEvidence}>
            📥 Export Evidence Dossier
          </button>
        </div>
      </div>

      {/* KPI Stats */}
      <div className="grid g3" style={{ marginBottom: 16 }}>
        <div className="card elevated" style={{ marginBottom: 0 }}>
          <div className="muted small">Verified Passing Checks</div>
          <div className="stat" style={{ color: 'var(--ok)' }}>{passCount}</div>
        </div>
        <div className="card elevated" style={{ marginBottom: 0 }}>
          <div className="muted small">Refused / Failed Checks</div>
          <div className="stat" style={{ color: failCount ? 'var(--bad)' : 'var(--muted)' }}>{failCount}</div>
        </div>
        <div className="card elevated" style={{ marginBottom: 0 }}>
          <div className="muted small">Completed Mission Outcomes</div>
          <div className="stat" style={{ color: 'var(--ink-bright)' }}>{outcomes.length}</div>
        </div>
      </div>

      {/* Outcome Records */}
      <div className="card elevated" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2>Outcome Records ({outcomes.length})</h2>
          <span className="small muted">Missions complete ONLY when all completion criteria are verified</span>
        </div>

        {outcomes.length ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
            {outcomes.map((o: any) => (
              <div key={o.id} style={{ background: 'var(--surface)', padding: '14px', borderRadius: 8, border: '1px solid var(--line)' }}>
                <div className="row between" style={{ marginBottom: 6 }}>
                  <a href={`#/mission/${o.mission_id}`} style={{ fontWeight: 700, fontSize: 14 }}>
                    {o.mission_title}
                  </a>
                  <span className="badge b-ok">Completed Outcome</span>
                </div>
                <div className="small muted" style={{ marginBottom: 8 }}>
                  Recorded {fmtTime(o.created_at)} · Baseline v{o.new_baseline_version}
                </div>
                <div className="small" style={{ lineHeight: 1.5, marginBottom: 10 }}>
                  {o.summary}
                </div>
                
                {/* Completion Criteria Breakdown */}
                {Array.isArray(o.criteria) && o.criteria.length > 0 && (
                  <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px 10px', borderRadius: 6, marginBottom: 8 }}>
                    <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>SATISFIED COMPLETION CRITERIA:</div>
                    {o.criteria.map((c: any, i: number) => (
                      <div key={i} className="small" style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>✓</span> <span>{typeof c === 'string' ? c : c.rule || c.label || JSON.stringify(c)}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="small muted">
                  <strong>Unresolved items recorded:</strong>{' '}
                  {o.unresolved?.length ? o.unresolved.join(' · ') : <span style={{ color: '#10b981' }}>None (100% Resolved)</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No completed mission outcomes yet. Completion gates require verified evidence.</Empty>
        )}
      </div>

      {/* Evidence Ledger Table */}
      <div className="card flush elevated">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)' }} className="row between">
          <div>
            <h2>Independent Verification Ledger ({filteredEvidence.length})</h2>
            <p className="small muted" style={{ margin: 0 }}>
              Audit-grade proof recorded directly by verifiers upon reading real effects.
            </p>
          </div>
          <div className="row">
            <input
              type="search"
              placeholder="Search checks & details..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as any)}
              style={{ width: 'auto' }}
            >
              <option value="all">All Results</option>
              <option value="pass">Pass Only</option>
              <option value="fail">Fail Only</option>
            </select>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Result</th>
                <th>Verification Check</th>
                <th>Target Action / Mission</th>
                <th>Evidence Detail</th>
                <th>Verifier Authority</th>
                <th>Timestamp</th>
                <th>Inspect</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvidence.map((e: any) => (
                <tr key={e.id}>
                  <td>
                    <span className={`badge ${e.passed ? 'b-ok' : 'b-bad'}`}>
                      {e.passed ? '✓ PASS' : '✕ FAIL'}
                    </span>
                  </td>
                  <td>
                    <strong>{e.check_name}</strong>
                  </td>
                  <td className="small">
                    <div>{e.action_title || <span className="muted">Mission Check</span>}</div>
                    <div className="muted">{e.mission_title}</div>
                  </td>
                  <td className="small" style={{ maxWidth: 320 }}>
                    {e.detail}
                  </td>
                  <td className="mono small">
                    <span className="badge">{e.verifier}</span>
                  </td>
                  <td className="small muted">
                    {fmtTime(e.created_at)}
                  </td>
                  <td>
                    <button className="sm" onClick={() => setInspectItem(e)}>
                      Inspect 🔍
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filteredEvidence.length && <Empty>No evidence records matching current filter.</Empty>}
      </div>

      {/* Evidence Payload Inspection Modal */}
      {inspectItem && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: 16
          }}
          onClick={() => setInspectItem(null)}
        >
          <div
            className="card elevated"
            style={{ maxWidth: 600, width: '100%', border: '2px solid var(--emerald)', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row between" style={{ marginBottom: 12 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className={`badge ${inspectItem.passed ? 'b-ok' : 'b-bad'}`}>
                  {inspectItem.passed ? '✓ PASS' : '✕ FAIL'}
                </span>
                <h2>{inspectItem.check_name}</h2>
              </div>
              <button className="sm" onClick={() => setInspectItem(null)}>✕</button>
            </div>

            <div className="small muted" style={{ marginBottom: 10 }}>
              Mission: <strong>{inspectItem.mission_title}</strong> · Recorded: {fmtTime(inspectItem.created_at)}
            </div>

            <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--line)', marginBottom: 12 }}>
              <div className="small" style={{ marginBottom: 4 }}>
                <strong>Verifier Identity:</strong> <span className="mono">{inspectItem.verifier}</span>
              </div>
              <div className="small">
                <strong>Findings Detail:</strong> {inspectItem.detail}
              </div>
            </div>

            <label className="small muted">Recorded Cryptographic Evidence Payload (JSON)</label>
            <textarea
              readOnly
              className="code"
              style={{ flex: 1, minHeight: 200, fontSize: 11, background: '#0a0e17' }}
              value={JSON.stringify(inspectItem.data || {}, null, 2)}
            />

            <div className="row between" style={{ marginTop: 14 }}>
              <button
                className="sm"
                onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify(inspectItem, null, 2));
                  toast.ok('Item copied to clipboard');
                }}
              >
                Copy Payload JSON
              </button>
              <button className="primary sm" onClick={() => setInspectItem(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
