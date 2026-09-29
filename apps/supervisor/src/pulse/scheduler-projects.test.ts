// The pulse scheduler with a project's orchestrator beside a fleet one: a real temp
// SQLite file, the fixture on FakeExecutor, a FakeClock. Another project's work never costs the
// project's orchestrator a pulse, and another project's completion never wakes it; the fleet
// orchestrator (no project) sees and wakes for everything, as before.
import { FakeClock, err } from "@bayon/core";
import { listPulses, type PulseRow } from "@bayon/db";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import { afterEach, expect, test, vi } from "vitest";
import { tempHome } from "../lifecycle/testing/fixtures.js";
import type { ContextPackBuilder } from "./ports.js";
import { ORCH, T0, WAIT, pulseRows, startRig } from "./testing/rig.js";

vi.setConfig({ testTimeout: 30_000 });

const FLEET = "orch-fleet";
const LIVE = ["leased", "running"];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A pack that fails at once: a pulse that ran (it counts) but spawned nothing. */
const FAILING_PACK: ContextPackBuilder = {
  build: async () =>
    err({ class: "validation", message: "no pack", retryable: false }),
};

/** ORCH belongs to project P-A; FLEET, on the same profile, to none. `work`: tickets to seed. */
async function setup(work: readonly ReturnType<typeof ticketRow>[]) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome();
  const rows = pulseRows({ agent: { workspace_id: "P-A" } });
  const orch = rows.agents.find((a) => a.id === ORCH);
  if (orch === undefined) throw new Error("pulseRows has no orchestrator");
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
    }),
  );
  unwrap(
    await seedRows(t.db, {
      ...rows,
      agents: [
        ...rows.agents,
        { ...orch, id: FLEET, name: FLEET, workspace_id: null },
      ],
      tickets: [...work],
    }),
  );
  const rig = await startRig({
    db: t.db,
    clock,
    home: home.path,
    pack: FAILING_PACK,
  });
  cleanups.push(async () => {
    await rig.stop();
    t.cleanup();
    home.cleanup();
  });
  return { clock, db: t.db, ...rig };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const pulsesOf = async (s: Setup, agentId: string): Promise<PulseRow[]> =>
  unwrap(
    await listPulses(s.db, { agent_id: agentId, limit: 100 }),
  ).toReversed();

/** Waits until each of both agents' first pulse has ended. */
async function bootPulses(s: Setup): Promise<void> {
  await s.clock.advance(1_000);
  await vi.waitFor(async () => {
    await s.settle();
    for (const id of [ORCH, FLEET]) {
      const rows = await pulsesOf(s, id);
      expect(rows.filter((p) => !LIVE.includes(p.state))).toHaveLength(1);
    }
  }, WAIT);
  await s.settle();
}

test("only project B has work: A's orchestrator skips at $0, the fleet orchestrator runs", async () => {
  const s = await setup([
    ticketRow(1, { status: "prioritized", workspace_id: "P-B" }),
  ]);
  await bootPulses(s);
  expect(await pulsesOf(s, ORCH)).toMatchObject([
    {
      trigger: "catchup",
      state: "skipped",
      skip_reason: "nothing_to_do",
      cost_usd: 0,
    },
  ]);
  // The fleet's ran, and failed on the test's pack (its class is the row's reason): it was not
  // skipped for want of work.
  expect(await pulsesOf(s, FLEET)).toMatchObject([
    { trigger: "catchup", state: "failed", skip_reason: "validation" },
  ]);
});

test("a completion in project B wakes the fleet orchestrator, not A's; one in A wakes A's", async () => {
  const s = await setup([]);
  await bootPulses(s);
  const cron = s.scheduler.wakes().get(ORCH);
  expect(cron?.trigger).toBe("cron");
  expect(s.scheduler.wakes().get(FLEET)?.trigger).toBe("cron");

  s.scheduler.fanOutCompletion(s.clock.now(), "P-B");
  await s.settle();
  expect(s.scheduler.wakes().get(ORCH)).toEqual(cron);
  expect(s.scheduler.wakes().get(FLEET)?.trigger).toBe("completion");

  // A ticket session's end in B, as the lifecycle announces it: still not A's.
  s.scheduler.sessionEnded({
    sessionId: "ended-in-b",
    ticketId: "ticket-9",
    workspaceId: "P-B",
    at: s.clock.now(),
    handoffPending: false,
  });
  // A completion with no project is the fleet's alone too.
  s.scheduler.fanOutCompletion(s.clock.now(), null);
  await s.settle();
  expect(s.scheduler.wakes().get(ORCH)).toEqual(cron);

  s.scheduler.sessionEnded({
    sessionId: "ended-in-a",
    ticketId: "ticket-8",
    workspaceId: "P-A",
    at: s.clock.now(),
    handoffPending: false,
  });
  await s.settle();
  expect(s.scheduler.wakes().get(ORCH)?.trigger).toBe("completion");
});
