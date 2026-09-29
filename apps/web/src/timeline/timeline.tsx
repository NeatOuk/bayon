import type { EventItem, FeedStatus } from "@bayon/proto";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { humanize } from "@/components/status";
import { Button, buttonVariants } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useFeedStatus } from "@/feed/feed";
import { useSessionEvents } from "@/feed/use-session-events";
import { missionHref } from "@/routing";
import { EventRow } from "@/timeline/event-row";
import {
  CATEGORIES,
  filterEvents,
  isCategory,
  lastErrorIndex,
  type Category,
} from "@/timeline/event-view";

const ESTIMATED_ROW_PX = 32;
const OVERSCAN_ROWS = 10;

/** The default session view (§12.4 #3), live from the session's events topic. */
export function Timeline({
  sessionId,
  agentName,
}: {
  readonly sessionId: string;
  readonly agentName?: string | undefined;
}) {
  const { items } = useSessionEvents(sessionId);
  const status = useFeedStatus();
  return (
    <TimelineView
      sessionId={sessionId}
      items={items}
      agentName={agentName}
      status={status}
    />
  );
}

/**
 * A virtualized list: only the rows in view (plus overscan) are in the DOM, measured as they render.
 * With the session's `agentName`, "add a law" opens that agent's mission at its laws (§12.3).
 */
export function TimelineView({
  sessionId,
  items,
  agentName,
  status = "open",
}: {
  readonly sessionId: string;
  readonly items: readonly EventItem[];
  readonly agentName?: string | undefined;
  /** An empty list means "nothing happened" only while the feed is `open`. */
  readonly status?: FeedStatus;
}) {
  const [active, setActive] = useState<ReadonlySet<Category>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const shown = useMemo(() => filterEvents(items, active), [items, active]);
  const lastError = useMemo(() => lastErrorIndex(shown), [shown]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey: (index) => shown[index]?.id ?? index,
    overscan: OVERSCAN_ROWS,
  });

  const setOpen = (id: number, open: boolean) =>
    setExpanded((prev) =>
      open
        ? new Set([...prev, id])
        : new Set([...prev].filter((x) => x !== id)),
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="filter events"
          multiple
          variant="outline"
          value={[...active]}
          onValueChange={(values: readonly unknown[]) =>
            setActive(new Set(values.filter(isCategory)))
          }
        >
          {CATEGORIES.map((category) => (
            <ToggleGroupItem key={category} value={category}>
              {humanize(category)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button
          size="sm"
          variant="outline"
          disabled={lastError < 0}
          onClick={() =>
            virtualizer.scrollToIndex(lastError, { align: "center" })
          }
        >
          Jump to last error
        </Button>
        {agentName !== undefined && (
          <a
            href={missionHref(agentName, "laws")}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            add a law
          </a>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {`${shown.length} / ${items.length} events`}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card text-card-foreground"
      >
        {items.length === 0 && (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {status === "open"
              ? "No events yet."
              : "Not connected to the live feed: this list is not up to date."}
          </p>
        )}
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const event = shown[row.index];
            return event === undefined ? null : (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <EventRow
                  sessionId={sessionId}
                  event={event}
                  open={expanded.has(event.id)}
                  onOpenChange={(open) => setOpen(event.id, open)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
