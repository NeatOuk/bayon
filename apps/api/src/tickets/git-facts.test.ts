import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  gatherGitFacts,
  runGit,
  type GitFactsInput,
  type GitWorktree,
} from "./git-facts.js";
import { loadWorkRoot } from "../config.js";

// no_source_changes and the plan artifact against real git repositories (§3.2 L2). /tmp/frm-*
// keeps paths short on macOS.

const root = realpathSync(mkdtempSync("/tmp/frm-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

let repos = 0;

/** A repo under <root>/work with src/a.ts and README.md committed as the base. */
function repo(): { readonly path: string; readonly base: string } {
  repos += 1;
  const path = join(root, "work", `r${repos}`);
  mkdirSync(join(path, "src"), { recursive: true });
  mkdirSync(join(path, "docs", "spikes"), { recursive: true });
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(path, "README.md"), "# r\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "base");
  return { path, base: git(path, "rev-parse", "HEAD") };
}

const worktree = (
  path: string,
  base: string,
  o: Partial<GitWorktree> = {},
): GitWorktree => ({
  id: "W1",
  path,
  base_sha: base,
  state: "active",
  session_id: "S1",
  executor_kind: "local",
  ...o,
});

const input = (
  worktrees: readonly GitWorktree[],
  o: Partial<GitFactsInput> = {},
): GitFactsInput => ({
  worktrees,
  planPath: "docs/spikes/T1.md",
  need: new Set(["plan", "diff"]),
  planPaths: { prefixes: ["docs/"], suffixes: [".md"] },
  timeoutMs: 5_000,
  workRoot: join(root, "work"),
  ...o,
});

const plan = (path: string) =>
  writeFileSync(join(path, "docs", "spikes", "T1.md"), "# plan\n");

describe("a plan-only diff", () => {
  test("is clean, the plan is present, and the evidence names both", async () => {
    const r = repo();
    plan(r.path);
    writeFileSync(join(r.path, "NOTES.md"), "notes\n");
    const facts = await gatherGitFacts(input([worktree(r.path, r.base)]));
    expect(facts.plan).toEqual({ state: "present" });
    expect(facts.diff).toEqual({ state: "clean", files: 2 });
    expect(facts.worktreeIds).toEqual(["W1"]);
    expect(facts.evidence).toEqual({
      plan_path: "docs/spikes/T1.md",
      worktrees: [
        {
          id: "W1",
          base_sha: r.base,
          files: 2,
          paths: ["NOTES.md", "docs/spikes/T1.md"],
        },
      ],
    });
  });
});

describe("a source change is found however it was made", () => {
  test.each<[string, (path: string) => void, string]>([
    [
      "committed",
      (p) => {
        writeFileSync(join(p, "src", "b.ts"), "b\n");
        git(p, "add", "-A");
        git(p, "commit", "-q", "-m", "b");
      },
      "src/b.ts",
    ],
    [
      "staged",
      (p) => {
        writeFileSync(join(p, "src", "a.ts"), "changed\n");
        git(p, "add", "-A");
      },
      "src/a.ts",
    ],
    [
      "unstaged",
      (p) => writeFileSync(join(p, "src", "a.ts"), "x\n"),
      "src/a.ts",
    ],
    [
      "untracked",
      (p) => writeFileSync(join(p, "src", "new.ts"), "n\n"),
      "src/new.ts",
    ],
    ["deleted", (p) => unlinkSync(join(p, "src", "a.ts")), "src/a.ts"],
    [
      "with a space and a newline in its name",
      (p) => writeFileSync(join(p, "src", "odd name\nhere.ts"), "o\n"),
      "src/odd name\nhere.ts",
    ],
  ])("%s", async (_name, change, path) => {
    const r = repo();
    plan(r.path);
    change(r.path);
    const facts = await gatherGitFacts(input([worktree(r.path, r.base)]));
    expect(facts.diff).toEqual({ state: "dirty", paths: [path], total: 1 });
  });

  test("more than 20 changed files: the first 20, sorted, and the total", async () => {
    const r = repo();
    for (let i = 0; i < 25; i += 1) {
      writeFileSync(
        join(r.path, "src", `f${String(i).padStart(2, "0")}.ts`),
        "x\n",
      );
    }
    const facts = await gatherGitFacts(input([worktree(r.path, r.base)]));
    expect(facts.diff).toMatchObject({ state: "dirty", total: 25 });
    expect(facts.diff?.state === "dirty" ? facts.diff.paths : []).toHaveLength(
      20,
    );
    expect(facts.evidence.worktrees?.[0]).toMatchObject({ files: 25 });
    expect(facts.evidence.worktrees?.[0]?.paths).toHaveLength(20);
  });
});

describe("the plan artifact", () => {
  test("is missing when the file is absent", async () => {
    const r = repo();
    const facts = await gatherGitFacts(input([worktree(r.path, r.base)]));
    expect(facts.plan).toMatchObject({ state: "missing" });
  });

  test("is missing when it is a symlink out of the worktree", async () => {
    const r = repo();
    const outside = join(root, "outside.md");
    writeFileSync(outside, "# not in the repo\n");
    symlinkSync(outside, join(r.path, "docs", "spikes", "T1.md"));
    const facts = await gatherGitFacts(input([worktree(r.path, r.base)]));
    expect(facts.plan).toMatchObject({ state: "missing" });
  });

  test("is missing when it is a directory", async () => {
    const r = repo();
    mkdirSync(join(r.path, "docs", "spikes", "T1.md"));
    const facts = await gatherGitFacts(input([worktree(r.path, r.base)]));
    expect(facts.plan).toMatchObject({ state: "missing" });
  });

  test("is not checked without a plan_path", async () => {
    const r = repo();
    const facts = await gatherGitFacts(
      input([worktree(r.path, r.base)], { planPath: null }),
    );
    expect(facts.plan).toBeUndefined();
    expect(facts.evidence.plan_path).toBeUndefined();
  });
});

describe("anything but a local worktree is unverifiable", () => {
  test.each<[string, (path: string, base: string) => GitFactsInput]>([
    [
      "a container executor",
      (p, b) => input([worktree(p, b, { executor_kind: "container" })]),
    ],
    [
      "an unknown executor",
      (p, b) => input([worktree(p, b, { executor_kind: null })]),
    ],
    ["no work root", (p, b) => input([worktree(p, b)], { workRoot: null })],
    [
      "a path outside the work root",
      (p, b) => input([worktree(p, b)], { workRoot: join(root, "elsewhere") }),
    ],
    ["a bad base sha", (p) => input([worktree(p, "f".repeat(40))])],
  ])("%s", async (_name, build) => {
    const r = repo();
    plan(r.path);
    const facts = await gatherGitFacts(build(r.path, r.base));
    expect(facts.diff).toMatchObject({ state: "unverifiable" });
  });

  test("a non-local worktree's plan is unverifiable too", async () => {
    const r = repo();
    plan(r.path);
    const facts = await gatherGitFacts(
      input([worktree(r.path, r.base, { executor_kind: "remote" })]),
    );
    expect(facts.plan).toMatchObject({ state: "unverifiable" });
  });

  test("no active worktree: nothing to diff, no plan to find", async () => {
    const r = repo();
    const facts = await gatherGitFacts(
      input([worktree(r.path, r.base, { state: "orphan" })]),
    );
    expect(facts.diff).toMatchObject({ state: "unverifiable" });
    expect(facts.plan).toMatchObject({ state: "missing" });
    expect(facts.worktreeIds).toEqual([]);
  });

  test("a hung git is cut off at the timeout", async () => {
    const r = repo();
    const hang = join(root, "hang-git");
    writeFileSync(hang, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(hang, 0o755);
    const facts = await gatherGitFacts(
      input([worktree(r.path, r.base)], {
        timeoutMs: 200,
        need: new Set(["diff"]),
      }),
      runGit(hang),
    );
    expect(facts.diff).toMatchObject({
      state: "unverifiable",
      detail: expect.stringContaining("timed out"),
    });
  });
});

describe("only what the edge needs is gathered", () => {
  test("plan only: no git runs", async () => {
    const r = repo();
    plan(r.path);
    const facts = await gatherGitFacts(
      input([worktree(r.path, r.base)], { need: new Set(["plan"]) }),
    );
    expect(facts.plan).toEqual({ state: "present" });
    expect(facts.diff).toBeUndefined();
    expect(facts.evidence.worktrees).toBeUndefined();
  });
});

describe("where the supervisor roots sessions", () => {
  test("a worktree at FRM_HOME/work/<session>/repo is found through loadWorkRoot", async () => {
    // The supervisor's lifecycle roots each session at <FRM_HOME>/work/<id>; the API once looked
    // under <FRM_HOME>/runtime/work, so a real submit_plan could never verify its worktree.
    const home = join(root, "home");
    const path = join(home, "work", "S9", "repo");
    mkdirSync(join(path, "docs", "spikes"), { recursive: true });
    git(path, "init", "-q", "-b", "main");
    writeFileSync(join(path, "README.md"), "# r\n");
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "base");
    plan(path);
    const facts = await gatherGitFacts(
      input([worktree(path, git(path, "rev-parse", "HEAD"))], {
        workRoot: loadWorkRoot({ FRM_HOME: home }),
      }),
    );
    expect(facts.plan).toEqual({ state: "present" });
    expect(facts.diff).toEqual({ state: "clean", files: 1 });
  });
});
