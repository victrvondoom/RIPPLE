import { useMemo, useState } from 'react';
import { fmtTime, useApi } from '../../api';
import { Empty, ErrorView, Loading, StateBadge } from '../../components/ui';
import { Header, Pri, SysTag, SYS_LABEL } from './common';

/** Dashboard 2 — Operations Workbench: one case list with context-specific workspaces (one per capability system). */
export function Workbench() {
  const { data, error, loading, reload } = useApi<any>('/dash/workbench', 6000);
  const [ws, setWs] = useState('');
  const [q, setQ] = useState('');
  const [pri, setPri] = useState<string[]>([]);
  const [state, setState] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const cases = useMemo(() => (data?.cases ?? []).filter((c: any) =>
    (!ws || c.system === ws) && (!pri.length || pri.includes(c.priority)) && (!state || c.state === state) &&
    (!q || `${c.ref} ${c.title} ${c.pack_name} ${c.owner} ${c.assignees.join(' ')}`.toLowerCase().includes(q.toLowerCase()))), [data, ws, q, pri, state]);
  if (loading && !data) return <Loading />; if (error) return <ErrorView error={error} retry={reload} />; if (!data) return null;
  const count = (k: string, v: string) => data.facets[k].find((f: any) => f.key === v)?.n ?? 0;
  const togglePri = (p: string) => setPri(pri.includes(p) ? pri.filter((x) => x !== p) : [...pri, p]);
  const current = sel && cases.some((c: any) => c.id === sel) ? sel : cases[0]?.id ?? null;
  return <>
    <Header kicker="Dashboard 2 · Operations Workbench" title="Case dashboard" sub="Where the work happens. Each capability system is a workspace view over the same missions, not a separate app." right={<a className="btn primary" href="#/missions">Open a new case</a>} />
    <div className="tabs dash-tabs" role="tablist" aria-label="Workspace">
      <button role="tab" aria-selected={!ws} className={!ws ? 'active' : ''} onClick={() => setWs('')}>All workspaces <span className="count">{data.cases.length}</span></button>
      {data.systems.map((s: any) => <button key={s.id} role="tab" aria-selected={ws === s.id} className={ws === s.id ? 'active' : ''} onClick={() => setWs(s.id)}>{s.workspace} <span className="count">{count('system', s.id)}</span></button>)}
    </div>
    <div className="dash-wb">
      <aside className="card dash-filters" aria-label="Filters">
        <div className="row between"><h3 style={{ margin: 0 }}>Filters</h3><button className="linkish small" onClick={() => { setPri([]); setState(''); setQ(''); }}>Reset</button></div>
        <label htmlFor="wbq">Search</label><input id="wbq" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Case, owner, pack…" />
        <div className="small muted" style={{ marginTop: 10 }}>Priority</div>
        {['high', 'medium', 'low'].map((p) => <label key={p} className="inline"><input type="checkbox" checked={pri.includes(p)} onChange={() => togglePri(p)} />{p} <span className="muted small">({count('priority', p)})</span></label>)}
        <label htmlFor="wbs" style={{ marginTop: 10 }}>Status</label>
        <select id="wbs" value={state} onChange={(e) => setState(e.target.value)}><option value="">Any status</option>{data.facets.state.map((f: any) => <option key={f.key} value={f.key}>{f.key.replace(/_/g, ' ')} ({f.n})</option>)}</select>
      </aside>
      <div className="card" style={{ minWidth: 0 }}>
        <div className="row between"><h2>{ws ? SYS_LABEL[ws] : 'All'} cases</h2><span className="small muted">{cases.length} result(s)</span></div>
        {cases.length ? <div className="table-wrap"><table><thead><tr><th>Case</th><th>Title</th><th>Workspace</th><th>Owner</th><th>Priority</th><th>Status</th><th>Due</th><th>Activity</th></tr></thead><tbody>
          {cases.map((c: any) => <tr key={c.id} className={current === c.id ? 'dash-row-sel' : ''} onClick={() => setSel(c.id)} style={{ cursor: 'pointer' }}>
            <td className="mono small"><button className="linkish" onClick={() => setSel(c.id)}>{c.ref}</button></td>
            <td><strong>{c.title}</strong><div className="small muted">{c.pack_name}</div></td>
            <td><SysTag id={c.system} /></td><td className="small">{c.owner}{c.assignees.length ? <div className="muted">+ {c.assignees.join(', ')}</div> : null}</td>
            <td><Pri p={c.priority} /></td><td><StateBadge state={c.state} /></td>
            <td className="small">{c.due ? String(c.due).slice(0, 10) : '—'}</td><td className="small">{c.activity} events</td></tr>)}
        </tbody></table></div> : <Empty>{data.cases.length ? 'No case matches these filters.' : 'No cases yet. Start one from Workflow Packs, or say “start demo invoiceguard” in the Switch room.'}</Empty>}
      </div>
    </div>
    {current && <CasePanel id={current} />}
  </>;
}

function CasePanel({ id }: { id: string }) {
  const { data, error, loading } = useApi<any>(`/dash/workbench/${id}`, 6000);
  if (loading && !data) return <Loading />; if (error) return <ErrorView error={error} />; if (!data) return null;
  return <div className="grid dash-split">
    <div className="card">
      <div className="row between"><h2>Case timeline · {data.title}</h2><a className="btn primary sm" href={`#/mission/${data.id}`}>Open case</a></div>
      <ol className="dash-timeline">{data.timeline.slice(-14).map((t: any, i: number) => <li key={i} className={`tl-${t.actor_kind}`}>
        <div className="row between"><strong className="small">{t.type.replace(/_/g, ' ')}</strong><span className="small muted">{fmtTime(t.created_at)}</span></div>
        <div className="small">{t.summary}</div><div className="small muted">{t.actor_kind}: {t.actor}</div></li>)}</ol>
    </div>
    <div className="card">
      <h2>Next action</h2>
      <div className={`banner ${data.next.kind === 'info' ? 'info' : 'warn'}`}><strong>{data.next.label}</strong></div>
      <h3 style={{ marginTop: 14 }}>Completion criteria</h3>
      <ul className="list">{data.completion.checks.map((c: any) => <li key={c.key}><span className={`badge ${c.passed ? 'b-ok' : 'b-warn'}`}>{c.passed ? 'met' : 'open'}</span> {c.label}<div className="small muted">{c.detail}</div></li>)}</ul>
      <h3 style={{ marginTop: 14 }}>Latest evidence</h3>
      {data.evidence.length ? <ul className="list">{data.evidence.map((e: any, i: number) => <li key={i}><span className={`badge ${e.passed ? 'b-ok' : 'b-bad'}`}>{e.passed ? 'passed' : 'failed'}</span> {e.check_name}<div className="small muted">{e.verifier} · {fmtTime(e.created_at)}</div></li>)}</ul> : <Empty>No evidence recorded yet.</Empty>}
    </div>
  </div>;
}
