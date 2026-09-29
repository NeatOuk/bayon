import { FakeClock, ok } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import type { CommandHandler } from "../commands/claimer.js";
import { createIngest } from "../ingest/ingest.js";
import { envSecrets, lifecycleFactory } from "./index.js";
import { EXECUTOR_ID, lifecycleRows, tempHome } from "./testing/fixtures.js";

const clock = new FakeClock(1_700_000_000_000);
const log = pino({ level: "silent" });
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** startSupervisor's side of the factory call, with a claimer that records what it is given. */
async function build(settings: Readonly<Record<string, number>> = {}) {
  const t = unwrap(await tempDb(clock));
  unwrap(await seedRows(t.db, lifecycleRows({ healthArgv: ["ok"], settings })));
  const home = tempHome();
  const ingest = createIngest({ db: t.db, clock, log });
  cleanups.push(async () => {
    await ingest.shutdown();
    t.cleanup();
    home.cleanup();
  });
  const slots = new SlotCounter(1);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
  });
  const adapter = createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock });
  const registered: string[] = [];
  const lifecycle = lifecycleFactory({
    executors: new Map([[EXECUTOR_ID, { executor, slots }]]),
    adapters: new Map([[adapter.id, adapter]]),
    secrets: envSecrets({}),
  })({
    db: t.db,
    clock,
    log,
    claimer: {
      register: <P>(h: CommandHandler<P>) => {
        registered.push(h.type);
      },
      start: () => undefined,
      stop: async () => undefined,
      wake: () => undefined,
      wired: () => undefined,
      requeue: async () => ok({ requeued: [], failed: [] }),
    },
    ingest,
    home: home.path,
    relay: {
      path: "unused.sock",
      register: () => ok({ write: () => undefined, close: () => undefined }),
      close: async () => undefined,
    },
  });
  return { lifecycle, registered };
}

test("lifecycleFactory registers session.spawn, session.interrupt, session.stop, session.handoff, executor.health, session.attach, session.detach and repo.check, then boots", async () => {
  const { lifecycle, registered } = await build();
  expect(registered).toEqual([
    "session.spawn",
    "session.interrupt",
    "session.stop",
    "session.handoff",
    "executor.health",
    "session.attach",
    "session.detach",
    "repo.check",
  ]);
  expect(await lifecycle.boot()).toEqual(ok(undefined));
  await lifecycle.shutdown();
});

test("boot refuses invalid lifecycle settings, before any pass", async () => {
  const { lifecycle } = await build({ "lifecycle.kill_grace_ms": -5 });
  expect(await lifecycle.boot()).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});
