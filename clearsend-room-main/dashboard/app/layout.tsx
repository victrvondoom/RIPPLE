import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Toaster } from "@/components/Toaster";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display-face" });

export const metadata: Metadata = {
  title: { default: "ClearSend Room", template: "%s · ClearSend Room" },
  description: "A payer, a recipient, a verifier and an AI agent finish cross-border payments, flight bookings and escrow together in one Switch room. PayPal sandbox.",
};
export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#06060b" }, { color: "#f7f7fb" }] };

const themeScript = `try{var t=localStorage.getItem("theme");document.documentElement.dataset.theme=t||"dark"}catch(e){document.documentElement.dataset.theme="dark"}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${inter.variable} ${display.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-[var(--bg-2)] focus:px-4 focus:py-2">Skip to content</a>
        <div className="aurora" aria-hidden />
        <div className="grid-fade" aria-hidden />
        <Toaster>
          <Nav />
          <main id="main" className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14">{children}</main>
          <footer className="mx-auto max-w-7xl px-4 pb-10 text-xs text-mut sm:px-6">
            <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-6">
              <span>ClearSend Room · Flip the Switch hackathon · MIT</span>
              <span>PayPal sandbox only. Not affiliated with PayPal or Switch.</span>
              <Link className="underline" href="https://github.com/dukemawex/clearsend-room">Source</Link>
              <Link className="underline" href="/api/health">Health</Link>
            </div>
          </footer>
        </Toaster>
      </body>
    </html>
  );
}
