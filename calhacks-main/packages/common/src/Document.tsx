import type { ReactNode } from "react";
import { figtree } from "./font";

// Every store uses the same page shell. Browser extensions can add attributes to html and body, so those two skip hydration warnings.
// A store can pass its own font class. It must set the --font-sans variable.
export default function Document({ children, fontClass = figtree.variable }: { children: ReactNode; fontClass?: string }) {
  return (
    <html lang="en" className={fontClass} suppressHydrationWarning>
      <body id="top" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
