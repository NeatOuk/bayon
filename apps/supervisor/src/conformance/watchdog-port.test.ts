import { FakeClock, newId, ok } from "@bayon/core";
import { FakeExecutor } from "@bayon/executors/testing";
import type { RunnerAdapter, SessionHandle } from "@bayon/runners";
import { createMemoryIngest } from "@bayon/runners/conformance";
import { expect, test } from "vitest";
import { supervisorWatchdog } from "./watchdog-port.js";

// The supervisor's conformance watchdog (§5.2, §15 #9). The runner.conformance command certifies
// through it, so one that fires before its wall clock fails `fired_on_time` and costs a pair its
// gate eligibility: the M3 smoke saw it fire 9 ms early on a loaded host.

/** Lets pending continuations run between clock moves. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a timer that fires early by the clock never fires the watchdog before its wall clock", async () => {
  const clock = new FakeClock(0);
  const ingest = createMemoryIngest({ clock });
  const calls: string[] = [];
  // Only what the watchdog touches; the rest of the contract is irrelevant here.
  const adapter = {
    interrupt: async () => {
      calls.push("interrupt");
      return ok(undefined);
    },
    stop: async (_h: SessionHandle, mode: string) => {
      calls.push(`stop:${mode}`);
    },
  } as unknown as RunnerAdapter;
  const handle: SessionHandle = {
    sessionId: "s1",
    executorRef: "fake:1",
    exited: new Promise(() => undefined),
  };
  const watchdog = supervisorWatchdog({
    // A system timer armed from a stale loop time: it resolves a millisecond short of `ms`.
    clock: {
      now: () => clock.now(),
      after: (ms, signal) => clock.after(Math.max(1, ms - 1), signal),
    },
    ingest,
    // The run timer's verdict closes the run, as the scratch ingest's does.
    timeout: async (runId, message) => {
      await ingest.closeRun("s1", runId, {
        outcome: "timeout",
        errorClass: "timeout",
        message,
      });
      return ok(undefined);
    },
    graceMs: 100,
    stopMs: 200,
  });
  const runId = newId();
  await ingest.openRun("s1", runId);
  const watching = watchdog.watch({
    sessionId: "s1",
    runId,
    handle,
    adapter,
    executor: new FakeExecutor({ programs: {} }),
    wallClockMs: 1_000,
  });
  await clock.advance(999);
  await tick();
  expect(calls).toEqual([]);
  await clock.advance(1);
  expect(await watching).toEqual({
    by: "watchdog",
    outcome: "timeout",
    firedAt: 1_000,
  });
  expect(calls).toEqual(["interrupt", "stop:graceful"]);
});
