import { FakeClock } from "@bayon/core";
import { expect, test } from "vitest";
import { SessionRate } from "./rate.js";

test("a session gets `calls` per window; the next is refused until the window moves", async () => {
  const clock = new FakeClock(0);
  const rate = new SessionRate({ calls: 3, windowMs: 1_000, clock });
  expect([1, 2, 3, 4].map(() => rate.take("S"))).toEqual([
    true,
    true,
    true,
    false,
  ]);
  await clock.advance(1_001);
  expect(rate.take("S")).toBe(true);
});

test("each session has its own budget", () => {
  const rate = new SessionRate({
    calls: 1,
    windowMs: 1_000,
    clock: new FakeClock(0),
  });
  expect(rate.take("A")).toBe(true);
  expect(rate.take("A")).toBe(false);
  expect(rate.take("B")).toBe(true);
});

test("a refused call uses no budget: the window frees as the oldest call ages out", async () => {
  const clock = new FakeClock(0);
  const rate = new SessionRate({ calls: 2, windowMs: 1_000, clock });
  expect(rate.take("A")).toBe(true);
  await clock.advance(500);
  expect(rate.take("A")).toBe(true);
  expect(rate.take("A")).toBe(false);
  await clock.advance(501);
  expect(rate.take("A")).toBe(true);
  expect(rate.take("A")).toBe(false);
});

test("sessions with no call in a window are evicted: an ended one never lingers", async () => {
  const clock = new FakeClock(0);
  const rate = new SessionRate({ calls: 5, windowMs: 1_000, clock });
  rate.take("ended-1");
  rate.take("ended-2");
  expect(rate.tracked).toBe(2);
  await clock.advance(1_001);
  rate.take("live");
  expect(rate.tracked).toBe(1);
  // Back after an idle window, a session starts with a full budget.
  expect(rate.take("ended-1")).toBe(true);
  expect(rate.tracked).toBe(2);
});
