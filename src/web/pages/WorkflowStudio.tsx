import { useState, useEffect, useMemo, useRef } from 'react';
import { api, useApi } from '../api';
import { useToast } from '../components/ui';
import { PixelAvatar } from '../components/PixelAvatars';
import { Onboarding } from '../components/Onboarding';
import { StudioHome } from '../components/StudioHome';
import type { WorkflowDef } from '../../server/api/studio';

const fmtUptime = (s?: number) => (s == null ? '—' : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`);
const fmtBytes = (b?: number) => (b == null ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function WorkflowStudio({ me: _me }: { me: any }) {
  const toast = useToast();
  const [showTour, setShowTour] = useState<boolean>(() => { try { return !localStorage.getItem('ripple.tour.seen'); } catch { return true; } });
  const closeTour = () => { setShowTour(false); try { localStorage.setItem('ripple.tour.seen', '1'); } catch { /* storage blocked */ } };
  const [homeOpen, setHomeOpen] = useState<boolean>(true);  const { data: wfData } = useApi<{ workflows: WorkflowDef[] }>('/studio/workflows');
  const workflows = wfData?.workflows || [];

  const [selectedWfId, setSelectedWfId] = useState<string>('gpu-billing');
  const [activeTab, setActiveTab] = useState<'canvas' | 'builder' | 'board' | 'audit' | 'infra'>('canvas');
  const [selectedAgentKey, setSelectedAgentKey] = useState<string>('gpu_auditor');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const firstSel = useRef(true);
  useEffect(() => { if (firstSel.current) { firstSel.current = false; return; } setHomeOpen(false); }, [selectedAgentKey, selectedCardId]);

  // Canvas zoom & pan state
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isDraggingCanvas = useRef(false);
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Individual component dragging state
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const draggingItem = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Live simulation execution state
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [simStep, setSimStep] = useState<number>(2);
  const [approvalResolved, setApprovalResolved] = useState<'dispute' | 'paid_in_full' | null>(null);
  const [guidanceDraft, setGuidanceDraft] = useState<string>('');
  const [isSavingGuidance, setIsSavingGuidance] = useState<boolean>(false);

  // Live server telemetry — REAL values measured by the API (polled), never client-side fabricated numbers
  const { data: tele } = useApi<any>('/studio/telemetry', 5000);
  const { data: infra } = useApi<any>('/studio/infrastructure', 15000);

  // Dynamic live event logs stream
  const [liveLogs, setLiveLogs] = useState<Array<{ time: string; source: string; msg: string; type: string }>>([
    { time: '00:15:02', source: 'GPU Auditor', msg: 'Ingested Lambda Invoice HEL-2026-10-118-L3. Claimed: 36h ($3,600).', type: 'info' },
    { time: '00:15:04', source: 'GPU Auditor', msg: 'Queried Kubernetes lifecycle API. Pod terminated at 08:00 UTC (Ran: 24h).', type: 'info' },
    { time: '00:15:06', source: 'Cost Allocator', msg: 'Computed $1,200 delta (12 unverified hours @ $100/hr). Drafted JE-7027.', type: 'warn' },
    { time: '00:15:08', source: 'Orchestrator', msg: 'Join barrier resolved. Paused at human fiduciary gate: NEEDS YOUR OK.', type: 'gate' }
  ]);

  // Active workflow definition
  const currentWf = useMemo(() => {
    return workflows.find(w => w.id === selectedWfId) || workflows[0];
  }, [workflows, selectedWfId]);

  // Selected agent
  const selectedAgent = useMemo(() => {
    if (!currentWf) return null;
    return currentWf.agents.find(a => a.key === selectedAgentKey) || currentWf.agents[1];
  }, [currentWf, selectedAgentKey]);

  // Decisions recorded on the server (audit-logged) win over local state when data (re)loads
  const recordedDecision = (currentWf?.approvalRequest?.resolved as 'dispute' | 'paid_in_full' | null | undefined) ?? null;
  useEffect(() => { setApprovalResolved(recordedDecision); }, [recordedDecision]);

  // Initialize or reset dynamic node coordinates
  useEffect(() => {
    if (!currentWf) return;
    const initialPos: Record<string, { x: number; y: number }> = {
      'you': { x: 450, y: 340 },
      'approval-bubble': { x: 260, y: 250 }
    };

    // Calculate radial agents
    currentWf.agents.forEach((ag) => {
      if (ag.key === 'you') return;
      const rad = (ag.angle * Math.PI) / 180;
      initialPos[ag.key] = {
        x: Math.round(450 + 220 * Math.cos(rad)),
        y: Math.round(340 + 220 * Math.sin(rad))
      };
    });

    // Calculate initial positions for evidence cards
    const leftEvidence = currentWf.evidenceCards.slice(0, 4);
    leftEvidence.forEach((c, idx) => {
      initialPos[c.id] = { x: 50 + idx * 220, y: 40 };
    });

    const rightEvidence = currentWf.evidenceCards.slice(4);
    rightEvidence.forEach((c, idx) => {
      initialPos[c.id] = { x: 500 + (idx % 2) * 230, y: 470 + Math.floor(idx / 2) * 110 };
    });

    setPositions(initialPos);
  }, [currentWf]);

  useEffect(() => {
    if (selectedAgent) {
      setGuidanceDraft(selectedAgent.guidance || '');
    }
  }, [selectedAgent]);

  // Dynamic Drag Event Handlers for any component
  const handleNodeMouseDown = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const current = positions[id] || { x: 450, y: 340 };
    draggingItem.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      origX: current.x,
      origY: current.y
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingItem.current) {
      const { id, startX, startY, origX, origY } = draggingItem.current;
      const dx = (e.clientX - startX) / zoom;
      const dy = (e.clientY - startY) / zoom;
      setPositions(prev => ({
        ...prev,
        [id]: { x: Math.round(origX + dx), y: Math.round(origY + dy) }
      }));
    } else if (isDraggingCanvas.current) {
      setPan({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
    }
  };

  const handleMouseUp = () => {
    draggingItem.current = null;
    isDraggingCanvas.current = false;
  };

  // Handler to run / simulate workflow
  const handleSimulate = () => {
    setIsRunning(true);
    setSimStep(0);
    setApprovalResolved(null);
    toast.ok('Active multi-agent orchestration running...');

    const stepLogs = [
      { source: 'Intake Agent', msg: 'Ingesting invoice HEL-2026-10-118-L3 and matching cloud instance UUID.', type: 'info' },
      { source: 'GPU Auditor', msg: 'Querying Kubernetes telemetry and AWS/Lambda instance state API.', type: 'info' },
      { source: 'Cost Allocator', msg: 'Calculating billing discrepancy against contractual $100/hr tariff.', type: 'warn' },
      { source: 'Fiduciary Gate', msg: 'Approval required: Fiduciary signature needed to dispute $1,200.', type: 'gate' }
    ];

    let step = 0;
    const interval = setInterval(() => {
      step++;
      setSimStep(step);
      if (stepLogs[step]) {
        setLiveLogs(prev => [
          { time: new Date().toLocaleTimeString(), source: stepLogs[step].source, msg: stepLogs[step].msg, type: stepLogs[step].type },
          ...prev.slice(0, 7)
        ]);
      }
      if (step >= 2) {
        clearInterval(interval);
        setIsRunning(false);
        toast.ok('Workflow arrived at human checkpoint: NEEDS YOUR OK.');
      }
    }, 1500);
  };

  const handleStepForward = () => {
    setSimStep(s => Math.min(s + 1, 4));
    toast.ok(`Stepped forward to execution phase ${simStep + 1}`);
  };

  const handleReset = () => {
    setIsRunning(false);
    setSimStep(2);
    setApprovalResolved(null);
    toast.ok('Workflow coordinates and states reset.');
  };

  // Human approval action — records the decision in the audit ledger. Demo scenario only: nothing is dispatched.
  const handleDecide = async (action: 'dispute' | 'paid_in_full') => {
    try {
      const res = await api<{ message?: string }>('POST', `/studio/workflows/${currentWf.id}/approve`, {
        action,
        note: action === 'dispute' ? 'Recorded: dispute recommended for this demo scenario' : 'Recorded: pay-in-full chosen for this demo scenario'
      });
      setApprovalResolved(action);
      setSimStep(4);
      setLiveLogs(prev => [
        { time: new Date().toLocaleTimeString(), source: 'You (Controller)', msg: `Decision recorded in the audit ledger: ${action === 'dispute' ? 'dispute' : 'pay in full'} (synthetic demo — nothing was sent to any vendor).`, type: 'ok' },
        ...prev
      ]);
      toast.ok(res.message ?? 'Decision recorded.');
    } catch (err: any) {
      toast.err(err.message || 'Failed to record decision');
    }
  };

  // Save agent guidance instructions
  const handleSaveGuidance = async () => {
    if (!selectedAgent) return;
    setIsSavingGuidance(true);
    try {
      const res = await api<{ message?: string }>('POST', `/studio/workflows/${currentWf.id}/guidance`, {
        agentKey: selectedAgent.key,
        guidance: guidanceDraft
      });
      toast.ok(res.message ?? `Guidance for ${selectedAgent.name} saved to the audit ledger.`);
    } catch (err: any) {
      toast.err(err.message || 'Failed to save instructions');
    } finally {
      setIsSavingGuidance(false);
    }
  };

  if (!currentWf) {
    return <div className="card">Loading Workflow Studio...</div>;
  }

  const youPos = positions['you'] || { x: 450, y: 340 };
  const approvalBubblePos = positions['approval-bubble'] || { x: 260, y: 250 };

  return (
    <div className="studio-container" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}>
      {/* Top Studio Bar with Real-Time Dynamic Telemetry */}
      <div className="studio-topbar">
        <div className="studio-breadcrumb">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 10px #10b981', animation: 'pulseDot 1.2s infinite' }} />
            <strong>RIPPLE STUDIO</strong>
          </span>
          <span>/</span>
          <select
            value={selectedWfId}
            onChange={(e) => {
              setSelectedWfId(e.target.value);
              setApprovalResolved(null);
              setSimStep(2);
            }}
            style={{ width: 'auto', fontWeight: 600, padding: '4px 10px', background: 'var(--surface-elevated)' }}
          >
            {workflows.map(w => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.domain})
              </option>
            ))}
          </select>
          <span className="badge b-info">{currentWf.badge}</span>
        </div>

        {/* Live Server Telemetry (real values measured by the API, polled every 5 s) */}
        <div className="row" style={{ gap: 14, background: 'rgba(0,0,0,0.3)', padding: '4px 12px', borderRadius: 8, border: '1px solid var(--line-subtle)' }}>
          <div className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="muted">Uptime:</span>
            <strong style={{ color: '#10b981', fontFamily: 'monospace' }}>{fmtUptime(tele?.uptimeSeconds)}</strong>
          </div>
          <div className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="muted">Ledger:</span>
            <strong style={{ color: '#38bdf8', fontFamily: 'monospace' }}>{fmtBytes(tele?.dbBytes)}</strong>
          </div>
          <div className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="muted">Missions:</span>
            <strong style={{ color: '#fbbf24', fontFamily: 'monospace' }}>
              {tele ? `${tele.counts.activeMissions} active / ${tele.counts.missions} total` : '—'}
            </strong>
          </div>
          <div className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="muted">Open work:</span>
            <strong style={{ color: '#fbbf24', fontFamily: 'monospace' }}>{tele?.counts?.openWorkItems ?? '—'}</strong>
          </div>
          <div className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="muted">Analyzer:</span>
            <strong style={{ color: '#10b981', fontFamily: 'monospace' }}>{tele?.provider?.kind ?? '—'}</strong>
          </div>
        </div>

        {/* View Switcher Tabs */}
        <div className="studio-nav-tabs">
          <button className={activeTab === 'canvas' ? 'active' : ''} onClick={() => setActiveTab('canvas')}>
            🕸️ Canvas
          </button>
          <button className={activeTab === 'builder' ? 'active' : ''} onClick={() => setActiveTab('builder')}>
            🎛️ Node Builder
          </button>
          <button className={activeTab === 'board' ? 'active' : ''} onClick={() => setActiveTab('board')}>
            📋 Board
          </button>
          <button className={activeTab === 'audit' ? 'active' : ''} onClick={() => setActiveTab('audit')}>
            📜 Audit Trail
          </button>
          <button className={activeTab === 'infra' ? 'active' : ''} onClick={() => setActiveTab('infra')}>
            🌐 Infrastructure Map
          </button>
        </div>

        {/* Action Controls */}
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" onClick={handleSimulate} disabled={isRunning}>
            {isRunning ? '⏳ Running...' : '▶ Simulate Billing Event'}
          </button>
          <button onClick={handleStepForward} title="Step forward in execution graph">
            ⏭ Step
          </button>
          <button onClick={handleReset} title="Reset demo to synthetic state">
            🔄 Reset
          </button>
        </div>
      </div>

      {showTour && <Onboarding onClose={closeTour} onPick={() => { closeTour(); handleSimulate(); }} />}
      <button className="sm" style={{ position: 'absolute', right: 16, top: 8 }} aria-label="Help: replay the tour" onClick={() => setShowTour(true)}>?</button>

      {/* Main Studio Views */}
      {activeTab === 'canvas' && (
        <div className="studio-main-layout">
          {/* Visual Canvas Area with Full Cursor Dragging */}
          <div
            className="studio-canvas-stage"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'svg') {
                isDraggingCanvas.current = true;
                dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
              }
            }}
          >
            {/* Interactive Notice */}
            <div style={{ position: 'absolute', top: 14, right: 14, background: 'rgba(16,23,38,0.7)', backdropFilter: 'blur(8px)', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--line-subtle)', fontSize: 11, color: '#10b981', zIndex: 10, pointerEvents: 'none' }}>
              ✦ All components draggable with cursor
            </div>

            {/* Canvas Zoom & Tool Controls */}
            <div className="canvas-toolbar">
              <button onClick={() => setZoom(z => Math.min(z + 0.15, 2.0))} title="Zoom In">🔍+</button>
              <button onClick={() => setZoom(z => Math.max(z - 0.15, 0.5))} title="Zoom Out">🔍−</button>
              <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} title="Fit to Screen">⛶ Fit</button>
              <span style={{ fontSize: 11, padding: '4px 6px', color: 'var(--muted)', alignSelf: 'center' }}>
                {Math.round(zoom * 100)}%
              </span>
            </div>

            {/* Radial Constellation Orchestrator */}
            <div
              className="radial-canvas"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '50% 50%',
                transition: draggingItem.current || isDraggingCanvas.current ? 'none' : 'transform 0.1s ease-out'
              }}
            >
              {/* Dynamic Connecting Cables & Animated Token Pulses */}
              <svg className="orbit-svg" viewBox="0 0 1000 750" style={{ width: '100%', height: '100%' }}>
                <defs>
                  <linearGradient id="cableGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#10b981" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.9" />
                  </linearGradient>
                  <filter id="glowFilter">
                    <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                    <feMerge>
                      <feMergeNode in="coloredBlur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                {/* Concentric Sonar / Radar Waves radiating from Center Controller */}
                <circle cx={youPos.x} cy={youPos.y} r="80" stroke="rgba(16,185,129,0.15)" strokeWidth="1.5" fill="none">
                  <animate attributeName="r" values="60;240" dur="4s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.8;0" dur="4s" repeatCount="indefinite" />
                </circle>
                <circle cx={youPos.x} cy={youPos.y} r="140" stroke="rgba(56,189,248,0.1)" strokeWidth="1" fill="none">
                  <animate attributeName="r" values="80;260" dur="4s" begin="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.6;0" dur="4s" begin="2s" repeatCount="indefinite" />
                </circle>

                {/* Spoke Connection Cables dynamically anchoring from Center 'You' to Radial Agents */}
                {currentWf.agents.filter(a => a.key !== 'you').map((ag) => {
                  const targetPos = positions[ag.key] || { x: 450, y: 340 };
                  const isActive = ag.status === 'working' || (ag.key === 'cost_allocator' && !approvalResolved);

                  // Calculate bezier curve anchor control point
                  const midX = (youPos.x + targetPos.x) / 2;
                  const midY = (youPos.y + targetPos.y) / 2;

                  return (
                    <g key={ag.id}>
                      <path
                        d={`M ${youPos.x} ${youPos.y} Q ${midX} ${midY} ${targetPos.x} ${targetPos.y}`}
                        stroke={isActive ? 'url(#cableGrad)' : 'rgba(255,255,255,0.12)'}
                        strokeWidth={isActive ? 2.8 : 1.2}
                        fill="none"
                        className={isActive ? 'orbit-active-edge' : ''}
                      />

                      {/* Continuous Stream of Animated Data Packets flowing between nodes */}
                      <circle r="4" fill={isActive ? '#10b981' : '#38bdf8'} filter="url(#glowFilter)">
                        <animateMotion
                          path={`M ${youPos.x} ${youPos.y} L ${targetPos.x} ${targetPos.y}`}
                          dur={isActive ? '1.4s' : '3.2s'}
                          repeatCount="indefinite"
                        />
                      </circle>
                      <circle r="3" fill="#ffffff">
                        <animateMotion
                          path={`M ${targetPos.x} ${targetPos.y} L ${youPos.x} ${youPos.y}`}
                          dur={isActive ? '1.8s' : '4s'}
                          repeatCount="indefinite"
                        />
                      </circle>
                    </g>
                  );
                })}

                {/* Cables dynamically anchoring GPU Auditor to Evidence Cards */}
                {currentWf.evidenceCards.slice(0, 4).map((card) => {
                  const gpuPos = positions['gpu_auditor'] || { x: 550, y: 150 };
                  const cardPos = positions[card.id] || { x: 100, y: 50 };

                  return (
                    <line
                      key={`wire-${card.id}`}
                      x1={gpuPos.x}
                      y1={gpuPos.y}
                      x2={cardPos.x + 110}
                      y2={cardPos.y + 45}
                      stroke="rgba(16,185,129,0.3)"
                      strokeWidth="1.2"
                      strokeDasharray="4 4"
                    />
                  );
                })}

                {/* Cable linking Approval Bubble to You / Cost Allocator */}
                {!approvalResolved && (
                  <path
                    d={`M ${youPos.x} ${youPos.y} Q ${(youPos.x + approvalBubblePos.x) / 2} ${(youPos.y + approvalBubblePos.y) / 2 - 30} ${approvalBubblePos.x + 140} ${approvalBubblePos.y + 40}`}
                    stroke="#f59e0b"
                    strokeWidth="2"
                    strokeDasharray="5 5"
                    fill="none"
                    filter="url(#glowFilter)"
                  />
                )}
              </svg>

              {/* Center "You" Controller Node - Freely Draggable! */}
              <div
                className="center-controller-node"
                style={{
                  left: `${youPos.x}px`,
                  top: `${youPos.y}px`,
                  cursor: draggingItem.current?.id === 'you' ? 'grabbing' : 'grab'
                }}
                onMouseDown={(e) => handleNodeMouseDown('you', e)}
                onClick={() => setSelectedAgentKey('you')}
                title="Drag to reposition with cursor"
              >
                <div className="controller-badge-3d" style={{ position: 'relative' }}>
                  <PixelAvatar type="crown" size={44} />
                  <div style={{ position: 'absolute', bottom: -6, background: approvalResolved ? '#10b981' : '#f59e0b', color: '#000', fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4 }}>
                    YOU
                  </div>
                </div>
                <div className="agent-node-title" style={{ marginTop: 8 }}>
                  You
                </div>
                <div className="agent-node-subtitle" style={{ color: approvalResolved ? '#10b981' : '#f59e0b' }}>
                  {approvalResolved ? 'all clear' : currentWf.youStatus}
                </div>
              </div>

              {/* Orbital Specialist Agent Nodes - Freely Draggable with Cursor! */}
              {currentWf.agents.filter(a => a.key !== 'you').map((ag) => {
                const agPos = positions[ag.key] || { x: 450, y: 340 };
                const isSelected = selectedAgentKey === ag.key;

                return (
                  <div
                    key={ag.id}
                    className={`radial-agent-node ${isSelected ? 'active' : ''}`}
                    style={{
                      left: `${agPos.x}px`,
                      top: `${agPos.y}px`,
                      cursor: draggingItem.current?.id === ag.key ? 'grabbing' : 'grab'
                    }}
                    onMouseDown={(e) => handleNodeMouseDown(ag.key, e)}
                    onClick={() => setSelectedAgentKey(ag.key)}
                    title="Click to inspect · Drag to reposition"
                  >
                    <div className="agent-icon-box">
                      <PixelAvatar type={ag.avatar as any} size={36} />
                      <div className={`agent-status-dot ${ag.status}`} />
                    </div>
                    <div className="agent-node-title">{ag.name}</div>
                    <div className="agent-node-subtitle">{ag.taskCount}</div>
                  </div>
                );
              })}

              {/* Dynamic Draggable Evidence Flow Cards (Left Chain) */}
              {currentWf.evidenceCards.slice(0, 4).map((card) => {
                const cardPos = positions[card.id] || { x: 50, y: 50 };
                const isSelected = selectedCardId === card.id;

                return (
                  <div
                    key={card.id}
                    className="evidence-flow-card"
                    style={{
                      position: 'absolute',
                      left: `${cardPos.x}px`,
                      top: `${cardPos.y}px`,
                      cursor: draggingItem.current?.id === card.id ? 'grabbing' : 'grab',
                      borderColor: isSelected ? 'var(--emerald)' : undefined,
                      zIndex: isSelected ? 8 : 4
                    }}
                    onMouseDown={(e) => handleNodeMouseDown(card.id, e)}
                    onClick={() => {
                      setSelectedCardId(card.id);
                      setSelectedAgentKey(card.agentKey);
                    }}
                    title="Drag with cursor to move card"
                  >
                    <div className="evidence-flow-header">
                      <span className="dot" style={{ background: card.dotColor }} />
                      <span>{card.title}</span>
                    </div>
                    <div className="evidence-preview-text">{card.preview}</div>
                  </div>
                );
              })}

              {/* Dynamic Draggable Evidence Flow Cards (Right Chain) */}
              {currentWf.evidenceCards.slice(4).map((card) => {
                const cardPos = positions[card.id] || { x: 500, y: 450 };
                const isSelected = selectedCardId === card.id;

                return (
                  <div
                    key={card.id}
                    className="evidence-flow-card"
                    style={{
                      position: 'absolute',
                      left: `${cardPos.x}px`,
                      top: `${cardPos.y}px`,
                      cursor: draggingItem.current?.id === card.id ? 'grabbing' : 'grab',
                      borderColor: isSelected ? 'var(--emerald)' : undefined,
                      zIndex: isSelected ? 8 : 4
                    }}
                    onMouseDown={(e) => handleNodeMouseDown(card.id, e)}
                    onClick={() => {
                      setSelectedCardId(card.id);
                      setSelectedAgentKey(card.agentKey);
                    }}
                    title="Drag with cursor to move card"
                  >
                    <div className="evidence-flow-header">
                      <span className="dot" style={{ background: card.dotColor }} />
                      <span>{card.title}</span>
                    </div>
                    <div className="evidence-preview-text">{card.preview}</div>
                  </div>
                );
              })}

              {/* Draggable Human Approval Callout Bubble */}
              {currentWf.approvalRequest && !approvalResolved && (
                <div
                  className="approval-callout-bubble"
                  style={{
                    left: `${approvalBubblePos.x}px`,
                    top: `${approvalBubblePos.y}px`,
                    cursor: draggingItem.current?.id === 'approval-bubble' ? 'grabbing' : 'grab'
                  }}
                  onMouseDown={(e) => handleNodeMouseDown('approval-bubble', e)}
                  title="Drag with cursor to move anywhere"
                >
                  <div className="approval-callout-header">
                    <span>⚠️ NEEDS YOUR OK</span>
                  </div>
                  <div className="approval-callout-title">
                    {currentWf.approvalRequest.title}
                  </div>
                  <div className="approval-callout-actions">
                    <button
                      className="primary sm"
                      onClick={(e) => { e.stopPropagation(); handleDecide('dispute'); }}
                    >
                      Dispute {currentWf.approvalRequest.amount}
                    </button>
                    <button
                      className="sm"
                      onClick={(e) => { e.stopPropagation(); handleDecide('paid_in_full'); }}
                    >
                      Pay in full
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Bottom Floating Live Event Stream Console */}
            <div style={{
              position: 'absolute',
              bottom: 12,
              left: 14,
              right: 14,
              background: 'rgba(10, 14, 23, 0.88)',
              backdropFilter: 'blur(12px)',
              border: '1px solid var(--line-highlight)',
              borderRadius: 8,
              padding: '8px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              zIndex: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)'
            }}>
              <div className="row between" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--emerald)', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                  ⚡ Live Orchestrator Event Bus
                </span>
                <span className="small muted">
                  Phase {simStep} of 4 · {isRunning ? 'Active Execution' : 'Awaiting Input'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 60, overflowY: 'auto' }}>
                {liveLogs.slice(0, 3).map((log, i) => (
                  <div key={i} className="small row" style={{ gap: 8, fontSize: 11 }}>
                    <span className="mono muted">{log.time}</span>
                    <strong style={{ color: log.type === 'warn' ? '#f59e0b' : log.type === 'ok' ? '#10b981' : '#38bdf8' }}>
                      [{log.source}]
                    </strong>
                    <span style={{ color: 'var(--ink)' }}>{log.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right-Side Inspector Panel */}
          <div className="studio-inspector-panel">
            {homeOpen ? <StudioHome name={_me?.user?.name?.split(' ')[0] ?? 'there'} doneCount={approvalResolved ? 2 : 1} onAsk={() => setHomeOpen(false)} /> : <>
            <button className="sm" style={{ margin: 8 }} onClick={() => setHomeOpen(true)}>← Home</button>
            {/* Header: Agent Identity */}
            <div className="inspector-header">
              <div className="agent-icon-box" style={{ width: 44, height: 44 }}>
                <PixelAvatar type={selectedAgent?.avatar as any || 'detective'} size={32} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-bright)' }}>
                  {selectedAgent?.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: selectedAgent?.status === 'done' ? '#10b981' : '#f59e0b' }} />
                  {selectedAgent?.role}
                </div>
              </div>
            </div>

            {/* Approval Decision Card (if selected or pending) */}
            {currentWf.approvalRequest && (
              <div className="inspector-section" style={{ background: 'rgba(245, 158, 11, 0.06)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warn)', marginBottom: 6 }}>
                  FIDUCIARY AUTHORIZATION
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                  {currentWf.approvalRequest.title}
                </div>

                {/* Timeline Bar Chart */}
                {currentWf.timelineData && (
                  <div className="timeline-chart" style={{ marginBottom: 12 }}>
                    <div className="timeline-bar-group">
                      <div className="timeline-bar-label">
                        <span>Billed ({currentWf.timelineData.billedHours} h)</span>
                        <span style={{ color: '#ef4444' }}>+{currentWf.timelineData.diffHours} h over-metered</span>
                      </div>
                      <div className="timeline-bar-track">
                        <div className="timeline-bar-fill-billed" style={{ width: '100%' }} />
                      </div>
                    </div>
                    <div className="timeline-bar-group" style={{ marginBottom: 0 }}>
                      <div className="timeline-bar-label">
                        <span>Verified Ran ({currentWf.timelineData.ranHours} h)</span>
                        <span style={{ color: '#10b981' }}>K8s Teardown 08:00 UTC</span>
                      </div>
                      <div className="timeline-bar-track">
                        <div className="timeline-bar-fill-ran" style={{ width: '66.6%' }} />
                      </div>
                    </div>
                  </div>
                )}

                {/* Decision Actions */}
                {!approvalResolved ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <button
                      className="primary"
                      onClick={() => handleDecide('dispute')}
                      style={{ justifyContent: 'space-between' }}
                    >
                      <span>{currentWf.approvalRequest.recommendedAction}</span>
                      <span className="badge" style={{ background: 'rgba(0,0,0,0.3)', color: '#fff' }}>Recommended</span>
                    </button>
                    <button
                      onClick={() => handleDecide('paid_in_full')}
                      style={{ justifyContent: 'space-between' }}
                    >
                      <span>{currentWf.approvalRequest.alternativeAction}</span>
                    </button>
                  </div>
                ) : (
                  <div className="badge b-ok" style={{ width: '100%', padding: '8px', justifyContent: 'center' }}>
                    ✓ Recorded: {approvalResolved === 'dispute' ? 'Dispute' : 'Pay in full'} decision (audit-logged; demo only)
                  </div>
                )}
              </div>
            )}

            {/* Connections & Data Sources */}
            <div className="inspector-section">
              <div className="row between" style={{ marginBottom: 10 }}>
                <strong style={{ fontSize: 13 }}>Connections & Data Feeds</strong>
                <span className="badge">{currentWf.tools.length}</span>
              </div>
              {currentWf.tools.map((t, idx) => (
                <div key={idx} className="connection-item">
                  <div>
                    <strong style={{ color: 'var(--ink-bright)' }}>{t.name}</strong>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>{t.category}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className={`badge ${t.mode === 'reads' ? 'b-ok' : t.mode === 'writes' ? 'b-info' : ''}`}>
                      {t.mode}
                    </span>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{t.lastCall}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Guidance Instructions Editor */}
            <div className="inspector-section">
              <div className="row between" style={{ marginBottom: 6 }}>
                <strong style={{ fontSize: 13 }}>Guidance & LLM Instructions</strong>
                <button className="sm" onClick={handleSaveGuidance} disabled={isSavingGuidance}>
                  {isSavingGuidance ? 'Saving...' : 'Save'}
                </button>
              </div>
              <p className="small muted" style={{ margin: '0 0 8px' }}>
                Saved for this synthetic demo scenario (audit-logged). Not injected into analyzer runs:
              </p>
              <textarea
                rows={3}
                value={guidanceDraft}
                onChange={(e) => setGuidanceDraft(e.target.value)}
                style={{ fontSize: 12, resize: 'vertical' }}
              />
            </div>

            {/* Assigned Tasks */}
            <div className="inspector-section">
              <strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>Tasks</strong>
              {currentWf.steps.filter(s => s.agentKey === selectedAgent?.key).map((s, idx) => (
                <div key={idx} style={{ background: 'var(--surface)', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--line)', marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-bright)' }}>{s.taskTitle}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{s.actionSummary}</div>
                  <div style={{ marginTop: 6 }}>
                    <span className="badge b-ok">Completed</span>
                  </div>
                </div>
              ))}
            </div>
            </>}
          </div>
        </div>
      )}

      {/* Node Graph Builder View */}
      {activeTab === 'builder' && (
        <div className="card" style={{ minHeight: 600, background: '#0a0e17' }}>
          <div className="row between" style={{ marginBottom: 16 }}>
            <div>
              <h2>Visual Agent Orchestrator & Node Graph Builder</h2>
              <p className="muted small">Configure multi-agent coordination topologies, LLM parameters, temperature, and prompt contracts.</p>
            </div>
            <div className="row">
              <button className="primary sm">+ Add Agent Node</button>
              <button className="sm">Save Topology</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {currentWf.agents.map((ag) => (
              <div key={ag.id} className="card elevated" style={{ borderTop: '3px solid #10b981', cursor: 'grab' }}>
                <div className="row between" style={{ marginBottom: 10 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <PixelAvatar type={ag.avatar as any} size={24} />
                    <strong style={{ fontSize: 13 }}>{ag.name}</strong>
                  </div>
                  <span className="badge b-ok">{ag.status}</span>
                </div>

                <label className="small muted">Select LLM Engine</label>
                <select defaultValue="xai.grok-4" style={{ marginBottom: 8, fontSize: 12 }}>
                  <option value="xai.grok-4">xai.grok-4 (fast inference)</option>
                  <option value="claude-3-7-sonnet">claude-3-7-sonnet (reasoning)</option>
                  <option value="gemini-2.5-pro">gemini-2.5-pro (multimodal)</option>
                  <option value="deterministic">deterministic-core (zero hallucination)</option>
                </select>

                <label className="small muted">Custom Role Instructions</label>
                <textarea
                  defaultValue={ag.guidance}
                  rows={2}
                  style={{ fontSize: 11, marginBottom: 8 }}
                />

                <div className="row between small muted" style={{ marginTop: 8 }}>
                  <span>Temperature: 0.01</span>
                  <span>Reads: {ag.reads.length} sources</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Board View (Kanban) */}
      {activeTab === 'board' && (
        <div className="studio-board-columns">
          {['Pending', 'Queued', 'Running', 'Waiting for Evidence', 'Waiting for Human Approval', 'Completed'].map((col) => (
            <div key={col} className="board-column">
              <div className="board-column-header">
                <span>{col}</span>
                <span className="badge">
                  {col === 'Waiting for Human Approval' && !approvalResolved ? '1' : col === 'Completed' ? '4' : '0'}
                </span>
              </div>

              {col === 'Waiting for Human Approval' && !approvalResolved && (
                <div
                  className="board-task-card"
                  style={{ borderColor: 'var(--warn)' }}
                  onClick={() => setActiveTab('canvas')}
                >
                  <div className="badge b-warn" style={{ marginBottom: 6 }}>Fiduciary Check</div>
                  <strong style={{ fontSize: 13, display: 'block', color: 'var(--ink-bright)' }}>
                    Approve vendor dispute for $1,200
                  </strong>
                  <p className="small muted" style={{ margin: '6px 0' }}>
                    Assigned to You · Lambda overbilled 12 hours after shutdown.
                  </p>
                  <div className="row between small muted">
                    <span>Priority: HIGH</span>
                    <span>Action Required</span>
                  </div>
                </div>
              )}

              {col === 'Completed' && (
                <>
                  <div className="board-task-card" onClick={() => setActiveTab('canvas')}>
                    <div className="badge b-ok" style={{ marginBottom: 6 }}>GPU Auditor</div>
                    <strong style={{ fontSize: 13, display: 'block' }}>K8s Pod Teardown Correlation</strong>
                    <p className="small muted" style={{ margin: '4px 0' }}>Verified 24h actual run time vs 36h invoiced.</p>
                  </div>
                  <div className="board-task-card" onClick={() => setActiveTab('canvas')}>
                    <div className="badge b-ok" style={{ marginBottom: 6 }}>Cost Allocator</div>
                    <strong style={{ fontSize: 13, display: 'block' }}>Draft JE-7027 Journal Entry</strong>
                    <p className="small muted" style={{ margin: '4px 0' }}>$1,200 overbill calculated at $100/hr contractual rate.</p>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Audit Trail View */}
      {activeTab === 'audit' && (
        <div className="card">
          <h2>Multi-Agent Audit Trail <span className="badge">synthetic demo data</span></h2>
          <p className="muted small">Illustrative scenario events. The authoritative audit ledger lives in the engine database (Control Center); studio demo decisions are recorded there.</p>

          <table style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Actor / Agent</th>
                <th>Action / Event</th>
                <th>Evidence & Cryptographic Proof</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono small">2026-11-04 00:15:02</td>
                <td><strong>GPU Auditor</strong></td>
                <td>Ingested Lambda Invoice HEL-2026-10-118-L3</td>
                <td className="small mono">SHA256: 8f4a1...9b2 · 36h compute claimed ($3,600)</td>
                <td><span className="badge b-ok">VERIFIED</span></td>
              </tr>
              <tr>
                <td className="mono small">2026-11-04 00:15:04</td>
                <td><strong>GPU Auditor</strong></td>
                <td>Queried Kubernetes pod lifecycle audit logs</td>
                <td className="small mono">SHA256: 4e11c...7d9 · Pod terminated at 08:00 UTC</td>
                <td><span className="badge b-ok">INDEPENDENT READBACK</span></td>
              </tr>
              <tr>
                <td className="mono small">2026-11-04 00:15:06</td>
                <td><strong>Cost Allocator</strong></td>
                <td>Computed contractual overcharge & drafted JE-7027</td>
                <td className="small mono">Debit AP $2,400 · Holdback $1,200</td>
                <td><span className="badge b-ok">CALCULATED</span></td>
              </tr>
              <tr>
                <td className="mono small">2026-11-04 00:15:08</td>
                <td><strong>You (Controller)</strong></td>
                <td>Fiduciary authorization checkpoint</td>
                <td className="small mono">{approvalResolved ? `Recorded: ${approvalResolved}` : 'Pending human decision'}</td>
                <td>
                  <span className={`badge ${approvalResolved ? 'b-ok' : 'b-warn'}`}>
                    {approvalResolved ? 'DECISION RECORDED' : 'AWAITING DECISION'}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Infrastructure Map View — real values from GET /api/studio/infrastructure (polled) */}
      {activeTab === 'infra' && (
        <div className="card">
          <h2>Infrastructure &amp; Runtime Map</h2>
          <p className="muted small">Live values read from the running server (ledger counts measured per request; connectors are local dry-run). <span className="badge">checked {infra?.checkedAt ? new Date(infra.checkedAt).toLocaleTimeString() : '—'}</span></p>

          <div className="infra-grid" style={{ marginTop: 16 }}>
            {(infra?.nodes ?? []).map((node: any) => (
              <div key={node.id} className="infra-card">
                <div className="row between" style={{ marginBottom: 6 }}>
                  <strong style={{ fontSize: 14, color: 'var(--ink-bright)' }}>{node.name}</strong>
                  <span className="badge b-ok">● {node.status}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>{node.role}</div>
                <div className="row between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                  <span className="muted">{node.workload}</span>
                  <span className="muted">{node.env}</span>
                </div>
                <div className="small muted" style={{ marginTop: 8 }}>{node.details}</div>
              </div>
            ))}
            {!infra && <p className="muted small">Loading live infrastructure data…</p>}
          </div>
        </div>
      )}
    </div>
  );
}
