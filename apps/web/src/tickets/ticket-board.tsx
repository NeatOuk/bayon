import type { TicketStatus } from "@bayon/core";
import type { TicketSummary } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { ChevronsLeftRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import {
  ticketsQuery,
  workspacesQuery,
  type TicketFilter,
} from "@/api/queries";
import { Loading } from "@/components/loading";
import { PAGE_BLEED, PageContainer } from "@/components/page-container";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { humanize, labelOf } from "@/components/status";
import { StatusBadge, StatusIcon } from "@/components/status-badge";
import { FOCUS_RING, TextLink } from "@/components/text-link";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toggle } from "@/components/ui/toggle";
import { JiraKeyChip, jiraKeyOf, useJiraSites } from "@/jira/jira-key-chip";
import { cn } from "@/lib/utils";
import { ticketHref, ticketsHref } from "@/routing";
import { NeedsHumanLink, needsHuman } from "@/tickets/needs-human-link";
import { NewTicketDialog } from "@/tickets/new-ticket-dialog";
import { ProjectSelect } from "@/tickets/project-select";
import {
  boardColumns,
  reviewRoundsLabel,
  type BoardColumn,
} from "@/tickets/ticket-model";
import { useTicketsFeed } from "@/tickets/use-tickets-feed";

type LocalFilter = Omit<TicketFilter, "workspaceId">;

const NO_FILTER: LocalFilter = { q: "", needsHuman: false };

/** Where the board's cards and its project picker lead. */
export interface BoardLinks {
  readonly ticket: (num: number) => string;
  readonly project: (project: string | null) => string;
}

/**
 * The fleet-wide board's: a ticket's own screen, and for a picked project its IDE's Tickets view
 * (`#/p/<id>/tickets`, the one address for one project's board).
 */
const FLEET_LINKS: BoardLinks = { ticket: ticketHref, project: ticketsHref };

/**
 * §12.3 board: tickets by status, live from the `tickets` topic; search, needs-human and the
 * project are the server's. The project is the route's: one project's board is its IDE's Tickets
 * view (`#/p/<id>/tickets`), so picking one is a link and back/forward move between
 * them. The IDE passes its own `links`, so a card opens a ticket tab there, and its
 * `banner`: the Jira strip.
 * The board fills the screen's height and scrolls inside itself, so its column headings stay put
 *.
 */
export function TicketBoard({
  project,
  links = FLEET_LINKS,
  banner,
}: {
  readonly project: string | null;
  readonly links?: BoardLinks;
  /** Shown between the header and the columns. */
  readonly banner?: ReactNode;
}) {
  useTicketsFeed();
  const [local, setFilter] = useState<LocalFilter>(NO_FILTER);
  const [search, setSearch] = useState("");
  const filter: TicketFilter = { ...local, workspaceId: project };
  const tickets = useQuery(ticketsQuery(filter));
  const workspaces = useQuery(workspacesQuery);
  const jiraSiteOf = useJiraSites();
  const projectNames = new Map(
    (workspaces.data?.workspaces ?? []).map((w) => [w.id, w.name]),
  );
  const searched = filter.q !== "" || filter.needsHuman;
  const clear = () => {
    setSearch("");
    setFilter(NO_FILTER);
  };

  return (
    <PageContainer fill>
      <PageHeader
        title="Tickets"
        actions={<NewTicketDialog defaultProject={project} />}
      />
      <FilterBar
        project={project}
        search={search}
        needsHuman={filter.needsHuman}
        onSearchText={setSearch}
        onSearch={() => setFilter((f) => ({ ...f, q: search.trim() }))}
        onNeedsHuman={(pressed) =>
          setFilter((f) => ({ ...f, needsHuman: pressed }))
        }
        onProject={(next) => {
          window.location.hash = links.project(next);
        }}
      />
      {banner}
      {tickets.isPending && <Loading label="Loading the board…" lines={3} />}
      {tickets.isError && (
        <QueryError
          title="The board is unavailable"
          error={tickets.error}
          onRetry={() => void tickets.refetch()}
        />
      )}
      {tickets.data !== undefined &&
        (tickets.data.items.length === 0 ? (
          <NoTickets
            searched={searched}
            project={project}
            onClear={clear}
            allHref={links.project(null)}
          />
        ) : (
          <Board
            tickets={tickets.data.items}
            complete={tickets.data.complete}
            hrefOf={links.ticket}
            siteOf={(ticket) => jiraSiteOf(ticket.workspace_id)}
            // One project's board needs no badge saying so on every card.
            projectOf={(ticket) =>
              project !== null || ticket.workspace_id === null
                ? null
                : (projectNames.get(ticket.workspace_id) ?? ticket.workspace_id)
            }
          />
        ))}
    </PageContainer>
  );
}

/** The project, the search and needs-human on one line: every control the same 36px height. */
function FilterBar({
  project,
  search,
  needsHuman,
  onSearchText,
  onSearch,
  onNeedsHuman,
  onProject,
}: {
  readonly project: string | null;
  readonly search: string;
  readonly needsHuman: boolean;
  readonly onSearchText: (text: string) => void;
  readonly onSearch: () => void;
  readonly onNeedsHuman: (pressed: boolean) => void;
  readonly onProject: (project: string | null) => void;
}) {
  const searchId = useId();
  const projectLabelId = useId();
  return (
    <form
      aria-label="filter tickets"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label id={projectLabelId} className="text-xs text-muted-foreground">
          Project
        </Label>
        <ProjectSelect
          labelId={projectLabelId}
          noneLabel="All projects"
          value={project}
          onChange={onProject}
          className="w-48"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={searchId} className="text-xs text-muted-foreground">
          Search tickets
        </Label>
        <div className="flex gap-2">
          <Input
            id={searchId}
            value={search}
            placeholder="Words in the title or body"
            onChange={(event) => onSearchText(event.target.value)}
            className="w-72"
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </div>
      </div>
      <Toggle
        variant="outline"
        pressed={needsHuman}
        onPressedChange={onNeedsHuman}
        className="px-3"
      >
        Needs human only
      </Toggle>
    </form>
  );
}

function NoTickets({
  searched,
  project,
  onClear,
  allHref,
}: {
  readonly searched: boolean;
  readonly project: string | null;
  readonly onClear: () => void;
  readonly allHref: string;
}) {
  if (searched)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No tickets match these filters</EmptyTitle>
          <EmptyDescription>
            Nothing here has those words, or needs a human.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear the filters
          </Button>
        </EmptyContent>
      </Empty>
    );
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>
          {project === null ? "No tickets yet" : "No tickets in this project"}
        </EmptyTitle>
        <EmptyDescription>
          File one here, or let an agent file one with ticket_create.
          {project !== null && (
            <>
              {" "}
              <TextLink inline href={allHref}>
                See every project&apos;s tickets
              </TextLink>
              .
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <NewTicketDialog defaultProject={project} />
      </EmptyContent>
    </Empty>
  );
}

function Board({
  tickets,
  complete,
  hrefOf,
  siteOf,
  projectOf,
}: {
  readonly tickets: readonly TicketSummary[];
  readonly complete: boolean;
  readonly hrefOf: (num: number) => string;
  /** The Jira site of a mirrored ticket's project, for its key chip. */
  readonly siteOf: (ticket: TicketSummary) => string | null;
  readonly projectOf: (ticket: TicketSummary) => string | null;
}) {
  const [open, setOpen] = useState<ReadonlySet<TicketStatus>>(new Set());
  const toggle = (status: TicketStatus) =>
    setOpen((current) =>
      current.has(status)
        ? new Set([...current].filter((s) => s !== status))
        : new Set([...current, status]),
    );
  return (
    <>
      {!complete && (
        <p className="text-sm text-muted-foreground">
          The board shows the first pages only; search to narrow it.
        </p>
      )}
      <div
        data-testid="board"
        className={cn(
          "flex min-h-64 flex-1 items-stretch gap-3 overflow-auto pb-4",
          PAGE_BLEED,
        )}
      >
        {boardColumns(tickets, open).map((column) =>
          column.collapsed ? (
            <FoldedColumn
              key={column.status}
              column={column}
              onOpen={() => toggle(column.status)}
            />
          ) : (
            <section
              key={column.status}
              aria-label={labelOf("ticket", column.status)}
              className="flex w-72 shrink-0 flex-col gap-2"
            >
              <SectionTitle className="sticky top-0 z-10 flex items-center gap-2 bg-background py-2">
                <StatusIcon entity="ticket" state={column.status} />
                {labelOf("ticket", column.status)}{" "}
                <CountPill count={column.tickets.length} />
                {column.folded && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto"
                    aria-label={`Fold ${labelOf("ticket", column.status)}`}
                    aria-expanded={true}
                    onClick={() => toggle(column.status)}
                  >
                    <ChevronsLeftRight aria-hidden="true" />
                  </Button>
                )}
              </SectionTitle>
              {column.tickets.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  href={hrefOf(ticket.num)}
                  site={siteOf(ticket)}
                  project={projectOf(ticket)}
                />
              ))}
            </section>
          ),
        )}
      </div>
    </>
  );
}

function CountPill({ count }: { readonly count: number }) {
  return (
    <span className="rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground tabular-nums">
      {count}{" "}
      <span className="sr-only">{count === 1 ? "ticket" : "tickets"}</span>
    </span>
  );
}

/**
 * A narrow column: its label on its side and its count. A closed status with tickets opens on a
 * click; an empty flow column only holds its place, so the board never shifts.
 */
function FoldedColumn({
  column,
  onOpen,
}: {
  readonly column: BoardColumn;
  readonly onOpen: () => void;
}) {
  const label = labelOf("ticket", column.status);
  const inner = (
    <>
      <StatusIcon entity="ticket" state={column.status} />
      <span className="[writing-mode:vertical-rl]">{label}</span>{" "}
      <CountPill count={column.tickets.length} />
    </>
  );
  const openable = column.tickets.length > 0;
  return (
    <section
      aria-label={label}
      data-collapsed="true"
      className="flex w-10 shrink-0 flex-col"
    >
      {openable ? (
        <button
          type="button"
          aria-expanded={false}
          aria-label={`Show ${label}, ${column.tickets.length} ${column.tickets.length === 1 ? "ticket" : "tickets"}`}
          onClick={onOpen}
          className={cn(
            "sticky top-0 flex cursor-pointer flex-col items-center gap-2 rounded-lg border bg-card py-3 text-sm font-medium shadow-xs hover:bg-accent",
            FOCUS_RING,
          )}
        >
          {inner}
        </button>
      ) : (
        <div className="sticky top-0 flex flex-col items-center gap-2 rounded-lg border border-dashed py-3 text-sm text-muted-foreground">
          {inner}
        </div>
      )}
    </section>
  );
}

/** A quiet fact on a card: priority, type, cost tier. */
const Chip = ({
  children,
  label,
}: {
  readonly children: string;
  readonly label?: string;
}) => (
  <span
    aria-label={label}
    className="rounded-sm bg-muted px-1.5 py-px text-xs text-muted-foreground"
  >
    {children}
  </span>
);

/**
 * A card is one link to its ticket. A mirrored ticket's Jira chip is a link of its own, so it sits
 * over the card's corner beside that link, never inside it (an `<a>` may not hold another); so does
 * its needs-human badge.
 */
function TicketCard({
  ticket,
  href,
  site,
  project,
}: {
  readonly ticket: TicketSummary;
  readonly href: string;
  readonly site: string | null;
  readonly project: string | null;
}) {
  const human = needsHuman(ticket);
  const waiting = ticket.waiting_on_you;
  return (
    <div className="relative">
      <a
        href={href}
        className={cn(
          "flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-xs transition-[border-color,box-shadow] hover:border-input-border hover:shadow-sm",
          FOCUS_RING,
        )}
      >
        <span
          className={cn(
            "font-mono text-xs text-muted-foreground",
            jiraKeyOf(ticket) !== null && "pr-24",
          )}
        >
          {ticket.key}
        </span>
        <h3
          className="line-clamp-3 text-sm leading-snug font-medium"
          title={ticket.title}
        >
          {ticket.title}
        </h3>
        <span className="flex flex-wrap items-center gap-1">
          {project !== null && (
            <Chip label={`project ${project}`}>{project}</Chip>
          )}
          <Chip>{`P${ticket.priority}`}</Chip>
          <Chip>{humanize(ticket.type)}</Chip>
          <Chip>{ticket.complexity_tier}</Chip>
          {ticket.review_rounds > 0 && (
            <Chip>{reviewRoundsLabel(ticket.review_rounds)}</Chip>
          )}
        </span>
        {(waiting || human) && (
          <span className="flex min-h-5 flex-wrap items-center gap-1 pr-28">
            {/* Its next step waits on the operator; why, on hover. */}
            {waiting && (
              <span
                className="inline-flex"
                title={ticket.waiting_reason ?? undefined}
              >
                <StatusBadge entity="waiting" state="you" />
                <span className="sr-only">{`: ${ticket.waiting_reason ?? ""}`}</span>
              </span>
            )}
          </span>
        )}
      </a>
      <JiraKeyChip
        ticket={ticket}
        site={site}
        className="absolute top-2.5 right-2.5"
      />
      {/* Over the card beside its link, never inside it (an `<a>` may not hold another), an earlier change. */}
      {human && (
        <NeedsHumanLink ticket={ticket} className="absolute right-3 bottom-3" />
      )}
    </div>
  );
}
