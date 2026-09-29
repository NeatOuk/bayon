// The pulse scheduler under one project's pause: project P-A's orchestrator neither
// catches up, arms, fires nor runs now while P-A is paused, and a pulse already decided fails
// `project_paused` before its spawn; the fleet's orchestrator (no project) pulses throughout.
// Resumed, the next tick plans P-A's again. scheduler-pause.test.ts's shape, per project: a real
// temp SQLite file, the fixture orchestrators on FakeExecutor, a FakeClock.
import { FakeClock } from "@bayon/core";
import { listPulses, type PulseRow } from "@bayon/db";
import {
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
} from "@bayon/db/testing";
import { afterEach, expect, test, vi } from "vitest";
import { tempHome } from "../lifecycle/testing/fixtures.js";
import { contextPackBuilder } from "./context-pack.js";
import type { ContextPackBuilder } from "./ports.js";
import { MIN, ORCH, T0, WAIT, pulseRows, startRig } from "./testing/rig.js";

vi.setConfig({ testTimeout: 30_000 });

const TICK_MS = 60_000; // 004's pulse.tick_ms
const FLEET = "orch-fleet";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * ORCH belongs to P-A, FLEET (same profile) to no project. Work waits in P-A, so a pulse of either
 * that fires runs. `paused`: P-A is paused from the start; else `pack` may pause it itself.
 */
async function setup(o: {
  readonly paused: boolean;
  readonly pack?: (
    real: ContextPackBuilder,
    setPaused: (p: boolean) => Promise<void>,
  ) => ContextPackBuilder;
}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome();
  const rows = pulseRows({ agent: { workspace_id: "P-A" } });
  const orch = rows.agents.find((a) => a.id === ORCH);
  if (orch === undefined) throw new Error("pulseRows has no orchestrator");
  unwrap(
    await seedRows(t.db, {
      ...rows,
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single", paused: o.paused ? 1 : 0 },
      ],
      agents: [
        ...rows.agents,
        { ...orch, id: FLEET, name: FLEET, workspace_id: null },
      ],
      tickets: [ticketRow(1, { status: "prioritized", workspace_id: "P-A" })],
    }),
  );
  const setPaused = async (p: boolean): Promise<void> => {
    unwrap(
      await updateRowForTest(t.db, "workspaces", "P-A", { paused: p ? 1 : 0 }),
    );
  };
  const real = contextPackBuilder({ db: t.db, frmHome: home.path });
  const rig = await startRig({
    db: t.db,
    clock,
    home: home.path,
    pack: o.pack === undefined ? real : o.pack(real, setPaused),
  });
  cleanups.push(async () => {
    await rig.stop();
    t.cleanup();
    home.cleanup();
  });
  const pulsesOf = async (agentId: string): Promise<PulseRow[]> =>
    unwrap(await listPulses(t.db, { agent_id: agentId, limit: 100 }));
  return { clock, ...rig, setPaused, pulsesOf };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Advances fake time a step at a time, letting each step's work settle. */
async function run(s: Setup, ms: number, step = TICK_MS) {
  for (let spent = 0; spent < ms; spent += step) {
    await s.clock.advance(step);
    await s.settle();
  }
}

test("P-A paused at boot: its orchestrator has no catchup, wake or pulse for hours and run-now is refused project_paused; the fleet's pulses", async () => {
  const s = await setup({ paused: true });
  expect(s.scheduler.wakes().has(ORCH)).toBe(false);
  expect(s.scheduler.wakes().get(FLEET)?.trigger).toBe("catchup");
  await run(s, 3 * 60 * MIN);
  expect(await s.pulsesOf(ORCH)).toEqual([]);
  expect(s.scheduler.wakes().has(ORCH)).toBe(false);
  // The fleet's pulsed all along (whether its next wake is armed right now depends on whether one
  // of its pulses is live at this instant, which a loaded machine decides).
  expect((await s.pulsesOf(FLEET)).length).toBeGreaterThan(1);
  expect(await s.scheduler.runNow(ORCH)).toMatchObject({
    ok: false,
    error: {
      class: "admission_refused",
      retryable: true,
      cause: { gate: "project_paused" },
    },
  });
  expect(await s.pulsesOf(ORCH)).toEqual([]);
  expect(
    s.logs.filter(
      (l) => l.msg === "the project is paused: its orchestrator does not pulse",
    ),
  ).toHaveLength(1);
});

test("P-A resumed, the next tick plans its orchestrator again and a pulse runs", async () => {
  const s = await setup({ paused: true });
  await run(s, 3 * 60 * MIN);
  await s.setPaused(false);
  await vi.waitFor(async () => {
    await run(s, TICK_MS, 1_000);
    expect((await s.pulsesOf(ORCH)).length).toBeGreaterThan(0);
  }, WAIT);
  expect(
    s.logs.some(
      (l) => l.msg === "the project resumed: its orchestrator plans again",
    ),
  ).toBe(true);
});

test("a pause mid-life cancels P-A's armed wake and fires none until the resume; the fleet's keeps pulsing", async () => {
  const s = await setup({ paused: false });
  await vi.waitFor(async () => {
    await run(s, 1_000, 1_000);
    expect(await s.pulsesOf(ORCH)).toHaveLength(1); // the boot catchup
  }, WAIT);
  await s.settle();
  expect(s.scheduler.wakes().get(ORCH)?.trigger).toBe("cron");
  const fleetBefore = (await s.pulsesOf(FLEET)).length;

  await s.setPaused(true);
  await run(s, 2 * 60 * MIN);
  expect(await s.pulsesOf(ORCH)).toHaveLength(1);
  expect(s.scheduler.wakes().has(ORCH)).toBe(false);
  expect((await s.pulsesOf(FLEET)).length).toBeGreaterThan(fleetBefore);

  await s.setPaused(false);
  await vi.waitFor(async () => {
    await run(s, TICK_MS, 1_000);
    expect(await s.pulsesOf(ORCH)).toHaveLength(2);
  }, WAIT);
});

test("paused after the pulse was decided: it fails project_paused before its spawn, and frees its lease", async () => {
  // P-A is paused while ORCH's pack is built: after the decision, before the spawn.
  const s = await setup({
    paused: false,
    pack: (real, setPaused) => ({
      build: async (input) => {
        if (input.agentId === ORCH) await setPaused(true);
        return real.build(input);
      },
    }),
  });
  await vi.waitFor(async () => {
    await run(s, 1_000, 1_000);
    expect(await s.pulsesOf(ORCH)).toMatchObject([
      {
        trigger: "catchup",
        state: "failed",
        skip_reason: "project_paused",
        session_id: null,
      },
    ]);
  }, WAIT);
  // The fleet's catchup, on the same pack, spawned its session and ran it to its end (the fixture
  // sends no pulse report, so that end is `unreported`).
  await vi.waitFor(async () => {
    await run(s, 1_000, 1_000);
    expect(await s.pulsesOf(FLEET)).toMatchObject([
      {
        trigger: "catchup",
        state: "failed",
        skip_reason: "unreported",
        session_id: expect.any(String),
      },
    ]);
  }, WAIT);
});
