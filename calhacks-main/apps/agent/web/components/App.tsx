"use client";

import { useEffect, useState } from "react";
import { deleteChat, loadChats, saveChat } from "@/lib/chats";
import type { Chat } from "@/lib/data";
import { ChatView } from "./ChatView";
import { NewChat } from "./NewChat";
import { Settings } from "./Settings";
import { Sidebar, type View } from "./Sidebar";
import { Transactions } from "./Transactions";

export function App() {
  const [view, setView] = useState<View>({ kind: "new" });
  const [chats, setChats] = useState<Chat[]>([]);

  // Every new chat is a live Hunter run against the agent API. The title starts as the prompt and becomes
  // the item's name as soon as Hunter names it.
  const startChat = (prompt: string) => {
    const chat: Chat = {
      id: crypto.randomUUID(),
      title: prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt,
      status: "searching",
      live: { prompt },
      messages: [{ role: "user", text: prompt }],
    };
    setChats((current) => [chat, ...current]);
    setView({ kind: "chat", id: chat.id });
  };

  // Saved chats join the list once they load. A failed load leaves just this session's chats.
  useEffect(() => {
    loadChats()
      .then((saved) => setChats((current) => [...current, ...saved.filter((s) => !current.some((c) => c.id === s.id))]))
      .catch(() => {});
  }, []);

  const update = (id: string, change: (chat: Chat) => Partial<Chat>) =>
    setChats((current) => current.map((chat) => (chat.id === id ? { ...chat, ...change(chat) } : chat)));

  // Only finished chats are saved, so only they are deleted from the agent API. If that fails, the chat comes back.
  const removeChat = (gone: Chat) => {
    setChats((current) => current.filter((c) => c.id !== gone.id));
    if (view.kind === "chat" && view.id === gone.id) setView({ kind: "new" });
    if (gone.live?.saved) deleteChat(gone.id).catch(() => setChats((current) => [...current, gone]));
  };

  const chat = view.kind === "chat" ? chats.find((c) => c.id === view.id) : undefined;

  return (
    <div className="app">
      <Sidebar chats={chats} view={view} onNavigate={setView} onDelete={removeChat} />
      <main className="main">
        {view.kind === "new" && <NewChat onStart={startChat} />}
        {chat && (
          <ChatView
            key={chat.id}
            chat={chat}
            onSend={(text) => update(chat.id, (c) => ({ messages: [...c.messages, { role: "user", text }] }))}
            onTitle={(title) => update(chat.id, () => ({ title }))}
            onAsking={(asking) =>
              update(chat.id, (c) =>
                c.status === "searching" || c.status === "asking" ? { status: asking ? "asking" : "searching" } : {},
              )
            }
            onRunDone={(run) => {
              const live = chat.live && { ...chat.live, saved: run };
              const done: Chat = { ...chat, status: run.status ?? "stopped", live };
              update(chat.id, () => done);
              // Saving is best effort: the finished chat stays in this session either way.
              saveChat(done).catch(() => {});
            }}
          />
        )}
        {view.kind === "transactions" && <Transactions chats={chats} />}
        {view.kind === "settings" && <Settings />}
      </main>
    </div>
  );
}
