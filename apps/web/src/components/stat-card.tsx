import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// A figure at a glance: a small card with what it counts, the figure, a line under it
// and room for a bar or an action. A row of them is a StatRow, as wide as the screen allows.

export function StatCard({
  label,
  value,
  detail,
  action,
  children,
  className,
}: {
  /** What the figure is: the card's accessible name too. */
  readonly label: string;
  readonly value: ReactNode;
  /** A 12px line under the figure. */
  readonly detail?: ReactNode;
  /** One control beside the label (Edit cap). */
  readonly action?: ReactNode;
  /** Under the detail: a Progress bar, a short list. */
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="stat-card"
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-4 text-card-foreground shadow-xs",
        className,
      )}
    >
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {action}
      </div>
      <div className="font-head text-xl leading-tight font-semibold tabular-nums">
        {value}
      </div>
      {detail !== undefined && (
        <div className="text-xs text-muted-foreground">{detail}</div>
      )}
      {children}
    </div>
  );
}

/** Stat cards side by side, wrapping to the next row below ~12rem each. */
export function StatRow({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="stat-row"
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
