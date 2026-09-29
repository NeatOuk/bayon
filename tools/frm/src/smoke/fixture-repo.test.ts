import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  BASE_BRANCH,
  DOCTRINE,
  DOCTRINE_PATH,
  README,
  createFixtureRepo,
  git,
  mirrorProblems,
  worktreeProblems,
} from "./fixture-repo.js";

const dir = mkdtempSync(join(tmpdir(), "frm-repo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const created = createFixtureRepo(dir);
if (!created.ok) throw new Error(created.error.message);
const repo = created.value;

test("origin has one commit with README and doctrine on main; no mirror is made (first use clones it)", () => {
  expect(readFileSync(join(repo.origin, "README.md"), "utf8")).toBe(README);
  expect(readFileSync(join(repo.origin, DOCTRINE_PATH), "utf8")).toBe(DOCTRINE);
  expect(repo.baseSha).toMatch(/^[0-9a-f]{40}$/);
  expect(git(repo.origin, ["rev-parse", `refs/heads/${BASE_BRANCH}`])).toBe(
    repo.baseSha,
  );
  expect(repo.mirror).toBe(join(dir, "mirror.git"));
  expect(existsSync(repo.mirror)).toBe(false);
});

const outstanding = (mirror: string, ...names: string[]): string[] =>
  names.map((n) => `${mirror} is not hardened: ${n} is still outstanding`);

test("mirrorProblems: missing, an unhardened clone, then the hardened one", () => {
  const missing = join(dir, "mirrors", "missing.git");
  expect(mirrorProblems(missing, repo.origin)).toEqual([
    `no mirror at ${missing}`,
  ]);
  // A --mirror clone, as the supervisor made before an earlier change: bare, and wrong in every other way.
  const mirror = join(dir, "mirrors", "mirror.git");
  git(dir, ["clone", "-q", "--mirror", repo.origin, mirror]);
  expect(mirrorProblems(mirror, repo.origin)).toEqual(
    outstanding(
      mirror,
      // The remote name is no secret, but the redaction is one rule for every key: for a
      // `url.<base>.insteadOf` the base is where a token would sit (Invariant 11).
      "unset remote.*.mirror",
      "unset remote.*.tagopt",
      "set gc.worktreePruneExpire",
      "set remote.*.fetch",
    ),
  );
  const bare = join(dir, "mirrors", "bare.git");
  git(dir, ["clone", "-q", "--bare", repo.origin, bare]);
  expect(mirrorProblems(bare, repo.origin)).toEqual(
    outstanding(bare, "set gc.worktreePruneExpire", "set remote.*.fetch"),
  );
  for (const [key, value] of [
    ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    ["gc.worktreePruneExpire", "never"],
  ] as const) {
    git(bare, ["config", "--local", "--replace-all", key, value]);
  }
  expect(mirrorProblems(bare, repo.origin)).toEqual([]);

  // What the first cut of this check would not have seen (review, LOW-3): a driver reached through
  // an include, which a plain `--local --list` does not print at all, and a repointed origin.
  const included = join(dir, "mirrors", "planted.cfg");
  writeFileSync(included, '[filter "p"]\n\tsmudge = /bin/sh\n');
  git(bare, ["config", "--local", "include.path", included]);
  expect(mirrorProblems(bare, repo.origin)).toEqual(
    outstanding(bare, "unset filter.*.smudge", "unset include.path"),
  );
  git(bare, ["config", "--local", "--unset-all", "include.path"]);
  git(bare, [
    "config",
    "--local",
    "remote.origin.url",
    "https://evil.example/",
  ]);
  expect(mirrorProblems(bare, repo.origin)).toEqual(
    outstanding(bare, "set remote.*.url"),
  );
  git(bare, ["config", "--local", "remote.origin.url", repo.origin]);
  expect(mirrorProblems(bare, repo.origin)).toEqual([]);

  // A directory that is not a repository at all.
  const plain = join(dir, "mirrors", "plain.git");
  mkdirSync(plain, { recursive: true });
  expect(mirrorProblems(plain, repo.origin)).toEqual([
    expect.stringContaining(`${plain} is not a git repository`),
  ]);
});

test("worktreeProblems: a worktree off the repo, before and after the README change", () => {
  const path = join(dir, "work", "repo");
  git(repo.origin, [
    "worktree",
    "add",
    "-q",
    "-b",
    "frm/s1",
    path,
    repo.baseSha,
  ]);
  const expected = { branch: "frm/s1", readmeLine: "smoke was here" };
  expect(worktreeProblems(path, expected)).toEqual([
    "README.md is unchanged in the worktree",
    'README.md lacks the line "smoke was here"',
  ]);
  appendFileSync(join(path, "README.md"), "smoke was here\n");
  expect(worktreeProblems(path, expected)).toEqual([]);
  expect(worktreeProblems(path, { ...expected, branch: "frm/s2" })).toEqual([
    "worktree is on frm/s1, not frm/s2",
  ]);
  expect(worktreeProblems(join(dir, "nowhere"), expected)).toEqual([
    `no worktree at ${join(dir, "nowhere")}`,
  ]);
});

test("a repo that cannot be created is an error, not a throw", () => {
  const blocked = createFixtureRepo(join(dir, "origin", "README.md"));
  expect(blocked.ok ? null : blocked.error.class).toBe("internal");
});
