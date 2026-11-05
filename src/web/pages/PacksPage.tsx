import { useState } from 'react';
import { api, go, useApi } from '../api';
import { ErrorView, Loading, useAction } from '../components/ui';

export function PacksPage() {
  const { data, error, loading, reload } = useApi<any>('/packs');
  const [sel, setSel] = useState<string | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string>('all');
  const [inspectingSample, setInspectingSample] = useState<any | null>(null);

  const { busy, run } = useAction();

  const demo = async (id: string, runAnalysis: boolean) => {
    const r = await run(
      `${id}${runAnalysis}`,
      () => api('POST', `/packs/${id}/demo`, { runAnalysis }),
      'Demo mission created (labelled sample data)'
    );
    if (r) go(`#/mission/${r.mission.id}`);
  };

  const { data: p } = useApi<any>(sel ? `/packs/${sel}` : null);

  if (loading) return <Loading />;
  if (error) return <ErrorView error={error} retry={reload} />;

  const packs = data?.packs || [];
  const domains = ['all', ...new Set<string>(packs.map((k: any) => k.domain))];

  const filteredPacks = packs.filter((k: any) =>
    selectedDomain === 'all' || k.domain === selectedDomain
  );

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <h1>Workflow Pack Catalog</h1>
          <p className="muted" style={{ margin: 0 }}>
            Domain packs are configuration for the one mission engine — unified dependency graph, approvals, actions, and evidence ledger.
          </p>
        </div>
      </div>

      {/* Domain Category Filter Tabs */}
      <div className="row" style={{ gap: 6, marginBottom: 16, overflowX: 'auto', paddingBottom: 4 }}>
        {domains.map((dom) => (
          <button
            key={dom}
            className={`sm ${selectedDomain === dom ? 'primary' : ''}`}
            onClick={() => setSelectedDomain(dom)}
          >
            {dom === 'all' ? '🌐 All Domains' : dom}
          </button>
        ))}
      </div>

      {/* Pack Cards Grid */}
      <div className="grid g3">
        {filteredPacks.map((k: any) => (
          <div
            key={k.id}
            className="card elevated"
            style={{
              marginBottom: 0,
              display: 'flex',
              flexDirection: 'column',
              borderColor: sel === k.id ? 'var(--emerald)' : undefined
            }}
          >
            <div className="row between" style={{ marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>{k.name}</h2>
              <span className={`badge ${k.status === 'implemented' ? 'b-ok' : ''}`}>
                {k.status}
              </span>
            </div>

            <div className="small muted" style={{ marginBottom: 8 }}>
              Domain: <strong style={{ color: 'var(--ink)' }}>{k.domain}</strong>
            </div>

            <p className="small" style={{ lineHeight: 1.5, marginBottom: 12, flex: 1 }}>
              {k.tagline}
            </p>

            {k.status === 'implemented' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--line-subtle)', paddingTop: 10 }}>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="sm"
                    style={{ flex: 1 }}
                    onClick={() => setSel(sel === k.id ? null : k.id)}
                  >
                    {sel === k.id ? 'Hide Pipeline' : 'Inspect Pipeline 🔍'}
                  </button>
                  <button
                    className="sm"
                    onClick={async () => {
                      const detail = await api('GET', `/packs/${k.id}`);
                      setInspectingSample(detail);
                    }}
                  >
                    Sample JSON 📄
                  </button>
                </div>

                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="sm"
                    style={{ flex: 1 }}
                    disabled={!!busy}
                    onClick={() => demo(k.id, false)}
                  >
                    Load Baseline
                  </button>
                  <button
                    className="sm primary"
                    style={{ flex: 1 }}
                    disabled={!!busy}
                    onClick={() => demo(k.id, true)}
                  >
                    Demo + Analyse ⚡
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Expanded Pack Pipeline & Dependency Details */}
      {p && (
        <div className="card elevated" style={{ marginTop: 20, border: '2px solid var(--emerald)' }}>
          <div className="row between" style={{ marginBottom: 14 }}>
            <div>
              <h2>{p.name} v{p.version} — Pack Architecture & Pipeline</h2>
              <div className="small muted">{p.description}</div>
            </div>
            <button className="sm" onClick={() => setSel(null)}>✕ Close</button>
          </div>

          {/* Sequential Handoff Flow */}
          <div style={{ background: 'var(--surface)', padding: '14px 16px', borderRadius: 8, border: '1px solid var(--line)', marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 11 }}>SEQUENTIAL AGENT HANDOFF PIPELINE</h3>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {p.roleOrder.map((roleKey: string, idx: number) => {
                const r = p.roles.find((ro: any) => ro.key === roleKey);
                return (
                  <div key={roleKey} className="row" style={{ gap: 8 }}>
                    <div style={{ background: 'var(--surface-elevated)', border: '1px solid var(--line-highlight)', padding: '8px 12px', borderRadius: 6 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <span className="badge b-info" style={{ fontSize: 10 }}>#{idx + 1}</span>
                        <strong style={{ fontSize: 13, color: 'var(--ink-bright)' }}>{r?.name || roleKey}</strong>
                      </div>
                      <div className="small muted" style={{ fontSize: 11, marginTop: 4 }}>{r?.responsibility}</div>
                    </div>
                    {idx < p.roleOrder.length - 1 && (
                      <span style={{ color: 'var(--emerald)', fontWeight: 700 }}>➔</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid g2">
            <div>
              <h3>Artifacts Produced</h3>
              <ul className="list">
                {p.artifacts.map((a: any) => (
                  <li key={a.key}>
                    <strong>{a.label}</strong>
                    <div className="small muted">
                      Department: <span className="mono">{a.department}</span> · Owner Role: <span className="mono">{a.ownerRole}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3>Propagation Rules</h3>
              <ul className="list">
                {p.rules.map((r: any) => (
                  <li key={r.id} className="small">
                    <span className="mono" style={{ color: '#38bdf8' }}>{r.id}</span>
                    <div style={{ color: 'var(--ink)', marginTop: 2 }}>{r.why}</div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Sample Scenario Modal */}
      {inspectingSample && (
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
          onClick={() => setInspectingSample(null)}
        >
          <div
            className="card elevated"
            style={{ maxWidth: 640, width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row between" style={{ marginBottom: 12 }}>
              <h2>{inspectingSample.name} — Sample Baseline & Change</h2>
              <button className="sm" onClick={() => setInspectingSample(null)}>✕</button>
            </div>

            <div className="small muted" style={{ marginBottom: 8 }}>
              Scenario: <strong>{inspectingSample.sample?.title}</strong>
            </div>

            <label className="small muted">Approved Baseline Plan (JSON)</label>
            <textarea
              readOnly
              className="code"
              style={{ flex: 1, minHeight: 220, fontSize: 11, background: '#0a0e17', marginBottom: 12 }}
              value={JSON.stringify(inspectingSample.sample?.plan || {}, null, 2)}
            />

            <label className="small muted">Sample Change Event (JSON)</label>
            <textarea
              readOnly
              className="code"
              style={{ minHeight: 120, fontSize: 11, background: '#0a0e17' }}
              value={JSON.stringify(inspectingSample.sample?.change || {}, null, 2)}
            />

            <div className="row between" style={{ marginTop: 14 }}>
              <button
                className="primary sm"
                onClick={() => {
                  demo(inspectingSample.id, true);
                  setInspectingSample(null);
                }}
              >
                Launch Demo With This Plan ⚡
              </button>
              <button className="sm" onClick={() => setInspectingSample(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
