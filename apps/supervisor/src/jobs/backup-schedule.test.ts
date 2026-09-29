import { err, FakeClock, ok } from "@bayon/core";
import { expect, test } from "vitest";
import {
  createBackupScheduler,
  nextSlotAfter,
  slotAtOrBefore,
} from "./backup-schedule.js";
import {
  DEFAULT_BACKUP_SETTINGS,
  type BackupSettings,
} from "./backup-settings.js";

// The nightly schedule on a fake clock: no sleeps, time moves only when a test says.
const H = 3_600_000;
const DAY = 24 * H;
const D0 = Date.UTC(2026, 8, 14);
const YESTERDAY_AT_3 = D0 - DAY + 3 * H;

/** Lets the scheduler's async tick run to its next wait. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

function harness(
  start: number,
  o: {
    settings?: Partial<BackupSettings>;
    attempts?: readonly number[];
    failFirstLoad?: boolean;
  } = {},
) {
  const clock = new FakeClock(start);
  const runs: number[] = [];
  const errors: unknown[] = [];
  let settings: BackupSettings = { ...DEFAULT_BACKUP_SETTINGS, ...o.settings };
  let failLoad = o.failFirstLoad === true;
  const scheduler = createBackupScheduler({
    clock,
    loadSettings: async () => {
      if (!failLoad) return ok(settings);
      failLoad = false;
      return err({ class: "db_busy", message: "busy", retryable: true });
    },
    attemptedSince: async (slot) =>
      ok([...(o.attempts ?? []), ...runs].some((at) => at >= slot)),
    run: async () => {
      runs.push(clock.now());
    },
    onError: (e) => errors.push(e),
  });
  return {
    clock,
    runs,
    errors,
    scheduler,
    set: (s: Partial<BackupSettings>) => {
      settings = { ...settings, ...s };
    },
  };
}

test("slots are backup.at_utc_hour:00 UTC", () => {
  expect(slotAtOrBefore(D0 + 2 * H, 3)).toBe(YESTERDAY_AT_3);
  expect(slotAtOrBefore(D0 + 3 * H, 3)).toBe(D0 + 3 * H);
  expect(slotAtOrBefore(D0 + 5 * H, 3)).toBe(D0 + 3 * H);
  expect(slotAtOrBefore(D0, 0)).toBe(D0);
  expect(nextSlotAfter(D0 + 2 * H, 3)).toBe(D0 + 3 * H);
  expect(nextSlotAfter(D0 + 3 * H, 3)).toBe(D0 + DAY + 3 * H);
  expect(nextSlotAfter(D0 + 23 * H, 23)).toBe(D0 + DAY + 23 * H);
});

test("runs at 03:00 UTC, once a night", async () => {
  const h = harness(D0 + H, { attempts: [YESTERDAY_AT_3] });
  h.scheduler.start();
  await settle();
  expect(h.runs).toEqual([]);
  await h.clock.advance(2 * H);
  expect(h.runs).toEqual([D0 + 3 * H]);
  await h.clock.advance(DAY);
  expect(h.runs).toEqual([D0 + 3 * H, D0 + DAY + 3 * H]);
  await h.scheduler.stop();
});

test("a missed night is caught up once at start, and not again after a restart", async () => {
  const first = harness(D0 + 5 * H, { attempts: [YESTERDAY_AT_3] });
  first.scheduler.start();
  await settle();
  expect(first.runs).toEqual([D0 + 5 * H]);
  await first.clock.advance(3 * H);
  expect(first.runs).toEqual([D0 + 5 * H]);
  await first.scheduler.stop();

  const restarted = harness(D0 + 9 * H, { attempts: first.runs });
  restarted.scheduler.start();
  await settle();
  await restarted.clock.advance(2 * H);
  expect(restarted.runs).toEqual([]);
  await restarted.scheduler.stop();
});

test("backup.enabled = 0 never runs; enabling it is seen within the recheck", async () => {
  const h = harness(D0 + H, {
    settings: { "backup.enabled": 0 },
    attempts: [YESTERDAY_AT_3],
  });
  h.scheduler.start();
  await settle();
  await h.clock.advance(4 * H);
  expect(h.runs).toEqual([]);
  h.set({ "backup.enabled": 1 });
  await h.clock.advance(H);
  expect(h.runs).toEqual([D0 + 6 * H]);
  await h.scheduler.stop();
});

test("a changed hour applies from the next tick", async () => {
  const h = harness(D0 + H, { attempts: [YESTERDAY_AT_3] });
  h.scheduler.start();
  await settle();
  h.set({ "backup.at_utc_hour": 2 });
  await h.clock.advance(H);
  expect(h.runs).toEqual([D0 + 2 * H]);
  await h.clock.advance(2 * H);
  expect(h.runs).toEqual([D0 + 2 * H]);
  await h.scheduler.stop();
});

test("a settings error is reported and retried at the recheck; stop ends the loop", async () => {
  const h = harness(D0 + 5 * H, {
    attempts: [YESTERDAY_AT_3],
    failFirstLoad: true,
  });
  h.scheduler.start();
  await settle();
  expect(h.errors).toHaveLength(1);
  expect(h.runs).toEqual([]);
  await h.clock.advance(H);
  expect(h.runs).toEqual([D0 + 6 * H]);
  await h.scheduler.stop();
  await h.clock.advance(3 * DAY);
  expect(h.runs).toEqual([D0 + 6 * H]);
});
