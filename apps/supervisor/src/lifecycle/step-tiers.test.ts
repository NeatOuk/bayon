// A project's tier per step at spawn: one builder agent, one profile (standard), project
// P says plan=complex and build=standard. Its `spike` session runs and records the complex tier's
// model, its `build` session the standard one; a role binding's own tier still wins; a step tier
// whose model is not certified is refused `uncertified` before any row, as any other model is. The
// fixture on FakeExecutor, a FakeClock, a real temp SQLite file. Spawns go in with no workspace of
// their own (as a pulse's), so the project is their agent's and no worktree is needed.
import { FakeClock, TEMPLATES, stepOfRunClass } from "@bayon/core";
import { getSession } from "@bayon/db";
import { putRoleBinding, seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { FIXTURE_RUNNER_ID, FIXTURE_VERSION } from "@bayon/runners/fixture";
import { afterAll, expect, test } from "vitest";
import { REVIEW_RUN_CLASS } from "../gates/run-gate.js";
import { REVIEWER_STEP } from "../gates/pick.js";
import type { InternalSpawn } from "./internal-spawn.js";
import {
  admissionRows,
  startAdmission,
  T0,
} from "./testing/admission-world.js";
import { certifyPair } from "./testing/certify.js";
import { AGENT_ID, EXECUTOR_ID } from "./testing/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

const PROJECT = "P";
const TIERS = ["complex", "standard", "cheap"] as const;
const modelOf = (tier: string) => `fixture-${tier}-model`;
const modelId = (tier: string) => `${FIXTURE_RUNNER_ID}.${tier}`;

/** AGENT_ID is P's builder; its profile runs `standard`. Each tier's model has its own string. */
async function world(o: { readonly certified?: readonly string[] } = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const rows = admissionRows({
    rows: { workspaceId: PROJECT, maxConcurrency: 4 },
  });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      models: rows.models.map((m) => ({ ...m, model: modelOf(m.tier) })),
      workspaces: [
        {
          id: PROJECT,
          name: PROJECT,
          kind: "single",
          plan_tier: "complex",
          build_tier: "standard",
        },
      ],
    }),
  );
  const w = await startAdmission(t.db, clock, { certified: false });
  cleanups.push(async () => {
    await w.shutdown();
    t.cleanup();
  });
  await certifyPair(w.db, {
    runnerId: w.adapter.id,
    runnerVersion: FIXTURE_VERSION,
    caps: w.adapter.caps(),
    executorId: EXECUTOR_ID,
    at: T0,
    modelIds: (o.certified ?? TIERS).map(modelId),
  });
  return {
    ...w,
    spawnAs: (id: string, runClass: string) =>
      w.lifecycle.spawnInternal(internal(id, runClass)),
  };
}

const internal = (id: string, runClass: string): InternalSpawn => ({
  payload: {
    session_id: id,
    agent_id: AGENT_ID,
    role: "builder",
    run_class: runClass,
  },
  run: {
    seq: 1,
    trigger: "operator",
    template: TEMPLATES.operator,
    inputs: { task: "go" },
  },
  workspace: "none",
});

test("one builder, plan=complex and build=standard: its spike runs the complex model, its build the standard one", async () => {
  const w = await world();
  unwrap(await w.spawnAs("PLAN", "spike"));
  unwrap(await w.spawnAs("BUILD", "build"));
  await w.until("PLAN", { state: "idle" });
  await w.until("BUILD", { state: "idle" });
  expect(unwrap(await getSession(w.db, "PLAN"))).toMatchObject({
    agent_id: AGENT_ID,
    run_class: "spike",
    model_tier: "complex",
    model: modelOf("complex"),
  });
  expect(unwrap(await getSession(w.db, "BUILD"))).toMatchObject({
    agent_id: AGENT_ID,
    run_class: "build",
    model_tier: "standard",
    model: modelOf("standard"),
  });
});

test("a step the project leaves unset, and a run class with no step, inherit the profile's tier", async () => {
  const w = await world();
  // review is unset in P; `pulse` is no step at all.
  unwrap(await w.spawnAs("REVIEW", "review"));
  unwrap(await w.spawnAs("PULSE", "pulse"));
  for (const id of ["REVIEW", "PULSE"]) {
    await w.until(id, { state: "idle" });
    expect(unwrap(await getSession(w.db, id)), id).toMatchObject({
      model_tier: "standard",
      model: modelOf("standard"),
    });
  }
});

test("the role binding's own tier wins over the project's step tier", async () => {
  const w = await world();
  unwrap(
    await putRoleBinding(
      w.db,
      { role: "builder", runner_id: FIXTURE_RUNNER_ID, model_tier: "cheap" },
      "operator",
    ),
  );
  unwrap(await w.spawnAs("PLAN", "spike"));
  await w.until("PLAN", { state: "idle" });
  expect(unwrap(await getSession(w.db, "PLAN"))).toMatchObject({
    model_tier: "cheap",
    model: modelOf("cheap"),
  });
});

test("a step tier whose model is not certified is refused `uncertified` before any row; the other step still runs", async () => {
  const w = await world({ certified: ["standard"] });
  expect(await w.spawnAs("PLAN", "spike")).toMatchObject({
    ok: false,
    error: {
      class: "admission_refused",
      cause: { gate: "uncertified" },
      message: expect.stringContaining(`model ${modelOf("complex")}`),
    },
  });
  expect((await getSession(w.db, "PLAN")).ok).toBe(false);
  unwrap(await w.spawnAs("BUILD", "build"));
  await w.until("BUILD", { state: "idle", model_tier: "standard" });
});

test("a gate's reviewer runs run class review, whose step is the pick's", () => {
  expect(stepOfRunClass(REVIEW_RUN_CLASS)).toBe(REVIEWER_STEP);
});
