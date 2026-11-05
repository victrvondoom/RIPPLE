"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { API } from "@/lib/api";
import {
  CHECKOUT, START, advance, answer, apply, checkoutOver, confirmPurchase, cleanTitle, goBack, counts, select, storeLabel, titleCase, waiting,
  type Answer, type GridItem, type Pick, type Question, type Row, type Run,
} from "@/lib/run";
import { ArrowUpRightIcon, CheckIcon, ChevronIcon, NoImageIcon, SendIcon } from "./Icons";
import { Logo } from "./Logo";

// Matches .feed-row in globals.css. The follow loop uses it to find the row being checked without measuring.
const ROW_HEIGHT = 36;

// How often a found listing joins the feed while searching, and how often the next one is checked, in milliseconds.
const SEARCH_MS = 55;
const CHECK_MS = 70;

// How quickly the list scroll catches up, in milliseconds. While the list moves at a steady speed, easing trails the
// target by speed × this, so the scam check leads by the same amount to keep the row being checked centered.
const FOLLOW_MS = 260;
const CHECK_LEAD = (ROW_HEIGHT / CHECK_MS) * FOLLOW_MS;

// How long each thinking sentence stays on screen before the next one, in milliseconds.
const THINK_MS = 2800;

// The scam check mounts rows just ahead of the one being checked instead of all at once, which avoids a long first
// frame. Twelve rows fill the box below the centered row and its bottom fade.
const CHECK_AHEAD = 12;

// The qualified grid: four photos a row, two rows a page, and at most five favorites.
const PER_ROW = 4;
const ROWS = 2;
const PER_PAGE = PER_ROW * ROWS;
const MAX_FAVORITES = 5;
// One page step of the pager thumb: a 6px dot plus the 8px gap, as .pager-dot and .pager-dots set them.
const PAGE_DOT = 14;

// Photos narrower than this, in pixels, are placeholders rather than product photos.
const MIN_PHOTO = 40;

// How long the first Confirm click waits for the second before it resets, in milliseconds.
const ARM_MS = 5000;

// Events the run listens for on the GET /chat stream.
const EVENTS = [
  "run", "title", "reasoning", "question", "answer", "thought", "instruction", "listing", "verdict", "done", "narrow",
  "qualified", "selected", "pick", "confirmed", "back", "checkout", "receipt", "end", "error",
];

const shorten = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

const dollars = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

const limitOf = (i: NonNullable<Run["instruction"]>) => (i.max_price ? dollars(i.max_price) : null);

const titleOf = (i: NonNullable<Run["instruction"]>) => (limitOf(i) ? `${i.item} Under ${limitOf(i)}` : i.item);

// "Oct 23, 2026 · 4:42 PM".
const paidOn = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

type Props = {
  prompt: string;
  saved?: Run;
  onTitle?: (title: string) => void;
  onAsking?: (asking: boolean) => void;
  onDone?: (run: Run) => void;
};

// Streams one Hunter run from the agent API. With `saved`, it renders that finished run instead.
export function AgentRun({ prompt, saved, onTitle, onAsking, onDone }: Props) {
  const [run, setRun] = useState<Run>(saved ?? START);
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const feed = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onTitle, onAsking, onDone });

  useEffect(() => {
    callbacks.current = { onTitle, onAsking, onDone };
  });

  // ponytail: the stream lives in this component, so leaving the chat mid-run ends it and coming back starts over.
  // Keep runs in App state (or the backend) if chats should keep running in the background.
  useEffect(() => {
    if (saved) return;
    const source = new EventSource(`${API}/chat?prompt=${encodeURIComponent(prompt)}`);
    for (const type of EVENTS) {
      source.addEventListener(type, (event) => {
        // A connection failure is also dispatched as "error", but without data.
        const data = (event as MessageEvent).data;
        if (type === "end" || data === undefined) source.close();
        setRun((current) => apply(current, type, data === undefined ? {} : JSON.parse(data)));
      });
    }
    return () => source.close();
  }, [prompt, saved]);

  useEffect(() => {
    if (run.title && !saved) callbacks.current.onTitle?.(run.title);
  }, [run.title, saved]);

  const asked = waiting(run);
  useEffect(() => {
    if (!saved) callbacks.current.onAsking?.(asked);
  }, [asked, saved]);

  // Each reply shows once the stream echoes it back. If it can't be sent, the run ends with the reason.
  const failed = (e: Error) => setRun((current) => ({ ...current, error: e.message }));
  const reply = (text: string) => {
    if (run.runId) answer(run.runId, text).catch(failed);
  };
  const choose = (ids: string[]) => {
    if (run.runId) select(run.runId, ids).catch(failed);
  };
  // Back is sent once; the link hides until the stream says it landed.
  const [backing, setBacking] = useState(false);
  const [landed, setLanded] = useState(run.backs);
  if (landed !== run.backs) {
    setLanded(run.backs);
    setBacking(false);
  }
  const back = () => {
    if (!run.runId || backing) return;
    setBacking(true);
    goBack(run.runId).catch(failed);
  };
  const decide = (ok: boolean) => {
    if (run.runId) confirmPurchase(run.runId, ok, run.choice ?? 0).catch(failed);
  };
  const asking = (stage: Question["stage"]) =>
    run.question?.stage === stage ? (
      <>
        {backLink(run.answers.length > 0)}
        <Ask key={run.question.text} question={run.question} onAnswer={reply} />
      </>
    ) : null;

  // A tiny "Back" above whatever Hunter is waiting on, when there is a step to go back to.
  function backLink(show: boolean) {
    if (saved || !show) return null;
    return <BackLink onBack={back} disabled={backing} />;
  }

  // Rows join the feed, and then get checked, one tick at a time.
  useEffect(() => {
    if (saved || (run.stage !== 1 && run.stage !== 2)) return;
    const id = setInterval(() => setRun(advance), run.stage === 1 ? SEARCH_MS : CHECK_MS);
    return () => clearInterval(id);
  }, [saved, run.stage]);

  // After the check: the user picks favorites, Hunter weighs them and marks the best one, then waits for the
  // go-ahead and pays step by step as the store answers. Each step waits for its event, so the pace never runs
  // ahead of the real checkout. An error, or a no to paying, finishes right away.
  const paymentOver = checkoutOver(run);
  useEffect(() => {
    if (saved || run.stage === 5) return;
    const later = (ms: number, change: Partial<Run>) => {
      const id = setTimeout(() => setRun((current) => ({ ...current, ...change })), ms);
      return () => clearTimeout(id);
    };
    if (run.error) return later(300, { stage: 5 });
    if (run.stage === 3 && run.picks && !run.picked) return later(2000, { picked: true });
    if (run.stage === 3 && run.picked) return later(1400, { stage: run.picks?.length ? 4 : 5 });
    if (run.stage === 4 && run.confirmed === false) return later(600, { stage: 5 });
    if (run.stage === 4 && paymentOver) return later(1400, { stage: 5 });
    if (run.stage === 4 && run.steps[run.paid]) return later(run.paid === 0 ? 900 : 1300, { paid: run.paid + 1 });
  }, [saved, run.stage, run.error, run.picks, run.picked, run.confirmed, run.paid, run.steps, paymentOver]);

  useEffect(() => {
    if (run.stage === 5 && !saved) callbacks.current.onDone?.(run);
  }, [run, saved]);

  // The follow loop reads the latest position from a ref, so it never restarts when a row arrives.
  const gatedNow = useRef(0);
  useEffect(() => {
    gatedNow.current = run.gated;
  }, [run.gated]);

  // While the list is live, one animation-frame loop eases the scroll toward its target: the newest listing while
  // searching, the row being checked while the gate runs. Rows are a fixed height and never fold away, so the target
  // only moves forward, and the frame-rate independent easing keeps the motion continuous.
  useEffect(() => {
    if (run.stage !== 1 && run.stage !== 2) return;
    // Each loop holds the list it started with. A loop from the previous stage can tick once more after the next
    // list mounts, and through the shared ref it would scroll that new list.
    const box = feed.current;
    if (!box) return;
    const gating = run.stage === 2;
    let frame = 0;
    let position = box.scrollTop;
    let last = performance.now();

    const tick = (now: number) => {
      const max = box.scrollHeight - box.clientHeight;
      const target = gating ? (gatedNow.current + 0.5) * ROW_HEIGHT - box.clientHeight / 2 + CHECK_LEAD : max;
      const elapsed = Math.min(now - last, 64);
      position += (Math.max(0, Math.min(max, target)) - position) * (1 - Math.exp(-elapsed / FOLLOW_MS));
      box.scrollTop = position;
      last = now;
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run.stage]);

  // Keep the newest part of the run in view as it grows.
  useEffect(() => {
    if (saved) return;
    const id = setTimeout(() => end.current?.scrollIntoView({ block: "end", behavior: "smooth" }), 350);
    return () => clearTimeout(id);
  }, [saved, run.stage, run.thoughts.length, run.instruction, run.question, run.qualified, run.picks, run.picked, run.paid]);

  const total = counts(run.rows);
  const checked = counts(run.rows.slice(0, run.gated));
  const chosen = run.picks?.[run.choice ?? 0];
  // The favorites can be switched until the user confirms or cancels.
  const choosing = !saved && run.stage === 4 && run.confirmed === undefined;

  // One line per finished stage, shown when the stage folds up.
  const summaries = [
    run.instruction ? titleOf(run.instruction) : "Your Request",
    `${run.rows.length} Listings From ${total.stores} ${total.stores === 1 ? "Store" : "Stores"}`,
    `${total.safe} Safe · ${total.blocked} Scams Blocked`,
    chosen ? `${chosen.store} · ${chosen.price.toFixed(2)} USDC` : "No Safe Listing",
    run.receipt ? `Paid ${run.receipt.amount.toFixed(2)} USDC` : run.confirmed === false ? "Canceled" : "Not Paid",
  ];
  const favorites = run.selected?.length ?? 0;
  const pickLive = run.question
    ? "Waiting for Your Answer"
    : run.qualified && !run.selected
      ? `${run.qualified.length} Qualified Items`
      : favorites
        ? `Weighing ${favorites} ${favorites === 1 ? "Favorite" : "Favorites"}`
        : `Comparing ${run.narrowed?.kept ?? total.safe} Safe Listings`;

  const status = (stage: number) => (run.stage > stage ? "done" : run.stage === stage ? "active" : "pending");
  // The active stage is open. Finished stages fold to their summary, and a click opens them again.
  // The picking stage stays open while the user can still switch favorites.
  const isOpen = (stage: number) => opened[stage] ?? (run.stage === stage || (stage === 3 && choosing));
  const toggle = (stage: number) => setOpened((current) => ({ ...current, [stage]: !isOpen(stage) }));
  const stageProps = (stage: number) => ({
    status: status(stage),
    open: isOpen(stage),
    summary: summaries[stage],
    onToggle: () => toggle(stage),
  });

  return (
    <div className="run">
      <Stage {...stageProps(0)} title="Understanding Your Request">
        {!run.instruction && <Answers answers={run.answers} stage="understand" />}
        {asking("understand")}
        {run.stage === 0 && !run.instruction && !run.error && !run.question && (
          <Thinking text={run.reasoning.understand || "Thinking"} />
        )}
        {run.instruction && <Request instruction={run.instruction} />}
      </Stage>

      {run.stage >= 1 && run.instruction && (
        <Stage {...stageProps(1)} expandable={false} title="Searching Stores" live={`${run.scraped} Listings Found`}>
          {run.stage === 1 && <Feed ref={feed} rows={run.rows.slice(0, run.scraped)} gated={-1} />}
        </Stage>
      )}

      {run.stage >= 2 && run.rows.length > 0 && (
        <Stage {...stageProps(2)} title="Checking for Scams" live={`${checked.safe} Safe · ${checked.blocked} Blocked`}>
          <Feed ref={feed} rows={run.rows.slice(0, run.gated + CHECK_AHEAD)} gated={run.gated} />
        </Stage>
      )}

      {run.stage >= 3 && run.rows.length > 0 && (
        <Stage
          {...stageProps(3)}
          title="Picking the Best Deal"
          live={pickLive}
        >
          <Answers answers={run.answers} stage="pick" />
          {asking("pick")}
          {!run.qualified && !run.picks && !run.question && (
            <Thinking text={run.reasoning.pick || "Finding listings that fit"} />
          )}
          {run.qualified && run.qualified.length > 0 && !run.selected && (
            <>
              {backLink(run.answers.length > 0)}
              <Qualified items={run.qualified} picked={run.reselect} live={!saved} onChoose={choose} />
            </>
          )}
          {run.selected && !run.picks && <Thinking text="Weighing seller, price, reviews and condition" />}
          {run.picks && run.picks.length > 0 && (
            <Weighing
              picks={run.picks}
              picked={run.picked}
              choice={run.choice ?? 0}
              onChoose={choosing ? (choice) => setRun((current) => ({ ...current, choice })) : undefined}
            />
          )}
        </Stage>
      )}

      {run.stage >= 4 && chosen && (
        <Stage
          {...stageProps(4)}
          title={run.steps.length ? "Paying the Store" : "Confirm Your Purchase"}
          live={run.confirmed === undefined ? undefined : `${chosen.store} · USDC`}
        >
          {chosen.score !== undefined && (
            <>
              {backLink(choosing)}
              <Offer pick={chosen} confirmed={run.confirmed} live={!saved} onDecide={decide} />
            </>
          )}
          {run.confirmed !== false && run.steps.length > 0 && <ol className="checkout">
            {CHECKOUT(chosen.store).map((label, index) => {
              const step = run.steps[index];
              const shown = index < run.paid;
              const state = shown
                ? step.state === "done" ? "done" : "stopped"
                : index === run.paid && run.stage === 4 && !checkoutOver(run) ? "active" : "pending";
              return (
                <li key={label} className={state}>
                  <span className="step-mark">
                    {state === "done" ? <CheckIcon size={14} /> : <span className={`stage-icon ${state}`} />}
                  </span>
                  <div>
                    <div className="checkout-label">{label}</div>
                    {shown && step.state !== "done" && <div className="cell-sub">{step.detail}</div>}
                  </div>
                </li>
              );
            })}
          </ol>}
        </Stage>
      )}

      {run.stage >= 5 && <Finish run={run} />}
      <div ref={end} />
    </div>
  );
}

// What Hunter is looking for: the item, then a chip for each detail (who it is for, the size and the limit).
function Request({ instruction: i }: { instruction: NonNullable<Run["instruction"]> }) {
  const who = i.gender === "men" ? "Men's" : i.gender === "women" ? "Women's" : null;
  // "Men's Hoodie" already says who it is for.
  const named = Boolean(who && i.item.toLowerCase().startsWith(who.toLowerCase().slice(0, 3)));
  const chips = [named ? null : who, i.size ? `Size ${i.size}` : null, limitOf(i) ? `Under ${limitOf(i)}` : null]
    .filter((chip): chip is string => Boolean(chip));
  return (
    <div className="instruction">
      <Logo size={14} strokeWidth={1.6} />
      <strong>{i.item}</strong>
      {chips.map((chip) => (
        <span key={chip} className="chip">
          {chip}
        </span>
      ))}
    </div>
  );
}

function Finish({ run }: { run: Run }) {
  const chosen = run.picks?.[run.choice ?? 0];
  const item = run.instruction?.item ?? chosen?.title;
  const limit = run.instruction ? limitOf(run.instruction) : null;
  const stopped = run.steps.find((s) => s.state !== "done");

  if (run.receipt) {
    const r = run.receipt;
    return (
      <div className="finish">
        <div className="receipt">
          <div className="receipt-top">
            <Photo className="receipt-photo" src={r.image ?? chosen?.image} />
            <div className="receipt-main">
              <div className="receipt-total">
                <span className="receipt-amount">{r.amount.toFixed(2)} USDC</span>
                <span className="paid">Paid</span>
              </div>
              <p className="receipt-item">{cleanTitle(r.item) || item}</p>
              <p className="offer-meta">
                {storeLabel(r.store)} · {paidOn(r.paidAt)}
              </p>
            </div>
          </div>
          <div className="receipt-foot">
            <span className="mono" title={r.order}>
              {r.order.length > 14 ? shorten(r.order) : r.order}
            </span>
            {r.explorer && (
              <a className="receipt-link" href={r.explorer} target="_blank" rel="noreferrer">
                View Payment
                <ArrowUpRightIcon />
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  let body: ReactNode;
  if (run.error) body = run.error;
  else if (chosen && run.confirmed === false) body = <>Canceled. Nothing was bought.</>;
  else if (chosen && stopped?.state === "blocked")
    body = (
      <>
        Ready to buy <strong>{item}</strong> from <strong>{chosen.store}</strong> for{" "}
        <strong>{chosen.price.toFixed(2)} USDC</strong>, but no wallet key is set, so nothing was paid.
      </>
    );
  else if (chosen && stopped) body = <>Nothing was paid. {stopped.detail}</>;
  else body = <>No safe listing matched your request{limit ? ` under ${limit}` : ""}. Nothing was bought.</>;

  return (
    <div className="finish">
      <p className="instruction">
        <Logo size={14} strokeWidth={1.6} />
        <span>{body}</span>
      </p>
    </div>
  );
}

// Every qualified listing with a photo, as photos only, a page at a time. Hovering a photo lifts it slightly while the others ease
// back, with transforms and opacity only, so the motion runs on the compositor. The hovered photo is kept in state
// rather than read from :hover, so crossing the gap between two photos doesn't make everything snap back.
// The user picks up to five favorites to be weighed.
function Qualified({ items: all, picked, live, onChoose }: {
  items: GridItem[];
  // Favorites picked before going back, by `at`. They start out picked again.
  picked?: string[];
  live: boolean;
  onChoose: (ids: string[]) => void;
}) {
  const [wanted, setPage] = useState(0);
  const [chosen, setChosen] = useState<string[]>(() =>
    all.filter((i) => picked?.includes(i.at)).map((i) => i.id).slice(0, MAX_FAVORITES),
  );
  const [sent, setSent] = useState(false);
  const [hot, setHot] = useState<string>();
  // Photos that failed to load leave the grid, so it never shows an empty tile. If every photo fails, the items stay
  // with the no-image icon so there is still something to pick.
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const shown = all.filter((i) => i.image && !broken.has(i.id));
  const items = shown.length ? shown : all;
  const drop = (id: string) => setBroken((current) => new Set(current).add(id));
  const pages = Math.ceil(items.length / PER_PAGE);
  // Dropped photos can leave fewer pages than the one showing.
  const page = Math.min(wanted, pages - 1);
  const rows = Math.min(ROWS, Math.ceil(items.length / PER_ROW));
  const most = Math.min(MAX_FAVORITES, items.length);
  const open = live && !sent;

  const toggle = (id: string) =>
    setChosen((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : current.length < MAX_FAVORITES ? [...current, id] : current,
    );
  const send = () => {
    if (!chosen.length || !open) return;
    setSent(true);
    onChoose(chosen);
  };
  const turn = (to: number) => {
    setHot(undefined);
    setPage(to);
  };

  return (
    <div className="qualified">
      <div className="qualified-head">
        <p className="ask-text">Qualified Items</p>
        <p className="muted">Pick up to {most}.</p>
      </div>
      <div className="grid-window">
        <div className="grid-track" style={{ transform: `translateX(${-page * 100}%)` }}>
          {Array.from({ length: pages }, (_, p) => {
            const slice = items.slice(p * PER_PAGE, (p + 1) * PER_PAGE);
            const lit = p === page && slice.some((i) => i.id === hot);
            return (
              <div
                key={p}
                className={`grid-page rows-${rows}${lit ? " lit" : ""}`}
                inert={p !== page}
                onPointerLeave={() => setHot(undefined)}
              >
                {Array.from({ length: rows }, (_, r) => {
                  const row = slice.slice(r * PER_ROW, (r + 1) * PER_ROW);
                  return (
                    <div key={r} className="grid-row">
                      {row.map((item) => {
                        const order = chosen.indexOf(item.id);
                        const locked = !open || (order < 0 && chosen.length >= MAX_FAVORITES);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={`grid-tile${item.id === hot ? " hot" : ""}${order >= 0 ? " chosen" : ""}${locked ? " locked" : ""}`}
                            aria-pressed={order >= 0}
                            aria-label={item.title}
                            aria-disabled={locked}
                            // Touch has no hover, so only a mouse grows photos.
                            onPointerEnter={(event) => event.pointerType === "mouse" && setHot(item.id)}
                            onClick={() => !locked && toggle(item.id)}
                          >
                            <GridPhoto src={item.image} onBroken={() => drop(item.id)} />
                            <span className="grid-check">{order >= 0 && order + 1}</span>
                          </button>
                        );
                      })}
                      {Array.from({ length: PER_ROW - row.length }, (_, k) => (
                        <span key={`gap-${k}`} className="grid-tile gap" />
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid-foot">
        {pages > 1 && (
          <div className="pager">
            <button
              className="pager-arrow back"
              type="button"
              aria-label="Previous Page"
              disabled={page === 0}
              onClick={() => turn(page - 1)}
            >
              <ChevronIcon />
            </button>
            <div className="pager-dots">
              {Array.from({ length: pages }, (_, p) => (
                <button
                  key={p}
                  type="button"
                  className="pager-dot"
                  aria-label={`Page ${p + 1}`}
                  aria-current={p === page}
                  onClick={() => turn(p)}
                />
              ))}
              <span className="pager-thumb" style={{ transform: `translateX(${page * PAGE_DOT}px)` }} />
            </div>
            <button
              className="pager-arrow next"
              type="button"
              aria-label="Next Page"
              disabled={page === pages - 1}
              onClick={() => turn(page + 1)}
            >
              <ChevronIcon />
            </button>
          </div>
        )}
        <span className="grid-count">
          {chosen.length} of {most}
        </span>
        <button className="button primary" type="button" disabled={!chosen.length || !open} onClick={send}>
          Compare
        </button>
      </div>
    </div>
  );
}

// "4.4 stars (382)", "99.9% positive" or "No reviews": what a listing's page says about it, in one short phrase.
function reviewsOf(pick: Pick): string {
  if (pick.feedback != null) return `${pick.feedback}% positive`;
  if (pick.stars != null) return `${pick.stars} stars (${(pick.reviews ?? 0).toLocaleString("en-US")})`;
  return "No reviews";
}

// The favorites, best first: photo, title, one line of store, rating and price, and the score as a short bar. The
// best score is green, as Hunter's recommendation, and starts out chosen. With `onChoose`, a click chooses another
// one, like a radio button. Picks saved before the grid have no photo or score and show their note instead.
function Weighing({ picks, picked, choice, onChoose }: {
  picks: Pick[];
  picked: boolean;
  choice: number;
  onChoose?: (choice: number) => void;
}) {
  return (
    <div className="picks" role="radiogroup" aria-label="Favorites">
      {picks.map((pick, index) => {
        const state = !picked ? "" : index === choice ? " chosen" : " passed";
        return (
          <div
            key={pick.at}
            className={`weigh-row${state}${picked && index === 0 ? " recommended" : ""}${onChoose ? " choosable" : ""}`}
            style={{ animationDelay: `${index * 90}ms` }}
            role="radio"
            aria-checked={picked && index === choice}
            tabIndex={onChoose ? 0 : undefined}
            onClick={() => onChoose?.(index)}
            onKeyDown={(event) => {
              if (onChoose && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                onChoose(index);
              }
            }}
          >
            {pick.image !== undefined && <Photo className="weigh-photo" src={pick.image} />}
            <div className="pick-main">
              <div className="cell-main">{pick.score !== undefined ? cleanTitle(pick.title) : pick.store}</div>
              <div className="cell-sub">
                {pick.score !== undefined ? `${pick.store} · ${reviewsOf(pick)} · ${pick.price.toFixed(2)} USDC` : pick.note || pick.title}
              </div>
              {pick.score !== undefined && (
                <div className="score-row" title="Hunter Score">
                  <span className="score-bar">
                    <span style={{ transform: `scaleX(${pick.score / 100})`, animationDelay: `${index * 90 + 150}ms` }} />
                  </span>
                  <span className="score">{Math.round(pick.score)}</span>
                </div>
              )}
            </div>
            {pick.score === undefined && <span className="pick-price">{pick.price.toFixed(2)} USDC</span>}
          </div>
        );
      })}
    </div>
  );
}

// The item Hunter would buy, with everything the user needs to decide. Nothing is paid until Confirm is clicked
// twice: the first click arms it and the second pays. An armed button that isn't clicked again resets after ARM_MS.
function Offer({ pick, confirmed, live, onDecide }: {
  pick: Pick;
  confirmed?: boolean;
  live: boolean;
  onDecide: (ok: boolean) => void;
}) {
  const [armed, setArmed] = useState(false);
  const [sent, setSent] = useState(false);
  const open = live && confirmed === undefined && !sent;
  const price = `${pick.price.toFixed(2)} USDC`;

  // Switching to another favorite disarms Confirm, so the second click always pays for what is on screen.
  const [shown, setShown] = useState(pick.at);
  if (shown !== pick.at) {
    setShown(pick.at);
    setArmed(false);
  }

  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(id);
  }, [armed]);

  const decide = (ok: boolean) => {
    setSent(true);
    setArmed(false);
    onDecide(ok);
  };

  const sold = pick.seller && pick.seller.toLowerCase() !== pick.store.toLowerCase() ? `Sold by ${pick.seller}` : null;

  return (
    <div className="offer">
      <div key={pick.at} className="offer-top">
        <Photo className="offer-photo" src={pick.image} />
        <div className="offer-main">
          <p className="offer-title">{cleanTitle(pick.title)}</p>
          <p className="offer-meta">{[pick.store, sold].filter(Boolean).join(" · ")}</p>
          <p className="offer-meta">
            {[reviewsOf(pick), pick.condition && pick.condition[0].toUpperCase() + pick.condition.slice(1)]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="offer-price-row">
            <span className="offer-price">{price}</span>
            {pick.url && (
              <a className="receipt-link" href={pick.url} target="_blank" rel="noreferrer">
                View Listing
                <ArrowUpRightIcon />
              </a>
            )}
          </div>
        </div>
      </div>
      {open && (
        <div className="offer-actions">
          <p className="offer-note">{armed ? "Click again to pay." : "Paid in USDC on Base Sepolia."}</p>
          <button className="button" type="button" onClick={() => decide(false)}>
            Cancel
          </button>
          <button
            className={armed ? "button primary armed" : "button primary"}
            type="button"
            onClick={() => (armed ? decide(true) : setArmed(true))}
          >
            {armed ? `Pay ${price}` : "Confirm"}
          </button>
        </div>
      )}
    </div>
  );
}

// Store photos come at up to 1500px. Every photo here shows at a few hundred, so Amazon and eBay photos are asked
// for at 600px, which keeps the grid's hover smooth. Other hosts' URLs are left as they are.
const sized = (src: string) => src.replace(/\._AC_SL\d+_\./, "._AC_SL600_.").replace(/\/s-l\d+\./, "/s-l500.");

// A grid photo. It fades in once loaded, and reports a photo that fails or is too small to be a real one (a store's
// 1px placeholder) so the grid can leave it out.
function GridPhoto({ src, onBroken }: { src: string | null; onBroken: () => void }) {
  const [ready, setReady] = useState(false);
  if (!src) return <Photo className="grid-photo" src={src} />;
  return (
    <img
      className={ready ? "grid-photo ready" : "grid-photo"}
      src={sized(src)}
      alt=""
      decoding="async"
      draggable={false}
      referrerPolicy="no-referrer"
      onLoad={(event) => (event.currentTarget.naturalWidth < MIN_PHOTO ? onBroken() : setReady(true))}
      onError={onBroken}
    />
  );
}

// A listing photo, or the no-image icon in the same space when there is none or it fails to load.
function Photo({ src, className }: { src?: string | null; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <span className={`${className} empty`}>
        <NoImageIcon />
      </span>
    );
  return (
    <img
      className={className}
      src={sized(src)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

// A question Hunter is waiting on, as a column of options with typing your own answer last. A number key picks
// that option, and the last number focuses the text row. Everything locks once one answer is sent.
function Ask({ question, onAnswer }: { question: Question; onAnswer: (text: string) => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string>();
  const other = useRef<HTMLInputElement>(null);
  const options = question.options.map(titleCase);
  const send = (value: string) => {
    const reply = value.trim();
    if (sent !== undefined || !reply) return;
    setSent(reply);
    onAnswer(reply);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return;
      if (event.target instanceof HTMLTextAreaElement) return;
      const n = Number(event.key);
      if (n >= 1 && n <= options.length) send(options[n - 1]);
      else if (n === options.length + 1) {
        event.preventDefault();
        other.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const state = (option: string) =>
    sent === undefined ? "ask-row" : sent === option ? "ask-row chosen" : "ask-row passed";

  return (
    <div className="ask">
      <p className="ask-text">{question.text}</p>
      <div className="ask-list">
        {options.map((option, index) => (
          <button
            key={option}
            className={state(option)}
            type="button"
            disabled={sent !== undefined}
            onClick={() => send(option)}
          >
            <span className="ask-key">{index + 1}</span>
            {question.images && <Thumb src={question.images[index]} />}
            <span className="ask-label">{option}</span>
            {question.counts?.[index] != null && <span className="ask-count">{question.counts[index]}</span>}
          </button>
        ))}
        <form
          className={sent !== undefined && !options.includes(sent) ? "ask-row ask-other chosen" : "ask-row ask-other"}
          onSubmit={(event) => {
            event.preventDefault();
            send(text);
          }}
        >
          <span className="ask-key">{options.length + 1}</span>
          {question.images && <Thumb />}
          <input
            ref={other}
            className="ask-input"
            value={text}
            placeholder="Something Else…"
            maxLength={200}
            disabled={sent !== undefined}
            onChange={(event) => setText(event.target.value)}
          />
          <button className="send" type="submit" aria-label="Send" disabled={sent !== undefined || !text.trim()}>
            <SendIcon />
          </button>
        </form>
      </div>
    </div>
  );
}

// A photo from one listing an option keeps, so the choice shows what it means. Options without a photo, or whose
// photo fails to load, show the no-image icon in the same space. Rows that never have one (No Preference,
// Something Else) show nothing.
function Thumb({ src }: { src?: string | null }) {
  return src === undefined ? null : <Photo className="ask-thumb" src={src} />;
}

// Questions already answered at this stage, each with the user's answer.
function Answers({ answers, stage }: { answers: Answer[]; stage: Answer["stage"] }) {
  const shown = answers.filter((a) => a.stage === stage);
  if (!shown.length) return null;
  return (
    <ul className="answers">
      {shown.map((a, index) => (
        <li key={`${index}-${a.question}`}>
          <span>{a.question}</span>
          <span className="chip">{titleCase(a.text)}</span>
        </li>
      ))}
    </ul>
  );
}

// What Hunter is thinking right now: one short sentence. Each stays up for THINK_MS before the newest replaces it,
// so a burst of thoughts reads as a few calm changes.
function Thinking({ text }: { text: string }) {
  const shown = useSteady(text, THINK_MS);
  return (
    <p key={shown} className="thinking">
      {shown}
    </p>
  );
}

// `value`, changing at most once every `ms`. Values that arrive in between are skipped for the newest one.
function useSteady<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const since = useRef(0);
  useEffect(() => {
    const id = setTimeout(() => {
      setShown(value);
      since.current = Date.now();
    }, Math.max(0, since.current + ms - Date.now()));
    return () => clearTimeout(id);
  }, [value, ms]);
  return shown;
}

type StageProps = {
  status: string;
  open: boolean;
  title: string;
  summary: string;
  live?: string;
  // A stage whose content moves on to the next stage has nothing to reopen, so it shows no chevron.
  expandable?: boolean;
  onToggle: () => void;
  children: ReactNode;
};

// The body animates between open and folded by transitioning its grid row, so heights never jump. The clip has no
// padding of its own, so a folded stage collapses all the way to its header.
function Stage({ status, open, title, summary, live, expandable = true, onToggle, children }: StageProps) {
  const done = status === "done";
  const toggleable = done && expandable;
  const [measure, size] = useHeight();
  return (
    <section className={`stage ${status}`}>
      <button className="stage-head" onClick={onToggle} disabled={!toggleable} aria-expanded={toggleable ? open : undefined}>
        <StageIcon status={status} />
        <h3>{title}</h3>
        <span className="stage-meta">{done ? summary : live}</span>
        {toggleable && (
          <span className={open ? "stage-chevron open" : "stage-chevron"}>
            <ChevronIcon />
          </span>
        )}
        {done && !expandable && <span className="stage-chevron-space" />}
      </button>
      <div className={open ? "stage-fold open" : "stage-fold"}>
        <div className="stage-clip">
          <div className="stage-size" style={size}>
            <div ref={measure} className="stage-body">
              {children}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// The measured height of an element, as a style for its wrapper, so the wrapper can transition to each new height.
// The first measure lands without a transition (the wrapper starts at auto).
function useHeight() {
  const [el, measure] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [measure, height === undefined ? undefined : { height }] as const;
}

// A very quiet way back: a small chevron and one word, above whatever Hunter is waiting on.
function BackLink({ onBack, disabled }: { onBack: () => void; disabled: boolean }) {
  return (
    <button type="button" className="back-link" onClick={onBack} disabled={disabled}>
      <ChevronIcon />
      Back
    </button>
  );
}

function StageIcon({ status }: { status: string }) {
  if (status === "done")
    return (
      <span className="stage-icon done">
        <CheckIcon />
      </span>
    );
  return <span className={`stage-icon ${status}`} />;
}

// `gated` is how far the gate has read: rows before it are verified or rejected, and the row at it is being checked.
// The card keeps a crisp border while the scroller inside it fades out at the top and bottom edges.
function Feed({ ref, rows, gated }: { ref: Ref<HTMLDivElement>; rows: Row[]; gated: number }) {
  return (
    <div className="feed">
      <div className="feed-scroll" ref={ref}>
        {rows.map((row) => {
          const checked = row.id < gated;
          const state = !checked ? (row.id === gated ? "scanning" : "") : row.verdict === "skip" ? "rejected" : "verified";
          return <FeedRow key={row.id} row={row} state={state} />;
        })}
      </div>
    </div>
  );
}

// Rows only re-render when their own state changes, not on every tick of the run.
const FeedRow = memo(function FeedRow({ row, state }: { row: Row; state: string }) {
  return (
    <div className={`feed-row ${state}`}>
      <span className="feed-mark">{state === "verified" ? <CheckIcon /> : <span className="feed-dot" />}</span>
      <span className="feed-title">{row.title}</span>
      <span className="feed-store">{state === "rejected" ? row.reason : row.store}</span>
      <span className="feed-price">${row.price.toFixed(2)}</span>
    </div>
  );
});
