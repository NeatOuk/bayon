import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runGit } from "../../tickets/git-facts.js";
import { folderState, initFolder } from "./folder-state.js";

// What a folder is as a repo, and making one that has no commit a repo with one empty commit
//, against real git in a temp folder. Git here runs with no global or system config,
// as Bayon's own does.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  ).trim();

const AUTHOR = { name: "Bayon Agent", email: "agent@bayon.invalid" };
const run = runGit();

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-folder-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const folder = (name: string): string => {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
};

describe("folderState", () => {
  test("an empty folder is not a repo, and empty", async () => {
    expect(await folderState(run, folder("empty"), dir)).toEqual({
      state: "not_repo_empty",
      branch: null,
    });
  });

  test("a folder with files is not a repo, with files", async () => {
    const path = folder("files");
    writeFileSync(join(path, "notes.md"), "hello");
    expect((await folderState(run, path, dir)).state).toBe("not_repo_files");
  });

  test("a folder inside another repository's tree is not a repo itself", async () => {
    const outer = folder("outer");
    git(outer, "init", "-q", "-b", "main");
    git(outer, "commit", "-q", "--allow-empty", "-m", "outer");
    expect((await folderState(run, folder("outer/inner"), dir)).state).toBe(
      "not_repo_empty",
    );
  });

  test("a repo with no commits", async () => {
    const path = folder("fresh");
    git(path, "init", "-q", "-b", "main");
    expect(await folderState(run, path, dir)).toEqual({
      state: "no_commits",
      branch: "main",
    });
  });

  test("HEAD on a branch with no commits while another has some is an unborn HEAD", async () => {
    const path = folder("unborn");
    git(path, "init", "-q", "-b", "main");
    git(path, "commit", "-q", "--allow-empty", "-m", "one");
    git(path, "symbolic-ref", "HEAD", "refs/heads/nothing-yet");
    expect(await folderState(run, path, dir)).toEqual({
      state: "unborn_head",
      branch: "nothing-yet",
    });
  });

  test("a repo with a commit on HEAD is ready", async () => {
    const path = folder("ready");
    git(path, "init", "-q", "-b", "main");
    git(path, "commit", "-q", "--allow-empty", "-m", "one");
    expect(await folderState(run, path, dir)).toEqual({
      state: "ready",
      branch: "main",
    });
  });
});

describe("initFolder", () => {
  test("an empty folder becomes a repo on main with one empty commit", async () => {
    const path = folder("empty");
    const done = await initFolder(run, path, dir, AUTHOR);
    expect(done).toMatchObject({
      ok: true,
      value: { createdRepo: true, branch: "main" },
    });
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(path, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(path, "ls-tree", "HEAD")).toBe("");
    expect(git(path, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      "Bayon Agent <agent@bayon.invalid>|Bayon Agent <agent@bayon.invalid>",
    );
    expect(done.ok && done.value.commit).toBe(git(path, "rev-parse", "HEAD"));
    expect((await folderState(run, path, dir)).state).toBe("ready");
  });

  test("a folder with files: the commit is empty and every file is left untracked, unchanged", async () => {
    const path = folder("files");
    writeFileSync(join(path, "notes.md"), "hello");
    const done = await initFolder(run, path, dir, AUTHOR);
    expect(done.ok).toBe(true);
    expect(git(path, "ls-tree", "HEAD")).toBe("");
    expect(git(path, "status", "--porcelain")).toBe("?? notes.md");
    expect(readdirSync(path).sort()).toEqual([".git", "notes.md"]);
  });

  test("a repo with no commits gets the commit on its own branch; what is staged stays staged, uncommitted", async () => {
    const path = folder("fresh");
    git(path, "init", "-q", "-b", "trunk");
    writeFileSync(join(path, "staged.txt"), "x");
    git(path, "add", "staged.txt");
    const done = await initFolder(run, path, dir, AUTHOR);
    expect(done).toMatchObject({
      ok: true,
      value: { createdRepo: false, branch: "trunk" },
    });
    expect(git(path, "ls-tree", "HEAD")).toBe("");
    expect(git(path, "status", "--porcelain")).toBe("A  staged.txt");
  });

  test("a repo with commits is refused and left exactly as it was, not even an object added", async () => {
    const path = folder("ready");
    git(path, "init", "-q", "-b", "main");
    git(path, "commit", "-q", "--allow-empty", "-m", "one");
    const before = git(path, "rev-parse", "HEAD");
    const objects = git(path, "count-objects", "-v");
    const done = await initFolder(run, path, dir, AUTHOR);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.message).toMatch(/already has commits/);
    expect(git(path, "rev-parse", "HEAD")).toBe(before);
    expect(git(path, "count-objects", "-v")).toBe(objects);
  });

  test("an unborn HEAD beside branches with commits is refused and left alone", async () => {
    const path = folder("unborn");
    git(path, "init", "-q", "-b", "main");
    git(path, "commit", "-q", "--allow-empty", "-m", "one");
    git(path, "symbolic-ref", "HEAD", "refs/heads/nothing-yet");
    const done = await initFolder(run, path, dir, AUTHOR);
    expect(done.ok).toBe(false);
    expect(git(path, "for-each-ref", "--format=%(refname)")).toBe(
      "refs/heads/main",
    );
  });
});

// The review's M1: a `.git` that leads anywhere but the folder's own repository, inside the
// allowed folder, is `foreign_repo`, and nothing is done to it — or to where it leads.
describe("a .git that is not the folder's own", () => {
  const outsideRepo = (): string => {
    const path = folder("outside");
    git(path, "init", "-q", "-b", "main");
    git(path, "commit", "-q", "--allow-empty", "-m", "theirs");
    return path;
  };

  test("an empty .git under a parent repo with no commits never reaches the parent", async () => {
    const parent = folder("parent");
    git(parent, "init", "-q", "-b", "main");
    const child = folder("parent/child");
    mkdirSync(join(child, ".git"));
    expect((await folderState(run, child, dir)).state).toBe("foreign_repo");
    const done = await initFolder(run, child, dir, AUTHOR);
    expect(done.ok).toBe(false);
    if (!done.ok)
      expect(done.error.message).toMatch(
        /belongs to another repository, or is broken/,
      );
    expect(() => git(parent, "rev-parse", "--verify", "HEAD")).toThrow();
  });

  test("a .git file pointing outside the allowed folder", async () => {
    const theirs = outsideRepo();
    const head = git(theirs, "rev-parse", "HEAD");
    const root = folder("root");
    const app = folder("root/app");
    writeFileSync(join(app, ".git"), `gitdir: ${join(theirs, ".git")}\n`);
    expect((await folderState(run, app, root)).state).toBe("foreign_repo");
    expect((await initFolder(run, app, root, AUTHOR)).ok).toBe(false);
    expect(git(theirs, "rev-parse", "HEAD")).toBe(head);
  });

  test("a .git symlink pointing outside the allowed folder", async () => {
    const theirs = outsideRepo();
    const root = folder("root");
    const app = folder("root/app");
    symlinkSync(join(theirs, ".git"), join(app, ".git"));
    expect((await folderState(run, app, root)).state).toBe("foreign_repo");
    expect((await initFolder(run, app, root, AUTHOR)).ok).toBe(false);
  });
});

// The review's L7: a repository's own config cannot make init run anything — no hook (the
// reference-transaction hook update-ref fires, post-commit), no fsmonitor, no signing program.
test("a hostile repo config runs nothing during init", async () => {
  const path = folder("hostile");
  git(path, "init", "-q", "-b", "main");
  const marker = join(dir, "ran");
  const script = (name: string): string => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho ${name} >> ${marker}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const hooks = folder("hooks");
  for (const hook of ["reference-transaction", "post-commit", "pre-commit"]) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  git(path, "config", "core.hooksPath", hooks);
  git(path, "config", "core.fsmonitor", script("fsmonitor"));
  git(path, "config", "commit.gpgSign", "true");
  git(path, "config", "gpg.program", script("gpg"));
  const done = await initFolder(run, path, dir, AUTHOR);
  expect(done.ok).toBe(true);
  expect(existsSync(marker)).toBe(false);
  expect(git(path, "cat-file", "-p", "HEAD")).not.toMatch(/gpgsig/);
});
