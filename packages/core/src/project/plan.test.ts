import { describe, expect, test } from "vitest";
import {
  checkOriginUrl,
  checkProjectName,
  parseProjectPlanInput,
  projectIds,
  projectPlan,
  projectStaff,
  type ProjectPlanInput,
} from "./plan.js";

const REPO = "git@github.com:acme/app.git";

const INPUT: ProjectPlanInput = {
  name: "demo",
  repoUrl: REPO,
  runner: "fixture",
  executor: "local",
  orchestrator: true,
  reviewerRunner: "fixture",
};

describe("checkProjectName", () => {
  test.each([
    ["demo", true],
    ["demo-1", true],
    ["a", true],
    ["a".repeat(32), true],
    ["Demo", false],
    ["de mo", false],
    ["", false],
    ["a".repeat(33), false],
    ["frm-demo", false],
  ])("%j is valid: %s", (name, valid) => {
    expect(checkProjectName(name).ok).toBe(valid);
  });
});

describe("checkOriginUrl", () => {
  test.each([
    ["https://example.com/acme/app.git", true],
    ["http://example.com/acme/app.git", true],
    ["ssh://git@example.com/acme/app.git", true],
    ["git@github.com:acme/app.git", true],
    ["/home/frm/repos/app", false],
    ["./relative/path", false],
    ["javascript:alert(1)", false],
    ["", false],
  ])("%j is valid: %s", (url, valid) => {
    expect(checkOriginUrl(url).ok).toBe(valid);
  });
});

describe("parseProjectPlanInput", () => {
  test("a valid input parses to itself", () => {
    expect(parseProjectPlanInput(INPUT)).toEqual({ ok: true, value: INPUT });
  });

  test("a bad name is refused before the url is even checked", () => {
    const parsed = parseProjectPlanInput({ ...INPUT, name: "Demo" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("must match");
  });

  test("a bad origin_url is refused", () => {
    const parsed = parseProjectPlanInput({ ...INPUT, repoUrl: "/local/path" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("must be https");
  });
});

describe("projectIds and projectStaff", () => {
  test("derived ids: repo = workspace = name, three profiles, three agents", () => {
    expect(projectIds(INPUT)).toEqual({
      repo: "demo",
      workspace: "demo",
      builderProfile: "demo-build",
      builder: "demo-builder",
      orchestrator: { agent: "demo-orchestrator", profile: "demo-orchestrate" },
      reviewer: {
        agent: "demo-reviewer",
        profile: "demo-review",
        runner: "fixture",
      },
    });
    expect(
      projectIds({ ...INPUT, orchestrator: false }).orchestrator,
    ).toBeNull();
    expect(projectIds({ ...INPUT, reviewerRunner: null }).reviewer).toBeNull();
  });

  test("staff: builder always, orchestrator and reviewer unless suppressed", () => {
    const ids = projectIds(INPUT);
    expect(projectStaff(INPUT, ids)).toEqual([
      {
        id: "demo-builder",
        kind: "builder",
        profile: "demo-build",
        runner: "fixture",
      },
      {
        id: "demo-orchestrator",
        kind: "orchestrator",
        profile: "demo-orchestrate",
        runner: "fixture",
      },
      {
        id: "demo-reviewer",
        kind: "reviewer",
        profile: "demo-review",
        runner: "fixture",
      },
    ]);
  });

  test("--no-orchestrator-equivalent: no orchestrator entry", () => {
    const noOrch = { ...INPUT, orchestrator: false };
    const ids = projectIds(noOrch);
    expect(projectStaff(noOrch, ids).map((s) => s.kind)).toEqual([
      "builder",
      "reviewer",
    ]);
  });

  test("--no-reviewer-equivalent: no reviewer entry", () => {
    const solo = { ...INPUT, reviewerRunner: null };
    const ids = projectIds(solo);
    expect(projectStaff(solo, ids).map((s) => s.kind)).toEqual([
      "builder",
      "orchestrator",
    ]);
  });

  test("a distinct reviewer runner staffs the reviewer on it, not the main runner", () => {
    const critic = { ...INPUT, reviewerRunner: "critic" };
    const ids = projectIds(critic);
    expect(
      projectStaff(critic, ids).find((s) => s.kind === "reviewer"),
    ).toMatchObject({
      runner: "critic",
    });
  });
});

describe("projectPlan: row assembly, no I/O", () => {
  test("the exact rows a door writes, short mirror_path/allowlist/hash/created_at", () => {
    const ids = projectIds(INPUT);
    const plan = projectPlan(INPUT, ids);
    expect(plan.repo).toEqual({ id: "demo", name: "demo", origin_url: REPO });
    expect(plan.workspace).toEqual({
      id: "demo",
      name: "demo",
      kind: "single",
    });
    expect(plan.workspaceRepo).toEqual({
      workspace_id: "demo",
      repo_id: "demo",
      rel_path: "demo",
    });
    expect(plan.profiles).toEqual([
      {
        id: "demo-build",
        name: "demo-build",
        runner_id: "fixture",
        model_tier: "standard",
      },
      {
        id: "demo-orchestrate",
        name: "demo-orchestrate",
        runner_id: "fixture",
        model_tier: "standard",
      },
      {
        id: "demo-review",
        name: "demo-review",
        runner_id: "fixture",
        model_tier: "standard",
      },
    ]);
    expect(plan.agents).toEqual([
      {
        id: "demo-builder",
        name: "demo-builder",
        kind: "builder",
        runner_id: "fixture",
        executor_id: "local",
        profile_id: "demo-build",
        workspace_id: "demo",
      },
      {
        id: "demo-orchestrator",
        name: "demo-orchestrator",
        kind: "orchestrator",
        runner_id: "fixture",
        executor_id: "local",
        profile_id: "demo-orchestrate",
        workspace_id: "demo",
      },
      {
        id: "demo-reviewer",
        name: "demo-reviewer",
        kind: "reviewer",
        runner_id: "fixture",
        executor_id: "local",
        profile_id: "demo-review",
        workspace_id: "demo",
      },
    ]);
  });

  test("--reviewer-runner puts the review profile and reviewer on it; no reviewer drops both", () => {
    const critic = { ...INPUT, reviewerRunner: "critic" };
    const criticPlan = projectPlan(critic, projectIds(critic));
    expect(criticPlan.profiles.map((p) => [p.id, p.runner_id])).toEqual([
      ["demo-build", "fixture"],
      ["demo-orchestrate", "fixture"],
      ["demo-review", "critic"],
    ]);

    const solo = { ...INPUT, reviewerRunner: null };
    const soloPlan = projectPlan(solo, projectIds(solo));
    expect(soloPlan.profiles.map((p) => p.id)).toEqual([
      "demo-build",
      "demo-orchestrate",
    ]);
    expect(soloPlan.agents.some((a) => a.kind === "reviewer")).toBe(false);
  });

  test("base sets default_base_branch; no orchestrator drops both its rows", () => {
    const withBase = projectPlan(
      { ...INPUT, base: "trunk" },
      projectIds(INPUT),
    );
    expect(withBase.repo).toMatchObject({ default_base_branch: "trunk" });

    const noOrch = { ...INPUT, orchestrator: false };
    const plan = projectPlan(noOrch, projectIds(noOrch));
    expect(plan.profiles.map((p) => p.id)).toEqual([
      "demo-build",
      "demo-review",
    ]);
    expect(plan.agents.map((a) => a.id)).toEqual([
      "demo-builder",
      "demo-reviewer",
    ]);
  });
});
