// One project's pause at admission: a paused project's spawn waits, queued
// `project_paused`, and its live session's next run is held, while another project's spawn and run
// go on; resumed, the recheck admits what it queued. The fixture on FakeExecutor, a FakeClock, a
// real temp SQLite file. Spawns go in with no workspace of their own (as a pulse's), so the
// project is their agent's and no worktree is needed; one names its own workspace instead.
import { FakeClock, TEMPLATES } from "@bayon/core";
import { seedRows, tempDb, unwrap, updateRowForTest } from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import type { InternalSpawn } from "./internal-spawn.js";
import {
  admissionRows,
  operatorRun,
  startAdmission,
  T0,
} from "./testing/admission-world.js";
import { AGENT_ID } from "./testing/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** AGENT_ID is project P-A's builder; B_AGENT is P-B's; FLEET_AGENT has no project. */
const B_AGENT = "agent-b";
const FLEET_AGENT = "agent-fleet";

async function world() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const rows = admissionRows({
    rows: { workspaceId: "P-A", maxConcurrency: 4 },
  });
  const [own] = rows.agents;
  if (own === undefined) throw new Error("admissionRows has no agent");
  unwrap(
    await seedRows(t.db, {
      ...rows,
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
      agents: [
        own,
        { ...own, id: B_AGENT, name: B_AGENT, workspace_id: "P-B" },
        { ...own, id: FLEET_AGENT, name: FLEET_AGENT, workspace_id: null },
      ],
    }),
  );
  const w = await startAdmission(t.db, clock);
  cleanups.push(async () => {
    await w.shutdown();
    t.cleanup();
  });
  return {
    ...w,
    setPaused: (project: string, paused: boolean) =>
      updateRowForTest(t.db, "workspaces", project, { paused: paused ? 1 : 0 }),
    /** A spawn with no workspace of its own, as the pulse's: its agent's project is its. */
    spawnFor: (id: string, agentId: string) =>
      w.lifecycle.spawnInternal(internal(id, agentId)),
  };
}

const internal = (id: string, agentId: string): InternalSpawn => ({
  payload: {
    session_id: id,
    agent_id: agentId,
    role: "builder",
    run_class: "build",
  },
  run: {
    seq: 1,
    trigger: "operator",
    template: TEMPLATES.operator,
    inputs: { task: "go" },
  },
  workspace: "none",
});

const refusedBy = (gate: string) => ({
  ok: false,
  error: {
    class: "admission_refused",
    retryable: true,
    cause: { gate },
  },
});

test("a paused project's spawn queues project_paused while another project's and the fleet's start; resumed, it starts", async () => {
  const w = await world();
  unwrap(await w.setPaused("P-A", true));
  unwrap(await w.spawnFor("A", AGENT_ID));
  unwrap(await w.spawnFor("B", B_AGENT));
  unwrap(await w.spawnFor("F", FLEET_AGENT));
  await w.until("A", { state: "pending", queued_reason: "project_paused" });
  await w.until("B", { state: "idle", queued_reason: null });
  await w.until("F", { state: "idle", queued_reason: null });
  // Held across rechecks, while it stays paused.
  await w.recheck();
  await w.until("A", { state: "pending", queued_reason: "project_paused" });

  unwrap(await w.setPaused("P-A", false));
  await w.recheck();
  await w.until("A", { state: "idle", queued_reason: null });
});

test("a session's own workspace is its project, even on an agent with none", async () => {
  const w = await world();
  unwrap(await w.setPaused("P-B", true));
  // The fleet's agent, sent into P-B (as staffing sends a project's ticket to a borrowed agent).
  unwrap(await w.spawn("S", { agent_id: FLEET_AGENT, workspace_id: "P-B" }));
  await w.until("S", {
    state: "pending",
    workspace_id: "P-B",
    queued_reason: "project_paused",
  });
  // The same agent with no workspace: the fleet's work, which no project's pause holds.
  unwrap(await w.spawnFor("F", FLEET_AGENT));
  await w.until("F", { state: "idle", queued_reason: null });
});

test("mayStartTurn: in a paused project a live session's run is held (project_paused); another project's runs; resumed, it runs", async () => {
  const w = await world();
  // Each spawned with its run 1, which ends at once: idle, and the next send is a new turn.
  unwrap(await w.spawnFor("A", AGENT_ID));
  unwrap(await w.spawnFor("B", B_AGENT));
  await w.until("A", { state: "idle" });
  await w.until("B", { state: "idle" });

  unwrap(await w.setPaused("P-A", true));
  expect(await w.lifecycle.startRun("A", operatorRun(2))).toMatchObject(
    refusedBy("project_paused"),
  );
  expect(unwrap(await w.lifecycle.startRun("B", operatorRun(2)))).toMatchObject(
    { seq: 2 },
  );
  // A hand-off packet is never checked, as under the fleet's pause.
  expect(
    unwrap(
      await w.lifecycle.startRun("A", operatorRun(2, { turn: "handoff" })),
    ),
  ).toMatchObject({ seq: 2 });
  await w.until("A", { state: "idle" });

  unwrap(await w.setPaused("P-A", false));
  expect(unwrap(await w.lifecycle.startRun("A", operatorRun(3)))).toMatchObject(
    { seq: 3 },
  );
});

test("the fleet's pause is reported before a project's", async () => {
  const w = await world();
  unwrap(await w.setPaused("P-A", true));
  unwrap(
    await seedRows(w.db, {
      settings: [{ key: "fleet.paused", value_json: "1", updated_at: T0 }],
    }),
  );
  unwrap(await w.spawnFor("A", AGENT_ID));
  await w.until("A", { state: "pending", queued_reason: "fleet_paused" });
  unwrap(
    await seedRows(w.db, {
      settings: [{ key: "fleet.paused", value_json: "0", updated_at: T0 }],
    }),
  );
  await w.recheck();
  await w.until("A", { state: "pending", queued_reason: "project_paused" });
});
