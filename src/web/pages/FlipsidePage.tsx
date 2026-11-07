import { useState } from 'react';
import { api, useApi, go } from '../api';
import { Banner, Empty, Loading, useAction } from '../components/ui';
import { Mascot3D, type Mood } from '../components/Mascot3D';
import { MerkleTree3D } from '../components/MerkleTree3D';
import { Stepper } from '../components/Stepper';
import type { Me } from '../App';

/** Flipside review: ask the author's agent why. Renders /api/flipside/:id; every verdict was recomputed on the server. */
export function FlipsidePage({ me }: { me: Me }) {
  const list = useApi<{ missions: { id: string; title: string; state: string }[] }>('/flipside', 8000);
  const [sel, setSel] = useState<string | null>(null);
  const { busy, run } = useAction();
  const id = sel ?? list.data?.missions[0]?.id ?? null;
  const view = useApi<any>(id ? `/flipside/${id}` : null, 4000);
  const v = view.data;
  const start = () => run('start', async () => { const r = await api('POST', '/packs/flipside-review/demo', { runAnalysis: true }); await list.reload(); setSel(r.mission.id); }, 'Sample review started (synthetic PR #142)');
  const after = async () => { await view.reload(); await list.reload(); };
  const [why, setWhy] = useState('');
  const mood: Mood = !v ? 'idle' : v.disclosed ? 'verify' : v.next?.kind === 'approve' ? 'ask' : v.wholeSessionRefused && v.next?.kind === 'none' ? 'refuse' : v.next?.kind === 'deliver' ? 'happy' : 'idle';
  return <div className="fs-page">
    <div className="fs-hero">
      <div className="fs-hero-copy">
        <div className="fs-kicker">Code review · cross-team agents</div>
        <h1>Ask the agent <em>why.</em></h1>
        <p className="muted">The reviewer's agent asks the author's agent why a change was made. The author shares <b>one step</b>, not the session. The reviewer proves it is real: the step is checked against the seal made before review.</p>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button className="primary" disabled={busy === 'start'} onClick={start}>▶ Start a sample review</button>
          {list.data && list.data.missions.length > 1 && <select value={id ?? ''} onChange={(e) => setSel(e.target.value)} aria-label="Choose a review">{list.data.missions.map((m) => <option key={m.id} value={m.id}>{m.title.slice(0, 60)}</option>)}</select>}
        </div>
        <p className="muted small">Deterministic: no model decides anything. The sample PR and session are synthetic. Delivery is a local dry-run outbox; Switch rooms are not used by this page.</p>
      </div>
      <Mascot3D mood={mood} size={230} />
    </div>
    {list.loading && !list.data && <Loading />}
    {list.data && list.data.missions.length === 0 && <Empty>No Flipside review yet. Start a sample review to see the seal, the question, the approval and the proof.</Empty>}
    {v && v.sealed && <>
      <Stepper stages={v.stages} />
      <div className="fs-grid">
        <section className="fs-card fs-dark">
          <MerkleTree3D tree={v.tree} label={`Seal · PR #${v.pr.number}`} />
          <p className="mono fs-meta">{v.pr.repo} · commit {v.seal.commit} · sealed {v.seal.sealedAt}</p>
        </section>
        <section className="fs-card fs-dark fs-room">
          <div className="fs-room-head"># pr-{v.pr.number}-review</div>
          <Msg who="reviewer-agent" tag="AGENT">Read the public PR only. <code>auth/session.py</code> changed and the description never says why. Q1 to {v.author}; requesting one session step, not the session.</Msg>
          {v.answer && <Msg who={v.author.toLowerCase().split(' ')[0]} tag="HUMAN">{v.answer}</Msg>}
          {v.wholeSessionRefused && <Msg who="switch policy" tag="REFUSED" bad>Whole-session request refused. Only one approved step can be shared.</Msg>}
          {v.next.kind === 'answer' && <div className="fs-act">
            <label className="small">{v.author} answers Q1 in their own words (server refuses anyone else):</label>
            <textarea rows={3} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why did auth/session.py change?" />
            <button className="primary sm" disabled={busy === 'ans' || why.trim().length < 10} onClick={() => run('ans', async () => { await api('POST', `/missions/${id}/questions/${v.next.questionId}/answer`, { answer: why }); setWhy(''); await after(); }, 'Answered')}>Send answer</button>
          </div>}
          {v.proposed && v.next.kind === 'approve' && <Msg who="author-agent" tag="AGENT">Disclose step {v.proposed.index} of {v.seal.leafCount} to the review room? {v.seal.leafCount - 1} steps stay private.
            <div className="fs-btns"><button className="ok sm" disabled={busy === 'ap'} onClick={() => run('ap', async () => { await api('POST', `/missions/${id}/approvals/${v.next.approvalId}/decide`, { decision: 'approved', note: 'share this one step' }); await after(); }, 'Approved')}>1. Approve</button>
              <button className="sm" disabled={busy === 'ap'} onClick={() => run('ap', async () => { await api('POST', `/missions/${id}/approvals/${v.next.approvalId}/decide`, { decision: 'rejected', note: 'declined' }); await after(); }, 'Declined')}>2. Decline</button></div>
            <small className="muted">Only {v.author} can decide this card{v.viewer.isAuthor ? ' (that is you)' : `; you are ${me.user.name}`}.</small></Msg>}
          {v.next.kind === 'deliver' && <div className="fs-act"><button className="primary sm" disabled={busy === 'ex'} onClick={() => run('ex', async () => { await api('POST', `/missions/${id}/actions/${v.next.actionId}/execute`); await after(); }, 'Delivered and re-verified')}>Deliver the one step (dry-run) and verify</button></div>}
          {v.disclosed && <Msg who="verifier" tag="AGENT"><span className="fs-ok">{v.disclosed.verdict}</span> step {v.disclosed.index} is in the sealed session (root recomputed from the delivered step and its proof).<blockquote>{v.disclosed.text}</blockquote></Msg>}
          {v.forged && <Msg who="verifier" tag="AGENT" bad={v.forged.verdict !== 'PROOF_FAIL'}><span className={v.forged.verdict === 'PROOF_FAIL' ? 'fs-bad' : 'fs-ok'}>{v.forged.verdict}</span> edited copy of step {v.forged.index}: {v.forged.reason}.<blockquote className="fs-forged">{v.forged.text}</blockquote></Msg>}
        </section>
      </div>
      <div className="fs-facts">
        <div><b>{v.disclosed ? '1' : '0'} / {v.seal.leafCount}</b><span>steps shared</span></div>
        <div><b>{v.notShown ?? v.seal.leafCount}</b><span>steps not shown</span></div>
        <div><b>{v.state.replace(/_/g, ' ')}</b><span>mission state</span></div>
        <button className="sm" onClick={() => go(`#/mission/${v.missionId}`)}>Open full mission →</button>
      </div>
      <Banner tone="info" title="What this proves, and what it does not">{v.limits}</Banner>
    </>}
    {view.error && <Banner tone="bad" title="Could not load the review">{view.error.message}</Banner>}
  </div>;
}

function Msg({ who, tag, bad, children }: { who: string; tag: string; bad?: boolean; children: React.ReactNode }) {
  return <div className={`fs-msg${bad ? ' bad' : ''}`}><div className="fs-who"><span className="fs-av" aria-hidden />{who}<span className="fs-tag">{tag}</span></div><div className="fs-body">{children}</div></div>;
}
