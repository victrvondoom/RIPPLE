import type { Chat } from "@/lib/data";
import type { Run } from "@/lib/run";
import { AgentRun } from "./AgentRun";
import { Composer } from "./Composer";
import { Logo } from "./Logo";

const STATUS = {
  searching: "Searching",
  asking: "Needs Your Answer",
  ready: "Ready to Pay",
  bought: "Bought",
  stopped: "Nothing Bought",
};

type Props = {
  chat: Chat;
  onSend: (text: string) => void;
  onTitle: (title: string) => void;
  onAsking: (asking: boolean) => void;
  onRunDone: (run: Run) => void;
};

export function ChatView({ chat, onSend, onTitle, onAsking, onRunDone }: Props) {
  return (
    <section className="page chat">
      <header className="page-head">
        <h2>{chat.title}</h2>
        <span className={`badge ${chat.status}`}>{STATUS[chat.status]}</span>
      </header>
      <div className="messages">
        {chat.messages.map((message, index) =>
          message.role === "user" ? (
            <p key={index} className="message user">
              {message.text}
            </p>
          ) : (
            <div key={index} className="message agent">
              <span className="brand-mark small">
                <Logo size={10} strokeWidth={1.9} />
              </span>
              <p>{message.text}</p>
            </div>
          ),
        )}
        {chat.live && (
          <AgentRun
            prompt={chat.live.prompt}
            saved={chat.live.saved}
            onTitle={onTitle}
            onAsking={onAsking}
            onDone={onRunDone}
          />
        )}
      </div>
      {!chat.live && (
        <div className="chat-composer">
          <Composer placeholder="Reply to Hunter…" onSend={onSend} />
        </div>
      )}
    </section>
  );
}
