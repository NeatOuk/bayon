// A runner whose stream ends while its exit is never reported: the session must
// not stay `idle` behind a queue op that waits for that exit for ever. Real fixture processes on the
// local executor; a FakeClock drives the lifecycle; cross-process waits are deadlines, never sleeps.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getEventsSince } from "@bayon/db";
import { FakeClock } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import type { RunnerAdapter } from "@bayon/runners";
import { FIXTURE_CAPS, type FixtureAdapter } from "@bayon/runners/fixture";
import { afterAll, describe, expect, test, vi } from "vitest";
import { CMD } from "./testing/fixtures.js";
import {
  GRACE,
  T0,
  WAIT,
  driveUntil,
  killMidRun,
  processWorld,
  session,
  spawnRunning,
  withheld as hungExit,
  worldRows,
} from "./testing/process-gone-world.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function setup(adapter: (base: FixtureAdapter) => RunnerAdapter) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedRows(t.db, worldRows()));
  const w = await processWorld({
    adapter,
    db: t.db,
    clock,
    cleanupDb: t.cleanup,
  });
  cleanups.push(w.cleanup);
  return w;
}

describe("a runner exit that is never reported", { timeout: 30_000 }, () => {
  test("mid-run: the exit op gives up after its grace, and one reconciler pass adopts the session", async () => {
    const h = await setup((base) => hungExit(base));
    await spawnRunning(h, "A");
    const before = await killMidRun(h, "A");
    await driveUntil(h, h.lifecycle.reconcile());
    await driveUntil(h, h.lifecycle.settled());
    const after = await session(h.db, "A");
    expect(after.state).toBe("idle");
    expect(after.executor_ref).not.toBe(before);
    expect(await h.executor.probe(after.executor_ref ?? "")).toBe("alive");
    expect(h.slots.capacity().used).toBe(1);
    expect(h.logs.map((l) => l.msg)).toContain(
      "the runner's stream ended but its exit was not reported: going on without it",
    );
  });

  test("mid-run, not resumable: one pass ends it exited(error) and frees its slot", async () => {
    const h = await setup((base) =>
      hungExit(base, {
        caps: () => ({ ...FIXTURE_CAPS, resumable: false }),
      }),
    );
    await spawnRunning(h, "N");
    await killMidRun(h, "N");
    await driveUntil(h, h.lifecycle.reconcile());
    await driveUntil(h, h.lifecycle.settled());
    expect(await session(h.db, "N")).toMatchObject({
      state: "exited",
      exit_reason: "error",
      error_class: "runner_exited_without_terminal",
    });
    expect(h.slots.capacity().used).toBe(0);
  });

  test("stop after the exit: the session ends, with no reconciler pass", async () => {
    const h = await setup((base) => hungExit(base));
    await spawnRunning(h, "S");
    await killMidRun(h, "S");
    unwrap(
      await h.lifecycle.handlers.stop.handle(
        { session_id: "S", mode: "graceful" },
        CMD,
      ),
    );
    await driveUntil(h, h.lifecycle.settled());
    expect(await session(h.db, "S")).toMatchObject({
      state: "exited",
      exit_reason: "killed",
    });
    expect(h.slots.capacity().used).toBe(0);
  });

  test("its queue held: the periodic pass still ends, declares the missed exit, and the session is adopted once the queue frees", async () => {
    const hold = Promise.withResolvers<undefined>();
    const h = await setup((base) => hungExit(base, { hold: hold.promise }));
    await spawnRunning(h, "Q");
    const before = await killMidRun(h, "Q");
    // Past the longest an exit op may take: the missed exit is the pass's to notice.
    await h.clock.advance(4 * GRACE + 10_000);
    await driveUntil(h, h.lifecycle.reconcile());
    expect(h.logs.map((l) => l.msg)).toContain(
      "its stream ended but no exit op took it: marked dead for this pass",
    );
    expect(h.logs.map((l) => l.msg)).toContain(
      "reconciler: the session's queue is still busy; the pass goes on without it",
    );
    hold.resolve(undefined);
    await driveUntil(h, h.lifecycle.settled());
    const after = await session(h.db, "Q");
    expect(after.state).toBe("idle");
    expect(after.executor_ref).not.toBe(before);
    expect(await h.executor.probe(after.executor_ref ?? "")).toBe("alive");
  });
});

describe("the exit record beside the raw log", { timeout: 30_000 }, () => {
  test("a runner killed mid-run leaves its signal in stderr.log, and nothing of it in events", async () => {
    const h = await setup((base) => base);
    await spawnRunning(h, "R");
    const ref = await killMidRun(h, "R");
    const raw = (await session(h.db, "R")).raw_log_path ?? "";
    const file = join(dirname(raw), "stderr.log");
    await vi.waitFor(() => {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain(
        `process ${ref} exited: code=- signal=SIGKILL`,
      );
    }, WAIT);
    const events = unwrap(
      await getEventsSince(h.db, { sessionId: "R", since: 0, limit: 100 }),
    ).rows;
    expect(events.some((e) => (e.payload_json ?? "").includes("stderr"))).toBe(
      false,
    );
  });
});
