import { Composer } from "./Composer";
import { Logo } from "./Logo";

// Sending the request starts a live Hunter run.
export function NewChat({ onStart }: { onStart: (prompt: string) => void }) {
  return (
    <section className="hero">
      <Logo className="halo" size={180} strokeWidth={0.9} />
      <h1>What should Hunter buy?</h1>
      <p className="sub">Describe the item and the most you’ll pay. Hunter only pays when every check passes.</p>
      <Composer placeholder="Find me a warm fleece jacket. Don’t pay more than $50." onSend={onStart} autoFocus />
      <p className="hint-line">
        Press <kbd>Enter</kbd> to send.
      </p>
    </section>
  );
}
