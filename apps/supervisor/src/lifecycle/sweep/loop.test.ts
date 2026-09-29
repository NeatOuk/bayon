import { FakeClock } from "@bayon/core";
import { describe, expect, test } from "vitest";
import { createSweepLoop, type Cadence } from "./loop.js";

// The sweep's own loop under a fake clock: the first pass at start,
// the next recheck_ms after the last ended, no overlap, requestPass coalesced behind a minimum gap,
// stop waiting for a running pass.
const CADENCE: Cadence = { recheckMs: 1_000, minGapMs: 100 };

function rig() {
  const clock = new FakeClock(0);
  const starts: number[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const errors: unknown[] = [];
  let throwNext = false;
  const loop = createSweepLoop({
    clock,
    runPass: async () => {
      starts.push(clock.now());
      if (throwNext) {
        throwNext = false;
        throw new Error("boom");
      }
      if (hold) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return CADENCE;
    },
    onError: (e) => errors.push(e),
  });
  return {
    clock,
    loop,
    starts,
    errors,
    holdNext() {
      hold = true;
    },
    release() {
      hold = false;
      release?.();
      release = null;
    },
    failNext() {
      throwNext = true;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the sweep loop", () => {
  test("the first pass at start, then one every recheck_ms after the last ended; start is idempotent", async () => {
    const r = rig();
    r.loop.start();
    r.loop.start();
    await r.clock.advance(0);
    await tick();
    expect(r.starts).toEqual([0]);
    await r.clock.advance(999);
    expect(r.starts).toEqual([0]);
    await r.clock.advance(1);
    await tick();
    expect(r.starts).toEqual([0, 1_000]);
    await r.loop.stop();
  });

  test("never overlaps: requests during a pass coalesce into one, a minimum gap after it", async () => {
    const r = rig();
    r.holdNext();
    r.loop.start();
    await r.clock.advance(0);
    await tick();
    expect(r.starts).toEqual([0]);
    for (let i = 0; i < 5; i += 1) r.loop.requestPass();
    await r.clock.advance(50);
    r.release();
    await tick();
    await tick();
    expect(r.starts).toEqual([0]);
    await r.clock.advance(99);
    expect(r.starts).toEqual([0]);
    await r.clock.advance(1);
    await tick();
    expect(r.starts).toEqual([0, 150]);
    await r.loop.stop();
  });

  test("an idle request waits out the minimum gap, then runs once", async () => {
    const r = rig();
    r.loop.start();
    await r.clock.advance(0);
    await tick();
    r.loop.requestPass();
    r.loop.requestPass();
    await r.clock.advance(99);
    expect(r.starts).toEqual([0]);
    await r.clock.advance(1);
    await tick();
    expect(r.starts).toEqual([0, 100]);
    await r.clock.advance(999);
    expect(r.starts).toEqual([0, 100]);
    await r.clock.advance(1);
    await tick();
    expect(r.starts).toEqual([0, 100, 1_100]);
    await r.loop.stop();
  });

  test("a request before start runs nothing; runNow runs one after any running pass", async () => {
    const r = rig();
    r.loop.requestPass();
    await r.clock.advance(5_000);
    expect(r.starts).toEqual([]);
    await r.loop.runNow();
    expect(r.starts).toEqual([5_000]);
    await r.loop.stop();
  });

  test("a throwing pass is reported and the loop goes on at the last cadence; stop waits for the running pass and no pass follows", async () => {
    const r = rig();
    r.loop.start();
    await r.clock.advance(0);
    await tick();
    r.failNext();
    await r.clock.advance(1_000);
    await tick();
    expect(r.errors).toHaveLength(1);
    await r.clock.advance(1_000);
    await tick();
    expect(r.starts).toEqual([0, 1_000, 2_000]);
    r.holdNext();
    await r.clock.advance(1_000);
    await tick();
    let stopped = false;
    const stopping = r.loop.stop().then(() => {
      stopped = true;
    });
    await tick();
    expect(stopped).toBe(false);
    r.release();
    await stopping;
    await r.clock.advance(10_000);
    expect(r.starts).toEqual([0, 1_000, 2_000, 3_000]);
    r.loop.requestPass();
    await r.clock.advance(10_000);
    expect(r.starts).toHaveLength(4);
  });

  test("a first pass that throws leaves the default cadence: the next is an hour on", async () => {
    const r = rig();
    r.failNext();
    r.loop.start();
    await r.clock.advance(0);
    await tick();
    await r.clock.advance(3_599_999);
    expect(r.starts).toEqual([0]);
    await r.clock.advance(1);
    await tick();
    expect(r.starts).toEqual([0, 3_600_000]);
    await r.loop.stop();
  });
});
