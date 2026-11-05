const BUDGETS = [
  { team: 'Frontier Language Models', spent: 370.6, cap: 520 },
  { team: 'Inference Efficiency', spent: 21.6, cap: 40 },
  { team: 'Multimodal Perception', spent: 187.5, cap: 240 },
  { team: 'RL and Agents', spent: 112.7, cap: 150 },
];
const FEEDS = [
  { name: 'Lambda billing feed', done: 0, total: 3, next: 'Oct 25' },
  { name: 'Nebius billing feed', done: 1, total: 2, next: 'Oct 26' },
];

/** Right-hand home panel shown when nothing is selected (reference: moa home). */
export function StudioHome({ name, doneCount, onAsk }: { name: string; doneCount: number; onAsk: (q: string) => void }) {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return <div className="studio-home">
    <div className="home-banner" aria-hidden />
    <h3>{greet}, {name}</h3>
    <p className="muted small">All clear for this period. <span className="badge">synthetic demo data</span></p>
    <div className="home-card">
      <div className="row between"><strong>Compute budgets</strong><span className="muted small">Day 25 of 31</span></div>
      {BUDGETS.map((b) => {
        const pct = Math.min(100, (b.spent / b.cap) * 100);
        return <div key={b.team} className="budget">
          <div className="row between small"><span>{b.team}</span><span className="muted">${b.spent}K / ${b.cap}K</span></div>
          <div className="bar"><i style={{ width: `${pct}%`, background: pct > 85 ? '#f59e0b' : '#22c55e' }} /></div>
        </div>;
      })}
    </div>
    <details className="home-card" open>
      <summary><strong>Running on its own</strong></summary>
      {FEEDS.map((f) => <div key={f.name} className="row between small feed"><span>○ {f.name}</span><span className="muted">{f.done}/{f.total} · next {f.next}</span></div>)}
    </details>
    <div className="home-card row between"><strong>Done</strong><span className="muted">{doneCount}</span></div>
    <div className="home-asks">
      {['What is blocking close?', 'Where are we overbilled most?'].map((q) => <button key={q} className="ask" onClick={() => onAsk(q)}>{q} <span>↗</span></button>)}
    </div>
  </div>;
}
