import { useState } from 'react';
import { api, fmtTime, useApi } from '../../api';
import { Empty, ErrorView, Loading, Status, useAction } from '../../components/ui';
import type { Me } from '../../App';
import { Header, Kpi } from './common';

/** Dashboard 3 — Trust & Evidence Center: is this actually trustworthy? Receipts, seals, separation of duties, failures. */
export function TrustCenter({ me }: { me: Me }) {
  const { data, error, loading, reload, setData } = useApi<any>('/dash/trust', 8000);
  const { busy, run } = useAction();
  const [filter, setFilter] = useState<'all' | 'passed' | 'failed'>('all');
  const [receipt, setReceipt] = useState<any>(null); // last receipt issued from this page (session 16)
  const [q, setQ] = useState('');
  if (loading && !data) return <Loading />; if (error) return <ErrorView error={error} retry={reload} />; if (!data) return null;
  const canSeal = ['owner', 'manager'].includes(me.user.role);
  const chain = data.chain;
  const verify = () => run('verify', async () => { const v = await api('POST', '/dash/trust/verify'); setData({ ...data, chain: v }); }, 'Chain re-verified from the stored audit log.');
  const seal = () => run('seal', async () => { await api('POST', '/dash/trust/seal'); reload(); }, 'Ledger sealed at the current head.');
  const issueReceipt = () => run('receipt', async () => { setReceipt(await api('POST', '/dash/trust/receipt')); }, 'Ledger receipt issued over the current head.');
  const gapSeals = (chain.seals ?? []).filter((s: any) => s.reconciliation?.status === 'gap').length;
  const receipts = data.receipts.filter((r: any) => (filter === 'all' || (filter === 'passed') === r.passed) && (!q || `${r.check} ${r.action ?? ''} ${r.mission_title} ${r.verifier}`.toLowerCase().includes(q.toLowerCase())));
  return <>
    <Header kicker="Dashboard 3 · Trust & Evidence" title="Verification history" sub="The audit-integrity surface: re-verify the hash chain, review approvals and failed checks, and export portable receipts." />

    <div className="grid dash-split3">
      <div className="card term dash-chain">
        <div className="row between"><strong>Ledger hash chain</strong><span className={`badge ${!chain.seals.length ? '' : chain.intact ? 'b-ok' : 'b-bad'}`}>{!chain.seals.length ? 'not sealed yet' : chain.intact ? 'all seals intact' : 'TAMPER DETECTED'}</span></div>
        <div className="small mono" style={{ margin: '8px 0', wordBreak: 'break-all' }}>head {chain.current.head.slice(0, 32)}…<br />over {chain.current.count} audit event(s)</div>
        <div className="small" style={{ opacity: .8 }}>No verdict is shown until the server recomputes the chain. Last check: {fmtTime(chain.verifiedAt)}.</div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="sm primary" disabled={!!busy} onClick={verify}>{busy === 'verify' ? 'Verifying…' : 'Verify chain'}</button>
          {canSeal && <button className="sm" disabled={!!busy} onClick={seal}>{busy === 'seal' ? 'Sealing…' : 'Seal current head'}</button>}
          {canSeal && <button className="sm" disabled={!!busy} onClick={issueReceipt}>{busy === 'receipt' ? 'Issuing…' : 'Issue receipt'}</button>}
        </div>
        {gapSeals > 0 && <div className="small" style={{ marginTop: 8, color: 'var(--danger, #b42318)' }}>Reconciliation: {gapSeals} seal(s) report covered events that are no longer present.</div>}
        {receipt && <div className="small" style={{ marginTop: 10 }}>
          <div className="mono" style={{ wordBreak: 'break-all' }}>receipt {receipt.receiptId} · {receipt.chain.events} event(s) · head {receipt.chain.head.slice(0, 24)}…</div>
          <div><span className={`badge ${receipt.signed ? 'b-ok' : ''}`}>{receipt.signed ? 'signed (Ed25519)' : 'UNSIGNED'}</span> {receipt.labels.join(' · ')}</div>
          <a className="btn sm" style={{ marginTop: 6 }} href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(receipt, null, 2))}`} download={`receipt-${receipt.receiptId}.json`}>Download JSON</a>
        </div>}
        {chain.seals.length > 0 && <ul className="list small" style={{ marginTop: 10 }}>{chain.seals.slice(-4).reverse().map((s: any) => <li key={s.id}><span className={`badge ${s.intact ? 'b-ok' : 'b-bad'}`}>{s.intact ? 'intact' : 'broken'}</span> {s.upto} events · {s.sealed_by} · {fmtTime(s.sealed_at)}</li>)}</ul>}
      </div>
      <div className="card">
        <h2>Outcomes · last 24h</h2>
        <div className="grid g2">
          <Kpi label="Approvals granted" value={data.outcomes24h.granted} />
          <Kpi label="Approvals rejected" value={data.outcomes24h.rejected} />
          <Kpi label="Checks passed" value={data.outcomes24h.checksPassed} tone="ok" />
          <Kpi label="Checks failed" value={data.outcomes24h.checksFailed} tone={data.outcomes24h.checksFailed ? 'bad' : undefined} />
        </div>
      </div>
      <div className="card">
        <h2>Separation of duties</h2>
        <p className="small muted" style={{ marginTop: 0 }}>Re-checked from the ledger on every load: an executed consequential action needs a human approval, and no evidence may be signed by the proposing role.</p>
        <div className="stat">{data.separation.violations} <span className="small muted">violation(s) in {data.separation.checked} executed action(s)</span></div>
        <div className="small muted" style={{ marginTop: 6 }}>{data.passports} reality passport(s) · connectors: {data.connectors.map((c: any) => `${c.name} (${c.mode})`).join(', ')}</div>
      </div>
    </div>

    <div className="card">
      <div className="row between"><h2>Verification receipts</h2>
        <div className="row">
          <input aria-label="Search receipts" placeholder="Search check, action, verifier…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
          {(['all', 'passed', 'failed'] as const).map((f) => <button key={f} className={`sm ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>{f}</button>)}
        </div></div>
      {receipts.length ? <div className="table-wrap"><table><thead><tr><th>Result</th><th>Check</th><th>Action · mission</th><th>Verifier</th><th>Approved by</th><th>Bound to</th><th>Receipt</th></tr></thead><tbody>
        {receipts.map((r: any) => <tr key={r.evidence_id}>
          <td><span className={`badge ${r.passed ? 'b-ok' : 'b-bad'}`}>{r.passed ? 'passed' : 'failed'}</span></td>
          <td><strong className="small">{r.check}</strong><div className="small muted">{String(r.detail ?? '').slice(0, 120)}</div></td>
          <td className="small">{r.action ?? '—'}<div className="muted"><a href={`#/mission/${r.mission_id}`}>{r.mission_title}</a></div></td>
          <td className="small mono">{r.verifier}<div className="muted">{fmtTime(r.observed_at)}</div></td>
          <td className="small">{r.approval ? <>{r.approval.decided_by ?? '—'} <Status s={r.approval.status} /></> : '—'}</td>
          <td className="small mono">{r.baseline_version !== null && r.baseline_version !== undefined ? `baseline v${r.baseline_version} · change #${r.change_seq}` : '—'}{r.payload_hash ? <div className="muted">payload {String(r.payload_hash).slice(0, 10)}…</div> : null}</td>
          <td><a className="btn sm" href={`/api/dash/trust/receipts/${r.evidence_id}`} download>JSON</a><div className="small mono muted">{r.receipt_hash.slice(0, 10)}…</div></td></tr>)}
      </tbody></table></div> : <Empty>{data.receipts.length ? 'No receipt matches.' : 'No independent verification has run yet. Execute an approved action to produce the first receipt.'}</Empty>}
    </div>

    <div className="grid g2">
      <div className="card">
        <h2>Failed verification & recovery</h2>
        {data.failures.length ? <ul className="list">{data.failures.map((f: any) => <li key={f.id}><div className="row between"><a href={`#/mission/${f.mission_id}`}>{f.title}</a><Status s={f.status} /></div><div className="small muted">{f.mission_title} · {f.last_error ?? f.stale_reason ?? '—'} · {f.attempts} attempt(s)</div></li>)}</ul> : <Empty>No failed, stale or unknown executions.</Empty>}
      </div>
      <div className="card">
        <h2>Tenant audit log</h2>
        <ul className="list">{data.audit.map((x: any, i: number) => <li key={i}><div className="row between"><span className="small"><strong>{x.type.replace(/_/g, ' ')}</strong> · {x.actor_kind}: {x.actor}</span><span className="small muted">{fmtTime(x.created_at)}</span></div><div className="small">{x.summary}</div></li>)}</ul>
      </div>
    </div>
  </>;
}
