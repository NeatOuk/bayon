import type { FleetRow, ProjectAgentView } from "@bayon/proto";
import { Id } from "@/components/id";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { formatIdle, formatUsd } from "@/fleet/fleet-model";
import type { EditorTab } from "@/routing";

/** Builds the href that opens `tab` beside the IDE's current view. */
export type TabHref = (tab: EditorTab) => string;

/**
 * What one agent is doing now, from the project's live fleet rows: each live session's
 * state, run class, ticket, turns, cost and idle time, its ticket and session opening as tabs; or
 * Idle when it has none, and Disabled when it takes no new work. `relative z-10` keeps these
 * links above a row's stretched link.
 */
export function LiveState({
  agent,
  rows,
  tabHref,
}: {
  readonly agent: ProjectAgentView;
  readonly rows: readonly FleetRow[];
  readonly tabHref: TabHref;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      {!agent.enabled && <StatusBadge entity="enabled" state="disabled" />}
      {agent.enabled && rows.length === 0 && (
        <StatusBadge entity="session" state="idle" />
      )}
      {rows.length > 0 && (
        <ul
          aria-label={`${agent.name} live sessions`}
          className="flex flex-col gap-1"
        >
          {rows.map((row) => (
            <li
              key={row.id}
              className="relative z-10 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs"
            >
              <StatusBadge entity="session" state={row.state} />
              <span>{row.run_class}</span>
              {row.ticket === null ? (
                <span className="text-muted-foreground">no ticket</span>
              ) : (
                <TextLink
                  href={tabHref({ kind: "ticket", num: row.ticket })}
                  title={row.title ?? undefined}
                >
                  {row.ticket_key ?? `#${row.ticket}`}
                </TextLink>
              )}
              <span>{`t${row.turns}`}</span>
              <span>{formatUsd(row.cost_usd)}</span>
              <span>{`idle ${formatIdle(row.idle_ms)}`}</span>
              <TextLink href={tabHref({ kind: "session", id: row.id })}>
                {"session "}
                <Id value={row.id} />
              </TextLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An orchestrator is awake while it has a live session (and then shows that session's state). */
export function Presence({ live }: { readonly live: FleetRow | undefined }) {
  return live === undefined ? (
    <StatusBadge entity="presence" state="asleep" />
  ) : (
    <>
      <StatusBadge entity="presence" state="awake" />
      <StatusBadge entity="session" state={live.state} />
    </>
  );
}
