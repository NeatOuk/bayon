import type { ProjectView, TimelineEntry } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { Loading } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { FOCUS_RING } from "@/components/text-link";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { HistoryFilters } from "@/ide/history-filters";
import { tabOf } from "@/ide/open-tabs";
import {
  ACTIVITY_LIMIT,
  ACTIVITY_REFRESH_MS,
  projectTimelineQuery,
  useTimelineFeed,
} from "@/ide/timeline-api";
import { readFlag, writeFlag } from "@/ide/viewer-prefs";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { projectHref, type IdeView } from "@/routing";

/** Per viewer: whether the activity panel is open. */
const OPEN_KEY = "bayon.ide.activity-open";

const ROW =
  "grid grid-cols-[3rem_minmax(0,9rem)_minmax(0,1fr)] items-baseline gap-3 px-3 py-1";

/**
 * The IDE's bottom panel: the project's newest history rows, live. A `tickets` frame
 * refetches it at once; a 10 s poll catches the rows no ticket event announces. A row naming a ticket
 * or a session opens it as a tab. Folded, it reads nothing.
 */
export function ActivityPanel({
  project,
  view,
  filters,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
  /** The history view's filters: a row opened beside it keeps them. */
  readonly filters?: HistoryFilters | undefined;
}) {
  const [open, setOpen] = useState(() => readFlag(OPEN_KEY, true));
  useTimelineFeed(project.id);
  const timeline = useQuery({
    ...projectTimelineQuery(project.id, ACTIVITY_LIMIT),
    enabled: open,
    refetchInterval: open ? ACTIVITY_REFRESH_MS : false,
  });
  const names = new Map(project.agents.map((agent) => [agent.id, agent.name]));
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        writeFlag(OPEN_KEY, next);
      }}
      render={<section aria-label="activity" />}
      className="flex min-h-0 flex-col border-t bg-card text-card-foreground"
    >
      <CollapsibleTrigger
        className={cn(
          FOCUS_RING,
          "group flex shrink-0 items-center gap-2 px-3 py-1.5 text-left font-head text-xs tracking-wider text-muted-foreground uppercase hover:text-foreground focus-visible:-outline-offset-2",
        )}
      >
        <ChevronRightIcon className="size-4 transition-transform group-data-panel-open:rotate-90" />
        Activity
        <span className="font-sans tracking-normal normal-case">
          {`newest ${ACTIVITY_LIMIT}, live`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="min-h-0">
        <div className="max-h-[25vh] overflow-y-auto pb-1 text-sm">
          {timeline.isPending && (
            <Loading label="Loading the activity…" className="px-3 py-1" />
          )}
          {timeline.isError && (
            <QueryError
              className="mx-3 my-1"
              title="The activity is unavailable"
              error={timeline.error}
              onRetry={() => void timeline.refetch()}
            />
          )}
          {timeline.data !== undefined &&
            (timeline.data.items.length === 0 ? (
              <p className="px-3 py-1 text-muted-foreground">
                Nothing has happened in this project yet.
              </p>
            ) : (
              <ol aria-label="activity rows">
                {timeline.data.items.map((entry) => (
                  <li key={`${entry.source}:${entry.key}`}>
                    <ActivityRow
                      entry={entry}
                      who={
                        entry.agent_id === null
                          ? entry.actor
                          : (names.get(entry.agent_id) ?? entry.agent_id)
                      }
                      href={hrefOf(project.id, view, entry, filters)}
                    />
                  </li>
                ))}
              </ol>
            ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function hrefOf(
  project: string,
  view: IdeView,
  entry: TimelineEntry,
  filters: HistoryFilters | undefined,
): string | null {
  const tab = tabOf(entry);
  return tab === null ? null : projectHref(project, view, tab, filters);
}

function ActivityRow({
  entry,
  who,
  href,
}: {
  readonly entry: TimelineEntry;
  readonly who: string;
  readonly href: string | null;
}) {
  const at = formatTime(entry.ts);
  const cells = (
    <>
      <time
        dateTime={new Date(entry.ts).toISOString()}
        title={`${at} UTC`}
        className="font-mono text-xs text-muted-foreground"
      >
        {at.slice(11)}
      </time>
      <span className="truncate font-mono text-xs">{who}</span>
      <span className="truncate" title={entry.summary}>
        {entry.summary}
      </span>
    </>
  );
  return href === null ? (
    <div className={ROW}>{cells}</div>
  ) : (
    <a
      href={href}
      className={cn(
        ROW,
        FOCUS_RING,
        "hover:bg-accent focus-visible:bg-accent focus-visible:-outline-offset-2",
      )}
    >
      {cells}
    </a>
  );
}
