import type { GatesPage, TicketDetail } from "@bayon/proto";
import {
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { TICKET_KEY } from "@/api/queries";
import { useFeed } from "@/feed/feed";
import { projectQueueQuery, reviewQueueQuery } from "@/gates/gate-api";

type Queue = InfiniteData<GatesPage, string | null>;

/**
 * The queue after a snapshot: the snapshot is its first page. With one page loaded it simply
 * replaces it; with more (the operator pressed "Load more") the later pages are kept, so the view
 * does not shrink back to page one on every push, and are refetched in order on
 * their keyset cursors, since the rows under each cursor moved with the snapshot.
 */
function applySnapshot(queryClient: QueryClient, page: GatesPage): void {
  const { queryKey } = reviewQueueQuery;
  const cached = queryClient.getQueryData<Queue>(queryKey);
  if (cached === undefined || cached.pages.length <= 1) {
    queryClient.setQueryData<Queue>(queryKey, {
      pages: [page],
      pageParams: [null],
    });
    return;
  }
  queryClient.setQueryData<Queue>(queryKey, {
    pages: [page, ...cached.pages.slice(1)],
    pageParams: cached.pageParams,
  });
  void queryClient.invalidateQueries({ queryKey, exact: true });
}

/**
 * The `gates` topic: each snapshot is the review queue's first page. The open ticket
 * details of every gate it names, before or after, are refetched. A reviewer session starting writes
 * no ticket event, so the `tickets` topic alone would not show its link.
 *
 * With `project` a frame only says the fleet's queue moved: its rows carry no project and
 * are only the first page, so the project's own queue is refetched, and nothing is read off the
 * frame.
 */
export function useGatesFeed(project?: string): void {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      feed.subscribeGates((page) => {
        if (project !== undefined) {
          void queryClient.invalidateQueries({
            queryKey: projectQueueQuery(project).queryKey,
            exact: true,
          });
          return;
        }
        const before =
          queryClient
            .getQueryData<Queue>(reviewQueueQuery.queryKey)
            ?.pages.flatMap((loaded) => loaded.items) ?? [];
        const named = new Set(
          [...before, ...page.items].map((gate) => gate.ticket.id),
        );
        applySnapshot(queryClient, page);
        for (const [
          queryKey,
          detail,
        ] of queryClient.getQueriesData<TicketDetail>({
          queryKey: TICKET_KEY,
        }))
          if (detail !== undefined && named.has(detail.ticket.id))
            void queryClient.invalidateQueries({ queryKey, exact: true });
      }),
    [feed, queryClient, project],
  );
}
