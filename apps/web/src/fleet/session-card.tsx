import type { FleetRow } from "@bayon/proto";
import { Id } from "@/components/id";
import { StatusBadge } from "@/components/status-badge";
import { FOCUS_RING } from "@/components/text-link";
import { formatIdle, formatUsd } from "@/fleet/fleet-model";
import { cn } from "@/lib/utils";
import { sessionHref } from "@/routing";

/**
 * One live session on the Fleet (§12.3): who, doing which ticket, how it stands, where it runs and
 * what it has cost. The whole card is the link to its timeline. A stale one (amendment 8) is edged
 * in the warning tone; "Needs you" says what to do about it.
 */
export function SessionCard({
  row,
  stale,
}: {
  readonly row: FleetRow;
  readonly stale: boolean;
}) {
  const ticket =
    row.ticket === null ? null : (row.ticket_key ?? `#${row.ticket}`);
  return (
    <a
      href={sessionHref(row.id)}
      data-testid="session-card"
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs transition-[border-color,box-shadow] hover:border-input-border hover:shadow-sm",
        stale && "border-warning/60",
        FOCUS_RING,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate font-head font-medium">{row.agent}</h3>
        <StatusBadge entity="session" state={row.state} />
      </div>
      <p className="min-h-10 text-sm">
        {ticket === null ? (
          <span className="text-muted-foreground">{`No ticket · ${row.run_class}`}</span>
        ) : (
          <>
            <span className="font-mono text-xs text-muted-foreground">
              {`${ticket} · ${row.run_class}`}
            </span>
            {row.title !== null && (
              <span className="line-clamp-2" title={row.title}>
                {row.title}
              </span>
            )}
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1">
          <Id value={row.runner_id} />
          <span aria-hidden="true">·</span>
          <Id value={row.executor_id} />
        </span>
        <span className="flex gap-3 tabular-nums">
          <span>{`${row.turns} ${row.turns === 1 ? "turn" : "turns"}`}</span>
          <span>{formatUsd(row.cost_usd)}</span>
          <span>{`idle ${formatIdle(row.idle_ms)}`}</span>
        </span>
      </div>
    </a>
  );
}
