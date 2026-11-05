"use client";

import { useState } from "react";
import { AGENT_WALLET, fundWallet, useWallet } from "@/lib/wallet";
import { ArrowUpRightIcon } from "./Icons";

type Funding = { state: "idle" } | { state: "sending" } | { state: "sent"; explorer: string; added?: number } | { state: "failed"; error: string };

// The faucet transaction takes a few seconds to land, so the balance is read again until it changes.
const POLL_MS = 3000;
const POLLS = 10;

export function Settings() {
  const { wallet, error, reload } = useWallet();
  const [funding, setFunding] = useState<Funding>({ state: "idle" });

  const addFunds = async () => {
    setFunding({ state: "sending" });
    try {
      const { explorer } = await fundWallet();
      setFunding({ state: "sent", explorer });
      const before = wallet?.balance ?? 0;
      for (let i = 0; i < POLLS; i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const after = (await reload())?.balance;
        if (after !== undefined && after !== before) {
          setFunding({ state: "sent", explorer, added: after - before });
          break;
        }
      }
    } catch (e) {
      setFunding({ state: "failed", error: (e as Error).message });
    }
  };

  return (
    <section className="page">
      <header className="page-head">
        <h2>Settings</h2>
      </header>
      <div className="field">
        <label htmlFor="wallet">Wallet Address</label>
        <p className="hint">The Base Sepolia wallet Hunter pays from, in USDC.</p>
        <div className="field-row">
          <input id="wallet" className="input mono" value={AGENT_WALLET} disabled readOnly />
          <button className="button" type="button" disabled>
            Save
          </button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="balance">Balance</label>
        <p className="hint">The USDC Hunter can spend, read live from the chain.</p>
        <div className="field-row">
          <input
            id="balance"
            className="input mono"
            value={wallet ? `${wallet.balance.toFixed(2)} USDC` : error ? "Unavailable" : "Loading…"}
            disabled
            readOnly
          />
          <button className="button" type="button" onClick={addFunds} disabled={funding.state === "sending"}>
            {funding.state === "sending" ? "Adding…" : "Add Funds"}
          </button>
        </div>
        {error && !wallet && <p className="hint error">{error}</p>}
        {funding.state === "sent" && (
          <p className="hint">
            {funding.added ? `Added ${funding.added.toFixed(2)} test USDC.` : "Test USDC is on its way."}{" "}
            <a className="receipt-link" href={funding.explorer} target="_blank" rel="noreferrer">
              View Transaction
              <ArrowUpRightIcon />
            </a>
          </p>
        )}
        {funding.state === "failed" && <p className="hint error">{funding.error}</p>}
      </div>
    </section>
  );
}
