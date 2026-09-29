import type { OnTicketEvents, TicketDetail } from "@bayon/proto";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { TICKETS_KEY, TICKET_KEY } from "@/api/queries";
import { useFeed, type Feed } from "@/feed/feed";

/**
 * The last `ticket_events.id` each feed delivered. The board, a ticket and the IDE's activity panel
 * each subscribe on mount, and resume here, so moving between them never replays the topic. A page
 * load starts from 0 once.
 */
const resumeAt = new WeakMap<Feed, number>();

/** Subscribes `on` to the `tickets` topic from where this feed last delivered. */
export function subscribeTicketEvents(
  feed: Feed,
  on: OnTicketEvents,
): () => void {
  return feed.subscribeTickets(
    (items, cursor) => {
      resumeAt.set(feed, Math.max(resumeAt.get(feed) ?? 0, cursor));
      on(items, cursor);
    },
    resumeAt.get(feed) ?? 0,
  );
}

/**
 * The `tickets` topic (M1 contract 8): every ticket event refetches the board and the details of the
 * tickets it names. Frames carry events, not tickets, so REST stays the one source of their state.
 */
export function useTicketsFeed(): void {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeTicketEvents(feed, (items) => {
        const moved = new Set(items.map((event) => event.ticket_id));
        void queryClient.invalidateQueries({ queryKey: TICKETS_KEY });
        for (const [
          queryKey,
          detail,
        ] of queryClient.getQueriesData<TicketDetail>({
          queryKey: TICKET_KEY,
        }))
          if (detail !== undefined && moved.has(detail.ticket.id))
            void queryClient.invalidateQueries({ queryKey, exact: true });
      }),
    [feed, queryClient],
  );
}
