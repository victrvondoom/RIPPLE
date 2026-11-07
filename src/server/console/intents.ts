import { z } from 'zod';

/**
 * Switch Console intents. Plain language → one structured intent.
 *
 * Interpretation is two-tier, cheapest first:
 *   1. a deterministic parser (regex + keywords) handles every documented command;
 *   2. only when it returns `unknown`, an optional model (Anthropic, default claude-opus-5-5) maps the phrasing to ONE of the same intents.
 * The model never executes anything. Its output is schema-validated and every state-changing intent still waits for a
 * signed-in human to confirm it; the engine then enforces that person's role.
 */
export const READ_INTENTS = ['help', 'status', 'attention', 'approvals', 'actions', 'questions', 'missions', 'brief', 'verify', 'capabilities', 'packs', 'switch', 'navigate'] as const;
export const WRITE_INTENTS = ['approve', 'reject', 'execute', 'answer', 'demo', 'seal', 'complete'] as const;
export type IntentKind = typeof READ_INTENTS[number] | typeof WRITE_INTENTS[number] | 'confirm' | 'cancel' | 'unknown';
export interface Intent { kind: IntentKind; ref?: string; text?: string; page?: string; pack?: string }
export const isWrite = (k: IntentKind) => (WRITE_INTENTS as readonly string[]).includes(k);

export const PAGES: Record<string, { hash: string; label: string; words: string[] }> = {
  'mission-control': { hash: '#/mission-control', label: 'Mission Control', words: ['mission control', 'command', 'overview dashboard', 'mission-control'] },
  workbench: { hash: '#/workbench', label: 'Operations Workbench', words: ['workbench', 'operations', 'cases', 'case dashboard'] },
  trust: { hash: '#/trust', label: 'Trust & Evidence Center', words: ['trust', 'evidence center', 'receipts', 'ledger'] },
  knowledge: { hash: '#/knowledge', label: 'Knowledge & Decision Center', words: ['knowledge', 'decisions', 'memory', 'decision center'] },
  approvals: { hash: '#/approvals', label: 'Approvals', words: ['approvals page', 'approval queue'] },
  control: { hash: '#/control', label: 'Control Center', words: ['control center'] },
  reality: { hash: '#/reality', label: 'Reality Gap Engine', words: ['reality', 'gap engine', 'rigor'] },
  packs: { hash: '#/packs', label: 'Workflow Packs', words: ['packs page', 'workflow packs'] },
  studio: { hash: '#/studio', label: 'Workflow Studio', words: ['studio'] },
  settings: { hash: '#/settings', label: 'Settings', words: ['settings'] },
};

const has = (t: string, ...w: string[]) => w.some((x) => t.includes(x));
const refOf = (s: string) => { const m = /^#?\s*(\d{1,3})\b/.exec(s.trim()); return m ? m[1] : s.trim() || undefined; };

export function parseIntent(input: string): Intent {
  const raw = input.trim(); const t = raw.toLowerCase().replace(/\s+/g, ' ');
  if (!t) return { kind: 'unknown' };
  if (/^(yes|y|confirm|confirmed|do it|go ahead|proceed)\b/.test(t)) return { kind: 'confirm' };
  if (/^(no|n|cancel|stop|abort|never ?mind)\b/.test(t)) return { kind: 'cancel' };
  if (/^(help|\?|commands|what can you do)/.test(t)) return { kind: 'help' };

  let m: RegExpExecArray | null;
  if ((m = /^(?:please )?approve\s+(.+?)(?:\s+(?:because|note|—|-|:)\s+(.+))?$/i.exec(raw))) return { kind: 'approve', ref: refOf(m[1]), text: m[2]?.trim() };
  if ((m = /^(?:please )?reject\s+(.+?)(?:\s+(?:because|note|—|-|:)\s+(.+))?$/i.exec(raw))) return { kind: 'reject', ref: refOf(m[1]), text: m[2]?.trim() };
  if ((m = /^(?:please )?(?:execute|run action|send action|perform)\s+(.+)$/i.exec(raw))) return { kind: 'execute', ref: refOf(m[1]) };
  if ((m = /^answer\s+#?(\d{1,3})\s*[:,-]?\s*(.+)$/i.exec(raw))) return { kind: 'answer', ref: m[1], text: m[2].trim() };
  if ((m = /^(?:start|run|launch|create|open)\s+(?:a\s+)?(?:demo|sample)(?:\s+(?:mission|of|for))?\s+(.+)$/i.exec(raw)) || (m = /^(?:start|run|launch)\s+(?:the\s+)?(.+?)\s+(?:demo|sample)$/i.exec(raw))) return { kind: 'demo', pack: m[1].trim().toLowerCase() };
  if (has(t, 'seal the ledger', 'seal ledger', 'seal audit')) return { kind: 'seal' };
  if ((m = /^(?:please )?(?:complete|close|finish)(?: the)?(?: mission| case)?\s*(.*)$/i.exec(raw))) return { kind: 'complete', ref: m[1].trim() ? refOf(m[1]) : undefined };

  if (/^(open|go to|goto|show me the|show the|take me to|navigate to)\b/.test(t)) for (const [key, p] of Object.entries(PAGES)) if (has(t, ...p.words)) return { kind: 'navigate', page: key };

  if (has(t, 'verify chain', 'verify the chain', 'verify ledger', 'verify the ledger', 'tamper', 'integrity')) return { kind: 'verify' };
  if (has(t, 'brief', 'digest', 'summary of today', 'morning')) return { kind: 'brief' };
  if (has(t, 'attention', 'urgent', 'critical', 'on fire', 'stuck', 'problems')) return { kind: 'attention' };
  if (has(t, 'approval')) return { kind: 'approvals' };
  if (has(t, 'question')) return { kind: 'questions' };
  if (has(t, 'ready to execute', 'approved actions', 'actions')) return { kind: 'actions' };
  if (has(t, 'capabilit', 'systems', 'projects', 'scenario')) return { kind: 'capabilities' };
  if (has(t, 'pack')) return { kind: 'packs' };
  if (has(t, 'switch', 'connection', 'connected')) return { kind: 'switch' };
  if (has(t, 'mission', 'workflows', 'cases')) return { kind: 'missions' };
  if (has(t, 'status', 'how are we', "how's it going", 'health', 'kpi')) return { kind: 'status' };
  return { kind: 'unknown' };
}

const ModelIntent = z.object({
  kind: z.enum([...READ_INTENTS, ...WRITE_INTENTS, 'unknown'] as [string, ...string[]]),
  ref: z.string().max(120).optional(), text: z.string().max(500).optional(), page: z.string().max(40).optional(), pack: z.string().max(60).optional(),
});

export interface ModelInterpreter { readonly name: string; interpret(text: string): Promise<Intent | null> }

/**
 * Optional model fallback. Called ONLY for phrases the deterministic parser could not place, with a small token budget.
 * Not exercised against the live API in this repository's tests (no key in CI); the guard logic is unit-tested with an injected fetch.
 */
export class AnthropicInterpreter implements ModelInterpreter {
  get name() { return `model:${this.model}`; }
  constructor(private apiKey: string, private model = 'claude-opus-5-5', private baseUrl = 'https://api.anthropic.com', private f: typeof fetch = fetch) {}
  async interpret(text: string): Promise<Intent | null> {
    const prompt = `You route a user's message in the RIPPLE operations console to exactly one intent. Reply with ONE JSON object and nothing else.
Intents: ${[...READ_INTENTS, ...WRITE_INTENTS].join(', ')}, unknown.
Fields: kind (required); ref (list number or title words for approve/reject/execute/answer); text (approval note or answer text); page (one of ${Object.keys(PAGES).join(', ')}); pack (workflow pack name for demo).
Never invent a ref the user did not give. If unsure, use "unknown".
Message: ${JSON.stringify(text.slice(0, 600))}`;
    try {
      const r = await this.f(`${this.baseUrl}/v1/messages`, {
        method: 'POST', headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) return null;
      const body: any = await r.json();
      const out: string = body?.content?.find?.((c: any) => c.type === 'text')?.text ?? '';
      const json = /\{[\s\S]*\}/.exec(out)?.[0]; if (!json) return null;
      const parsed = ModelIntent.safeParse(JSON.parse(json));
      if (!parsed.success) return null;
      const i = parsed.data as Intent;
      if (i.page && !PAGES[i.page]) delete i.page;
      return i;
    } catch { return null; }
  }
}
export function interpreterFromEnv(env: NodeJS.ProcessEnv): ModelInterpreter | null {
  return env.ANTHROPIC_API_KEY ? new AnthropicInterpreter(env.ANTHROPIC_API_KEY, env.RIPPLE_CONSOLE_MODEL || 'claude-opus-5-5', env.ANTHROPIC_BASE_URL || undefined) : null;
}

export const HELP = [
  'status · what needs attention · brief me',
  'list approvals · approve 1 [because …] · reject 2 because …',
  'list actions · execute 1 (an unknown outcome is read back first, never repeated blindly)',
  'complete mission (only if every completion criterion is met)',
  'list questions · answer 1: <your answer>',
  'missions · capabilities · packs · start demo podflow',
  'verify the ledger · seal the ledger',
  'open mission control | workbench | trust | knowledge',
  'switch status · yes / cancel (for a pending confirmation)',
];
