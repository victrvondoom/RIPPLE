import { WORKFLOW } from "@/lib/workflow";
import { cx } from "./ui";

/** current = index of the step being waited on; steps before it are done. counts = optional live counts per step. */
export function Stepper({ current, counts, compact, skip = [] }: { current?: number; counts?: number[]; compact?: boolean; skip?: number[] }) {
  return (
    <ol className={cx("grid gap-2", compact ? "grid-cols-3 sm:grid-cols-9" : "grid-cols-1 sm:grid-cols-3 lg:grid-cols-9")} aria-label="Workflow">
      {WORKFLOW.map((s, i) => {
        const skipped = skip.includes(i);
        const done = current !== undefined && i < current && !skipped;
        const active = current === i;
        return (
          <li key={s.key} aria-current={active ? "step" : undefined} className={cx("relative rounded-2xl border border-line p-3 transition", active ? "gradient-ring bg-acc" : done ? "bg-ok" : "glass", skipped && "opacity-40")}>
            <div className="flex items-center gap-2">
              <span className={cx("grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold", done ? "bg-[var(--ok)] text-white" : active ? "btn-primary animate-pulse-ring" : "border border-line text-mut")}>{done ? "✓" : i + 1}</span>
              {counts && counts[i] > 0 && <span className="ml-auto rounded-full bg-[var(--fg)] px-2 text-[11px] font-semibold text-[var(--bg)]">{counts[i]}</span>}
            </div>
            <div className="mt-2 text-[13px] font-semibold leading-tight">{s.label}</div>
            {!compact && <div className="mt-0.5 text-[11px] text-mut">{skipped ? "not used here" : s.hint}</div>}
          </li>
        );
      })}
    </ol>
  );
}
