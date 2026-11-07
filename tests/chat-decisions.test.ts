import { describe, it, expect } from 'vitest';
import type { CollabPort, InboundMessage } from '../src/server/collab/port.js';
import { makeEnv, rows, row, type Env } from './helpers.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { chatRef, parseChatCommand, parseChatIdentities } from '../src/server/collab/chat.js';
import { runOfShowPack } from '../src/server/packs/runofshow/pack.js';

/** Session 19: decisions typed in a bridged Switch room. Identity from the Switch sender, authority from the engine. */

describe('chat command grammar (pure)', () => {
  it('parses approve, decline and answer, with the reference upper-cased', () => {
    expect(parseChatCommand('approve Q-3F9A2C')).toEqual({ verb: 'approve', ref: 'Q-3F9A2C', rest: '' });
    expect(parseChatCommand('  Decline a-7b1d04 the panel cannot move before 13:00')).toEqual({ verb: 'decline', ref: 'A-7B1D04', rest: 'the panel cannot move before 13:00' });
    expect(parseChatCommand('answer Q-00AA11 Thursday is fine')?.rest).toBe('Thursday is fine');
    expect(parseChatCommand('@ripple approve Q-3F9A2C')).toEqual({ verb: 'approve', ref: 'Q-3F9A2C', rest: '' });
    expect(parseChatCommand('@ripple: decline A-7B1D04 no')?.verb).toBe('decline');
  });

  it('ignores ordinary chat and malformed references', () => {
    expect(parseChatCommand('approve it, looks good')).toBeNull();
    expect(parseChatCommand('approve X-123456')).toBeNull();
    expect(parseChatCommand('please approve Q-3F9A2C')).toBeNull();
    expect(parseChatCommand(undefined)).toBeNull();
  });

  it('round-trips the reference RIPPLE prints for a row id', () => {
    const ref = chatRef('Q', 'q_3f9a0b1c2d4e');
    expect(ref).toMatch(/^Q-[0-9A-Z]{6}$/);
    expect(parseChatCommand(`approve ${ref}`)?.ref).toBe(ref);
  });

  it('reads the operator identity map, lower-casing names and refusing malformed config', () => {
    expect(parseChatIdentities(undefined)).toEqual({});
    expect(parseChatIdentities('{"Alex":"Alex@Harborvine.example"}')).toEqual({ alex: 'alex@harborvine.example' });
    expect(() => parseChatIdentities('not json')).toThrow(/JSON/);
    expect(() => parseChatIdentities('{"alex":"no-at-sign"}')).toThrow(/email/);
  });
});

const EMAIL = { maya: 'maya@harborvine.example', jamie: 'jamie@harborvine.example', sam: 'sam@harborvine.example', alex: 'alex@harborvine.example', priya: 'priya@harborvine.example' };
const CHAT_MAP = { maya: EMAIL.maya, jamie: EMAIL.jamie, sam: EMAIL.sam, alex: EMAIL.alex, priya: EMAIL.priya };

/** A fake Switch room: records what RIPPLE posts and lets the test push a message in as a Mattermost user. */
function fakeSwitch() {
  const sent: { kind: string; body: string }[] = [];
  let handler: ((m: InboundMessage) => void) | null = null;
  const port = {
    mode: 'switch', label: 'fake switch (test)',
    describe: () => ({ mode: 'switch', connected: true, detail: 'fake room for tests' }),
    openRoom: async () => ({ mode: 'switch', externalId: 'room-fake', name: 'fake room', note: 'test' }),
    send: async (_room: unknown, msg: { kind: string; body: string }) => { sent.push({ kind: msg.kind, body: msg.body }); },
    subscribe: (_room: unknown, h: (m: InboundMessage) => void) => { handler = h; return () => { handler = null; }; },
  } as unknown as CollabPort;
  const say = (senderName: string, body: string) => {
    if (!handler) throw new Error('room not subscribed');
    handler({ senderName, senderId: `${senderName}-id`, body, messageId: `in-${Math.random().toString(36).slice(2)}`, addressed: false, timestamp: Date.now() });
  };
  return { port, sent, say };
}
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('chat decisions through the engine', () => {
  async function open(): Promise<{ e: Env; sw: ReturnType<typeof fakeSwitch>; m: { id: string } }> {
    const sw = fakeSwitch();
    const e = makeEnv(sw.port, extendedRegistry(), CHAT_MAP);
    const s = runOfShowPack.sample();
    const m = await e.engine.createMission(e.maya, { packId: 'run-of-show', title: s.title, plan: s.plan });
    e.engine.approveBaseline(e.maya, m.id, 'test');
    await e.engine.submitChange(e.maya, m.id, s.change);
    await settle();
    return { e, sw, m: { id: String(m.id) } };
  }
  const openQs = (e: Env, missionId: string) => rows(e, "SELECT * FROM questions WHERE mission_id=? AND status='open' AND key LIKE 'ev_decide_%'", missionId);
  const qFor = (e: Env, missionId: string, email: string) => openQs(e, missionId).find((q) => q.assignee_user_id === e.seeded.userIds[email])!;
  const refusals = (e: Env, missionId: string) => rows(e, "SELECT summary FROM audit_events WHERE mission_id=? AND type='chat_decision_refused' ORDER BY created_at", missionId).map((r) => r.summary as string);
  const decisions = (e: Env, missionId: string) => rows(e, "SELECT summary FROM audit_events WHERE mission_id=? AND type='chat_decision' ORDER BY created_at", missionId).map((r) => r.summary as string);

  it('the room shows each open question with the reference a person types back', async () => {
    const { e, sw, m } = await open();
    const q = qFor(e, m.id, EMAIL.maya);
    const posted = sw.sent.map((s) => s.body).join('\n');
    expect(posted).toContain(`approve ${chatRef('Q', q.id)}`);
    expect(posted).toContain(`decline ${chatRef('Q', q.id)} <reason>`);
  });

  it('a sender who is not mapped to a RIPPLE user changes nothing', async () => {
    const { e, sw, m } = await open();
    const q = qFor(e, m.id, EMAIL.maya);
    sw.say('stranger', `approve ${chatRef('Q', q.id)}`);
    await settle();
    expect(refusals(e, m.id).some((s) => s.includes('not mapped'))).toBe(true);
    expect(row(e, 'SELECT status FROM questions WHERE id=?', q.id).status).toBe('open');
  });

  it('a mapped person who is not the assignee is refused by the engine, and the question stays open', async () => {
    const { e, sw, m } = await open();
    const q = qFor(e, m.id, EMAIL.maya);
    sw.say('priya', `approve ${chatRef('Q', q.id)}`);
    await settle();
    expect(refusals(e, m.id).length).toBe(1);
    expect(row(e, 'SELECT status FROM questions WHERE id=?', q.id).status).toBe('open');
  });

  it('the assignee approves in the thread: recorded as that person, with the Switch sender named', async () => {
    const { e, sw, m } = await open();
    const q = qFor(e, m.id, EMAIL.maya);
    sw.say('maya', `approve ${chatRef('Q', q.id)}`);
    await settle();
    expect(row(e, 'SELECT status, answer_value, answered_by FROM questions WHERE id=?', q.id)).toMatchObject({ status: 'answered', answer_value: '"approve"', answered_by: e.seeded.userIds[EMAIL.maya] });
    expect(decisions(e, m.id)[0]).toContain('Maya Chen answered');
  });

  it('a decline without a reason is refused; with a reason it is recorded as declined', async () => {
    const { e, sw, m } = await open();
    const q = qFor(e, m.id, EMAIL.jamie);
    sw.say('jamie', `decline ${chatRef('Q', q.id)}`);
    await settle();
    expect(refusals(e, m.id).some((s) => s.includes('needs a reason'))).toBe(true);
    expect(row(e, 'SELECT status FROM questions WHERE id=?', q.id).status).toBe('open');
    sw.say('jamie', `decline ${chatRef('Q', q.id)} the panelists need until 13:00 to travel`);
    await settle();
    expect(row(e, 'SELECT answer_value FROM questions WHERE id=?', q.id).answer_value).toBe('"decline"');
  });

  it('an unknown reference is refused and nothing changes', async () => {
    const { e, sw, m } = await open();
    sw.say('maya', 'approve Q-ABCDEF');
    await settle();
    expect(refusals(e, m.id).some((s) => s.includes('no open question or pending approval'))).toBe(true);
    expect(openQs(e, m.id)).toHaveLength(3);
  });

  it('publishing is approved in chat by the lead planner only, and the approval is recorded as Alex', async () => {
    const { e, sw, m } = await open();
    for (const [who, email] of [['maya', EMAIL.maya], ['jamie', EMAIL.jamie], ['sam', EMAIL.sam]] as const) {
      sw.say(who, `approve ${chatRef('Q', qFor(e, m.id, email).id)}`);
      await settle();
    }
    const apr = row(e, "SELECT * FROM approvals WHERE mission_id=? AND status='pending' AND required_role='manager'", m.id);
    expect(apr).toBeDefined();
    const ref = chatRef('A', apr.id);
    sw.say('maya', `approve ${ref}`);
    await settle();
    expect(refusals(e, m.id).length).toBeGreaterThan(0);
    expect(row(e, 'SELECT status FROM approvals WHERE id=?', apr.id).status).toBe('pending');
    sw.say('alex', `approve ${ref}`);
    await settle();
    expect(row(e, 'SELECT status FROM approvals WHERE id=?', apr.id).status).not.toBe('pending');
    expect(decisions(e, m.id).some((s) => s.includes('Alex Morgan') && s.includes(ref))).toBe(true);
  });
});
