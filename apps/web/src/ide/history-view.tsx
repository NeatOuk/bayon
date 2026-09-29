import type { ProjectView, TimelineEntry } from "@bayon/proto";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import {
  HISTORY_REFRESH_MS,
  flattenPages,
  freshRows,
  historyHeadQuery,
  historyListKey,
  historyListQuery,
  prependRows,
  useHistoryFeed,
  type HistoryPages,
} from "@/ide/history-api";
import { HistoryExport } from "@/ide/history-export";
import { HistoryFilterBar, type FilterRefusal } from "@/ide/history-filter-bar";
import {
  NO_FILTERS,
  isFiltered,
  timelineParams,
  type HistoryFilters,
} from "@/ide/history-filters";
import { HistoryList } from "@/ide/history-list";
import { tabOf } from "@/ide/open-tabs";
import { projectHref } from "@/routing";

/** How often the rows' "5 min ago" hints move on. */
const NOW_TICK_MS = 30_000;

/** The time the relative hints count from, moving on while the view is on screen. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/**
 * A 400 is the server refusing the filters, in its own words: one naming the ticket shows under the
 * ticket field, any other above the list.
 */
function refusalOf(
  error: Error | null,
  filters: HistoryFilters,
): FilterRefusal {
  if (!(error instanceof ApiRequestError) || error.status !== 400)
    return { ticket: null, other: null };
  const message = error.error.message;
  return filters.ticket !== undefined && /\bticket\b/.test(message)
    ? { ticket: message, other: null }
    : { ticket: null, other: message };
}

/**
 * The IDE's History view: the project's whole timeline, filtered, searched,
 * scrolled and exported. The filters are the URL's; a row opens its ticket, session or pulse as a
 * tab and keeps them. While `visible` (its tab focused), the newest page is asked again every 10 s
 * and on every `tickets` frame; what it holds that the list lacks waits behind a pill.
 */
export function HistoryView({
  project,
  filters,
  visible,
}: {
  readonly project: ProjectView;
  readonly filters: HistoryFilters;
  readonly visible: boolean;
}) {
  const queryClient = useQueryClient();
  const list = useInfiniteQuery(
    historyListQuery(queryClient, project.id, filters),
  );
  const rows = useMemo(() => flattenPages(list.data?.pages ?? []), [list.data]);
  useHistoryFeed(project.id);
  const head = useQuery({
    ...historyHeadQuery(project.id, filters),
    enabled: visible && list.isSuccess,
    refetchInterval: visible ? HISTORY_REFRESH_MS : false,
  });
  const now = useNow(visible);
  const fresh =
    head.data === undefined || !list.isSuccess
      ? null
      : freshRows(head.data, rows, !list.hasNextPage);

  const go = (next: HistoryFilters) => {
    window.location.hash = projectHref(project.id, "history", undefined, next);
  };
  const showFresh = () => {
    if (fresh === null) return;
    const key = historyListKey(project.id, filters);
    if (fresh.prepend)
      queryClient.setQueryData<HistoryPages>(key, (data) =>
        data === undefined ? data : prependRows(data, fresh.rows),
      );
    else void queryClient.resetQueries({ queryKey: key, exact: true });
  };
  const hrefOf = (entry: TimelineEntry): string | null => {
    const tab = tabOf(entry);
    return tab === null
      ? null
      : projectHref(project.id, "history", tab, filters);
  };
  const refusal = refusalOf(list.error, filters);
  const refused = refusal.ticket !== null || refusal.other !== null;

  return (
    <section
      aria-label="history"
      className="flex min-h-0 flex-1 flex-col md:overflow-hidden"
    >
      <PageHeader title="History" className="shrink-0 px-3 pt-3" />
      <HistoryFilterBar
        project={project}
        filters={filters}
        refusal={refusal}
        onChange={go}
        actions={
          <HistoryExport
            // A new filter set starts with no export said about it.
            key={timelineParams(filters).join("&")}
            project={project.id}
            filters={filters}
            disabled={!list.isSuccess}
          />
        }
      />
      {refused && (
        <p className="p-4 text-sm text-muted-foreground">
          Nothing to show until the filters above are fixed.
        </p>
      )}
      {list.isError && list.data === undefined && !refused && (
        <QueryError
          className="m-4"
          title="The history is unavailable"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      )}
      <HistoryList
        key={timelineParams(filters).join("&")}
        project={project}
        list={list}
        rows={rows}
        filtered={isFiltered(filters)}
        hrefOf={hrefOf}
        now={now}
        fresh={fresh}
        onShowFresh={showFresh}
        onClear={() => go(NO_FILTERS)}
      />
    </section>
  );
}
