import type { EventItem, OnEvents } from "@bayon/proto";

// One session's events as a cursor client delivers them (contract 7), kept in arrival order, with
// promises for "once the events so far satisfy this".

/** The part of CursorClient a follower uses. */
export interface EventSource {
  subscribeEvents(sessionId: string, on: OnEvents, since?: number): () => void;
}

export interface Follower {
  /** Every event received so far, in arrival order. */
  items(): readonly EventItem[];
  /** Resolves with the events once `done(events)` holds; at once if it already does. */
  until(
    done: (items: readonly EventItem[]) => boolean,
  ): Promise<readonly EventItem[]>;
  stop(): void;
}

interface Waiter {
  readonly done: (items: readonly EventItem[]) => boolean;
  readonly resolve: (items: readonly EventItem[]) => void;
}

export function follow(
  source: EventSource,
  sessionId: string,
  since = 0,
): Follower {
  let items: readonly EventItem[] = [];
  let waiters: readonly Waiter[] = [];
  const stop = source.subscribeEvents(
    sessionId,
    (batch) => {
      items = [...items, ...batch];
      const ready = waiters.filter((w) => w.done(items));
      waiters = waiters.filter((w) => !ready.includes(w));
      for (const w of ready) w.resolve(items);
    },
    since,
  );
  return {
    items: () => items,
    until: (done) =>
      done(items)
        ? Promise.resolve(items)
        : new Promise((resolve) => {
            waiters = [...waiters, { done, resolve }];
          }),
    stop,
  };
}

export const kinds = (items: readonly EventItem[]): string[] =>
  items.map((item) => item.kind);

export const ids = (items: readonly EventItem[]): number[] =>
  items.map((item) => item.id);

/** Whether the follower has received up to id `last`: the check before comparing against stored ids. */
export const reached =
  (last: number) =>
  (items: readonly EventItem[]): boolean =>
    (ids(items).at(-1) ?? 0) >= last;

export const hasKind =
  (kind: string) =>
  (items: readonly EventItem[]): boolean =>
    items.some((item) => item.kind === kind);

/** The first terminal event, if any. */
export function terminalOf(items: readonly EventItem[]) {
  for (const item of items) if (item.kind === "terminal") return item;
  return undefined;
}
