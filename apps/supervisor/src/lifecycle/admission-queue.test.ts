// The drain's waiter list on its own: arrival order, the one-waiter rule
// for a re-delivered id (re-admits by enqueue), and withdraw. The executor these waiters
// name has no row, so every pass reads no facts and leaves them all queued: nothing is admitted.
import { FakeClock } from "@bayon/core";
import { tempDb, unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { createAdmission, type Admitted } from "./admission.js";
import type { Ctx } from "./context.js";
import { KeyedQueue } from "./session-queue.js";

const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());

const clock = new FakeClock(1_700_000_000_000);

/** Only what the drain touches; the rest of Ctx is never read by it. */
const ctx = {
  db: t.db,
  clock,
  log: pino({ level: "silent" }),
  live: new Map(),
  queue: new KeyedQueue(),
  executors: new Map(),
  adapters: new Map(),
  jobRunners: new Set<string>(),
  mcpUrl: "http://127.0.0.1:1/mcp",
  mcpReachable: async () => true,
} as unknown as Ctx;

/** A waiter's spawn as far as the drain reads it before its facts fail (no executor row). */
const admitted = (id: string): Admitted =>
  ({
    sessionId: id,
    executorId: "no-such-executor",
    agent: { id: "agent" },
    runner: { id: "runner" },
    toolset: { tools: [] },
    gate: null,
  }) as unknown as Admitted;

const started: string[] = [];
const admission = createAdmission(
  () => ctx,
  (a) => {
    started.push(a.sessionId);
  },
);
afterAll(() => admission.shutdown());

const enqueue = (id: string) =>
  admission.enqueue({
    sessionId: id,
    admitted: admitted(id),
    first: undefined,
  });

test("enqueueing an id already waiting is a no-op: one waiter, in its original place", async () => {
  enqueue("A");
  enqueue("B");
  enqueue("A");
  expect(admission.waiting()).toEqual(["A", "B"]);
  await admission.settled();
  expect(admission.waiting()).toEqual(["A", "B"]);
  expect(started).toEqual([]);
});

test("withdraw takes an unclaimed waiter out once; enqueued again, it goes to the back", async () => {
  expect(admission.withdraw("A")).toEqual({ reason: null });
  expect(admission.withdraw("A")).toBeUndefined();
  expect(admission.waiting()).toEqual(["B"]);
  enqueue("A");
  expect(admission.waiting()).toEqual(["B", "A"]);
  await admission.settled();
  expect(admission.reasonOf("A")).toBeNull();
});

test("settled() never waits for the waiters themselves (CRITICAL-1); busy() only while a drain runs", async () => {
  expect(admission.waiting()).toHaveLength(2);
  admission.wake();
  expect(admission.busy()).toBe(true);
  await admission.settled();
  expect(admission.busy()).toBe(false);
  expect(admission.waiting()).toHaveLength(2);
});
