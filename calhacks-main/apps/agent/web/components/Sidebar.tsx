import type { Chat } from "@/lib/data";
import { BoltIcon, ChatIcon, PenIcon, ReceiptIcon, TrashIcon, WalletIcon } from "./Icons";
import { Logo } from "./Logo";

export type View = { kind: "new" } | { kind: "chat"; id: string } | { kind: "transactions" } | { kind: "settings" };

type Props = { chats: Chat[]; view: View; onNavigate: (view: View) => void; onDelete: (chat: Chat) => void };

export function Sidebar({ chats, view, onNavigate, onDelete }: Props) {
  const active = (kind: View["kind"]) => (view.kind === kind ? "nav-item active" : "nav-item");

  return (
    <aside className="sidebar">
      <div className="sb-top">
        <div className="brand">
          <span className="brand-mark">
            <Logo size={12} strokeWidth={1.8} />
          </span>
          Hunter
        </div>
        <button className="icon-btn raised" aria-label="New Chat" onClick={() => onNavigate({ kind: "new" })}>
          <PenIcon />
        </button>
      </div>

      <nav className="nav sb-group">
        <button className={active("transactions")} onClick={() => onNavigate({ kind: "transactions" })}>
          <ReceiptIcon />
          Transactions
        </button>
      </nav>

      {chats.length > 0 && (
        <div className="sb-group">
          <div className="section">Chats</div>
          <nav className="nav">
            {chats.map((chat) => (
              <div key={chat.id} className="chat-row">
                <button
                  className={view.kind === "chat" && view.id === chat.id ? "nav-item active" : "nav-item"}
                  onClick={() => onNavigate({ kind: "chat", id: chat.id })}
                >
                  <ChatIcon />
                  <span className="truncate">{chat.title}</span>
                  {chat.status === "searching" && <span className="live-dot" aria-label="Searching" />}
                </button>
                <button
                  className="chat-delete"
                  aria-label={`Delete ${chat.title}`}
                  title="Delete Chat"
                  onClick={() => onDelete(chat)}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </nav>
        </div>
      )}

      <div className="sb-spacer" />
      <nav className="nav">
        {/* Automatic buying is off and locked for now: every purchase waits for the user to confirm it. */}
        <label className="nav-item toggle-row" title="Coming Soon">
          <BoltIcon />
          <span className="truncate">Automatic</span>
          <input className="switch" type="checkbox" role="switch" checked={false} disabled readOnly />
        </label>
        <button className={active("settings")} onClick={() => onNavigate({ kind: "settings" })}>
          <WalletIcon />
          Settings
        </button>
      </nav>
    </aside>
  );
}
