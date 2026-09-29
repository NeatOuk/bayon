// A linked worktree off a bare mirror (Bayon's local layout), a plain checkout and a directory
// outside any repository, each through the real local executor and the host's git.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, expect, test } from "vitest";
import { gitWritableRoots, rootsOf } from "./git-roots.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-git-roots-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const local = new LocalExecutor({ id: "local", slots: new SlotCounter(4) });
const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const GIT_ENV = {
  PATH,
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
};

const upstream = join(root, "up");
mkdirSync(upstream);
git(upstream, "init", "-q", "-b", "main");
git(upstream, "commit", "-q", "--allow-empty", "-m", "init");
const mirror = join(root, "mirror.git");
git(root, "clone", "-q", "--mirror", upstream, mirror);
const worktree = join(root, "wt");
git(mirror, "worktree", "add", "-q", "-b", "agent/x", worktree, "main");

test("a linked worktree: its own git dir and the mirror's objects, refs and logs, never its config", async () => {
  const roots = await gitWritableRoots(local, worktree, PATH);
  expect(roots).toEqual({
    ok: true,
    value: [
      join(mirror, "worktrees", "wt"),
      join(mirror, "objects"),
      join(mirror, "refs"),
      join(mirror, "logs"),
    ],
  });
  expect(JSON.stringify(roots)).not.toContain("hooks");
});

test("a plain checkout gets no roots: its git dir would grant its config and hooks", async () => {
  expect(await gitWritableRoots(local, upstream, PATH)).toEqual({
    ok: true,
    value: [],
  });
});

test("a directory outside any repository gets no roots", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "frm-no-repo-")));
  try {
    expect(await gitWritableRoots(local, outside, PATH)).toEqual({
      ok: true,
      value: [],
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("git that cannot run is an error, never an empty grant", async () => {
  const r = await gitWritableRoots(local, worktree, join(root, "no-bin"));
  expect(r).toMatchObject({ ok: false, error: { class: "spawn_failed" } });
});

test("rootsOf: relative or identical dirs grant nothing", () => {
  expect(rootsOf(".git", ".git")).toEqual([]);
  expect(rootsOf("/r/.git", "/r/.git")).toEqual([]);
  expect(rootsOf("/m/worktrees/w", "/m")).toEqual([
    "/m/worktrees/w",
    "/m/objects",
    "/m/refs",
    "/m/logs",
  ]);
});
