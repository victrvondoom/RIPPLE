import { useState } from "react";
import type { Chat } from "@/lib/data";
import { short, useWallet, type Transfer } from "@/lib/wallet";
import { ArrowUpRightIcon, NoImageIcon } from "./Icons";

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// The ledger starts here: earlier payments were test runs, so they are cleared from the list. They stay on chain.
const SINCE = Date.parse("2026-10-24T22:30:00Z");

// What a payment bought, from the receipt of the chat that made it.
type Bought = { title: string; image?: string | null };

// Every payment Hunter made since SINCE, read live from Base Sepolia. Refunds and faucet funds are left out, so the
// list shows only what Hunter paid for. A payment made by a saved chat shows that item's photo and name.
export function Transactions({ chats }: { chats: Chat[] }) {
  const { wallet, error } = useWallet();
  const transfers = (wallet?.transactions ?? []).filter((t) => t.direction === "sent" && Date.parse(t.at) >= SINCE);
  const spent = transfers.reduce((sum, t) => sum + t.amount, 0);

  const bought = new Map<string, Bought>();
  for (const chat of chats) {
    const receipt = chat.live?.saved?.receipt;
    if (receipt?.txHash) bought.set(receipt.txHash.toLowerCase(), { title: chat.title, image: receipt.image });
  }

  return (
    <section className="ledger">
      <header className="ledger-head">
        <h1>Transactions</h1>
        <p className="sub">
          {wallet
            ? `${transfers.length} ${transfers.length === 1 ? "Payment" : "Payments"} · ${spent.toFixed(2)} USDC Spent · ${wallet.balance.toFixed(2)} USDC Left`
            : "Base Sepolia"}
        </p>
        <p className="note">Demo purchases are refunded.</p>
      </header>

      <div className="ledger-group">
        <div className="ledger-card">
          {!wallet ? (
            <p className="ledger-empty">{error ?? "Loading…"}</p>
          ) : transfers.length > 0 ? (
            transfers.map((t) => (
              <Row key={`${t.hash}-${t.direction}-${t.amount}`} transfer={t} bought={bought.get(t.hash.toLowerCase())} />
            ))
          ) : (
            <p className="ledger-empty">Nothing here yet.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function Row({ transfer: t, bought }: { transfer: Transfer; bought?: Bought }) {
  const sent = t.direction === "sent";

  return (
    <div className="tx-row">
      <TxPhoto src={bought?.image} />
      <div className="tx-item">
        <div className="cell-main">{bought?.title ?? (sent ? "Payment" : "Received")}</div>
        <div className="cell-sub mono">
          {sent ? "To" : "From"} {short(t.counterparty)}
        </div>
      </div>
      <div className="tx-date">{when.format(new Date(t.at))}</div>
      <div className="tx-amount">
        {sent ? "−" : "+"}
        {t.amount.toFixed(2)} USDC
      </div>
      <a
        className="tx-receipt"
        href={t.explorer}
        target="_blank"
        rel="noreferrer"
        title="View on Basescan"
        aria-label="View on Basescan"
      >
        <ArrowUpRightIcon />
      </a>
    </div>
  );
}

// The item's photo, or the no-image icon when the payment has no saved chat or the photo fails to load.
function TxPhoto({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <span className="tx-photo empty">
        <NoImageIcon />
      </span>
    );
  return (
    <img className="tx-photo" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  );
}
