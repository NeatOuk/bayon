import { err, FakeClock, ok } from "@bayon/core";
import { expect, test } from "vitest";
import { createUpdateCheckScheduler } from "./update-check.js";

// The scheduler alone, on a fake clock: no sleeps, no DB, no network — loadHours and
// run are injected, as createBackupScheduler's are (backup-schedule.test.ts).
const HOUR = 3_600_000;

/** Lets the scheduler's async tick run to its next wait. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

function harness(
  start: number,
  o: { hours?: number; failFirstLoad?: boolean; recheckMs?: number } = {},
) {
  const clock = new FakeClock(start);
  const runs: number[] = [];
  const errors: unknown[] = [];
  let hours = o.hours ?? 24;
  let failLoad = o.failFirstLoad === true;
  const scheduler = createUpdateCheckScheduler({
    clock,
    loadHours: async () => {
      if (!failLoad) return ok(hours);
      failLoad = false;
      return err({ class: "db_busy", message: "busy", retryable: true });
    },
    run: async () => {
      runs.push(clock.now());
    },
    onError: (e) => errors.push(e),
    ...(o.recheckMs === undefined ? {} : { recheckMs: o.recheckMs }),
  });
  return {
    clock,
    runs,
    errors,
    scheduler,
    setHours: (h: number) => {
      hours = h;
    },
  };
}

test("a pass runs at start (the boot pass), then again after the interval, never sooner", async () => {
  const h = harness(0, { hours: 24 });
  h.scheduler.start();
  await settle();
  expect(h.runs).toEqual([0]);

  await h.clock.advance(24 * HOUR - 1);
  await settle();
  expect(h.runs).toEqual([0]);

  await h.clock.advance(1);
  await settle();
  expect(h.runs).toEqual([0, 24 * HOUR]);
  await h.scheduler.stop();
});

test("0 turns the check off: nothing runs, but the setting is re-read hourly", async () => {
  const h = harness(0, { hours: 0 });
  h.scheduler.start();
  await settle();
  expect(h.runs).toEqual([]);

  await h.clock.advance(HOUR);
  await settle();
  expect(h.runs).toEqual([]);

  // Turned back on: seen within the hourly recheck, and the pass runs at once.
  h.setHours(24);
  await h.clock.advance(HOUR);
  await settle();
  expect(h.runs).toHaveLength(1);
  await h.scheduler.stop();
});

test("a failed load is reported and retried hourly; it never stops the loop", async () => {
  const h = harness(0, { hours: 24, failFirstLoad: true });
  h.scheduler.start();
  await settle();
  expect(h.runs).toEqual([]);
  expect(h.errors).toEqual([
    { class: "db_busy", message: "busy", retryable: true },
  ]);

  await h.clock.advance(HOUR);
  await settle();
  expect(h.runs).toEqual([HOUR]);
  await h.scheduler.stop();
});

test("stop() cancels the wait; a second start or stop is a no-op", async () => {
  const h = harness(0, { hours: 24 });
  h.scheduler.start();
  h.scheduler.start();
  await settle();
  expect(h.runs).toEqual([0]);
  await h.scheduler.stop();
  await h.scheduler.stop();
  await h.clock.advance(48 * HOUR);
  await settle();
  expect(h.runs).toEqual([0]);
});
