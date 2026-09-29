import { describe, expect, test } from "vitest";
import {
  EMPTY_BUFFER,
  appendEvents,
  type EventBuffer,
} from "@/feed/event-buffer";
import { text } from "@/test/fixtures";

const ids = (buffer: EventBuffer) => buffer.items.map((item) => item.id);

describe("appendEvents", () => {
  test("appends in id order and advances lastId", () => {
    const buffer = appendEvents(EMPTY_BUFFER, [text(1), text(2)]);
    expect(ids(buffer)).toEqual([1, 2]);
    expect(buffer.lastId).toBe(2);
  });

  test("a batch replayed after a reconnect adds only the new ids", () => {
    const first = appendEvents(EMPTY_BUFFER, [text(1), text(2), text(3)]);
    const replayed = appendEvents(first, [
      text(1),
      text(2),
      text(3),
      text(4),
      text(5),
    ]);
    expect(ids(replayed)).toEqual([1, 2, 3, 4, 5]);
    expect(replayed.lastId).toBe(5);
  });

  test("duplicates and disorder inside one batch are dropped and sorted", () => {
    const buffer = appendEvents(EMPTY_BUFFER, [
      text(3),
      text(1),
      text(3),
      text(2),
    ]);
    expect(ids(buffer)).toEqual([1, 2, 3]);
  });

  test("nothing new returns the same buffer, so nothing re-renders", () => {
    const buffer = appendEvents(EMPTY_BUFFER, [text(1)]);
    expect(appendEvents(buffer, [text(1)])).toBe(buffer);
    expect(appendEvents(buffer, [])).toBe(buffer);
  });

  test("never mutates the buffer or the batch", () => {
    const buffer = appendEvents(EMPTY_BUFFER, [text(1)]);
    const batch = [text(3), text(2)];
    appendEvents(buffer, batch);
    expect(ids(buffer)).toEqual([1]);
    expect(batch.map((item) => item.id)).toEqual([3, 2]);
  });
});
