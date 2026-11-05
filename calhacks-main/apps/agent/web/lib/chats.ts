"use client";

import type { Chat } from "./data";
import { api } from "./api";
import type { Run } from "./run";

// There are no accounts yet, so each browser keeps a random id of its own, and the agent API only lists, saves and
// deletes that id's chats. Without storage (a private window), the id lasts until the page reloads.
const OWNER_KEY = "hunter-owner";
let fallbackOwner: string | undefined;

function owner(): string {
  try {
    const saved = localStorage.getItem(OWNER_KEY);
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(OWNER_KEY, id);
    return id;
  } catch {
    return (fallbackOwner ??= crypto.randomUUID());
  }
}

type Saved = { id: string; title: string; prompt: string; status: Chat["status"]; run: Run };

// A finished chat comes back exactly as it ended: its run shows without streaming again.
const toChat = (s: Saved): Chat => ({
  id: s.id,
  title: s.title,
  status: s.status,
  live: { prompt: s.prompt, saved: s.run },
  messages: [{ role: "user", text: s.prompt }],
});

export const loadChats = async () => (await api<Saved[]>(`/chats?owner=${owner()}`)).map(toChat);

// Saves a chat once its run has finished. Chats still running are not saved, so a reload never starts a purchase again.
export async function saveChat(chat: Chat) {
  if (!chat.live?.saved) return;
  const { title, status, live } = chat;
  await api(`/chats/${chat.id}`, {
    method: "PUT",
    json: { owner: owner(), title, prompt: live.prompt, status, run: live.saved },
  });
}

export const deleteChat = (id: string) => api(`/chats/${id}?owner=${owner()}`, { method: "DELETE" });
