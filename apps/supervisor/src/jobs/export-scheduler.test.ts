import { FakeClock } from "@bayon/core";
import { expect, test } from "vitest";
import { createExportScheduler } from "./export-scheduler.js";

test("ticks once per interval, driven by the injected clock, no sleeps", async () => {
  const clock = new FakeClock(0);
  let ticks = 0;
  const scheduler = createExportScheduler({
    clock,
    intervalMs: 1_000,
    tick: async () => {
      ticks += 1;
    },
  });
  scheduler.start();
  expect(ticks).toBe(0); // nothing before the first interval elapses

  await clock.advance(1_000);
  expect(ticks).toBe(1);

  await clock.advance(2_000);
  expect(ticks).toBe(3);

  scheduler.stop();
  await clock.advance(10_000);
  expect(ticks).toBe(3); // stopped: no more ticks
});

test("intervalMs <= 0 means off: start() never ticks", async () => {
  const clock = new FakeClock(0);
  let ticks = 0;
  const scheduler = createExportScheduler({
    clock,
    intervalMs: 0,
    tick: async () => {
      ticks += 1;
    },
  });
  scheduler.start();
  await clock.advance(1_000_000);
  expect(ticks).toBe(0);
});

test("a throwing tick is caught and reported, and the loop keeps going", async () => {
  const clock = new FakeClock(0);
  let ticks = 0;
  const errors: unknown[] = [];
  const scheduler = createExportScheduler({
    clock,
    intervalMs: 100,
    tick: async () => {
      ticks += 1;
      throw new Error("boom");
    },
    onError: (e) => errors.push(e),
  });
  scheduler.start();
  await clock.advance(300);
  expect(ticks).toBe(3);
  expect(errors).toHaveLength(3);
});

test("start() is idempotent: calling it twice does not double the tick rate", async () => {
  const clock = new FakeClock(0);
  let ticks = 0;
  const scheduler = createExportScheduler({
    clock,
    intervalMs: 100,
    tick: async () => {
      ticks += 1;
    },
  });
  scheduler.start();
  scheduler.start();
  await clock.advance(100);
  expect(ticks).toBe(1);
});
