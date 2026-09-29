import { expect, test } from "vitest";
import { KeyedQueue } from "./session-queue.js";

test("ops on one key run one at a time, in order; other keys run alongside", async () => {
  const q = new KeyedQueue();
  const order: string[] = [];
  const gate = Promise.withResolvers<undefined>();
  const a1 = q.run("a", async () => {
    order.push("a1 start");
    await gate.promise;
    order.push("a1 end");
    return 1;
  });
  const a2 = q.run("a", async () => {
    order.push("a2");
    return 2;
  });
  await q.run("b", async () => {
    order.push("b1");
  });
  expect(order).toEqual(["a1 start", "b1"]);
  gate.resolve(undefined);
  expect(await Promise.all([a1, a2])).toEqual([1, 2]);
  expect(order).toEqual(["a1 start", "b1", "a1 end", "a2"]);
});

test("a failed op rejects its caller and does not block the next", async () => {
  const q = new KeyedQueue();
  const failed = q.run("a", async () => {
    throw new Error("boom");
  });
  await expect(failed).rejects.toThrow("boom");
  expect(await q.run("a", async () => "next")).toBe("next");
});

test("idle only while no op is queued or running under any key", async () => {
  const q = new KeyedQueue();
  expect(q.idle()).toBe(true);
  const gate = Promise.withResolvers<undefined>();
  const op = q.run("a", () => gate.promise);
  expect(q.idle()).toBe(false);
  gate.resolve(undefined);
  await op;
  await q.settled();
  expect(q.idle()).toBe(true);
});

test("settled waits for ops queued while it waits", async () => {
  const q = new KeyedQueue();
  const done: string[] = [];
  void q.run("a", async () => {
    void q.run("b", async () => {
      done.push("b");
    });
    done.push("a");
  });
  await q.settled();
  expect(done).toEqual(["a", "b"]);
});
