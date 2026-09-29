import type { EventItem } from "@bayon/proto";

/** A session's events so far, ascending by id; `lastId` is the cursor to resubscribe from. */
export interface EventBuffer {
  readonly items: readonly EventItem[];
  readonly lastId: number;
}

export const EMPTY_BUFFER: EventBuffer = { items: [], lastId: 0 };

/**
 * The buffer with `incoming` appended. Ids are strictly increasing (contract 7), so an id at or
 * below `lastId` is a replay — after a reconnect, a resync or a remount — and is dropped. Returns
 * `buffer` itself when nothing is new.
 */
export function appendEvents(
  buffer: EventBuffer,
  incoming: readonly EventItem[],
): EventBuffer {
  const fresh = [...incoming]
    .sort((a, b) => a.id - b.id)
    .filter(
      (item, i, sorted) =>
        item.id > buffer.lastId && item.id !== sorted[i - 1]?.id,
    );
  const last = fresh.at(-1);
  return last === undefined
    ? buffer
    : { items: [...buffer.items, ...fresh], lastId: last.id };
}
