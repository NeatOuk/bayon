import type { ProjectView, TimelineEntry } from "@bayon/proto";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Id } from "@/components/id";
import { Loading } from "@/components/loading";
import { FOCUS_RING } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { rowId, type FreshRows, type HistoryPages } from "@/ide/history-api";
import { formatLocalTime, formatTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// The History view's list: virtualized, a page more as the reader nears the end (or on
// Load older), each row a link to its tab with its payload behind a toggle. New rows wait behind a
// pill: the list never moves under the reader.

const ESTIMATED_ROW_PX = 44;
const OVERSCAN_ROWS = 10;
/** Rows from the end at which the next page is read. */
const LOAD_AHEAD = 10;

const CELLS =
  "flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 md:grid md:grid-cols-[10.5rem_minmax(0,13rem)_minmax(0,10rem)_5.5rem_minmax(0,1fr)]";

/** The focus ring inside the list's scroller, drawn flush so the scroller does not clip it. */
const FLUSH_FOCUS_RING = cn(
  FOCUS_RING,
  "rounded-md focus-visible:outline-offset-0",
);

/** `session:<id>` as the row shows it: the kind, then the id (shortened in the middle). */
function ActorLabel({ actor }: { readonly actor: string }) {
  const at = actor.indexOf(":");
  if (at < 0) return <>{actor}</>;
  return (
    <>
      {`${actor.slice(0, at)} `}
      <Id value={actor.slice(at + 1)} />
    </>
  );
}

export function HistoryList({
  project,
  list,
  rows,
  filtered,
  hrefOf,
  now,
  fresh,
  onShowFresh,
  onClear,
}: {
  readonly project: ProjectView;
  readonly list: UseInfiniteQueryResult<HistoryPages>;
  readonly rows: readonly TimelineEntry[];
  readonly filtered: boolean;
  readonly hrefOf: (entry: TimelineEntry) => string | null;
  readonly now: number;
  readonly fresh: FreshRows | null;
  readonly onShowFresh: () => void;
  readonly onClear: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey: (index) => {
      const entry = rows[index];
      return entry === undefined ? index : rowId(entry);
    },
    overscan: OVERSCAN_ROWS,
  });
  const lastShown = virtualizer.getVirtualItems().at(-1)?.index ?? -1;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError } = list;
  const { fetchNextPage } = list;
  // The row count the last automatic read started from: a page that adds no new row (every one a
  // repeat) never starts another on its own, so a stuck cursor cannot loop. Load older still reads.
  const readFrom = useRef(-1);
  useEffect(() => {
    if (
      lastShown >= rows.length - LOAD_AHEAD &&
      rows.length !== readFrom.current &&
      hasNextPage &&
      !isFetchingNextPage &&
      !isFetchNextPageError
    ) {
      readFrom.current = rows.length;
      void fetchNextPage();
    }
  }, [
    lastShown,
    rows.length,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  ]);

  const names = new Map(project.agents.map((agent) => [agent.id, agent.name]));
  const setOpen = (id: string, open: boolean) =>
    setExpanded((prev) =>
      open
        ? new Set([...prev, id])
        : new Set([...prev].filter((known) => known !== id)),
    );
  const showFresh = () => {
    onShowFresh();
    // A list started over reads its older pages again as the reader nears their end.
    readFrom.current = -1;
    scrollRef.current?.scrollTo({ top: 0 });
  };

  if (list.isPending)
    return <Loading label="Loading the history…" lines={4} className="p-4" />;
  if (list.isError && list.data === undefined) return null;
  if (rows.length === 0)
    return (
      <div className="p-4">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {filtered
                ? "No events match these filters."
                : "This project has no history yet."}
            </EmptyTitle>
            {filtered && (
              <EmptyDescription>
                <Button variant="outline" size="sm" onClick={onClear}>
                  Clear all filters
                </Button>
              </EmptyDescription>
            )}
          </EmptyHeader>
        </Empty>
      </div>
    );

  return (
    // Narrow screens scroll the whole view, the list keeping a height of its own; wider ones give the
    // list what the filter bar leaves.
    <div className="relative flex min-h-72 flex-1 flex-col md:min-h-0">
      <div
        role="status"
        className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
      >
        {fresh !== null && fresh.rows.length > 0 && (
          <Button
            size="sm"
            className="pointer-events-auto rounded-full shadow-md"
            onClick={showFresh}
          >
            {`${fresh.rows.length}${fresh.more ? "+" : ""} new ${
              fresh.rows.length === 1 && !fresh.more ? "event" : "events"
            } — show`}
          </Button>
        )}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div
          role="list"
          aria-label="history events"
          aria-busy={list.isFetchingNextPage}
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const entry = rows[item.index];
            if (entry === undefined) return null;
            const id = rowId(entry);
            return (
              <div
                key={item.key}
                role="listitem"
                aria-posinset={item.index + 1}
                aria-setsize={list.hasNextPage ? -1 : rows.length}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full border-b"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <HistoryRow
                  entry={entry}
                  agent={
                    entry.agent_id === null
                      ? null
                      : (names.get(entry.agent_id) ?? entry.agent_id)
                  }
                  href={hrefOf(entry)}
                  now={now}
                  open={expanded.has(id)}
                  onOpenChange={(open) => setOpen(id, open)}
                />
              </div>
            );
          })}
        </div>
        <ListFoot list={list} count={rows.length} filtered={filtered} />
      </div>
    </div>
  );
}

/** Below the rows: the next page's state, or where the history begins. */
function ListFoot({
  list,
  count,
  filtered,
}: {
  readonly list: UseInfiniteQueryResult<HistoryPages>;
  readonly count: number;
  readonly filtered: boolean;
}) {
  const loadOlder = (
    <Button
      variant="outline"
      size="sm"
      disabled={list.isFetchingNextPage}
      onClick={() => void list.fetchNextPage()}
    >
      Load older
    </Button>
  );
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 p-3 text-sm text-muted-foreground">
      {list.isFetchingNextPage ? (
        <Loading label="Loading older events…" />
      ) : list.isFetchNextPageError ? (
        <>
          <span
            role="alert"
            className="text-danger"
          >{`Older events are unavailable: ${list.error?.message ?? ""}`}</span>
          {loadOlder}
        </>
      ) : list.hasNextPage ? (
        loadOlder
      ) : (
        <span>
          {`The beginning of this project's history: ${count} ${
            filtered ? "matching " : ""
          }${count === 1 ? "event" : "events"}.`}
        </span>
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  agent,
  href,
  now,
  open,
  onOpenChange,
}: {
  readonly entry: TimelineEntry;
  readonly agent: string | null;
  readonly href: string | null;
  readonly now: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const cells = (
    <>
      <span className="flex flex-col">
        <time
          dateTime={new Date(entry.ts).toISOString()}
          title={`${formatTime(entry.ts)} UTC`}
          className="font-mono text-xs"
        >
          {formatLocalTime(entry.ts)}
        </time>
        <span className="text-xs text-muted-foreground">
          {relativeTime(entry.ts, now)}
        </span>
      </span>
      <span className="min-w-0">
        <Badge variant="outline" className="max-w-full font-mono">
          <span className="truncate">{entry.kind}</span>
        </Badge>
      </span>
      <span className="flex min-w-0 flex-col text-xs">
        {agent !== null && <span className="truncate">{agent}</span>}
        <span className="truncate font-mono text-muted-foreground">
          <ActorLabel actor={entry.actor} />
        </span>
      </span>
      <span className="font-mono text-xs">{entry.ticket_key ?? ""}</span>
      <span
        className="min-w-0 basis-full truncate text-sm md:basis-auto"
        title={entry.summary}
      >
        {entry.summary}
      </span>
    </>
  );
  const main =
    href === null ? (
      <div className={CELLS}>{cells}</div>
    ) : (
      <a href={href} className={`${CELLS} ${FLUSH_FOCUS_RING} hover:bg-accent`}>
        {cells}
      </a>
    );
  if (entry.payload === undefined)
    return <div className="flex items-center gap-2 px-3 py-1.5">{main}</div>;
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        {main}
        <CollapsibleTrigger
          className={`group flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground ${FLUSH_FOCUS_RING}`}
        >
          <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
          details
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <pre className="mx-3 mb-2 max-h-80 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {JSON.stringify(entry.payload, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
