// The models counted as bound, against a real temp database: a role binding's
// on its runner and fallback, and — so a step tier's model is certified by default rather than found
// out as every spawn refused — each model a project's step tier selects, on the runner of each agent
// that runs the step, labelled `<project> · <step> step`. A binding with its own tier wins, and adds
// nothing for the step.
import { FakeClock, type StepTiers } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterEach, expect, test } from "vitest";
import type { AgentsTable } from "../schema.js";
import {
  modelRow,
  putRoleBinding,
  seedRows,
  tempDb,
  unwrap,
  updateRowForTest,
  type TempDb,
} from "../testing.js";
import { listBoundModels } from "./role-models.js";
import { stepBoundLabel } from "./step-bound-models.js";

const RUNNERS = ["runner-a", "runner-b", "runner-c"] as const;
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

const agent = (
  id: string,
  kind: "builder" | "reviewer",
  runner_id: string,
  workspace_id: string | null,
  o: Partial<Insertable<AgentsTable>> = {},
): Insertable<AgentsTable> => ({
  id,
  name: id,
  kind,
  runner_id,
  workspace_id,
  created_at: 0,
  ...o,
});

/** Runners a, b, c with a model per tier; project P (builder on a, reviewer on b) and Q (none). */
async function fresh(
  steps: Partial<StepTiers> = {},
  agents: readonly Insertable<AgentsTable>[] = [
    agent("P-builder", "builder", "runner-a", "P"),
    agent("P-reviewer", "reviewer", "runner-b", "P"),
  ],
) {
  const t = unwrap(await tempDb(new FakeClock(0)));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      runners: RUNNERS.map((id) => ({
        id,
        kind: "script",
        adapter: "fixture",
        caps_json: "{}",
      })),
      models: RUNNERS.flatMap((id) =>
        (["complex", "standard", "cheap"] as const).map((tier) =>
          modelRow(id, tier),
        ),
      ),
      workspaces: [
        {
          id: "P",
          name: "P",
          kind: "single",
          plan_tier: steps.plan ?? null,
          build_tier: steps.build ?? null,
          review_tier: steps.review ?? null,
        },
        { id: "Q", name: "Q", kind: "single" },
      ],
      agents: [...agents],
    }),
  );
  return t.db;
}

const boundOf = async (db: TempDb["db"]) =>
  unwrap(await listBoundModels(db)).map((b) => ({
    role: b.role,
    runner: b.runner_id,
    model: b.model_id,
    step: b.step?.step ?? null,
  }));

test("with no step tier and no binding, nothing is bound", async () => {
  expect(await boundOf(await fresh())).toEqual([]);
});

test("a step-tier-only model is bound: plan and build on the project's builder's runner, review on its reviewer's and, for ce_review, its builder's", async () => {
  const db = await fresh({
    plan: "complex",
    build: "cheap",
    review: "complex",
  });
  expect(await boundOf(db)).toEqual([
    {
      role: "P · plan step",
      runner: "runner-a",
      model: "runner-a.complex",
      step: "plan",
    },
    {
      role: "P · build step",
      runner: "runner-a",
      model: "runner-a.cheap",
      step: "build",
    },
    {
      role: "P · review step",
      runner: "runner-b",
      model: "runner-b.complex",
      step: "review",
    },
    {
      role: "P · review step",
      runner: "runner-a",
      model: "runner-a.complex",
      step: "review",
    },
  ]);
  expect(stepBoundLabel("P", "build")).toBe("P · build step");
});

test("a role binding with its own tier wins: its role adds nothing for the step, and its own model is listed", async () => {
  const db = await fresh({ build: "complex" });
  unwrap(
    await putRoleBinding(
      db,
      { role: "builder", runner_id: "runner-c", model_tier: "cheap" },
      "operator",
    ),
  );
  expect(await boundOf(db)).toEqual([
    {
      role: "builder",
      runner: "runner-c",
      model: "runner-c.cheap",
      step: null,
    },
  ]);
  // A binding with no tier leaves the step's model bound.
  unwrap(
    await putRoleBinding(
      db,
      { role: "builder", runner_id: "runner-c", model_tier: null },
      "operator",
    ),
  );
  expect(await boundOf(db)).toEqual([
    {
      role: "P · build step",
      runner: "runner-a",
      model: "runner-a.complex",
      step: "build",
    },
  ]);
});

test("a project with no agents of its own runs the fleet's: enabled ones, reviewers narrowed to the binding's runners", async () => {
  const db = await fresh({ review: "standard" }, [
    agent("F-builder", "builder", "runner-a", null),
    agent("F-builder-off", "builder", "runner-b", null, { enabled: 0 }),
    agent("F-rev-b", "reviewer", "runner-b", null),
    agent("F-rev-c", "reviewer", "runner-c", null),
    // Another project's reviewer is never P's.
    agent("Q-rev", "reviewer", "runner-a", "Q"),
  ]);
  unwrap(
    await putRoleBinding(
      db,
      { role: "code_reviewer", runner_id: "runner-c", model_tier: null },
      "operator",
    ),
  );
  const review = (await boundOf(db)).filter((b) => b.step === "review");
  // plan_reviewer is unbound: every fleet reviewer; code_reviewer: its runner only; ce_review: the
  // enabled fleet builder. One entry per runner.
  expect(review.map((b) => b.runner)).toEqual([
    "runner-b",
    "runner-c",
    "runner-a",
  ]);
});

test("a project's own disabled agents keep the fleet out, and run nothing", async () => {
  const db = await fresh({ build: "standard" }, [
    agent("P-builder-off", "builder", "runner-a", "P", { enabled: 0 }),
    agent("F-builder", "builder", "runner-b", null),
  ]);
  expect(await boundOf(db)).toEqual([]);
});

test("a step tier with no active model of it on the runner binds nothing there", async () => {
  const db = await fresh({ plan: "complex" });
  unwrap(
    await updateRowForTest(db, "models", "runner-a.complex", { active: 0 }),
  );
  expect(await boundOf(db)).toEqual([]);
});
