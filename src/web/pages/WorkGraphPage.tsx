import { useState } from 'react';
import { api, useApi } from '../api';
import { Empty, ErrorView, Loading, StateBadge, useToast } from '../components/ui';
import { Graph } from '../components/Graph';

export function WorkGraphPage() {
  const toast = useToast();
  const { data: list, error, loading, reload } = useApi<any>('/graph');
  const [sel, setSel] = useState<string>('');
  const [isDemoLoading, setIsDemoLoading] = useState<boolean>(false);

  const missions = list?.missions || [];
  const id = sel || missions[0]?.id;
  const { data: d, loading: l2 } = useApi<any>(id ? `/missions/${id}` : null, 5000);

  // Quick-load demo mission if none exists or to explore another pack
  const loadDemoMission = async (packId: string) => {
    setIsDemoLoading(true);
    try {
      const res = await api('POST', `/packs/${packId}/demo`, { runAnalysis: true });
      toast.ok(`Loaded ${packId} analyzed graph`);
      reload();
      if (res?.mission?.id) {
        setSel(res.mission.id);
      }
    } catch (err: any) {
      toast.err(err.message || 'Failed to create demo mission');
    } finally {
      setIsDemoLoading(false);
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorView error={error} retry={reload} />;

  // Empty state with quick-load demo graphs
  if (!missions.length) {
    return (
      <div className="card elevated">
        <h1>Work Graph & Cross-Domain Impact Architecture</h1>
        <p className="muted">
          RIPPLE's core engine models changes, artifacts, departments, owners, tasks, decisions, actions, and evidence into an immutable dependency DAG.
        </p>

        <div style={{ background: 'var(--surface)', padding: 20, borderRadius: 10, border: '1px solid var(--line)', marginTop: 16 }}>
          <h2 style={{ marginBottom: 6 }}>No Analyzed Missions in Workspace Yet</h2>
          <p className="small muted" style={{ marginBottom: 16 }}>
            Launch a demonstration scenario to visualize how an approved change ripples across departments and generates verified evidence:
          </p>

          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <button className="primary" onClick={() => loadDemoMission('beo-rescue')} disabled={isDemoLoading}>
              🍽️ Load BEO Rescue Graph
            </button>
            <button onClick={() => loadDemoMission('scopeguard')} disabled={isDemoLoading}>
              📑 Load ScopeGuard Graph
            </button>
            <button onClick={() => loadDemoMission('invoiceguard')} disabled={isDemoLoading}>
              🧾 Load InvoiceGuard Graph
            </button>
            <button onClick={() => loadDemoMission('shiftrelay')} disabled={isDemoLoading}>
              🔄 Load ShiftRelay Graph
            </button>
            <button onClick={() => loadDemoMission('submitready')} disabled={isDemoLoading}>
              📋 Load SubmitReady Graph
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div>
          <h1>Work Graph & Multi-Domain Dependency DAG</h1>
          <p className="muted" style={{ margin: 0 }}>
            Unified dependency model: changes propagate downstream through artifacts, human decisions, consequential actions, and verified evidence.
          </p>
        </div>
        <div className="row">
          <label htmlFor="mission-select" className="small muted">Active Mission:</label>
          <select
            id="mission-select"
            aria-label="Mission"
            style={{ minWidth: 260 }}
            value={id}
            onChange={(e) => setSel(e.target.value)}
          >
            {missions.map((m: any) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {l2 && !d ? (
        <Loading />
      ) : d ? (
        <>
          <div className="card elevated" style={{ marginBottom: 14 }}>
            <div className="row between">
              <div className="row" style={{ gap: 10 }}>
                <StateBadge state={d.mission.state} />
                <strong style={{ fontSize: 14, color: 'var(--ink-bright)' }}>{d.mission.title}</strong>
                <span className="badge b-info">{d.mission.pack_name}</span>
              </div>
              <div className="small muted">
                <strong style={{ color: '#10b981' }}>{d.graph.nodes.length}</strong> nodes ·{' '}
                <strong style={{ color: '#38bdf8' }}>{d.graph.edges.length}</strong> edges · Analysis Rev{' '}
                <span className="mono">{d.graph.rev}</span>
              </div>
            </div>
          </div>

          <div className="card flush elevated">
            <div style={{ padding: '14px 18px 0' }}>
              <h2>Interactive Dependency DAG</h2>
              <p className="small muted">
                Click any node to highlight upstream causes and downstream consequences across departments.
              </p>
            </div>
            <div style={{ padding: '0 18px 18px' }}>
              <Graph nodes={d.graph.nodes} edges={d.graph.edges} />
            </div>
          </div>
        </>
      ) : (
        <Empty>Select a mission above to render its dependency graph.</Empty>
      )}
    </>
  );
}
