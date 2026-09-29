import type { EventItem } from "@bayon/proto";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  EMPTY_BUFFER,
  appendEvents,
  type EventBuffer,
} from "@/feed/event-buffer";
import { useFeed } from "@/feed/feed";

/**
 * Holds the current buffer outside React (a ref, in effect): a WS frame of 200 events is one append
 * and one re-render, and there is no query-cache entry per row.
 */
interface BufferStore {
  readonly get: () => EventBuffer;
  readonly subscribe: (listener: () => void) => () => void;
  readonly append: (items: readonly EventItem[]) => void;
}

function createBufferStore(): BufferStore {
  let current = EMPTY_BUFFER;
  let listeners: ReadonlySet<() => void> = new Set();
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners = new Set([...listeners, listener]);
      return () => {
        listeners = new Set([...listeners].filter((l) => l !== listener));
      };
    },
    append: (items) => {
      const next = appendEvents(current, items);
      if (next === current) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

/** A session's events: replayed from the start, then live, each id once. */
export function useSessionEvents(sessionId: string): EventBuffer {
  const feed = useFeed();
  // One store per session. Were React to drop it, the effect below replays into the new one from 0.
  const store = useMemo(() => createBufferStore(), [sessionId]);
  useEffect(
    () => feed.subscribeEvents(sessionId, store.append, store.get().lastId),
    [feed, sessionId, store],
  );
  return useSyncExternalStore(store.subscribe, store.get);
}
