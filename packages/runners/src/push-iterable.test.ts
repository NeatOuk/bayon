import { expect, test } from "vitest";
import { createPushIterable } from "./push-iterable.js";
import { RunTracker } from "./run-tracker.js";

test("a push iterable yields pushed values in order and ends after end()", async () => {
  const stream = createPushIterable<number>();
  const taken: number[] = [];
  const reading = (async () => {
    for await (const n of stream) taken.push(n);
  })();
  expect(stream.push(1)).toBe(true);
  expect(stream.push(2)).toBe(true);
  stream.end();
  expect(stream.ended).toBe(true);
  expect(stream.push(3)).toBe(false);
  await reading;
  expect(taken).toEqual([1, 2]);
});

test("a run tracker reports the open run and wakes waiters when it ends", async () => {
  const run = new RunTracker();
  await run.whenEnded(); // nothing open: resolves at once
  run.opened();
  expect(run.open).toBe(true);
  const waiting = run.whenEnded();
  run.ended();
  await waiting;
  expect(run.open).toBe(false);
});
