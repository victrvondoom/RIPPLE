import { useApi } from '../api';
import { SwitchRoom } from '../components/SwitchRoom';
import type { Me } from '../App';

/**
 * Switch Room, in plain words (session 20). Everything shown comes from /api/console (what the server observed when it
 * last tried to connect). RIPPLE is ONE participant in the Switch room: your own coding agents (Claude Code, Codex, …)
 * join the same room through Switch Console under their own names. RIPPLE reads what they write as advice and never
 * writes in their name; anything that changes a mission waits for a signed-in person to say yes here.
 */
export function SwitchRoomPage({ me }: { me: Me }) {
  const { data } = useApi<any>('/console', 5000);
  const st = data?.state;
  const connected = st?.status === 'connected';
  const configured = !!st?.switchConfigured;
  const canToggle = me.user.role === 'manager' || me.user.role === 'owner';
  return <>
    <h1>Switch Room</h1>
    <p className="muted" style={{ marginTop: 0 }}>Talk to RIPPLE in plain language. When Switch is connected, the same conversation happens in a Switch room where your team and your own coding agents can join.</p>
    <div className="grid g3" style={{ marginBottom: 14 }}>
      <div className={`card sr-step ${connected ? 'ok' : ''}`}>
        <div className="sr-n">1</div><h3>Is Switch connected?</h3>
        <p className="sr-big">{!st ? '…' : connected ? 'Yes' : 'Not yet'}</p>
        <p className="small muted">{!st ? '' : connected ? 'RIPPLE is in a Switch room and posts mission updates there.' : !configured ? 'This server has no Switch address yet. Ask the admin to add SWITCH_BRIDGE_URL, SWITCH_AGENT_ID and SWITCH_AGENT_API_KEY (see docs/SWITCH.md) and restart.' : st.enabled ? 'Switch is configured but did not answer. Open Switch Console on the server machine and make sure it is running.' : canToggle ? 'Switch is configured. Turn on the switch in the chat panel below.' : 'Ask a manager to turn on the switch below.'}</p>
      </div>
      <div className="card sr-step">
        <div className="sr-n">2</div><h3>Bring your coding agents</h3>
        <p className="small">Claude Code, Codex or any agent you run locally joins through <b>Switch Console</b>: register it as an agent there and add it to the RIPPLE room. It keeps its own name and its own key.</p>
        <p className="small muted">RIPPLE never answers as your agent. What your agent writes is read as advice; it cannot approve or change anything by itself.</p>
      </div>
      <div className="card sr-step">
        <div className="sr-n">3</div><h3>Say what you need</h3>
        <p className="small">Ask “what needs attention”, “list approvals” or “approve 1”. Anything that changes a mission asks you first: press <b>Yes, do it</b> and it runs under your name and role.</p>
      </div>
    </div>
    <SwitchRoom me={me} mode="page" />
  </>;
}
