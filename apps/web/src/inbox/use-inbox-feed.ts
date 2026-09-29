import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useFeed } from "@/feed/feed";
import {
  TICKET_INBOX_KEY,
  inboxQuery,
  projectInboxKey,
} from "@/inbox/inbox-api";

/**
 * The `inbox` topic: each snapshot is the first page of the open requests, so it
 * replaces the open list; the answered list is refetched, since an answer moves a request there.
 *
 * With `project` a frame only says the fleet's requests moved: an item carries no
 * project and the frame is only the first page, so the project's two lists are refetched instead.
 *
 * `enabled` false subscribes to nothing: one owner at a time, so a frame is one refetch and not two
 * (— the shell keeps the header's count live only while the Inbox screen is not the one
 * doing it).
 */
export function useInboxFeed(project?: string, enabled = true): void {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      !enabled
        ? undefined
        : feed.subscribeInbox((page) => {
            if (project !== undefined) {
              void queryClient.invalidateQueries({
                queryKey: projectInboxKey(project),
              });
              return;
            }
            queryClient.setQueryData(inboxQuery("open").queryKey, {
              pages: [page],
              pageParams: [null],
            });
            void queryClient.invalidateQueries({
              queryKey: inboxQuery("answered").queryKey,
            });
            void queryClient.invalidateQueries({
              queryKey: inboxQuery("dismissed").queryKey,
            });
            // One ticket's lists: the frame is the fleet's first page, so refetch them.
            void queryClient.invalidateQueries({ queryKey: TICKET_INBOX_KEY });
          }),
    [feed, queryClient, project, enabled],
  );
}
