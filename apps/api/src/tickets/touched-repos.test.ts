import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runGit, type GitRunner } from "./git-facts.js";
import { touchedRepos, type RepoWorktree } from "./touched-repos.js";

// which repos a code_review round must cover, against real git repositories. /tmp/frm-*
// keeps paths short on macOS, as git-facts.test.ts does.

const root = realpathSync(mkdtempSync("/tmp/frm-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

let repos = 0;

/** A repo under <root>/work with one commit as its base. */
function repo(): { readonly path: string; readonly base: string } {
  repos += 1;
  const path = join(root, "work", `r${repos}`);
  mkdirSync(join(path, "src"), { recursive: true });
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "src", "a.ts"), "export const a = 1;\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "base");
  return { path, base: git(path, "rev-parse", "HEAD") };
}

/** One more commit on top: the repo now has something to review. */
function commit(path: string, name: string): void {
  writeFileSync(join(path, "src", `${name}.ts`), `export const ${name} = 1;\n`);
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", name);
}

const worktree = (
  repoId: string,
  r: { readonly path: string; readonly base: string },
  o: Partial<RepoWorktree> = {},
): RepoWorktree => ({
  id: `W-${repoId}`,
  repo_id: repoId,
  path: r.path,
  base_sha: r.base,
  state: "active",
  session_id: "S1",
  executor_kind: "local",
  ...o,
});

const scan = (
  worktrees: readonly RepoWorktree[],
  run: GitRunner = runGit(),
): Promise<readonly string[]> =>
  touchedRepos(
    { worktrees, timeoutMs: 5_000, workRoot: join(root, "work") },
    run,
  );

describe("a ticket whose worktrees do not span repos", () => {
  // The shape of every single-repo ticket in the fleet: an empty `ticket_repos` is what the laws
  // document as "one repo-less gate", and H3 never refuses it — so nothing is recorded and nothing
  // about such a ticket changes.
  test("records nothing, commits or not", async () => {
    const r = repo();
    expect(await scan([worktree("r1", r)])).toEqual([]);
    commit(r.path, "b");
    expect(await scan([worktree("r1", r)])).toEqual([]);
    // Two worktrees, one repo: still one repo.
    expect(
      await scan([worktree("r1", r), worktree("r1", r, { id: "W2" })]),
    ).toEqual([]);
  });
});

describe("a ticket whose worktrees span repos", () => {
  test("records only the repos with commits since their base", async () => {
    const a = repo();
    const b = repo();
    commit(a.path, "b");
    expect(await scan([worktree("r-a", a), worktree("r-b", b)])).toEqual([
      "r-a",
    ]);
    commit(b.path, "c");
    expect(await scan([worktree("r-a", a), worktree("r-b", b)])).toEqual([
      "r-a",
      "r-b",
    ]);
  });

  test("an idle or removed worktree is not scanned; only active ones are", async () => {
    const a = repo();
    const b = repo();
    commit(a.path, "b");
    commit(b.path, "c");
    expect(
      await scan([
        worktree("r-a", a),
        worktree("r-b", b, { state: "removed" }),
        worktree("r-c", b, { id: "W3", state: "removed" }),
      ]),
    ).toEqual([]);
  });

  // §3.1 would rather open a gate on a repo that turns out untouched than let a touched one
  // through unreviewed, so anything this host cannot read counts as touched.
  test.each<[string, Partial<RepoWorktree>]>([
    ["a worktree on a container", { executor_kind: "container" }],
    ["a worktree with no usable base sha", { base_sha: "not-a-sha" }],
    ["a worktree outside the work root", { path: "/nowhere" }],
  ])("%s counts as touched", async (_name, o) => {
    const a = repo();
    const b = repo();
    commit(a.path, "b");
    expect(await scan([worktree("r-a", a), worktree("r-b", b, o)])).toEqual([
      "r-a",
      "r-b",
    ]);
  });

  test("a git that fails counts as touched, rather than silently omitting the repo", async () => {
    const a = repo();
    const b = repo();
    commit(a.path, "b");
    const broken: GitRunner = (cwd, args, timeoutMs) =>
      cwd === b.path
        ? Promise.resolve({ ok: false, detail: "git exploded" })
        : runGit()(cwd, args, timeoutMs);
    expect(
      await scan([worktree("r-a", a), worktree("r-b", b)], broken),
    ).toEqual(["r-a", "r-b"]);
  });

  test("a repo whose second worktree carries the commits is still recorded", async () => {
    const a = repo();
    const b1 = repo();
    const b2 = repo();
    commit(a.path, "b");
    commit(b2.path, "c");
    // Both worktrees name repo r-b; the first has nothing, the second does.
    expect(
      await scan([
        worktree("r-a", a),
        worktree("r-b", b1),
        worktree("r-b", b2, { id: "W3" }),
      ]),
    ).toEqual(["r-a", "r-b"]);
  });
});
