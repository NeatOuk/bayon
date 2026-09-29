// An orchestrator added to a running install: `POST /projects/:id/agents` writes the
// rows core's `projectAgentPlan` names while the supervisor runs. The scheduler re-reads the enabled
// orchestrators every tick, so the next tick plans it — no restart — on the table's default policy,
// and from then on it wakes for and sees only its own project. A real temp SQLite file,
// the fixture on FakeExecutor, a FakeClock.
import { FakeClock, err, projectAgentPlan } from "@bayon/core";
import { listPulses, type PulseRow } from "@bayon/db";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import { FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import { afterEach, expect, test, vi } from "vitest";
import { EXECUTOR_ID, tempHome } from "../lifecycle/testing/fixtures.js";
import type { ContextPackBuilder } from "./ports.js";
import { ORCH, T0, WAIT, pulseRows, startRig } from "./testing/rig.js";

vi.setConfig({ testTimeout: 30_000 });

const LIVE = ["leased", "running"];
/** `pulse.tick_ms`'s default: the scheduler's re-read cadence. */
const TICK_MS = 60_000;
/** The agents table's defaults (001_spine): hybrid, 90 min, a 60 s debounce. */
const INTERVAL_MS = 5_400_000;
const DEBOUNCE_MS = 60_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A pack that fails at once: a pulse that ran (it counts) but spawned nothing. */
const FAILING_PACK: ContextPackBuilder = {
  build: async () =>
    err({ class: "validation", message: "no pack", retryable: false }),
};

/** ORCH is P-B's orchestrator, and P-B has a prioritized ticket; P-A has no orchestrator. */
async function setup() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome();
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
      ...pulseRows({ agent: { workspace_id: "P-B" } }),
      tickets: [ticketRow(1, { status: "prioritized", workspace_id: "P-B" })],
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

const ended = async (s: Setup, agentId: string): Promise<PulseRow[]> =>
  (await pulsesOf(s, agentId)).filter((p) => !LIVE.includes(p.state));

/** The rows the door writes for P-A's orchestrator: the plan's profile and agent, nothing more. */
async function addOrchestrator(s: Setup) {
  const plan = projectAgentPlan(
    { workspace: "P-A", kind: "orchestrator", runner: FIXTURE_RUNNER_ID },
    { taken: new Set([ORCH]), executor: EXECUTOR_ID },
  );
  const createdAt = s.clock.now();
  unwrap(
    await seedRows(s.db, {
      profiles: [
        { ...plan.profile, version: 1, hash: "0".repeat(64), created_at: 1 },
      ],
      agents: [{ ...plan.agent, created_at: createdAt }],
    }),
  );
  return { id: plan.agent.id, createdAt };
}

test("an orchestrator added while the scheduler runs is planned on its next tick, and wakes for and pulses only its project", async () => {
  const s = await setup();
  await s.clock.advance(1_000);
  await vi.waitFor(async () => {
    await s.settle();
    expect(await ended(s, ORCH)).toHaveLength(1);
  }, WAIT);
  await s.settle();

  const added = await addOrchestrator(s);
  expect(added.id).toBe("P-A-orchestrator-1");
  // Until the next tick the scheduler has not read it: a completion in its project reaches nothing.
  s.scheduler.fanOutCompletion(s.clock.now(), "P-A");
  await s.settle();
  expect(s.scheduler.wakes().has(added.id)).toBe(false);

  // The loop's next tick re-reads the orchestrators and plans it: its first cron wake, one
  // default interval after it was created.
  await s.clock.advance(TICK_MS);
  await vi.waitFor(async () => {
    await s.settle();
    expect(s.scheduler.wakes().get(added.id)).toEqual({
      at: added.createdAt + INTERVAL_MS,
      trigger: "cron",
    });
  }, WAIT);

  // Another project's completion is not its to serve; its own project's is.
  s.scheduler.fanOutCompletion(s.clock.now(), "P-B");
  await s.settle();
  expect(s.scheduler.wakes().get(added.id)?.trigger).toBe("cron");
  const at = s.clock.now();
  s.scheduler.fanOutCompletion(at, "P-A");
  await s.settle();
  expect(s.scheduler.wakes().get(added.id)).toEqual({
    at: at + DEBOUNCE_MS,
    trigger: "completion",
  });

  // It pulses, scoped: P-B's prioritized ticket is not its work, so it skips at $0.
  await s.clock.advance(DEBOUNCE_MS);
  await vi.waitFor(async () => {
    await s.settle();
    expect(await ended(s, added.id)).toHaveLength(1);
  }, WAIT);
  expect(await pulsesOf(s, added.id)).toMatchObject([
    {
      trigger: "completion",
      state: "skipped",
      skip_reason: "nothing_to_do",
      cost_usd: 0,
    },
  ]);
});
