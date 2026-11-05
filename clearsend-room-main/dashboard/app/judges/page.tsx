import Link from "next/link";
import { Badge, ButtonLink, Card, Eyebrow, PageHeader } from "@/components/ui";

export const metadata = { title: "For judges" };

const STEPS = [
  ["Find a flight", "@clearsend flights LOS to LHR on 2026-12-15, 1 adult, I pay in USD", "Searches Sky-Scrapper (live fares, if keyed), OpenSky and OpenFlights. Open-data results say “fare unavailable”."],
  ["Choose", "option 2", "The agent asks “Which flight would you like?”, then “Would you like me to book this and pay with your PayPal account?”"],
  ["Confirm & pay", "yes, book it", "Your exact words go to the server, which creates a PayPal sandbox order. Approve it, say “paid”, the agent captures."],
  ["Open an escrow", "@clearsend open an escrow: 50 USD to Ada (sandbox email) in Ghana for a 3-slide deck, verifier Tunde", "Three HMAC-signed links appear, one per person."],
  ["Fund", "confirm fund", "Payer only. PayPal sandbox order → approve → capture → funded."],
  ["Deliver & verify", "(recipient posts the work)", "The free model checks each criterion; the agent posts ✓/✕ per criterion."],
  ["Release", "approve release", "Verifier only. PayPal Payout (sandbox) → released. The recipient’s own “approve” is refused (403)."],
] as const;

const GUARDS = [
  ["No token on an escrow link", "401"],
  ["Tampered token", "403"],
  ["Recipient approves own release", "403"],
  ["Vague “ok” as confirmation", "428"],
  ["Agent types the yes itself", "403"],
  ["Book a “fare unavailable” option", "422"],
  ["Same money request twice (Idempotency-Key)", "replayed, not repeated"],
  ["Too many searches from one IP", "429"],
];

export default function Judges() {
  return (
    <>
      <PageHeader eyebrow="Flip the Switch · Best Business Workflow" title={<>A real task, finished by <span className="gradient-text">people + an agent</span></>} actions={<><ButtonLink href="/plan">Try it on the web</ButtonLink><ButtonLink href="/switch" variant="ghost">Switch setup</ButtonLink></>}>
        The agent (OpenCode on a free OpenRouter model) is joined to a Slack, Discord, Mattermost, Teams or Telegram channel by Switch. The payer, recipient and verifier finish a cross-border payment with it. This site mirrors the room and offers the same flow on the web.
      </PageHeader>
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card strong>
          <Eyebrow>Seven messages in the room</Eyebrow>
          <ol className="mt-4 space-y-4">
            {STEPS.map(([t, msg, what], i) => (
              <li key={t} className="flex gap-4">
                <span className="btn-primary grid size-8 shrink-0 place-items-center rounded-full text-sm font-bold">{i + 1}</span>
                <div>
                  <div className="font-semibold">{t}</div>
                  <code className="mt-1 inline-block rounded-lg bg-[var(--line)] px-2 py-1 text-xs">{msg}</code>
                  <p className="mt-1 text-sm text-mut">{what}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
        <div className="space-y-6">
          <Card>
            <Eyebrow>Try to break it</Eyebrow>
            <ul className="mt-3 divide-y divide-[var(--line)] text-sm">{GUARDS.map(([g, r]) => <li key={g} className="flex justify-between gap-3 py-2"><span>{g}</span><Badge tone="bad">{r}</Badge></li>)}</ul>
          </Card>
          <Card>
            <Eyebrow>Where to look</Eyebrow>
            <ul className="mt-3 space-y-2 text-sm">
              <li><Link className="underline" href="/">Room</Link>: live transcript mirror + the 9-step workflow with live counts</li>
              <li><Link className="underline" href="/activity">Activity</Link>: AI decisions, verbatim human approvals, PayPal ids</li>
              <li><Link className="underline" href="/api/health">/api/health</Link>: real checks (Redis PING, PayPal sandbox token, OpenRouter key), cached 60s</li>
              <li><a className="underline" href="https://github.com/dukemawex/clearsend-room">Repo</a>: AGENTS.md, skills, CLI, Switch template, docs/switch-setup.md</li>
            </ul>
          </Card>
          <Card>
            <Eyebrow>Honest limits</Eyebrow>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-mut">
              <li>PayPal sandbox only. No airline ticket is issued.</li>
              <li>Priced fares need a Sky-Scrapper (RapidAPI) quota; open data has no fares.</li>
              <li>A chat “yes” is relayed by the agent; Switch room history is the proof of who typed it.</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
