import type { EventItem, OnEvents } from "@bayon/proto";
import { expect, test } from "vitest";
import {
  follow,
  hasKind,
  ids,
  kinds,
  reached,
  terminalOf,
  type EventSource,
} from "./follow.js";

/** A source the test drives by hand. */
function fakeSource() {
  let on: OnEvents | undefined;
  const calls: { sessionId: string; since: number | undefined }[] = [];
  let stopped = 0;
  const source: EventSource = {
    subscribeEvents(sessionId, listener, since) {
      calls.push({ sessionId, since });
      on = listener;
      return () => {
        stopped += 1;
      };
    },
  };
  const push = (...items: EventItem[]) => on?.(items, items.at(-1)?.id ?? 0);
  return { source, push, calls, stopped: () => stopped };
}

const event = (
  id: number,
  kind: "turn_start" | "turn_end" = "turn_start",
): EventItem => ({
  id,
  kind,
  ts: 1,
  runner_type: "smoke.step",
  payload:
    kind === "turn_end"
      ? {
          usage: {
            tokens_in: 1,
            tokens_out: 1,
            tokens_cache_read: 0,
            tokens_cache_write: 0,
          },
        }
      : {},
});
const terminal: EventItem = {
  id: 9,
  kind: "terminal",
  ts: 1,
  runner_type: "smoke.terminal",
  payload: { outcome: "ok" },
};

test("follow subscribes from `since` and keeps events in arrival order", () => {
  const s = fakeSource();
  const f = follow(s.source, "s1", 4);
  expect(s.calls).toEqual([{ sessionId: "s1", since: 4 }]);
  s.push(event(5), event(6));
  s.push(event(7, "turn_end"));
  expect(ids(f.items())).toEqual([5, 6, 7]);
  expect(kinds(f.items())).toEqual(["turn_start", "turn_start", "turn_end"]);
  f.stop();
  expect(s.stopped()).toBe(1);
});

test("until resolves once the events satisfy it, or at once if they already do", async () => {
  const s = fakeSource();
  const f = follow(s.source, "s1");
  const ended = f.until(hasKind("terminal"));
  const turned = f.until(hasKind("turn_start"));
  s.push(event(1));
  expect(ids(await turned)).toEqual([1]);
  s.push(event(2), terminal);
  expect(ids(await ended)).toEqual([1, 2, 9]);
  expect(ids(await f.until(hasKind("turn_start")))).toEqual([1, 2, 9]);
});

test("reached waits for frames a runner emits after its terminal", async () => {
  const s = fakeSource();
  const f = follow(s.source, "s1");
  s.push(event(1), terminal);
  // stored ids end at 10: one frame arrives after the terminal (Invariant 4 keeps it)
  expect(reached(10)(f.items())).toBe(false);
  const caughtUp = f.until(reached(10));
  s.push(event(10));
  expect(ids(await caughtUp)).toEqual([1, 9, 10]);
  expect(reached(10)(f.items())).toBe(true);
  expect(reached(0)([])).toBe(true);
});

test("terminalOf finds the first terminal", () => {
  expect(terminalOf([event(1), terminal])?.payload.outcome).toBe("ok");
  expect(terminalOf([event(1)])).toBeUndefined();
});
