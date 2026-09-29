import { TimelinePage } from "@bayon/proto";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getJson } from "@/api/http";
import { useFeed } from "@/feed/feed";
import { subscribeTicketEvents } from "@/tickets/use-tickets-feed";

// A project's history as the IDE's activity panel reads it: the newest rows of
// `GET /projects/:id/timeline`, refetched on every `tickets` frame and on a slow poll for the rows
// no ticket event announces (sessions, pulses, audit).

export const TIMELINE_KEY = ["timeline"] as const;

/** How many of the newest rows the activity panel shows. */
export const ACTIVITY_LIMIT = 30;

/** The poll for rows the `tickets` topic says nothing about. */
export const ACTIVITY_REFRESH_MS = 10_000;

/** `GET /projects/:id/timeline?limit=n`: the newest page, newest first. */
export const projectTimelineQuery = (project: string, limit: number) =>
  queryOptions({
    queryKey: [...TIMELINE_KEY, project, limit],
    queryFn: ({ signal }) =>
      getJson(
        `/projects/${encodeURIComponent(project)}/timeline?limit=${limit}`,
        TimelinePage,
        signal,
      ),
  });

/** Every `tickets` frame refetches the project's timeline: a ticket moved, so its history did. */
export function useTimelineFeed(project: string): void {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeTicketEvents(feed, () => {
        void queryClient.invalidateQueries({
          queryKey: [...TIMELINE_KEY, project],
        });
      }),
    [feed, queryClient, project],
  );
}
