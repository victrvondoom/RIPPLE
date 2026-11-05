"use client";

import { useState } from "react";
import { SendIcon } from "./Icons";

type Props = { placeholder: string; onSend: (text: string) => void; autoFocus?: boolean };

// Enter sends and Shift+Enter adds a new line.
export function Composer({ placeholder, onSend, autoFocus }: Props) {
  const [text, setText] = useState("");

  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        value={text}
        placeholder={placeholder}
        rows={2}
        autoFocus={autoFocus}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-bar">
        <button className="send" type="submit" aria-label="Send" disabled={!text.trim()}>
          <SendIcon />
        </button>
      </div>
    </form>
  );
}
