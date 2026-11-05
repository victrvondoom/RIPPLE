// Chats live in the browser for the session: every chat is a live Hunter run. Transactions are real: see lib/wallet.ts.

import type { Run } from "./run";

export type Message = { role: "user" | "agent"; text: string };

export type Chat = {
  id: string;
  title: string;
  // "ready": Hunter picked a safe listing, but payments aren't connected yet.
  // "asking": the run is waiting for the user to answer a question.
  status: "searching" | "asking" | "ready" | "bought" | "stopped";
  // Live chats stream a Hunter run for `prompt`; `saved` is the finished run, shown without streaming again.
  live?: { prompt: string; saved?: Run };
  messages: Message[];
};
