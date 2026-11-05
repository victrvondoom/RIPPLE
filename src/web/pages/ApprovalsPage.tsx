import { useState } from 'react';
import { api, fmtTime, useApi } from '../api';
import { Empty, ErrorView, Loading, Status, useToast } from '../components/ui';
import type { Me } from '../App';

export function ApprovalsPage({ me }: { me: Me }) {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>('/approvals', 4000);
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  
  // In-place decision modal state
  const [decidingItem, setDecidingItem] = useState<any | null>(null);
  const [decisionNote, setDecisionNote] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // In-place question answering state
  const [answeringQ, setAnsweringQ] = useState<any | null>(null);
  const [answerText, setAnswerText] = useState<string>('');

  if (loading && !data) return <Loading />;
  if (error) return <ErrorView error={error} retry={reload} />;

  const canDecide = me.user.role === 'owner' || me.user.role === 'manager';

  // Handle in-place approval / rejection
  const submitDecision = async (decision: 'approved' | 'rejected') => {
    if (!decidingItem) return;
    setIsSubmitting(true);
    try {
      await api('POST', `/missions/${decidingItem.mission_id}/approvals/${decidingItem.id}/decide`, {
        decision,
        note: decisionNote.trim() || (decision === 'approved' ? 'Approved via Approvals Center' : 'Rejected via Approvals Center')
      });
      toast.ok(`Approval ${decision} successfully`);
      setDecidingItem(null);
      setDecisionNote('');
      reload();
    } catch (err: any) {
      toast.err(err.message || 'Failed to record decision');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle answering question in-place
  const submitAnswer = async () => {
    if (!answeringQ || !answerText.trim()) return;
    setIsSubmitting(true);
    try {
      await api('POST', `/missions/${answeringQ.mission_id}/questions/${answeringQ.id}/answer`, {
        answer: answerText.trim()
      });
      toast.ok('Answer recorded successfully');
      setAnsweringQ(null);
      setAnswerText('');
      reload();
    } catch (err: any) {
      toast.err(err.message || 'Failed to submit answer');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Filter pending approvals
  const filteredPending = (data.pending || []).filter((a: any) => {
    if (roleFilter !== 'all' && a.required_role !== roleFilter) return false;
    if (search && !a.title.toLowerCase().includes(search.toLowerCase()) && !a.mission_title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div>
          <h1>Approvals & Fiduciary Center</h1>
          <p className="muted" style={{ margin: 0 }}>
            Consequential changes and external actions require explicit human authorization.{' '}
            {canDecide ? (
              <span className="badge b-ok">You have decision authority ({me.user.role})</span>
            ) : (
              <span className="badge b-warn">Viewer mode (cannot decide)</span>
            )}
          </p>
        </div>
        <div className="row">
          <input
            type="search"
            placeholder="Search approvals & missions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            style={{ width: 'auto' }}
          >
            <option value="all">All Required Roles</option>
            <option value="manager">Requires Manager</option>
            <option value="owner">Requires Owner</option>
          </select>
        </div>
      </div>

      {/* Summary KPI Badges */}
      <div className="grid g3" style={{ marginBottom: 16 }}>
        <div className="card elevated" style={{ marginBottom: 0 }}>
          <div className="muted small">Pending Human Approvals</div>
          <div className="stat" style={{ color: filteredPending.length ? 'var(--warn)' : 'var(--ok)' }}>
            {filteredPending.length}
          </div>
        </div>
        <div className="card elevated" style={{ marginBottom: 0 }}>
          <div className="muted small">Questions Needing A Human</div>
          <div className="stat" style={{ color: data.openQuestions?.length ? 'var(--bad)' : 'var(--muted)' }}>
            {data.openQuestions?.length || 0}
          </div>
        </div>
        <div className="card elevated" style={{ marginBottom: 0 }}>
          <div className="muted small">Decisions Completed</div>
          <div className="stat" style={{ color: 'var(--ink-bright)' }}>
            {data.decided?.length || 0}
          </div>
        </div>
      </div>

      {/* Pending Approvals List */}
      <div className="card elevated">
        <div className="row between" style={{ marginBottom: 10 }}>
          <h2>Pending Approvals ({filteredPending.length})</h2>
          <span className="small muted">Separation of duties strictly enforced</span>
        </div>

        {filteredPending.length ? (
          <ul className="list">
            {filteredPending.map((a: any) => (
              <li key={a.id} style={{ padding: '12px 0' }}>
                <div className="row between" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                      <strong style={{ fontSize: 14, color: 'var(--ink-bright)' }}>{a.title}</strong>
                      <span className={`badge ${a.required_role === 'owner' ? 'b-bad' : 'b-warn'}`}>
                        needs {a.required_role}
                      </span>
                      {a.approver_label && <span className="badge b-bad" title="Who-specific gate: nobody else can decide this approval">only {a.approver_label}</span>}
                      <a href={`#/mission/${a.mission_id}`} className="small muted">
                        {a.mission_title}
                      </a>
                    </div>
                    <div className="small muted" style={{ lineHeight: 1.5 }}>
                      Baseline v{a.baseline_version} · Change #{a.change_seq} · Rationale: {a.rationale}
                    </div>
                  </div>

                  <div className="row" style={{ gap: 8 }}>
                    {canDecide ? (
                      <button
                        className="primary sm"
                        onClick={() => {
                          setDecidingItem(a);
                          setDecisionNote('');
                        }}
                      >
                        Review & Decide ✍️
                      </button>
                    ) : (
                      <span className="small muted">Read-only</span>
                    )}
                    <a className="btn sm" href={`#/mission/${a.mission_id}?tab=actions`}>
                      Inspect Mission →
                    </a>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No pending approvals matching your filter criteria.</Empty>
        )}
      </div>

      {/* Open Questions Needing A Human */}
      <div className="card elevated">
        <div className="row between" style={{ marginBottom: 10 }}>
          <h2>Open Questions Requiring Human Confirmation ({data.openQuestions?.length || 0})</h2>
          <span className="small muted">Answering unblocks dependent agent investigations</span>
        </div>

        {data.openQuestions?.length ? (
          <ul className="list">
            {data.openQuestions.map((q: any) => (
              <li key={q.id} style={{ padding: '12px 0' }}>
                <div className="row between">
                  <div>
                    <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                      <span className={`badge ${q.blocking ? 'b-bad' : 'b-warn'}`}>
                        {q.blocking ? 'BLOCKING GATE' : 'NON-BLOCKING'}
                      </span>
                      <strong style={{ fontSize: 13, color: 'var(--ink-bright)' }}>{q.text}</strong>
                    </div>
                    <div className="small muted">
                      Mission: <a href={`#/mission/${q.mission_id}`}>{q.mission_title}</a> · Asked by: <span className="mono">{q.asked_by_role}</span>
                    </div>
                  </div>
                  <div>
                    {canDecide && (
                      <button
                        className="sm"
                        onClick={() => {
                          setAnsweringQ(q);
                          setAnswerText('');
                        }}
                      >
                        Answer in-place
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No open questions awaiting a human response.</Empty>
        )}
      </div>

      {/* Decision Audit History */}
      <div className="card flush elevated">
        <div style={{ padding: '16px 20px 0' }}>
          <h2>Decision History & Fiduciary Audit</h2>
          <p className="small muted">Audited record of all approved and rejected consequential actions.</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Subject & Action</th>
                <th>Mission</th>
                <th>Decision Status</th>
                <th>Decided By & Timestamp</th>
                <th>Fiduciary Decision Note</th>
              </tr>
            </thead>
            <tbody>
              {data.decided?.map((a: any) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.title}</strong>
                    <div className="small muted mono">{a.subject_kind} · {a.subject_id?.slice(0, 16)}...</div>
                  </td>
                  <td className="small">
                    <a href={`#/mission/${a.mission_id}`}>{a.mission_title}</a>
                  </td>
                  <td>
                    <Status s={a.status} />
                  </td>
                  <td className="small">
                    <strong>{a.decided_by_name ?? 'System Authority'}</strong>
                    <div className="muted">{fmtTime(a.decided_at)}</div>
                  </td>
                  <td className="small" style={{ maxWidth: 320 }}>
                    {a.decision_note || <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.decided?.length && <Empty>No past decisions recorded yet.</Empty>}
      </div>

      {/* In-Place Decision Modal */}
      {decidingItem && (
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
          onClick={() => setDecidingItem(null)}
        >
          <div
            className="card elevated"
            style={{ maxWidth: 540, width: '100%', border: '2px solid var(--emerald)', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row between" style={{ marginBottom: 12 }}>
              <h2>Authorize Consequential Action</h2>
              <button className="sm" onClick={() => setDecidingItem(null)}>✕</button>
            </div>

            <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--line)', marginBottom: 14 }}>
              <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                <span className="badge b-warn">needs {decidingItem.required_role}</span>
                {decidingItem.approver_label && <span className="badge b-bad">only {decidingItem.approver_label}</span>}
                <strong>{decidingItem.title}</strong>
              </div>
              <div className="small muted">
                Mission: {decidingItem.mission_title} · Baseline v{decidingItem.baseline_version} · Change #{decidingItem.change_seq}
              </div>
              <div className="small" style={{ marginTop: 8, color: 'var(--ink)' }}>
                <strong>Rationale:</strong> {decidingItem.rationale}
              </div>
            </div>

            <label htmlFor="dec-note">Optional Fiduciary Note / Audit Reason</label>
            <textarea
              id="dec-note"
              rows={3}
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              placeholder="e.g. Verified client verbal approval and checked rate card..."
              style={{ marginBottom: 14 }}
            />

            <div className="row between">
              <button className="danger" onClick={() => submitDecision('rejected')} disabled={isSubmitting}>
                ✕ Reject Action
              </button>
              <div className="row">
                <button onClick={() => setDecidingItem(null)}>Cancel</button>
                <button className="primary" onClick={() => submitDecision('approved')} disabled={isSubmitting}>
                  {isSubmitting ? 'Recording...' : '✓ Approve Action'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* In-Place Question Answer Modal */}
      {answeringQ && (
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
          onClick={() => setAnsweringQ(null)}
        >
          <div
            className="card elevated"
            style={{ maxWidth: 500, width: '100%', border: '2px solid var(--info)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row between" style={{ marginBottom: 12 }}>
              <h2>Answer Human Question</h2>
              <button className="sm" onClick={() => setAnsweringQ(null)}>✕</button>
            </div>

            <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--line)', marginBottom: 14 }}>
              <div className="badge b-bad" style={{ marginBottom: 6 }}>
                {answeringQ.blocking ? 'BLOCKING QUESTION' : 'QUESTION'}
              </div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{answeringQ.text}</div>
              <div className="small muted" style={{ marginTop: 4 }}>
                Mission: {answeringQ.mission_title}
              </div>
            </div>

            <label htmlFor="ans-text">Your Answer / Value</label>
            <input
              id="ans-text"
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              placeholder="Type confirmed answer..."
              style={{ marginBottom: 16 }}
              autoFocus
            />

            <div className="row between">
              <button onClick={() => setAnsweringQ(null)}>Cancel</button>
              <button className="primary" onClick={submitAnswer} disabled={!answerText.trim() || isSubmitting}>
                {isSubmitting ? 'Submitting...' : 'Submit Answer & Resume'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
