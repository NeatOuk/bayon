// Step 5 never waits on a held session queue past its bound: a live
// session's resources are not queued at all, and the rest are waited on together under one
// reconciler.interval_ms, however many there are.
import { FakeClock } from "@bayon/core";
import { SlotCounter, type Executor, type Owned } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { expect, test } from "vitest";
import type { Ctx, Entry } from "./context.js";
import { reapOrphans, type Snapshot } from "./reaper.js";
import { KeyedQueue } from "./session-queue.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const TAG = "fh-bound";
const BUSY =
  "reconciler: the session's queue is still busy; the pass goes on without it";

const owned = (sessionId: string, n: number): Owned => ({
  kind: "process",
  sessionId,
  ref: `local:${1000 + n}:1`,
  homeTag: TAG,
});

test("held queues: a live session's are skipped, the others' waited on together within one bound", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const executor: Executor = new FakeExecutor({
    id: "local",
    slots: new SlotCounter(1),
    programs: {},
  });
  const queue = new KeyedQueue();
  const never = new Promise<void>(() => undefined);
  for (const id of ["LIVE", "A", "B", "C"]) void queue.run(id, () => never);
  const warned: { obj: object; msg: string }[] = [];
  const log = {
    info: () => undefined,
    warn: (obj: object, msg: string) => warned.push({ obj, msg }),
    error: () => undefined,
  };
  const live = new Map<string, Entry>([
    ["LIVE", { abort: new AbortController(), dead: false }],
  ]);
  const ctx = {
    executors: new Map([["local", { executor, slots: new SlotCounter(1) }]]),
    live,
    queue,
    settings: DEFAULT_SETTINGS,
    clock,
    log,
    homeTag: TAG,
  } as unknown as Ctx;
  const snapshot: Snapshot = new Map([
    ["local", [owned("LIVE", 0), owned("A", 1), owned("B", 2), owned("C", 3)]],
  ]);
  let done = false;
  const pass = reapOrphans(ctx, snapshot, "periodic").then(() => {
    done = true;
  });
  await clock.advance(DEFAULT_SETTINGS["reconciler.interval_ms"]);
  await pass;
  expect(done).toBe(true);
  // One bound for all three, not one each: the clock moved one interval, and each was given up.
  expect(
    warned
      .filter((w) => w.msg === BUSY)
      .map((w) => (w.obj as { sessionId: string }).sessionId),
  ).toEqual(["A", "B", "C"]);
});

test("at boot too, a live session's resource is never queued, so its held queue is never waited on", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const queue = new KeyedQueue();
  const gate = Promise.withResolvers<undefined>();
  void queue.run("A", () => gate.promise);
  const executor: Executor = new FakeExecutor({
    id: "local",
    slots: new SlotCounter(1),
    programs: {},
  });
  const ctx = {
    executors: new Map([["local", { executor, slots: new SlotCounter(1) }]]),
    live: new Map<string, Entry>([
      ["A", { abort: new AbortController(), dead: false }],
    ]),
    queue,
    settings: DEFAULT_SETTINGS,
    clock,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    homeTag: TAG,
  } as unknown as Ctx;
  // A live session is skipped at boot too: nothing is queued, so nothing is waited on.
  await reapOrphans(ctx, new Map([["local", [owned("A", 1)]]]), "boot");
  gate.resolve(undefined);
});
