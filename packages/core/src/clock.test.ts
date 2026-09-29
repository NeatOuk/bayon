import { describe, expect, test } from "vitest";
import { FakeClock, systemClock } from "./clock.js";

describe("FakeClock", () => {
  test("starts at the given time and only moves on advance", async () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    await clock.advance(250);
    expect(clock.now()).toBe(1_250);
    expect(new FakeClock().now()).toBe(0);
  });

  test("a timer resolves only once its due time is reached", async () => {
    const clock = new FakeClock();
    let fired = false;
    const done = clock.after(100).then(() => (fired = true));
    await clock.advance(99);
    expect(fired).toBe(false);
    await clock.advance(1);
    await done;
    expect(fired).toBe(true);
  });

  test("timers fire in due order, ties in arming order, at their due time", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const arm = (name: string, ms: number) =>
      clock.after(ms).then(() => log.push(`${name}@${clock.now()}`));
    const all = Promise.all([
      arm("c", 30),
      arm("a", 10),
      arm("b1", 20),
      arm("b2", 20),
    ]);
    await clock.advance(30);
    await all;
    expect(log).toEqual(["a@10", "b1@20", "b2@20", "c@30"]);
  });

  test("a continuation can arm the next timer within one advance", async () => {
    const clock = new FakeClock();
    const ticks: number[] = [];
    const loop = (async () => {
      for (let i = 0; i < 3; i++) {
        await clock.after(100);
        ticks.push(clock.now());
      }
    })();
    await clock.advance(1_000);
    await loop;
    expect(ticks).toEqual([100, 200, 300]);
    expect(clock.now()).toBe(1_000);
  });

  test("aborting rejects with the signal's reason and the timer never fires", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    let fired = false;
    const waiting = clock.after(100, controller.signal).then(() => {
      fired = true;
    });
    controller.abort("stop");
    await expect(waiting).rejects.toBe("stop");
    await clock.advance(100);
    expect(fired).toBe(false);
  });

  test("an already-aborted signal rejects immediately", async () => {
    const clock = new FakeClock();
    await expect(clock.after(100, AbortSignal.abort("gone"))).rejects.toBe(
      "gone",
    );
  });

  test("a fired timer does not reject on a later abort", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const waiting = clock.after(10, controller.signal);
    await clock.advance(10);
    controller.abort("late");
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("systemClock", () => {
  test("now is wall-clock epoch millis", () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  test("after resolves once the delay has passed", async () => {
    await expect(systemClock.after(0)).resolves.toBeUndefined();
  });

  test("aborting a pending wait rejects with the reason", async () => {
    const controller = new AbortController();
    const waiting = systemClock.after(60_000, controller.signal);
    controller.abort("stop");
    await expect(waiting).rejects.toBe("stop");
  });

  test("an already-aborted signal rejects immediately", async () => {
    await expect(
      systemClock.after(60_000, AbortSignal.abort("gone")),
    ).rejects.toBe("gone");
  });

  test("a completed wait does not reject on a later abort", async () => {
    const controller = new AbortController();
    await systemClock.after(0, controller.signal);
    controller.abort("late");
  });
});
