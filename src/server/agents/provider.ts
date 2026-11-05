/** Provider abstraction for model-generated text. Everything else in RIPPLE is deterministic. */
export interface TextProvider {
  readonly name: string;
  readonly kind: 'deterministic' | 'model';
  /** Returns improved wording or null to keep the deterministic draft. Must preserve all facts. */
  rewrite(kind: string, draft: string, mustContain: string[]): Promise<string | null>;
}
export class DeterministicProvider implements TextProvider {
  readonly name = 'deterministic'; readonly kind = 'deterministic' as const;
  async rewrite() { return null; }
}
/**
 * Optional Anthropic Messages API provider (ANTHROPIC_API_KEY). It only rewrites the *wording* of the client email;
 * the result is rejected unless every required fact string survives, and is labelled "model:<id>".
 * Not exercised against the live API in this repo's tests (no key in CI) — only its guard logic is unit-tested via an injected fetch.
 */
export class AnthropicProvider implements TextProvider {
  readonly kind = 'model' as const;
  get name() { return `model:${this.model}`; }
  constructor(private apiKey: string, private model: string, private baseUrl = 'https://api.anthropic.com', private f: typeof fetch = fetch) {}
  async rewrite(kind: string, draft: string, mustContain: string[]): Promise<string | null> {
    if (kind !== 'client_communication') return null;
    try {
      const r = await this.f(`${this.baseUrl}/v1/messages`, {
        method: 'POST', headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, max_tokens: 800, messages: [{ role: 'user', content: `Rewrite this catering client email to be warm and concise. Keep every fact, number, time and the Subject line exactly. Do NOT add promises, allergen-safety claims, certifications or guarantees. Output only the email.\n\n${draft}` }] }),
      });
      if (!r.ok) return null;
      const j: any = await r.json();
      const text: string | undefined = j?.content?.[0]?.text;
      if (!text || !mustContain.every((s) => text.includes(s))) return null;
      if (/\b(certif(y|ied)|guarantee[sd]?|100% safe|allergen[- ]free)\b/i.test(text)) return null;
      return text;
    } catch { return null; }
  }
}
export function providerFromEnv(env: NodeJS.ProcessEnv): TextProvider {
  return env.ANTHROPIC_API_KEY ? new AnthropicProvider(env.ANTHROPIC_API_KEY, env.RIPPLE_MODEL || 'claude-sonnet-5-5', env.ANTHROPIC_BASE_URL || undefined) : new DeterministicProvider();
}
