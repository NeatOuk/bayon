import { describe, expect, test } from "vitest";
import {
  projectAgentId,
  projectAgentPlan,
  projectAgentProfile,
  type ProjectAgentInput,
} from "./agent-plan.js";
import { projectIds, projectPlan, type ProjectPlanInput } from "./plan.js";

const PROJECT: ProjectPlanInput = {
  name: "demo",
  repoUrl: "https://example.com/demo.git",
  runner: "fixture",
  executor: "local",
  orchestrator: true,
  reviewerRunner: "fixture",
};
/** Every agent id and name `projectPlan` gives `demo`. */
const CREATED = new Set(
  projectPlan(PROJECT, projectIds(PROJECT)).agents.flatMap((a) => [
    a.id,
    a.name,
  ]),
);
const BUILDER: ProjectAgentInput = {
  workspace: "demo",
  kind: "builder",
  runner: "runner-b",
};

describe("projectAgentPlan", () => {
  test("the first builder beside projectPlan's demo-builder is demo-builder-1, on its own runner's profile", () => {
    expect(CREATED.has("demo-builder")).toBe(true);
    expect(
      projectAgentPlan(BUILDER, { taken: CREATED, executor: "local" }),
    ).toEqual({
      profile: {
        id: "demo-builder-runner-b",
        name: "demo-builder-runner-b",
        runner_id: "runner-b",
        model_tier: "standard",
      },
      agent: {
        id: "demo-builder-1",
        name: "demo-builder-1",
        kind: "builder",
        runner_id: "runner-b",
        executor_id: "local",
        profile_id: "demo-builder-runner-b",
        workspace_id: "demo",
      },
    });
  });

  test("a reviewer is numbered on its own: demo-reviewer-1, though demo-builder-1 exists", () => {
    const taken = new Set([...CREATED, "demo-builder-1"]);
    const plan = projectAgentPlan(
      { ...BUILDER, kind: "reviewer" },
      { taken, executor: null },
    );
    expect(plan.agent).toMatchObject({
      id: "demo-reviewer-1",
      kind: "reviewer",
      executor_id: null,
      profile_id: "demo-reviewer-runner-b",
    });
  });

  test("an orchestrator beside projectPlan's demo-orchestrator is demo-orchestrator-1, on an orchestrate profile per runner", () => {
    expect(CREATED.has("demo-orchestrator")).toBe(true);
    expect(
      projectAgentPlan(
        { ...BUILDER, kind: "orchestrator" },
        { taken: CREATED, executor: "local" },
      ),
    ).toEqual({
      profile: {
        id: "demo-orchestrate-runner-b",
        name: "demo-orchestrate-runner-b",
        runner_id: "runner-b",
        model_tier: "standard",
      },
      agent: {
        id: "demo-orchestrator-1",
        name: "demo-orchestrator-1",
        kind: "orchestrator",
        runner_id: "runner-b",
        executor_id: "local",
        profile_id: "demo-orchestrate-runner-b",
        workspace_id: "demo",
      },
    });
    // projectPlan's own is `<ws>-orchestrate`: the added one's word is the same, made per runner.
    expect(projectPlan(PROJECT, projectIds(PROJECT)).profiles).toContainEqual(
      expect.objectContaining({ id: "demo-orchestrate" }),
    );
    expect(
      projectAgentProfile({
        workspace: "demo",
        kind: "orchestrator",
        runner: "fixture",
      }).id,
    ).toBe("demo-orchestrate-fixture");
  });

  test("two builders on one runner share a profile; another runner gets its own", () => {
    const same = projectAgentProfile(BUILDER);
    expect(projectAgentProfile({ ...BUILDER })).toEqual(same);
    expect(projectAgentProfile({ ...BUILDER, runner: "fixture" }).id).toBe(
      "demo-builder-fixture",
    );
    expect(projectAgentProfile({ ...BUILDER, workspace: "other" }).id).toBe(
      "other-builder-runner-b",
    );
  });
});

describe("projectAgentId", () => {
  test.each<[string, readonly string[], string]>([
    ["nothing taken", [], "demo-builder-1"],
    ["1 and 2 taken", ["demo-builder-1", "demo-builder-2"], "demo-builder-3"],
    [
      "a gap: the smallest free",
      ["demo-builder-1", "demo-builder-3"],
      "demo-builder-2",
    ],
    [
      "another project's numbers do not count",
      ["demo2-builder-1", "other-builder-1"],
      "demo-builder-1",
    ],
    [
      "a hand-named agent is skipped",
      ["demo-builder", "demo-builder-1"],
      "demo-builder-2",
    ],
  ])("%s", (_, taken, expected) => {
    expect(projectAgentId("demo", "builder", new Set(taken))).toBe(expected);
  });
});
