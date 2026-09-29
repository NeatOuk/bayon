// The models projects' agents run, as uses: a new project's agents run their profile's
// tier with no role binding and no step tier, and that model is the one its sessions need
// certified. Enabled agents only, labelled `<project> · <agent> agent` (`fleet · …` without one).
// Resolved per role, as a session's tier is (core sessionTier): a binding's own tier wins; a
// project's step tier covers a step; the profile's tier counts only where neither does.
import { FakeClock } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import type { StepTiers } from "@bayon/core";
import {
  modelRow,
  putRoleBinding,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { agentBoundLabel, agentBoundModels } from "./agent-bound-models.js";

const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

const profile = (id: string, runner_id: string, model_tier: string) => ({
  id,
  name: id,
  runner_id,
  model_tier,
  version: 1,
  hash: id,
  created_at: 0,
});

async function fresh(steps: Partial<StepTiers> = {}) {
  const t = unwrap(await tempDb(new FakeClock(0)));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      runners: ["runner-a", "runner-b"].map((id) => ({
        id,
        kind: "script",
        adapter: "fixture",
        caps_json: "{}",
      })),
      models: ["runner-a", "runner-b"].flatMap((id) =>
        (["complex", "standard", "cheap"] as const).map((tier) =>
          modelRow(id, tier),
        ),
      ),
      profiles: [
        profile("p-std", "runner-a", "standard"),
        profile("p-cheap", "runner-a", "cheap"),
        // A profile for another runner names no tier on this agent's.
        profile("p-b", "runner-b", "complex"),
      ],
      workspaces: [
        {
          id: "demo",
          name: "demo",
          kind: "single",
          plan_tier: steps.plan ?? null,
          build_tier: steps.build ?? null,
          review_tier: steps.review ?? null,
        },
      ],
      agents: [
        {
          id: "a1",
          name: "demo-builder-1",
          kind: "builder",
          runner_id: "runner-a",
          workspace_id: "demo",
          profile_id: "p-std",
          created_at: 0,
        },
        {
          id: "a2",
          name: "demo-reviewer-1",
          kind: "reviewer",
          runner_id: "runner-a",
          workspace_id: "demo",
          profile_id: "p-std",
          created_at: 0,
        },
        {
          id: "a3",
          name: "fleet-builder",
          kind: "builder",
          runner_id: "runner-a",
          workspace_id: null,
          profile_id: "p-cheap",
          created_at: 0,
        },
        {
          id: "a4",
          name: "off",
          kind: "builder",
          runner_id: "runner-a",
          workspace_id: "demo",
          profile_id: "p-cheap",
          enabled: 0,
          created_at: 0,
        },
        {
          id: "a5",
          name: "mismatched",
          kind: "builder",
          runner_id: "runner-a",
          workspace_id: "demo",
          profile_id: "p-b",
          created_at: 0,
        },
      ],
    }),
  );
  return t.db;
}

test("the label names the project and the agent, or the fleet", () => {
  expect(agentBoundLabel("demo", "demo-builder-1")).toBe(
    "demo · demo-builder-1 agent",
  );
  expect(agentBoundLabel(null, "b")).toBe("fleet · b agent");
});

test("each enabled agent's model is a use, by its profile's tier on its own runner; a disabled one's is not", async () => {
  const uses = unwrap(await agentBoundModels(await fresh()));
  expect(uses).toEqual([
    {
      role: "demo · demo-builder-1 agent",
      runner_id: "runner-a",
      model_id: "runner-a.standard",
    },
    {
      role: "demo · demo-reviewer-1 agent",
      runner_id: "runner-a",
      model_id: "runner-a.standard",
    },
    {
      role: "fleet · fleet-builder agent",
      runner_id: "runner-a",
      model_id: "runner-a.cheap",
    },
  ]);
});

const usesOf = async (db: TempDb["db"]) =>
  unwrap(await agentBoundModels(db)).map((u) => `${u.role} → ${u.model_id}`);

test("a reviewer agent runs its review roles' binding tier: with both bound, only the bound model is listed", async () => {
  const db = await fresh();
  for (const role of ["plan_reviewer", "code_reviewer"]) {
    unwrap(
      await putRoleBinding(
        db,
        { role, runner_id: "runner-b", model_tier: "complex" },
        "operator",
      ),
    );
  }
  expect(await usesOf(db)).toEqual([
    "demo · demo-builder-1 agent → runner-a.standard",
    "demo · demo-reviewer-1 agent → runner-a.complex",
    "fleet · fleet-builder agent → runner-a.cheap",
  ]);
});

test("a reviewer agent with one review role bound runs the binding's tier for it and its profile's for the other", async () => {
  const db = await fresh();
  unwrap(
    await putRoleBinding(
      db,
      { role: "code_reviewer", runner_id: "runner-b", model_tier: "complex" },
      "operator",
    ),
  );
  expect(await usesOf(db)).toContain(
    "demo · demo-reviewer-1 agent → runner-a.standard",
  );
  expect(await usesOf(db)).toContain(
    "demo · demo-reviewer-1 agent → runner-a.complex",
  );
});

test("a project's step tiers covering every step an agent runs leave its profile's tier unused", async () => {
  // Every step tiered: the project's agents run the step tiers (stepBoundModels lists those).
  expect(
    await usesOf(
      await fresh({ plan: "complex", build: "complex", review: "complex" }),
    ),
  ).toEqual(["fleet · fleet-builder agent → runner-a.cheap"]);
  // Only build tiered: plan and review still run the builder's profile tier.
  expect(await usesOf(await fresh({ build: "complex" }))).toEqual([
    "demo · demo-builder-1 agent → runner-a.standard",
    "demo · demo-reviewer-1 agent → runner-a.standard",
    "fleet · fleet-builder agent → runner-a.cheap",
  ]);
  // Only review tiered: the reviewer's every step is covered; the builder's plan and build are not.
  expect(await usesOf(await fresh({ review: "complex" }))).toEqual([
    "demo · demo-builder-1 agent → runner-a.standard",
    "fleet · fleet-builder agent → runner-a.cheap",
  ]);
});
