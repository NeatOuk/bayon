import { FakeClock } from "@bayon/core";
import {
  CursorClient,
  sessionEventsTopic,
  type EventItem,
  type ServerFrame,
} from "@bayon/proto";
import { act, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Feed } from "@/feed/feed";
import { FakeSocket } from "@/test/fake-socket";
import { text } from "@/test/fixtures";
import { renderWithProviders, silentFeed } from "@/test/render";
import { Timeline } from "@/timeline/timeline";

const TOPIC = sessionEventsTopic("s1");
const frame = (items: EventItem[]): ServerFrame => ({
  type: "events",
  topic: TOPIC,
  cursor: items.at(-1)?.id ?? 0,
  items,
});
const rowIds = () =>
  screen.queryAllByTestId("event-row").map((r) => Number(r.dataset.eventId));

test("a reconnect resubscribes from the last id and adds no duplicate rows", async () => {
  const clock = new FakeClock(0);
  let sockets: readonly FakeSocket[] = [];
  const socket = (i: number): FakeSocket => {
    const found = sockets[i];
    if (!found) throw new Error(`socket ${i} was never opened`);
    return found;
  };
  const client = new CursorClient({
    connect: () => {
      const created = new FakeSocket();
      sockets = [...sockets, created];
      return created;
    },
    clock,
    reconnect: { initialMs: 10, maxMs: 10 },
    onError: () => undefined,
  });
  renderWithProviders(<Timeline sessionId="s1" />, { feed: client });

  act(() => socket(0).open());
  expect(socket(0).sent).toContainEqual({
    type: "subscribe",
    topic: TOPIC,
    since: 0,
  });
  act(() => socket(0).receive(frame([text(1), text(2), text(3)])));
  expect(rowIds()).toEqual([1, 2, 3]);

  act(() => socket(0).drop());
  await act(() => clock.advance(10));
  act(() => socket(1).open());
  expect(socket(1).sent).toContainEqual({
    type: "subscribe",
    topic: TOPIC,
    since: 3,
  });
  // A server that replays from the start anyway: nothing may appear twice.
  act(() =>
    socket(1).receive(frame([text(1), text(2), text(3), text(4), text(5)])),
  );
  expect(rowIds()).toEqual([1, 2, 3, 4, 5]);
  client.close();
});

test("the event buffer dedupes a feed that delivers the same events twice", () => {
  const feed: Feed = {
    ...silentFeed,
    subscribeEvents: (_sessionId, on) => {
      on([text(1), text(2), text(3)], 3);
      on([text(2), text(3), text(4)], 4);
      return () => undefined;
    },
  };
  renderWithProviders(<Timeline sessionId="s1" />, { feed });
  expect(rowIds()).toEqual([1, 2, 3, 4]);
});
