import { FakeClock, err, ok } from "@bayon/core";
import { expect, test } from "vitest";
import { createBatcher } from "./batcher.js";

function rig(o: { failOn?: number } = {}) {
  const clock = new FakeClock(0);
  const commits: number[][] = [];
  const batcher = createBatcher<number>({
    clock,
    maxRows: 100,
    maxDelayMs: 50,
    commit: async (rows) => {
      commits.push([...rows]);
      return commits.length === o.failOn
        ? err({ class: "internal", message: "boom", retryable: false })
        : ok(undefined);
    },
  });
  return { clock, commits, batcher };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);

test("rows wait up to 50 ms, then commit as one batch", async () => {
  const { clock, commits, batcher } = rig();
  expect(batcher.push([1, 2])).toBeUndefined();
  expect(batcher.push([3])).toBeUndefined();
  await clock.advance(49);
  expect(commits).toEqual([]);
  await clock.advance(1);
  expect(commits).toEqual([[1, 2, 3]]);
});

test("100 rows commit at once, and the timer then has nothing left", async () => {
  const { clock, commits, batcher } = rig();
  batcher.push([0]);
  const full = batcher.push(range(1, 100));
  expect(full).toBeDefined();
  expect(await full).toEqual(ok(undefined));
  expect(commits).toEqual([range(0, 100)]);
  await clock.advance(50);
  expect(commits).toHaveLength(1);
});

test("batches commit one at a time, in push order", async () => {
  const { commits, batcher } = rig();
  const first = batcher.push(range(0, 120));
  batcher.push(range(120, 150));
  const second = batcher.flush();
  expect(await first).toEqual(ok(undefined));
  expect(await second).toEqual(ok(undefined));
  expect(commits).toEqual([range(0, 120), range(120, 150)]);
  expect(await batcher.flush()).toEqual(ok(undefined));
  expect(commits).toHaveLength(2);
});

test("after a failed commit nothing else commits, and every flush reports it", async () => {
  const { commits, batcher } = rig({ failOn: 1 });
  batcher.push([1]);
  const failed = await batcher.flush();
  expect(failed.ok).toBe(false);
  batcher.push([2]);
  expect((await batcher.flush()).ok).toBe(false);
  expect(commits).toEqual([[1]]);
});
