import { useEffect, useState } from 'react';
import { api, fmtTime, go, useApi } from '../api';
import { Empty, ErrorView, Loading, StateBadge, useAction, Banner } from '../components/ui';
import type { Me } from '../App';

export function Missions({ me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<any>('/missions', 5000);
  const [creating, setCreating] = useState(false);
  const canCreate = me.user.role === 'owner' || me.user.role === 'manager';
  if (loading && !data) return <Loading />; if (error) return <ErrorView error={error} retry={reload} />;
  return <>
    <div className="row between"><h1>Missions</h1>{canCreate && <button className="primary" onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'New mission'}</button>}</div>
    {!canCreate && <p className="muted">Your role ({me.user.role}) can view missions but not create them.</p>}
    {creating && <NewMission onCreated={(id) => go(`#/mission/${id}`)} />}
    <div className="card flush"><div className="table-wrap"><table><thead><tr><th>Mission</th><th>Workflow</th><th>State</th><th>Why</th><th>Updated</th></tr></thead><tbody>
      {data.missions.map((m: any) => <tr key={m.id}><td><a href={`#/mission/${m.id}`}>{m.title}</a></td><td>{m.pack_name}</td><td><StateBadge state={m.state} /></td><td className="small muted" style={{ maxWidth: 420 }}>{m.state_reason}</td><td className="small">{fmtTime(m.updated_at)}</td></tr>)}
    </tbody></table></div>{!data.missions.length && <Empty>No missions yet.{canCreate ? ' Click "New mission", pick a workflow pack and load its sample plan.' : ''}</Empty>}</div>
  </>;
}

function NewMission({ onCreated }: { onCreated: (id: string) => void }) {
  const { data: packs } = useApi<any>('/packs');
  const [packId, setPackId] = useState(''); const [title, setTitle] = useState(''); const [plan, setPlan] = useState(''); const [source, setSource] = useState('form'); const [msg, setMsg] = useState('');
  const { busy, run } = useAction();
  const impl = packs?.packs.filter((p: any) => p.status === 'implemented') ?? [];
  // Session 19: default to the first pack the server lists (was a hardcoded id).
  useEffect(() => { if (!packId && impl.length) setPackId(impl[0].id); }, [packId, impl.length]);
  const loadSample = async () => { const p = await api('GET', `/packs/${packId}`); setTitle(p.sample.title); setPlan(JSON.stringify(p.sample.plan, null, 2)); setSource('sample'); setMsg('Sample plan loaded (labelled demonstration data — edit it or paste your own).'); };
  useEffect(() => { setPlan(''); setMsg(''); }, [packId]);
  const onFile = async (f?: File) => { if (!f) return; if (f.size > 300_000) return setMsg('File too large (max 300 KB).'); const text = await f.text(); const r = await run('upload', () => api('POST', '/uploads/plan', { packId, filename: f.name, content: text })); if (r) { setPlan(JSON.stringify(r.plan, null, 2)); setSource(`upload:${r.filename}`); setMsg(`Validated ${r.filename}.`); if (!title) setTitle(r.plan.event?.name ?? r.plan.production?.title ?? f.name); } };
  const create = async () => { let parsed: unknown; try { parsed = JSON.parse(plan); } catch { return setMsg('Plan is not valid JSON.'); } const r = await run('create', () => api('POST', '/missions', { packId, title, plan: parsed, source }), 'Mission created'); if (r) onCreated(r.mission.id); };
  return <div className="card"><h2>New mission</h2>
    <div className="grid g2"><div><label htmlFor="pk">Workflow pack</label><select id="pk" value={packId} onChange={(e) => setPackId(e.target.value)}>{impl.map((p: any) => <option key={p.id} value={p.id}>{p.name} — {p.domain}</option>)}</select></div>
      <div><label htmlFor="tt">Mission title</label><input id="tt" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} /></div></div>
    <label htmlFor="pl">Original approved plan (JSON, validated server-side)</label>
    <div className="row" style={{ marginBottom: 6 }}><button onClick={loadSample}>Load sample plan</button><label className="btn" style={{ margin: 0, color: 'var(--ink)' }}>Upload .json<input type="file" accept=".json,application/json" hidden onChange={(e) => onFile(e.target.files?.[0])} /></label></div>
    <textarea id="pl" className="code" value={plan} onChange={(e) => { setPlan(e.target.value); setSource('form'); }} placeholder="Paste or upload the original plan…" />
    {msg && <Banner tone="info">{msg}</Banner>}
    <div className="row" style={{ marginTop: 10 }}><button className="primary" disabled={!title.trim() || !plan.trim() || busy === 'create'} onClick={create}>Create mission</button></div>
  </div>;
}
