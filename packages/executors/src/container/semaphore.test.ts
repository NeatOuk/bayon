import { describe, expect, test } from "vitest";
import { Semaphore } from "./semaphore.js";

const forever = () => new AbortController().signal;

describe("Semaphore (ssh channels on one connection)", () => {
  test("grants up to its size, then first come first served; release is idempotent", async () => {
    const channels = new Semaphore(1);
    const first = await channels.acquire(forever(), "a channel");
    const order: string[] = [];
    const second = channels.acquire(forever(), "a channel").then((release) => {
      order.push("second");
      return release;
    });
    const third = channels.acquire(forever(), "a channel").then((release) => {
      order.push("third");
      return release;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    first();
    first();
    (await second)();
    (await third)();
    expect(order).toEqual(["second", "third"]);
    (await channels.acquire(forever(), "a channel"))();
  });

  test("a wait ends at the caller's deadline and gives up its place", async () => {
    const channels = new Semaphore(1);
    const held = await channels.acquire(forever(), "a channel");
    const deadline = new AbortController();
    const waiting = channels.acquire(deadline.signal, "an ssh channel");
    deadline.abort();
    await expect(waiting).rejects.toMatchObject({
      class: "timeout",
      retryable: true,
    });
    await expect(
      channels.acquire(AbortSignal.abort(), "an ssh channel"),
    ).rejects.toMatchObject({ class: "timeout" });
    held();
    (await channels.acquire(forever(), "a channel"))();
  });
});
