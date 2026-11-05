import { Card, Eyebrow, PageHeader } from "@/components/ui";

export const metadata = { title: "Switch setup" };

const NODES = [
  { t: "Team chat", d: "Slack · Teams · Discord · Mattermost · Telegram", c: "payer, recipient, verifier" },
  { t: "Switch", d: "Self-hosted server + Console", c: "room, history, bridge, agent protocol" },
  { t: "OpenCode agent", d: "free OpenRouter model", c: "AGENTS.md + docs/skills" },
  { t: "cli/clearsend.mjs", d: "the agent’s only tool", c: "service key, JSON out" },
  { t: "ClearSend API", d: "this dashboard", c: "PayPal sandbox · Upstash · flights · FX · verifier" },
];

const STEPS = [
  ["Install Switch Console + Docker", "From github.com/sandbox-quantum/switch releases. Console runs a local Switch server (Mattermost included) or connects to yours."],
  ["Add OpenCode as the agent provider", "Console → Agent providers → OpenCode. Switch passes OPENROUTER_API_KEY and OPENCODE_MODEL through to the session."],
  ["Connect your chat (optional)", "Slack, Teams, Discord or Telegram from Console → messaging apps. Or use the bundled Mattermost."],
  ["Import the template", "Templates → Import switch/clearsend-room.template.yaml → pick the app → Create. It creates @clearsend, clones this repo, creates #clearsend-room with the escrow-lifecycle doc and posts the kickoff."],
  ["Give the CLI its key", "In the agent’s directory create .env with CLEARSEND_API_URL and CLEARSEND_API_KEY. The agent never sees PayPal or Upstash secrets."],
  ["Invite the three people", "Payer, recipient, verifier join the channel and talk to @clearsend."],
] as const;

export default function SwitchPage() {
  return (
    <>
      <PageHeader eyebrow="Turn your solo agent into a teammate" title={<>How <span className="gradient-text">Switch</span> connects the agent to the team</>}>
        Switch makes a chat channel a room where people and agents share one conversation. ClearSend is one agent in that room, with hard rules about money.
      </PageHeader>
      <Card strong>
        <Eyebrow>Architecture</Eyebrow>
        <ol className="mt-5 grid gap-3 lg:grid-cols-5" aria-label="Data flow">
          {NODES.map((n, i) => (
            <li key={n.t} className="relative">
              <div className={`h-full rounded-2xl border border-line p-4 ${i === 1 ? "gradient-ring bg-acc" : "glass"}`}>
                <div className="font-display font-semibold">{n.t}</div>
                <div className="text-xs text-mut">{n.d}</div>
                <div className="mt-2 text-xs">{n.c}</div>
              </div>
              {i < NODES.length - 1 && <span aria-hidden className="absolute -right-2.5 top-1/2 z-10 hidden -translate-y-1/2 text-mut lg:block">→</span>}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-mut">Every money step returns to the chat: the agent posts status, links and the AI verdict; humans answer with their own words, which the server stores verbatim.</p>
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <Eyebrow>Setup in six steps</Eyebrow>
          <ol className="mt-4 space-y-4">{STEPS.map(([t, d], i) => <li key={t} className="flex gap-3"><span className="btn-primary grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold">{i + 1}</span><div><div className="font-semibold">{t}</div><p className="text-sm text-mut">{d}</p></div></li>)}</ol>
        </Card>
        <Card>
          <Eyebrow>What the agent runs</Eyebrow>
          <pre className="mt-3 overflow-x-auto rounded-2xl bg-[var(--line)] p-4 text-xs leading-relaxed">{`node cli/clearsend.mjs health
node cli/clearsend.mjs flights --from LOS --to LHR --date 2026-12-15
node cli/clearsend.mjs trip-quote --search srch_… --option 2 \\
  --traveller "Ada Obi|ada@example.com"
node cli/clearsend.mjs trip-pay --trip trip_… \\
  --confirmed-by ada --confirmation "yes, book it"
node cli/clearsend.mjs status --subject trip_… --step pay \\
  --summary "Waiting for Ada to approve in PayPal sandbox"
node cli/clearsend.mjs escrow-verify --escrow esc_…`}</pre>
          <p className="mt-3 text-sm text-mut">Full guide: <a className="underline" href="https://github.com/dukemawex/clearsend-room/blob/main/docs/switch-setup.md">docs/switch-setup.md</a></p>
        </Card>
      </div>
    </>
  );
}
