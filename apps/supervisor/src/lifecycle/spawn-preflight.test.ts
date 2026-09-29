// The spawn's model pre-flight (§9.1): a model its provider does not serve fails the
// spawn before the runner starts, naming the model and the host; a check that got no answer is
// logged and the spawn goes on; the pre-flight is asked with the spawn's own spec. On FakeExecutor
// with the fixture program in-process; the hook is the adapter's, stubbed.
import { FakeClock } from "@bayon/core";
import { getSession } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import type { ModelPreflight, RunnerAdapter, SpawnSpec } from "@bayon/runners";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import { preflightStep } from "./preflight.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

async function setup(verdict: ModelPreflight) {
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
  const slots = new SlotCounter(4);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
  });
  const base = createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock });
  const hook = vi.fn<NonNullable<RunnerAdapter["preflightModel"]>>(
    async () => verdict,
  );
  const spawn = vi.fn(base.spawn);
  const adapter: RunnerAdapter = { ...base, preflightModel: hook, spawn };
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter,
  });
  cleanups.push(() => {
    void started.lifecycle.shutdown();
    t.cleanup();
    home.cleanup();
  });
  return { ...started, db: t.db, slots, hook, spawn };
}

test("not served: the spawn fails before the runner starts, naming model and host", async () => {
  const reason = "model fixture-model not served by 127.0.0.1:9";
  const h = await setup({ verdict: "not_served", reason });
  unwrap(await h.lifecycle.handlers.spawn.handle(spawnPayload("P"), CMD));
  await h.lifecycle.settled();
  expect(unwrap(await getSession(h.db, "P"))).toMatchObject({
    state: "exited",
    exit_reason: "error",
    error_class: "runner_error",
    error_message: reason,
  });
  expect(h.spawn).not.toHaveBeenCalled();
  expect(h.slots.capacity().used).toBe(0);
  // Asked with the spawn's own spec: its model, flags and complete env, on its executor's kind.
  const [target] = h.hook.mock.calls[0] ?? [];
  expect(target).toMatchObject({
    model: "fixture-model",
    executorKind: "local",
    env: expect.objectContaining({ HOME: expect.any(String) }),
  });
});

test("unreachable: logged, and the spawn goes on", async () => {
  const h = await setup({
    verdict: "unreachable",
    reason: "cannot ask 127.0.0.1:9 which models it serves: refused",
  });
  unwrap(await h.lifecycle.handlers.spawn.handle(spawnPayload("U"), CMD));
  await h.lifecycle.settled();
  expect(unwrap(await getSession(h.db, "U")).state).toBe("idle");
  expect(h.spawn).toHaveBeenCalledOnce();
  expect(h.logs).toContainEqual(
    expect.objectContaining({
      level: "warn",
      msg: "model pre-flight got no answer; spawning anyway",
    }),
  );
});

test.each<ModelPreflight>([
  { verdict: "served" },
  { verdict: "unchecked", reason: "nothing to ask" },
])("$verdict: the spawn goes on", async (verdict) => {
  const h = await setup(verdict);
  unwrap(await h.lifecycle.handlers.spawn.handle(spawnPayload("S"), CMD));
  await h.lifecycle.settled();
  expect(unwrap(await getSession(h.db, "S")).state).toBe("idle");
  expect(h.spawn).toHaveBeenCalledOnce();
});

test("an adapter without the hook is unaffected: nothing is asked", async () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fetch = vi.fn();
  const adapter = createFixtureAdapter({ command: [FIXTURE_PROGRAM] });
  const got = await preflightStep(
    {
      log,
      sessionId: "N",
      adapter,
      executorKind: "local",
      clock: new FakeClock(T0),
      signal: new AbortController().signal,
      fetch,
    },
    { model: "m", flags: {}, env: {} } as unknown as SpawnSpec,
  );
  expect(got).toEqual({ ok: true, value: undefined });
  expect(fetch).not.toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
});

test("a hook that never answers is cut off at the bound, on the supervisor's clock", async () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = new FakeClock(T0);
  const adapter: RunnerAdapter = {
    ...createFixtureAdapter({ command: [FIXTURE_PROGRAM] }),
    preflightModel: () => new Promise<ModelPreflight>(() => undefined),
  };
  const pending = preflightStep(
    {
      log,
      sessionId: "H",
      adapter,
      executorKind: "local",
      clock,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    },
    { model: "m", flags: {}, env: {} } as unknown as SpawnSpec,
  );
  await clock.advance(5_000);
  expect((await pending).ok).toBe(true);
  expect(log.warn).toHaveBeenCalledOnce();
});

test("a stop during the pre-flight ends it at once, without the bound and without a warning", async () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const stop = new AbortController();
  let hookSignal: AbortSignal | undefined;
  const adapter: RunnerAdapter = {
    ...createFixtureAdapter({ command: [FIXTURE_PROGRAM] }),
    preflightModel: (_t, io) => {
      hookSignal = io.signal;
      return new Promise<ModelPreflight>(() => undefined);
    },
  };
  const pending = preflightStep(
    {
      log,
      sessionId: "X",
      adapter,
      executorKind: "local",
      clock: new FakeClock(T0), // never advanced: only the stop can end it
      signal: stop.signal,
    },
    { model: "m", flags: {}, env: {} } as unknown as SpawnSpec,
  );
  stop.abort(new Error("stopped"));
  expect((await pending).ok).toBe(true);
  expect(hookSignal?.aborted).toBe(true);
  expect(log.warn).not.toHaveBeenCalled();
});
