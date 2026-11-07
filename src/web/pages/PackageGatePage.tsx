import { useState } from 'react';
import { api, fmtTime, go, useApi } from '../api';
import { Banner, Empty, ErrorView, Loading, StateBadge, useAction } from '../components/ui';
import type { Me } from '../App';

/**
 * Package Gate (session 19). Renders /api/pkgguard/overview only: every number and list comes from the server (recorded
 * decisions, live registry observations, the benchmark's metrics file). The page holds no business rules.
 */
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const ci = (c: number[] | null | undefined) => (c ? ` [${c[0]}–${c[1]}]` : '');

export function PackageGatePage({ me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<any>('/pkgguard/overview', 15000);
  const { busy, run } = useAction();
  const [message, setMessage] = useState('');
  const [room, setRoom] = useState('#general');
  const [who, setWho] = useState('');
  const [kind, setKind] = useState<'human' | 'agent'>('agent');
  const [last, setLast] = useState<any>(null);
  const role = me.user.role as string;
  if (loading && !data) return <Loading />;
  if (error) return <ErrorView error={error} retry={reload} />;
  const b = data.benchmark;

  const check = async () => {
    const r = await run('check', () => api<any>('POST', '/pkgguard/check', { message, room, requestedBy: who.trim() ? { name: who.trim(), kind } : undefined }), 'Registry read and mission opened');
    if (r) { setLast(r); reload(); }
  };

  return <>
    <h1>Package Gate</h1>
    <p className="muted">Paste an install line from a room. Every package is read live from npm or PyPI (metadata, and the archive read as text in memory: nothing is installed or run), then a mission opens for the security lead{data.securityLead ? ` (${data.securityLead.name})` : ''} to decide each flagged package, one exact version at a time.</p>
    {!data.securityLead && <Banner tone="warn" title="No security lead">Nobody in this workspace is mapped to the Package Gate security lead role, so no check can open.</Banner>}

    {(role === 'manager' || role === 'owner') && <section className="card">
      <h2>Check an install line</h2>
      <label>Message or command<textarea aria-label="Install line" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="npm install express lodash   or   pip install requests" /></label>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label>Room<input aria-label="Room" value={room} onChange={(e) => setRoom(e.target.value)} /></label>
        <label>Asked by (optional)<input aria-label="Asked by" value={who} onChange={(e) => setWho(e.target.value)} placeholder={me.user.name} /></label>
        <label>Sender<select aria-label="Sender kind" value={kind} onChange={(e) => setKind(e.target.value as 'human' | 'agent')}><option value="agent">agent</option><option value="human">human</option></select></label>
      </div>
      <button disabled={!message.trim() || busy === 'check'} onClick={check}>{busy === 'check' ? 'Reading the registries…' : 'Check packages'}</button>
      {last && <div style={{ marginTop: 12 }}>
        <table><thead><tr><th>Package</th><th>Version</th><th>Registry</th><th>Code reading</th><th>Observed</th></tr></thead>
          <tbody>{last.observations.map((o: any) => <tr key={`${o.ecosystem}:${o.name}`}><td className="mono">{o.ecosystem}:{o.name}</td><td>{o.version ?? '—'}</td><td>{o.existence}</td><td>{o.code ?? 'not inspected'}</td><td>{fmtTime(o.observedAt)}</td></tr>)}</tbody></table>
        {last.skipped.length > 0 && <p className="small muted">Not checked: {last.skipped.map((s: any) => `${s.raw} (${s.reason})`).join('; ')}</p>}
        <button className="sm" onClick={() => go(`#/mission/${last.mission.id}`)}>Open the mission</button>
      </div>}
    </section>}

    <section className="card">
      <h2>Rooms</h2>
      {data.rooms.length === 0 ? <Empty>No install has been checked yet.</Empty> : data.rooms.map((r: any) => <div key={r.room} style={{ marginBottom: 16 }}>
        <h3 className="mono">{r.room} <span className="small muted">{r.checks} check(s)</span></h3>
        <p className="small">Review health: {r.review.approved}/{r.review.asked} decisions were approvals{r.review.ratio !== null ? ` (${Math.round(r.review.ratio * 100)}%)` : ''}{r.review.reflex ? ' — nearly every ask ends in approve; the gate may have become a reflex.' : ''}</p>
        <div className="grid2">
          <div><strong className="small">Approved versions</strong>{r.ledger.length === 0 ? <p className="small muted">None.</p> : <ul className="small">{r.ledger.map((l: any) => <li key={`${l.ecosystem}${l.name}${l.version}`}><span className="mono">{l.ecosystem}:{l.name}@{l.version}</span> by {l.approvedBy}, {fmtTime(l.at)}</li>)}</ul>}</div>
          <div><strong className="small">Invented names</strong>{r.invented.length === 0 ? <p className="small muted">None.</p> : <ul className="small">{r.invented.map((i: any) => <li key={`${i.ecosystem}${i.name}`}><span className="mono">{i.ecosystem}:{i.name}</span> asked {i.count}×, first {fmtTime(i.firstSeen)}</li>)}</ul>}</div>
        </div>
      </div>)}
    </section>

    <section className="card">
      <div className="row between"><h2>Squat Watch</h2>{(role === 'manager' || role === 'owner') && <button className="sm" disabled={busy === 'watch'} onClick={async () => { await run('watch', () => api('POST', '/pkgguard/watch/run'), 'Invented names re-read'); reload(); }}>{busy === 'watch' ? 'Reading…' : 'Run now'}</button>}</div>
      <p className="small muted">{data.watchIntervalMinutes > 0 ? `Every invented name is re-read on the registry every ${data.watchIntervalMinutes} minute(s).` : 'The scheduled watch is off (PKGGUARD_WATCH_MINUTES=0); run it on demand.'}</p>
      {data.watch.length === 0 ? <Empty>No watch has run yet.</Empty> : <table><thead><tr><th>Room</th><th>Name</th><th>Status</th><th>Registered seen</th><th>Checked</th></tr></thead>
        <tbody>{data.watch.map((w: any) => <tr key={`${w.room}${w.ecosystem}${w.name}`}><td className="mono">{w.room}</td><td className="mono">{w.ecosystem}:{w.name}</td><td>{w.status}{w.observed_version ? ` (${w.observed_version})` : ''}</td><td>{w.registered_seen_at ? fmtTime(w.registered_seen_at) : '—'}</td><td>{fmtTime(w.checked_at)}</td></tr>)}</tbody></table>}
    </section>

    <section className="card">
      <h2>Recent checks</h2>
      {data.missions.length === 0 ? <Empty>None yet.</Empty> : <table><tbody>{data.missions.map((m: any) => <tr key={m.id}><td><a href={`#/mission/${m.id}`}>{m.title}</a></td><td><StateBadge state={m.state} /></td><td>{fmtTime(m.created_at)}</td></tr>)}</tbody></table>}
    </section>

    <section className="card">
      <h2>Measured detection</h2>
      {!b ? <Empty>No benchmark results file is present on this server.</Empty> : <>
        <p className="small muted">From bench/pkgguard/results/metrics-{b.split}.json ({fmtTime(b.generatedAt)}, rules {b.rules}). Recall with 95% interval; "false alarms" is the share of legitimate packages flagged.</p>
        <table><thead><tr><th>Detector</th><th>Malicious caught</th><th>Legitimate flagged</th></tr></thead><tbody>
          <tr><td>npm metadata, at first malicious publish</td><td>{pct(b.npm.metadataAtPublish?.recall)}{ci(b.npm.metadataAtPublish?.recallCI95)}</td><td>{pct(b.npm.metadataAtPublish?.fpr)}</td></tr>
          <tr><td>npm metadata, averaged over the live window</td><td>{b.npm.liveWindowMean === null ? '—' : `${b.npm.liveWindowMean}%`}</td><td>—</td></tr>
          <tr><td>npm metadata vs fresh (&lt; 30 days) legitimate packages</td><td>—</td><td>{pct(b.npm.freshFalseAlarm?.fpr)}{ci(b.npm.freshFalseAlarm?.fprCI95)}</td></tr>
          <tr><td>npm static code reading</td><td>{pct(b.npm.code?.recall)}{ci(b.npm.code?.recallCI95)}</td><td>{pct(b.npm.code?.fpr)}</td></tr>
          <tr><td>npm metadata or code</td><td>{pct(b.npm.either?.recall)}{ci(b.npm.either?.recallCI95)}</td><td>{pct(b.npm.either?.fpr)}</td></tr>
          <tr><td>PyPI static code reading</td><td>{pct(b.pypi.code?.recall)}{ci(b.pypi.code?.recallCI95)}</td><td>{pct(b.pypi.code?.fpr)}</td></tr>
          <tr><td>Lookalike names (npm / PyPI)</td><td>{pct(b.npm.lookalike?.recall)} / {pct(b.pypi.lookalike?.recall)}</td><td>{pct(b.npm.lookalike?.fpr)} / {pct(b.pypi.lookalike?.fpr)}</td></tr>
        </tbody></table>
        <p className="small muted">Reference lists: {b.reference?.npm ?? '—'}; {b.reference?.pypi ?? '—'}.</p>
      </>}
    </section>
  </>;
}
