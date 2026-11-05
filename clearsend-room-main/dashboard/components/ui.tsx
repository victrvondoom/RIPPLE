import Link from "next/link";
import type { ReactNode } from "react";
import { STATE_TONE } from "@/lib/workflow";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Card({ children, className, strong }: { children: ReactNode; className?: string; strong?: boolean }) {
  return <div className={cx(strong ? "glass-strong" : "glass", "rounded-3xl p-5 sm:p-6", className)}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-mut">{children}</div>;
}

export function PageHeader({ eyebrow, title, children, actions }: { eyebrow?: string; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 animate-rise sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-3xl">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
        {children && <p className="mt-3 text-base text-mut sm:text-lg">{children}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

const TONES = { ok: "c-ok bg-ok", warn: "c-warn bg-warn", bad: "c-bad bg-bad", acc: "c-acc bg-acc", mut: "text-mut bg-[var(--line)]" };
export function Badge({ children, tone = "mut", className }: { children: ReactNode; tone?: keyof typeof TONES; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium", TONES[tone], className)}>{children}</span>;
}
export function StateBadge({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? "mut"}>{state.replace("_", " ")}</Badge>;
}

export function ButtonLink({ href, children, variant = "primary", className }: { href: string; children: ReactNode; variant?: "primary" | "ghost" | "paypal"; className?: string }) {
  return (
    <Link href={href} className={cx("inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition", variant === "primary" ? "btn-primary" : variant === "paypal" ? "btn-paypal" : "glass hover:bg-[var(--line)]", className)}>
      {children}
    </Link>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-3xl border border-dashed border-line p-8 text-center">
      <div className="font-display text-lg font-semibold">{title}</div>
      {children && <div className="mx-auto mt-2 max-w-xl text-sm text-mut">{children}</div>}
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-2xl bg-bad px-4 py-3 text-sm c-bad">
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton rounded-xl", className)} />;
}

export function Money({ amount, currency, className }: { amount: number; currency: string; className?: string }) {
  let s: string;
  try {
    s = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    s = `${amount.toFixed(2)} ${currency}`;
  }
  return <span className={cx("tabular-nums", className)}>{s}</span>;
}

export function Row({ k, v, strong }: { k: ReactNode; v: ReactNode; strong?: boolean }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4 py-2", strong ? "mt-1 border-t border-line pt-3 text-base font-semibold" : "text-sm")}>
      <span className={strong ? "" : "text-mut"}>{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}

export function SandboxNote() {
  return (
    <p className="flex items-center gap-2 text-xs text-mut">
      <span aria-hidden>🔒</span> PayPal <b>sandbox</b> only. Test accounts and test money, no real funds move.
    </p>
  );
}

export function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" }) + " WAT";
}
