import type { ProjectView, TicketSummary } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { ticketsQuery } from "@/api/queries";
import { Loading } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { TextLink } from "@/components/text-link";
import type { TabHref } from "@/ide/live-state";
import { inboxHref, projectHref } from "@/routing";
import { Panel } from "@/tickets/panel";
import { useTicketsFeed } from "@/tickets/use-tickets-feed";

// The Overview's "Waiting on you": the project's tickets whose next step waits on the
// operator, each with the server's short reason and the way on. The board's own query (the same key,
// so one fetch serves both), live from the `tickets` topic. Many tickets that wait for one reason —
// a paused project holds all of its work — are one row, not a screenful.

/** This many tickets sharing one reason are one row. */
const GROUP_AT = 3;

type Row =
  | {
      readonly kind: "ticket";
      readonly ticket: TicketSummary;
      readonly reason: string;
    }
  | { readonly kind: "group"; readonly reason: string; readonly count: number };

/** The waiting tickets in board order, one row per reason shared by GROUP_AT or more. */
function rowsOf(items: readonly TicketSummary[]): Row[] {
  const byReason = new Map<string, TicketSummary[]>();
  for (const t of items) {
    if (!t.waiting_on_you) continue;
    const reason = t.waiting_reason ?? "waits on you";
    byReason.set(reason, [...(byReason.get(reason) ?? []), t]);
  }
  return [...byReason].flatMap(([reason, tickets]): Row[] =>
    tickets.length >= GROUP_AT
      ? [{ kind: "group", reason, count: tickets.length }]
      : tickets.map((ticket) => ({ kind: "ticket", ticket, reason })),
  );
}

export function WaitingOnYou({
  project,
  tabHref,
}: {
  readonly project: ProjectView;
  readonly tabHref: TabHref;
}) {
  useTicketsFeed();
  const tickets = useQuery(
    ticketsQuery({ q: "", needsHuman: false, workspaceId: project.id }),
  );
  const rows = tickets.data === undefined ? [] : rowsOf(tickets.data.items);
  return (
    <Panel label="waiting on you" title="Waiting on you">
      {tickets.isPending && <Loading label="Loading the tickets…" />}
      {tickets.isError && (
        <QueryError
          title="The tickets are unavailable"
          error={tickets.error}
          onRetry={() => void tickets.refetch()}
        />
      )}
      {tickets.data !== undefined && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing waits on you.</p>
      )}
      {rows.length > 0 && (
        <ul
          aria-label="tickets waiting on you"
          className="flex flex-col gap-2 text-sm"
        >
          {rows.map((row) =>
            row.kind === "group" ? (
              <li
                key={`group:${row.reason}`}
                className="flex flex-wrap items-baseline gap-2"
              >
                <span className="font-head">{`${row.count} tickets`}</span>
                <span className="text-muted-foreground">{row.reason}</span>
                <TextLink href={projectHref(project.id, "tickets")}>
                  See them on the board
                </TextLink>
              </li>
            ) : (
              <li
                key={row.ticket.id}
                className="flex flex-wrap items-baseline gap-2"
              >
                <TextLink
                  className="font-head"
                  href={tabHref({ kind: "ticket", num: row.ticket.num })}
                >
                  {`${row.ticket.key} · ${row.ticket.title}`}
                </TextLink>
                <span className="text-muted-foreground">{row.reason}</span>
                <TextLink
                  href={
                    row.ticket.open_questions > 0
                      ? inboxHref(project.id, row.ticket.num)
                      : tabHref({ kind: "ticket", num: row.ticket.num })
                  }
                >
                  {row.ticket.open_questions > 0 ? "Answer" : "Open"}
                </TextLink>
              </li>
            ),
          )}
        </ul>
      )}
    </Panel>
  );
}
