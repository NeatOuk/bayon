import { FakeClock, ok } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { afterAll, expect, test } from "vitest";
import type { RequeueRequest } from "../commands/claimer.js";
import {
  EXECUTOR_ID,
  lifecycleRows,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

// The periodic pass's command step: the boot pass never requeues (claims
// have not started); every later pass asks the claimer for rows older than command_requeue_ms.
const T0 = 1_700_000_000_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function booted(settings: Readonly<Record<string, number>> = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedRows(t.db, lifecycleRows({ healthArgv: ["ok"], settings })));
  const home = tempHome();
  const slots = new SlotCounter(1);
  const asked: RequeueRequest[] = [];
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor: new FakeExecutor({
      id: EXECUTOR_ID,
      slots,
      programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
    }),
    slots,
    adapter: createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock }),
    commands: {
      requeue: async (r: RequeueRequest) => {
        asked.push(r);
        return ok({ requeued: [], failed: [] });
      },
    },
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    t.cleanup();
    home.cleanup();
  });
  return { ...started, clock, asked };
}

test("the boot pass asks nothing; a periodic pass asks for claims older than command_requeue_ms", async () => {
  // No loop pass fires while the clock moves: only the explicit one below asks.
  const b = await booted({ "reconciler.interval_ms": 86_400_000 });
  expect(b.asked).toEqual([]);
  await b.clock.advance(1_000_000);
  await b.lifecycle.reconcile();
  expect(b.asked).toEqual([
    {
      claimedBefore: T0 + 1_000_000 - 300_000,
      maxAttempts: 3,
      why: "claimed for more than 300000 ms without completing",
    },
  ]);
});

test("the settings rows decide the cut and the attempts", async () => {
  const b = await booted({
    "reconciler.command_requeue_ms": 5_000,
    "reconciler.command_max_attempts": 5,
  });
  await b.lifecycle.reconcile();
  expect(b.asked).toEqual([
    {
      claimedBefore: T0 - 5_000,
      maxAttempts: 5,
      why: "claimed for more than 5000 ms without completing",
    },
  ]);
});
