import type { TicketEconomics, TicketEventView } from "@bayon/proto";
import { DescriptionList } from "@/components/description-list";
import { ArrowRight } from "lucide-react";
import { Id } from "@/components/id";
import { humanize } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { formatUsd } from "@/fleet/fleet-model";
import { formatPercent, formatTime } from "@/lib/format";
import { Panel } from "@/tickets/panel";

// The read-only parts of the ticket view (§12.3 TICKET): economics and the event log. The gate
// strip and the findings are gates/, the hand-off chain handoffs/handoff-chain.tsx.

export const Muted = ({ children }: { readonly children: string }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

/** Every hand-off the ticket has, saying how many of them were phase boundaries (§7.1). */
function handoffs(e: TicketEconomics): string {
  const total = e.handoff_count + e.phase_handoff_count;
  return e.phase_handoff_count === 0
    ? String(total)
    : `${total} (${e.phase_handoff_count} phase)`;
}

/** `v_ticket_economics` (§8.9): derived by the server, rendered as is. */
export function EconomicsPanel({
  economics,
}: {
  readonly economics: TicketEconomics;
}) {
  const rows: readonly (readonly [string, string])[] = [
    ["spent", formatUsd(economics.cost_usd)],
    ["wasted", formatUsd(economics.cost_wasted_usd)],
    ["sessions", String(economics.sessions)],
    // The view splits the two (022): `handoff_count` is §7.5's sizing signal, the phase boundaries
    // are progress. Shown together, so this total still matches the hand-off chain below it.
    ["hand-offs", handoffs(economics)],
    ["review rounds", String(economics.review_rounds)],
    ["tokens", economics.tokens.toLocaleString("en")],
    ["cache", formatPercent(economics.cache_ratio)],
  ];
  return (
    <Panel label="economics" title="Economics">
      <DescriptionList items={rows} />
    </Panel>
  );
}

/** Who wrote an event: the operator, the supervisor, or a session (its id shortened). */
function Actor({ event }: { readonly event: TicketEventView }) {
  return (
    <span className="inline-flex items-center gap-1">
      {humanize(event.actor_kind)}
      {event.actor_id !== null && <Id value={event.actor_id} />}
    </span>
  );
}

/** What happened: a move between two statuses, as their badges; anything else in words. */
function EventWhat({ event }: { readonly event: TicketEventView }) {
  if (event.from_status === null || event.to_status === null)
    return <span>{humanize(event.kind)}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="sr-only">{`${event.kind} `}</span>
      <StatusBadge entity="ticket" state={event.from_status} />
      <ArrowRight aria-label="to" className="size-3.5 text-muted-foreground" />
      <StatusBadge entity="ticket" state={event.to_status} />
    </span>
  );
}

/** The ticket's log, newest first: when, what, who and why, a row each. */
export function EventsPanel({
  events,
  hasMore,
}: {
  readonly events: readonly TicketEventView[];
  readonly hasMore: boolean;
}) {
  return (
    <Panel label="events" title="Events">
      {events.length === 0 ? (
        <Muted>No events.</Muted>
      ) : (
        <ol className="flex flex-col divide-y text-sm">
          {events.toReversed().map((event) => (
            <li
              key={event.id}
              className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 py-2 first:pt-0 last:pb-0"
            >
              <time
                dateTime={new Date(event.ts).toISOString()}
                className="pt-0.5 text-xs text-muted-foreground tabular-nums"
              >
                {formatTime(event.ts)}
              </time>
              <div className="flex min-w-0 flex-col gap-0.5">
                <EventWhat event={event} />
                <span className="text-xs break-words text-muted-foreground">
                  <Actor event={event} />
                  {event.reason !== null && ` · ${event.reason}`}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {hasMore && <Muted>Older events: GET /tickets/:ref/events.</Muted>}
    </Panel>
  );
}
