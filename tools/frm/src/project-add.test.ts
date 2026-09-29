import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  getAgent,
  getProfile,
  getRepo,
  getWorkspace,
  listReviewerAgents,
} from "@bayon/db";
import {
  modelRow,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { CATALOGUE_TOOLS } from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseCli } from "./cli.js";
import {
  idsOf,
  parseProjectAddCli,
  runProjectAddCommand,
  toConfigRows,
  type ProjectAddCommand,
} from "./project-add.js";

const REPO = "git@github.com:acme/app.git";
const BASE = ["add", "demo", "--repo", REPO, "--runner", "fixture"];

const failure = (argv: string[]) => {
  const parsed = parseProjectAddCli(argv);
  return parsed.ok ? "parsed" : parsed.error.message;
};

describe("parseProjectAddCli", () => {
  test("defaults: the given runner on local, an orchestrator, a reviewer on the same runner, not a dry run", () => {
    expect(parseProjectAddCli(["project", ...BASE])).toEqual({
      ok: true,
      value: {
        name: "demo",
        repo: REPO,
        runner: "fixture",
        executor: "local",
        orchestrator: true,
        reviewerRunner: "fixture",
        dryRun: false,
      },
    });
  });

  test("--reviewer-runner names the reviewer's runner; --no-reviewer drops it", () => {
    expect(
      parseProjectAddCli(["project", ...BASE, "--reviewer-runner", "critic"]),
    ).toMatchObject({ ok: true, value: { reviewerRunner: "critic" } });
    expect(
      parseProjectAddCli(["project", ...BASE, "--no-reviewer"]),
    ).toMatchObject({ ok: true, value: { reviewerRunner: null } });
  });

  test("every flag reaches the command", () => {
    const parsed = parseProjectAddCli([
      "project",
      "add",
      "demo",
      "--repo",
      REPO,
      "--runner",
      "fixture",
      "--executor",
      "ctr-1",
      "--base",
      "trunk",
      "--reviewer-runner",
      "critic",
      "--no-orchestrator",
      "--dry-run",
    ]);
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "demo",
        repo: REPO,
        runner: "fixture",
        executor: "ctr-1",
        base: "trunk",
        orchestrator: false,
        reviewerRunner: "critic",
        dryRun: true,
      },
    });
  });

  test.each([
    [["project"], "usage"],
    [["project", "rm", "demo"], "usage"],
    [["project", "add"], "usage"],
    [["project", ...BASE, "extra"], "usage"],
    [
      ["project", "add", "Demo", "--repo", REPO, "--runner", "fixture"],
      "must match",
    ],
    [
      ["project", "add", "de mo", "--repo", REPO, "--runner", "fixture"],
      "must match",
    ],
    [["project", "add", "demo", "--runner", "fixture"], "--repo"],
    [["project", "add", "demo", "--repo", "", "--runner", "fixture"], "--repo"],
    [["project", "add", "demo", "--repo", REPO], "--runner"],
    [["project", "add", "demo", "--repo", REPO, "--runner", ""], "--runner"],
    [["project", ...BASE, "--bogus"], "Unknown option"],
    [
      ["project", ...BASE, "--reviewer-runner", "critic", "--no-reviewer"],
      "conflict",
    ],
    [["project", ...BASE, "--reviewer-runner", ""], "--reviewer-runner"],
  ])("%j is refused (%s)", (argv, reason) => {
    expect(failure(argv)).toContain(reason);
  });

  test("wired into frm's own cli", () => {
    expect(parseCli(["project", ...BASE])).toMatchObject({
      ok: true,
      value: { command: "project" },
    });
  });
});

describe("idsOf and toConfigRows: row assembly, no database", () => {
  const cmd: ProjectAddCommand = {
    name: "demo",
    repo: REPO,
    runner: "fixture",
    executor: "local",
    orchestrator: true,
    reviewerRunner: "fixture",
    dryRun: false,
  };

  test("derived ids: repo = workspace = <name>, three profiles, three agents", () => {
    expect(idsOf(cmd)).toEqual({
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
    expect(idsOf({ ...cmd, orchestrator: false }).orchestrator).toBeNull();
    expect(idsOf({ ...cmd, reviewerRunner: null }).reviewer).toBeNull();
  });

  test("the exact rows seedConfig would receive, mission_id absent", async () => {
    const ids = idsOf(cmd);
    const rows = await toConfigRows(cmd, ids, "/home/frm", 1_000);
    expect(rows.repos).toEqual([
      {
        id: "demo",
        name: "demo",
        origin_url: REPO,
        mirror_path: join("/home/frm", "mirrors", "demo.git"),
      },
    ]);
    expect(rows.workspaces).toEqual([
      { id: "demo", name: "demo", kind: "single" },
    ]);
    expect(rows.workspace_repos).toEqual([
      { workspace_id: "demo", repo_id: "demo", rel_path: "demo" },
    ]);
    expect(rows.profiles?.map((p) => p["id"])).toEqual([
      "demo-build",
      "demo-orchestrate",
      "demo-review",
    ]);
    for (const p of rows.profiles ?? []) {
      expect(p).not.toHaveProperty("tool_allowlist_json_given");
      // No hand-written permissions: the role's core command policy applies.
      expect(p).not.toHaveProperty("permission_json");
      expect(JSON.parse(String(p["tool_allowlist_json"]))).toEqual(
        CATALOGUE_TOOLS,
      );
      expect(p["version"]).toBe(1);
      expect(p["created_at"]).toBe(1_000);
    }
    expect(rows.agents).toEqual([
      {
        id: "demo-builder",
        name: "demo-builder",
        kind: "builder",
        runner_id: "fixture",
        executor_id: "local",
        profile_id: "demo-build",
        workspace_id: "demo",
        created_at: 1_000,
      },
      {
        id: "demo-orchestrator",
        name: "demo-orchestrator",
        kind: "orchestrator",
        runner_id: "fixture",
        executor_id: "local",
        profile_id: "demo-orchestrate",
        workspace_id: "demo",
        created_at: 1_000,
      },
      {
        id: "demo-reviewer",
        name: "demo-reviewer",
        kind: "reviewer",
        runner_id: "fixture",
        executor_id: "local",
        profile_id: "demo-review",
        workspace_id: "demo",
        created_at: 1_000,
      },
    ]);
    expect(rows.agents?.every((a) => !("mission_id" in a))).toBe(true);
  });

  test("--reviewer-runner puts the review profile and reviewer on it; --no-reviewer drops both", async () => {
    const critic = { ...cmd, reviewerRunner: "critic" };
    const rows = await toConfigRows(critic, idsOf(critic), "/home/frm", 1_000);
    expect(rows.profiles?.map((p) => [p["id"], p["runner_id"]])).toEqual([
      ["demo-build", "fixture"],
      ["demo-orchestrate", "fixture"],
      ["demo-review", "critic"],
    ]);
    expect(rows.agents?.find((a) => a.kind === "reviewer")).toMatchObject({
      id: "demo-reviewer",
      runner_id: "critic",
      profile_id: "demo-review",
    });

    const solo = { ...cmd, reviewerRunner: null };
    const bare = await toConfigRows(solo, idsOf(solo), "/home/frm", 1_000);
    expect(bare.profiles?.map((p) => p["id"])).toEqual([
      "demo-build",
      "demo-orchestrate",
    ]);
    expect(bare.agents?.some((a) => a.kind === "reviewer")).toBe(false);
  });

  test("--base sets default_base_branch; --no-orchestrator drops both new rows", async () => {
    const withBase = await toConfigRows(
      { ...cmd, base: "trunk" },
      idsOf(cmd),
      "/home/frm",
      1_000,
    );
    expect(withBase.repos?.[0]).toMatchObject({ default_base_branch: "trunk" });

    const noOrch = { ...cmd, orchestrator: false };
    const rows = await toConfigRows(noOrch, idsOf(noOrch), "/home/frm", 1_000);
    expect(rows.profiles?.map((p) => p["id"])).toEqual([
      "demo-build",
      "demo-review",
    ]);
    expect(rows.agents?.map((a) => a.id)).toEqual([
      "demo-builder",
      "demo-reviewer",
    ]);
  });
});

/** The tier a new project's profiles start on (core DEFAULT_MODEL_TIER): its agents' model. */
const DEFAULT_MODEL_TIER = "standard";

describe("runProjectAddCommand", () => {
  let t: TempDb;
  const home = mkdtempSync(join(tmpdir(), "frm-project-add-"));

  beforeAll(async () => {
    t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
    // The runner and executor rows profiles and agents point at, as a booted supervisor leaves them.
    unwrap(await seedSpine(t.db, 1));
    // The fixture's models, as its registration leaves them: certification is per model.
    unwrap(
      await seedRows(t.db, {
        models: (["complex", "standard", "cheap"] as const).map((tier) =>
          modelRow("fixture", tier),
        ),
      }),
    );
  });
  afterAll(() => {
    t.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  const run = async (argv: string[], env: Record<string, string> = {}) => {
    const parsed = parseProjectAddCli(argv);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const out: string[] = [];
    const errs: string[] = [];
    const code = await runProjectAddCommand(parsed.value, {
      env: { FRM_HOME: home, FRM_DB: t.path, ...env },
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
    });
    return { code, out: out.join("\n"), err: errs.join("\n") };
  };

  test("writes a repo, a workspace, three profiles, three agents; prints what it made", async () => {
    const r = await run([
      "project",
      "add",
      "app1",
      "--repo",
      REPO,
      "--runner",
      "fixture",
    ]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain(
      "project app1: 1 repos, 1 workspaces, 1 workspace_repos, 3 profiles, 3 agents",
    );
    // A review can run: a reviewer agent of the runner in the project, its profile with no
    // hand-written permissions.
    expect(unwrap(await getAgent(t.db, "app1-reviewer"))).toMatchObject({
      kind: "reviewer",
      runner_id: "fixture",
      executor_id: "local",
      profile_id: "app1-review",
      enabled: 1,
    });
    expect(unwrap(await getProfile(t.db, "app1-review"))).toMatchObject({
      runner_id: "fixture",
      permission_json: "{}",
    });
    expect(
      unwrap(await listReviewerAgents(t.db, "fixture", "app1")).map(
        (a) => a.id,
      ),
    ).toContain("app1-reviewer");
    // The fixture declares no structured output: plan reviews only, and the owner is told so.
    expect(r.out).toContain(
      "warning     fixture has no structured output: plan reviews will run, but code reviews need a runner with structured output bound to code_reviewer",
    );
    expect(unwrap(await getRepo(t.db, "app1"))).toMatchObject({
      origin_url: REPO,
      mirror_path: join(home, "mirrors", "app1.git"),
    });
    expect(unwrap(await getWorkspace(t.db, "app1"))).toMatchObject({
      kind: "single",
    });
    expect(unwrap(await getProfile(t.db, "app1-build"))).toMatchObject({
      runner_id: "fixture",
    });
    expect(unwrap(await getProfile(t.db, "app1-orchestrate"))).toMatchObject({
      runner_id: "fixture",
    });
    expect(unwrap(await getAgent(t.db, "app1-builder"))).toMatchObject({
      kind: "builder",
      workspace_id: "app1",
    });
    expect(unwrap(await getAgent(t.db, "app1-orchestrator"))).toMatchObject({
      kind: "orchestrator",
    });
  });

  test("--no-orchestrator: only the builder profile and agent exist", async () => {
    const r = await run([
      "project",
      "add",
      "app2",
      "--repo",
      REPO,
      "--runner",
      "fixture",
      "--no-orchestrator",
    ]);
    expect(r.code).toBe(0);
    expect(unwrap(await getAgent(t.db, "app2-builder"))).toMatchObject({
      kind: "builder",
    });
    expect((await getProfile(t.db, "app2-orchestrate")).ok).toBe(false);
    expect((await getAgent(t.db, "app2-orchestrator")).ok).toBe(false);
  });

  test("--no-reviewer: no review profile, no reviewer agent, no structured-output warning", async () => {
    const r = await run([
      "project",
      "add",
      "app5",
      "--repo",
      REPO,
      "--runner",
      "fixture",
      "--no-reviewer",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 profiles, 2 agents");
    expect((await getProfile(t.db, "app5-review")).ok).toBe(false);
    expect((await getAgent(t.db, "app5-reviewer")).ok).toBe(false);
    expect(r.out).not.toContain("structured output");
  });

  test("--reviewer-runner with structured output: the reviewer is on it, no warning; its pair's certify hint is printed", async () => {
    unwrap(
      await seedRows(t.db, {
        runners: [
          {
            id: "critic",
            kind: "script",
            adapter: "fixture",
            caps_json: JSON.stringify({ outputSchema: true }),
          },
        ],
        models: [modelRow("critic", "standard")],
      }),
    );
    const r = await run([
      "project",
      "add",
      "app6",
      "--repo",
      REPO,
      "--runner",
      "fixture",
      "--reviewer-runner",
      "critic",
    ]);
    expect(r.code).toBe(0);
    expect(unwrap(await getAgent(t.db, "app6-reviewer"))).toMatchObject({
      kind: "reviewer",
      runner_id: "critic",
    });
    expect(unwrap(await getProfile(t.db, "app6-review")).runner_id).toBe(
      "critic",
    );
    expect(r.out).not.toContain("structured output");
    expect(r.out).toContain(
      "frm runner conformance critic --model critic.standard --executor local",
    );
  });

  test("an unregistered --reviewer-runner writes nothing", async () => {
    const r = await run([
      "project",
      "add",
      "app7",
      "--repo",
      REPO,
      "--runner",
      "fixture",
      "--reviewer-runner",
      "nobody",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("nothing written");
    expect((await getRepo(t.db, "app7")).ok).toBe(false);
    expect((await getAgent(t.db, "app7-builder")).ok).toBe(false);
  });

  test("an existing name is refused before any write, with a good message", async () => {
    const before = unwrap(await getRepo(t.db, "app1"));
    const r = await run([
      "project",
      "add",
      "app1",
      "--repo",
      "https://example.com/different.git",
      "--runner",
      "fixture",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("project app1 already exists (repo app1)");
    expect(unwrap(await getRepo(t.db, "app1"))).toEqual(before);
  });

  test("uncertified (runner, model): the exact next command is printed, naming the model", async () => {
    const r = await run([
      "project",
      "add",
      "app3",
      "--repo",
      REPO,
      "--runner",
      "fixture",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `frm runner conformance fixture --model fixture.${DEFAULT_MODEL_TIER} --executor local`,
    );
  });

  test("a certified pair prints no warning", async () => {
    unwrap(
      await seedRows(t.db, {
        runner_certifications: [
          {
            runner_id: "fixture",
            executor_id: "local",
            model_id: `fixture.${DEFAULT_MODEL_TIER}`,
            model: `fixture-${DEFAULT_MODEL_TIER}-model`,
            runner_version: "1",
            suite_version: "1",
            kit_hash: "0".repeat(64),
            caps_hash: "0".repeat(64),
            result_json: "{}",
            gate_eligible: 1,
            passed_at: 1_700_000_000_000,
            certified_at: 1_700_000_000_000,
          },
        ],
      }),
    );
    const r = await run([
      "project",
      "add",
      "app4",
      "--repo",
      REPO,
      "--runner",
      "fixture",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("frm runner conformance");
  });

  test("--dry-run prints the rows and opens no database at all", async () => {
    const freshHome = mkdtempSync(join(tmpdir(), "frm-project-add-dry-"));
    try {
      const parsed = parseProjectAddCli([
        "project",
        "add",
        "dry1",
        "--repo",
        REPO,
        "--runner",
        "fixture",
        "--dry-run",
      ]);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const out: string[] = [];
      const code = await runProjectAddCommand(parsed.value, {
        env: { FRM_HOME: freshHome },
        out: (l) => out.push(l),
        err: () => {
          throw new Error("unexpected error output");
        },
      });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("project dry1: 1 repos");
      expect(out.join("\n")).toContain(
        "dry1-build, dry1-orchestrate, dry1-review",
      );
      expect(out.join("\n")).toContain(
        "code reviews need structured output on fixture (not checked: --dry-run)",
      );
      expect(existsSync(join(freshHome, "foreman.db"))).toBe(false);
    } finally {
      rmSync(freshHome, { recursive: true, force: true });
    }
  });

  test("no FRM_HOME: usage error", async () => {
    const r = await run(
      ["project", "add", "x", "--repo", REPO, "--runner", "fixture"],
      { FRM_HOME: "" },
    );
    expect(r.code).toBe(2);
  });
});
