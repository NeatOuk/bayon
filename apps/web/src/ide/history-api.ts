import {
  TimelinePage,
  type TimelineEntry,
  type TimelineExportFormat,
} from "@bayon/proto";
import {
  infiniteQueryOptions,
  queryOptions,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { getJson } from "@/api/http";
import { retryUnlessFinal } from "@/api/query-client";
import { useFeed } from "@/feed/feed";
import { timelineParams, type HistoryFilters } from "@/ide/history-filters";
import { subscribeTicketEvents } from "@/tickets/use-tickets-feed";

// The History view's reads: a project's timeline a page at a time on its
// keyset cursor, the newest page polled for what arrived since, and the export's address. The list
// and the head sit under separate keys: invalidating the head never refetches the list, so rows never
// move under the reader until they ask.

const HISTORY_KEY = ["history"] as const;

/** Rows a page: the API's default. */
export const HISTORY_PAGE = 50;

/** How often the newest page is asked again while the view is on screen. */
export const HISTORY_REFRESH_MS = 10_000;

const timelinePath = (project: string): string =>
  `/projects/${encodeURIComponent(project)}/timeline`;

/** `GET /projects/:id/timeline?limit=&<filters>&cursor=`: one page, newest first. */
export const historyPagePath = (
  project: string,
  filters: HistoryFilters,
  limit: number,
  cursor: string | null,
): string =>
  `${timelinePath(project)}?${[
    `limit=${limit}`,
    ...timelineParams(filters),
    ...(cursor === null ? [] : [`cursor=${encodeURIComponent(cursor)}`]),
  ].join("&")}`;

/** `GET /projects/:id/timeline/export?format=&<filters>`: every row the filters match. */
export const historyExportPath = (
  project: string,
  filters: HistoryFilters,
  format: TimelineExportFormat,
): string =>
  `${timelinePath(project)}/export?${[`format=${format}`, ...timelineParams(filters)].join("&")}`;

/** One key per filter set: the query it asks, so equal filters share a cache entry. */
const filtersKey = (filters: HistoryFilters): string =>
  timelineParams(filters).join("&");

const headKey = (project: string, filters: HistoryFilters) =>
  [...HISTORY_KEY, "head", project, filtersKey(filters)] as const;

export const historyListKey = (project: string, filters: HistoryFilters) =>
  [...HISTORY_KEY, "list", project, filtersKey(filters)] as const;

export type HistoryPages = InfiniteData<TimelinePage>;

/**
 * The list, page after page on the cursor. It never refetches on its own (`staleTime: Infinity`):
 * only a new filter, a reset, or the next page reads it. Its first page seeds the head, so the view
 * sends one request on load, not two.
 */
export const historyListQuery = (
  queryClient: QueryClient,
  project: string,
  filters: HistoryFilters,
) =>
  infiniteQueryOptions({
    queryKey: historyListKey(project, filters),
    queryFn: async ({ pageParam, signal }) => {
      const page = await getJson(
        historyPagePath(project, filters, HISTORY_PAGE, pageParam),
        TimelinePage,
        signal,
      );
      if (pageParam === null)
        queryClient.setQueryData(headKey(project, filters), page);
      return page;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
    staleTime: Infinity,
    retry: retryUnlessFinal,
  });

/** The newest page under the same filters: what the list would show if it were read now. */
export const historyHeadQuery = (project: string, filters: HistoryFilters) =>
  queryOptions({
    queryKey: headKey(project, filters),
    queryFn: ({ signal }) =>
      getJson(
        historyPagePath(project, filters, HISTORY_PAGE, null),
        TimelinePage,
        signal,
      ),
    staleTime: HISTORY_REFRESH_MS,
    retry: retryUnlessFinal,
  });

/** Every `tickets` frame asks the project's heads again: a ticket moved, so its history did. */
export function useHistoryFeed(project: string): void {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeTicketEvents(feed, () => {
        void queryClient.invalidateQueries({
          queryKey: [...HISTORY_KEY, "head", project],
        });
      }),
    [feed, queryClient, project],
  );
}

/** A row's identity: `key` is unique within its source. */
export const rowId = (entry: Pick<TimelineEntry, "source" | "key">): string =>
  `${entry.source}:${entry.key}`;

type Ordered = Pick<TimelineEntry, "ts" | "source" | "key">;

/** True when `a` comes before `b` in the timeline's order: ts, then source, then key, descending. */
export const newerThan = (a: Ordered, b: Ordered): boolean =>
  a.ts !== b.ts
    ? a.ts > b.ts
    : a.source !== b.source
      ? a.source > b.source
      : a.key > b.key;

/** The loaded pages as one list, each row once (the first page wins). */
export function flattenPages(
  pages: readonly TimelinePage[],
): readonly TimelineEntry[] {
  const seen = new Set<string>();
  return pages
    .flatMap((page) => page.items)
    .filter((entry) => {
      const id = rowId(entry);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

/** What the head holds that the list does not, and how to show it. */
export interface FreshRows {
  readonly rows: readonly TimelineEntry[];
  /** More may exist than `rows`: the head page is all new and has more after it. */
  readonly more: boolean;
  /** Every row sorts above the loaded top with no gap: prepend them. Else the list starts over. */
  readonly prepend: boolean;
}

/**
 * The head's rows the list lacks, within the range the list has read: a row below the loaded
 * bottom, while older pages remain, is just not read yet. `complete` is the list having read to the
 * beginning of the history.
 */
export function freshRows(
  head: TimelinePage,
  loaded: readonly TimelineEntry[],
  complete: boolean,
): FreshRows {
  const have = new Set(loaded.map(rowId));
  const top = loaded[0];
  const bottom = loaded.at(-1);
  const rows = head.items.filter(
    (entry) =>
      !have.has(rowId(entry)) &&
      (complete || bottom === undefined || !newerThan(bottom, entry)),
  );
  const last = head.items.at(-1);
  const gap =
    head.has_more &&
    (top === undefined || (last !== undefined && newerThan(last, top)));
  return {
    rows,
    more: gap,
    prepend:
      !gap &&
      (top === undefined || rows.every((entry) => newerThan(entry, top))),
  };
}

/** The list with `rows` at the head of its first page; older pages and every cursor unchanged. */
export function prependRows(
  data: HistoryPages,
  rows: readonly TimelineEntry[],
): HistoryPages {
  const [first, ...rest] = data.pages;
  if (first === undefined) return data;
  return {
    ...data,
    pages: [{ ...first, items: [...rows, ...first.items] }, ...rest],
  };
}
