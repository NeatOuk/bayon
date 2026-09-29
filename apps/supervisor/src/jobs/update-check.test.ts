import { FakeClock, err, ok, type Result } from "@bayon/core";
import { openRunnerUpdates } from "@bayon/db";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "@bayon/db/testing";
import type { RunnerAdapter, RunnerUpdate } from "@bayon/runners";
import { afterAll, expect, test } from "vitest";
import {
  loadUpdateCheckHours,
  runUpdateCheckPass,
  UPDATE_CHECK_TIMEOUT_MS,
} from "./update-check.js";

// runUpdateCheckPass and boundedCheck, against a real temp DB with fake adapters: a
// fake fetch never leaves this file, and a fake clock drives the 10 s bound with no real sleep.

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

async function freshDb(clock: FakeClock) {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 51));
  return t.db;
}

const noopLog = { warn: () => undefined } as unknown as {
  warn: (o: unknown, msg: string) => void;
};

/** A minimal adapter: only `id` and `updateCheck` matter to this job. */
function adapter(
  id: string,
  updateCheck: RunnerAdapter["updateCheck"],
): RunnerAdapter {
  return { id, updateCheck } as unknown as RunnerAdapter;
}

const ok_ = (u: RunnerUpdate) => async (): Promise<Result<RunnerUpdate>> =>
  ok(u);

test("a good check is recorded with newer computed from compareVersions", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const db = await freshDb(clock);
  const adapters = new Map([
    [
      SPINE_SEED.runnerId,
      adapter(
        SPINE_SEED.runnerId,
        ok_({ current: "0.3.283", latest: "0.3.290" }),
      ),
    ],
  ]);
  await runUpdateCheckPass({
    db,
    clock,
    adapters,
    log: noopLog as never,
    signal: new AbortController().signal,
  });
  const open = unwrap(await openRunnerUpdates(db));
  expect(open).toEqual([
    expect.objectContaining({
      runner_id: SPINE_SEED.runnerId,
      current: "0.3.283",
      latest: "0.3.290",
    }),
  ]);
});

test("an adapter with no updateCheck is skipped silently; one failure does not stop the others", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const db = await freshDb(clock);
  const warned: unknown[] = [];
  const log = { warn: (o: unknown) => warned.push(o) };
  const adapters = new Map<string, RunnerAdapter>([
    ["no-check", adapter("no-check", undefined)],
    [
      "failing",
      adapter("failing", async () =>
        err({ class: "runner_error", message: "npm down", retryable: false }),
      ),
    ],
    [
      SPINE_SEED.runnerId,
      adapter(SPINE_SEED.runnerId, ok_({ current: "1.0.0", latest: "1.0.0" })),
    ],
  ]);
  await runUpdateCheckPass({
    db,
    clock,
    adapters,
    log: log as never,
    signal: new AbortController().signal,
  });
  expect(warned).toHaveLength(1);
  // newer=0 rows do not open, but they were still recorded (not skipped).
  expect(unwrap(await openRunnerUpdates(db))).toEqual([]);
});

test("a check that never answers is abandoned at the timeout, on the injected clock", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const db = await freshDb(clock);
  const warned: unknown[] = [];
  const log = { warn: (o: unknown) => warned.push(o) };
  const adapters = new Map([
    [
      SPINE_SEED.runnerId,
      adapter(SPINE_SEED.runnerId, () => new Promise(() => undefined)),
    ],
  ]);
  const passed = runUpdateCheckPass({
    db,
    clock,
    adapters,
    log: log as never,
    signal: new AbortController().signal,
  });
  await clock.advance(UPDATE_CHECK_TIMEOUT_MS);
  await passed;
  expect(warned).toHaveLength(1);
  expect((warned[0] as { error: { class: string } }).error.class).toBe(
    "timeout",
  );
});

test("stop()'s signal aborts a check in flight", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const db = await freshDb(clock);
  const warned: unknown[] = [];
  const log = { warn: (o: unknown) => warned.push(o) };
  const controller = new AbortController();
  const adapters = new Map([
    [
      SPINE_SEED.runnerId,
      adapter(SPINE_SEED.runnerId, (io) => {
        return new Promise((_resolve, reject) => {
          io.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      }),
    ],
  ]);
  const passed = runUpdateCheckPass({
    db,
    clock,
    adapters,
    log: log as never,
    signal: controller.signal,
  });
  controller.abort();
  await passed;
  expect(warned).toHaveLength(1);
});

test("loadUpdateCheckHours reads the seeded default", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const db = await freshDb(clock);
  expect(unwrap(await loadUpdateCheckHours(db))).toBe(24);
});
