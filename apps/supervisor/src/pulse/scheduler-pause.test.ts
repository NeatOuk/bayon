// The pulse scheduler under the kill switch (M4 §13.3): paused, it is frozen (no wake
// armed or fired, a run-now refused `fleet_paused`); resumed, the next tick plans again. A real
// temp SQLite file, the fixture orchestrator on FakeExecutor, a FakeClock.
import { FLEET_PAUSED_KEY, FakeClock } from "@bayon/core";
import { listPulses } from "@bayon/db";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import { afterEach, expect, test, vi } from "vitest";
import { tempHome } from "../lifecycle/testing/fixtures.js";
import { MIN, ORCH, T0, WAIT, pulseRows, startRig } from "./testing/rig.js";

vi.setConfig({ testTimeout: 30_000 });

const TICK_MS = 60_000; // 004's pulse.tick_ms
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(paused: boolean) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome();
  unwrap(
    await seedRows(t.db, {
      ...pulseRows(),
      // Work waiting, so a pulse that fires runs (v_needs_attention: an unstaffed ticket).
      tickets: [ticketRow(1, { status: "prioritized" })],
    }),
  );
  const setPaused = (p: boolean) =>
    seedRows(t.db, {
      settings: [
        {
          key: FLEET_PAUSED_KEY,
          value_json: p ? "1" : "0",
          updated_at: clock.now(),
        },
      ],
    });
  unwrap(await setPaused(paused));
  const rig = await startRig({ db: t.db, clock, home: home.path });
  cleanups.push(async () => {
    await rig.stop();
    t.cleanup();
    home.cleanup();
  });
  const pulses = async () =>
    unwrap(await listPulses(t.db, { agent_id: ORCH, limit: 100 }));
  return { clock, ...rig, setPaused, pulses };
}

/** Advances fake time a step at a time, letting each step's work settle. */
async function run(
  s: Awaited<ReturnType<typeof setup>>,
  ms: number,
  step = TICK_MS,
) {
  for (let spent = 0; spent < ms; spent += step) {
    await s.clock.advance(step);
    await s.settle();
  }
}

test("paused at boot: no catchup, no wake, no pulse for hours; run-now is refused fleet_paused", async () => {
  const s = await setup(true);
  expect(s.scheduler.wakes().size).toBe(0);
  await run(s, 3 * 60 * MIN);
  expect(await s.pulses()).toEqual([]);
  expect(s.scheduler.wakes().size).toBe(0);
  expect(await s.scheduler.runNow(ORCH)).toMatchObject({
    ok: false,
    error: {
      class: "admission_refused",
      retryable: true,
      cause: { gate: "fleet_paused" },
    },
  });
  expect(await s.pulses()).toEqual([]);
});

test("resumed, the next tick plans again and a pulse runs", async () => {
  const s = await setup(true);
  await run(s, 3 * 60 * MIN);
  unwrap(await s.setPaused(false));
  await vi.waitFor(async () => {
    await run(s, TICK_MS, 1_000);
    expect((await s.pulses()).length).toBeGreaterThan(0);
  }, WAIT);
});

test("a pause mid-life cancels the armed wake: none fires until the resume", async () => {
  const s = await setup(false);
  await vi.waitFor(async () => {
    await run(s, 1_000, 1_000);
    expect((await s.pulses()).length).toBe(1); // the boot catchup
  }, WAIT);
  await s.settle();
  expect(s.scheduler.wakes().get(ORCH)?.trigger).toBe("cron");
  unwrap(await s.setPaused(true));
  await run(s, 2 * 60 * MIN);
  expect(await s.pulses()).toHaveLength(1);
  expect(s.scheduler.wakes().size).toBe(0);
  unwrap(await s.setPaused(false));
  await vi.waitFor(async () => {
    await run(s, TICK_MS, 1_000);
    expect((await s.pulses()).length).toBe(2);
  }, WAIT);
});
