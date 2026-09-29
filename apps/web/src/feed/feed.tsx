import { systemClock } from "@bayon/core";
import { CursorClient, type FeedStatus } from "@bayon/proto";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** What the screens need from /ws. A CursorClient is one; tests pass fakes. */
export type Feed = Pick<
  CursorClient,
  | "subscribeEvents"
  | "subscribeFleet"
  | "subscribeTickets"
  | "subscribeSpend"
  | "subscribePulses"
  | "subscribeInbox"
  | "subscribeGates"
  | "subscribeStatus"
  | "status"
>;

const FeedContext = createContext<Feed | null>(null);

export function FeedProvider({
  feed,
  children,
}: {
  readonly feed: Feed;
  readonly children: ReactNode;
}) {
  return <FeedContext value={feed}>{children}</FeedContext>;
}

export function useFeed(): Feed {
  const feed = useContext(FeedContext);
  if (!feed) throw new Error("useFeed must be used inside a <FeedProvider>");
  return feed;
}

/**
 * Whether the feed is delivering. A screen that shows nothing is only telling the truth while this
 * is `open`: before an earlier change a socket could be dead for an hour and every list simply read empty.
 */
export function useFeedStatus(): FeedStatus {
  const feed = useFeed();
  return useSyncExternalStore(
    (listener) => feed.subscribeStatus(listener),
    () => feed.status,
  );
}

/**
 * The page's one /ws connection, on its own origin (the dev server proxies it and adds the bearer).
 * CursorClient reconnects with backoff and resubscribes every topic from its last cursor.
 */
export function createBrowserFeed(
  location: Pick<Location, "protocol" | "host">,
): CursorClient {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${location.host}/ws`;
  return new CursorClient({
    connect: () => new WebSocket(url),
    clock: systemClock,
    onError: (error) =>
      console.warn(`feed: ${error.class}: ${error.message}`, error.cause),
  });
}
