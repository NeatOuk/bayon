// an earlier change via an earlier change: a replay that fails never lets the reconciler adopt (or end) the session.
// An adopt moves raw_segment_offset past the dead process's segment, so its uncommitted tail could
// never be replayed again; the session waits for the next pass, whose replay succeeds and adopts.
import { FakeClock, err } from "@bayon/core";
import { getSession, listRuns } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { createIngest, type Ingest } from "../ingest/ingest.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const WAIT = { timeout: 10_000, interval: 5 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const DIED = "the runner exited; the reconciler adopts or ends the session";

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

test("a failed replay leaves the dead session for the next pass; the next replay succeeds and adopts", async () => {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(
    await seedRows(
      t.db,
      lifecycleRows({
        healthArgv: ["ok"],
        script: { runs: [{ events: [TURN] }] },
      }),
    ),
  );
  const home = tempHome();
  const real = createIngest({
    db: t.db,
    clock,
    log: pino({ level: "silent" }),
    maxRows: 1,
  });
  let failing = false;
  // The real ingest, except that replay fails while `failing`.
  const ingest: Ingest = new Proxy(real, {
    get(target, key, receiver) {
      if (key === "replay" && failing) {
        return async () =>
          err({
            class: "internal",
            message: "injected replay failure",
            retryable: true,
          });
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const slots = new SlotCounter(4);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
  });
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock }),
    ingest,
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    await real.shutdown();
    t.cleanup();
    home.cleanup();
  });
  const session = async () => unwrap(await getSession(t.db, "R"));

  unwrap(
    await started.lifecycle.handlers.spawn.handle(
      spawnPayload("R", { prompt: "go" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await started.lifecycle.settled();
    expect(unwrap(await listRuns(t.db, "R"))[0]?.state).toBe("ok");
    expect((await session()).state).toBe("idle");
  }, WAIT);
  const before = await session();
  await executor.cleanup(before.executor_ref ?? "", "hard");
  await vi.waitFor(async () => {
    await started.lifecycle.settled();
    expect(started.logs.map((l) => l.msg)).toContain(DIED);
  }, WAIT);

  failing = true;
  await started.lifecycle.reconcile();
  await started.lifecycle.settled();
  expect(started.logs.map((l) => l.msg)).toContain(
    "replay failed: the session waits for the next pass",
  );
  expect(await session()).toMatchObject({
    state: "idle",
    executor_ref: before.executor_ref,
    raw_segment_offset: before.raw_segment_offset,
  });

  failing = false;
  await started.lifecycle.reconcile();
  await started.lifecycle.settled();
  const after = await session();
  expect(after.state).toBe("idle");
  expect(after.executor_ref).not.toBe(before.executor_ref);
  expect(await executor.probe(after.executor_ref ?? "")).toBe("alive");
});
