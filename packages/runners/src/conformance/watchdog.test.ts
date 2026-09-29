import { FakeClock, newId, type Result } from "@bayon/core";
import { FakeExecutor } from "@bayon/executors/testing";
import { describe, expect, test } from "vitest";
import type { RunnerAdapter, SessionHandle } from "../adapter.js";
import { createMemoryIngest } from "./memory-ingest.js";
import { createReferenceWatchdog } from "./watchdog.js";

/** Lets pending continuations run between clock moves. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const never = <T>() => new Promise<T>(() => undefined);

function harness(o: {
  readonly interrupt?: () => Promise<Result<void>>;
  readonly stop?: () => Promise<void>;
}) {
  const clock = new FakeClock(0);
  const ingest = createMemoryIngest({ clock });
  const calls: string[] = [];
  // Only what the watchdog touches; the rest of the contract is irrelevant here.
  const adapter = {
    interrupt: () => {
      calls.push("interrupt");
      return o.interrupt?.() ?? Promise.resolve({ ok: true, value: undefined });
    },
    stop: (_h: SessionHandle, mode: string) => {
      calls.push(`stop:${mode}`);
      return o.stop?.() ?? Promise.resolve();
    },
  } as unknown as RunnerAdapter;
  const cleaned: string[] = [];
  const executor = new FakeExecutor({ programs: {} });
  executor.cleanup = async (ref, mode) => {
    cleaned.push(`${ref}:${mode}`);
  };
  const handle: SessionHandle = {
    sessionId: "s1",
    executorRef: "fake:1",
    exited: never(),
  };
  const watchdog = createReferenceWatchdog({
    clock,
    ingest,
    graceMs: 100,
    stopMs: 200,
  });
  return { clock, ingest, calls, cleaned, executor, handle, adapter, watchdog };
}

describe("the reference watchdog (§5.2)", () => {
  test("a terminal inside the wall clock wins, and nothing is torn down", async () => {
    const h = harness({});
    const runId = newId();
    await h.ingest.openRun("s1", runId);
    const watching = h.watchdog.watch({
      sessionId: "s1",
      runId,
      handle: h.handle,
      adapter: h.adapter,
      executor: h.executor,
      wallClockMs: 1_000,
    });
    await h.ingest.closeRun("s1", runId, {
      outcome: "interrupted",
      errorClass: "interrupted",
      message: "done",
    });
    expect(await watching).toEqual({ by: "terminal", outcome: "interrupted" });
    await h.clock.advance(5_000);
    expect(h.calls).toEqual([]);
  });

  test("no terminal: onFire, the timeout verdict, then interrupt and stop(kill)", async () => {
    const h = harness({});
    const runId = newId();
    await h.ingest.openRun("s1", runId);
    const order: string[] = [];
    const watching = h.watchdog.watch({
      sessionId: "s1",
      runId,
      handle: h.handle,
      adapter: h.adapter,
      executor: h.executor,
      wallClockMs: 1_000,
      onFire: async () => {
        order.push(`fire@${h.clock.now()}`);
        order.push(`events:${(await h.ingest.events("s1")).length}`);
      },
    });
    await h.clock.advance(1_000);
    const result = await watching;
    expect(result).toEqual({
      by: "watchdog",
      outcome: "timeout",
      firedAt: 1_000,
    });
    expect(order).toEqual(["fire@1000", "events:0"]);
    expect(h.calls).toEqual(["interrupt", "stop:kill"]);
    const events = await h.ingest.events("s1");
    expect(events).toEqual([
      expect.objectContaining({ kind: "terminal", source: "supervisor" }),
    ]);
    expect(h.cleaned).toEqual([]);
  });

  test("a timer that fires early by the clock never fires the watchdog before its wall clock", async () => {
    const h = harness({});
    // A system timer armed from a stale loop time: it resolves a millisecond short of `ms`.
    const early = createReferenceWatchdog({
      clock: {
        now: () => h.clock.now(),
        after: (ms, signal) => h.clock.after(Math.max(1, ms - 1), signal),
      },
      ingest: h.ingest,
      graceMs: 100,
      stopMs: 200,
    });
    const runId = newId();
    await h.ingest.openRun("s1", runId);
    const watching = early.watch({
      sessionId: "s1",
      runId,
      handle: h.handle,
      adapter: h.adapter,
      executor: h.executor,
      wallClockMs: 1_000,
    });
    await h.clock.advance(999);
    await tick();
    expect(h.calls).toEqual([]);
    await h.clock.advance(1);
    expect(await watching).toEqual({
      by: "watchdog",
      outcome: "timeout",
      firedAt: 1_000,
    });
  });

  test("an interrupt that never settles is bounded by graceMs", async () => {
    const h = harness({ interrupt: never });
    const runId = newId();
    await h.ingest.openRun("s1", runId);
    const watching = h.watchdog.watch({
      sessionId: "s1",
      runId,
      handle: h.handle,
      adapter: h.adapter,
      executor: h.executor,
      wallClockMs: 50,
    });
    await h.clock.advance(50);
    await tick();
    expect(h.calls).toEqual(["interrupt"]);
    await h.clock.advance(100);
    await tick();
    expect(h.calls).toEqual(["interrupt", "stop:kill"]);
    expect((await watching).by).toBe("watchdog");
  });

  test("a stop that never settles falls back to the executor's hard cleanup", async () => {
    const h = harness({ stop: never });
    const runId = newId();
    await h.ingest.openRun("s1", runId);
    const watching = h.watchdog.watch({
      sessionId: "s1",
      runId,
      handle: h.handle,
      adapter: h.adapter,
      executor: h.executor,
      wallClockMs: 50,
    });
    await h.clock.advance(50);
    await tick();
    await h.clock.advance(200);
    await tick();
    expect((await watching).outcome).toBe("timeout");
    expect(h.cleaned).toEqual(["fake:1:hard"]);
  });
});
