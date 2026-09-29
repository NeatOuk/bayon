// The reference workspace: per session, a git worktree off a tiny fixture repo
// (README.md, and add.js with a planted bug for test 13), a 0700 home and a tmp dir, all under one
// scratch root. Production uses the supervisor's worktree-from-mirror path.
import { GIT_ENV_FLOOR, safeGitArgs } from "@bayon/executors";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { FileDiff, SessionDirs, WorkspacePort } from "./types.js";

const run = promisify(execFile);

export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "README.md": "# conformance fixture\n",
  // The planted bug test 13's reviewer must find.
  "add.js":
    "// Returns the sum of a and b.\nexport function add(a, b) {\n  return a - b;\n}\n",
};

// A fixed identity, so every machine agrees; the rest of the floor is GIT_ENV_FLOOR.
const GIT_ENV = {
  ...GIT_ENV_FLOOR,
  GIT_AUTHOR_NAME: "frm conformance",
  GIT_AUTHOR_EMAIL: "conformance@frm.invalid",
  GIT_COMMITTER_NAME: "frm conformance",
  GIT_COMMITTER_EMAIL: "conformance@frm.invalid",
};
/** This fixture's own: a signing key on the machine must never reach its commits. */
const NO_SIGN = ["-c", "commit.gpgsign=false"];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", safeGitArgs([...NO_SIGN, ...args]), {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...GIT_ENV },
  });
  return stdout.trim();
}

const CHANGES: Readonly<Record<string, FileDiff["change"]>> = {
  A: "add",
  M: "modify",
  D: "delete",
};

/** `git diff --name-status` and `--numstat` lines, joined by path (every workspace port's parse). */
export function parseDiff(names: string, numbers: string): FileDiff[] {
  const counts = new Map(
    numbers
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const [added = "-", removed = "-", ...path] = l.split("\t");
        return [path.join("\t"), { added, removed }] as const;
      }),
  );
  return names
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [status = "", ...rest] = l.split("\t");
      const path = rest.join("\t");
      const n = counts.get(path);
      const count = (v: string | undefined) =>
        v === undefined || v === "-" ? {} : { value: Number(v) };
      const added = count(n?.added);
      const removed = count(n?.removed);
      return {
        path,
        change: CHANGES[status.charAt(0)] ?? "modify",
        ...("value" in added ? { added: added.value } : {}),
        ...("value" in removed ? { removed: removed.value } : {}),
      };
    });
}

/** A directory name from a caller's, with nothing that could leave the session's root. */
export const safeName = (name: string): string =>
  name.replace(/[^A-Za-z0-9_-]/g, "_");

export async function createLocalWorkspace(): Promise<WorkspacePort> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "frm-conformance-")),
  );
  let scratches = 0;

  return {
    source: "reference",

    async place(sessionId) {
      return join(root, "sessions", sessionId);
    },

    async create(sessionId): Promise<SessionDirs> {
      const dir = join(root, "sessions", sessionId);
      const dirs = {
        root: dir,
        cwd: join(dir, "work"),
        homeDir: join(dir, "home"),
        tmpDir: join(dir, "tmp"),
      };
      await mkdir(dirs.cwd, { recursive: true });
      await mkdir(dirs.homeDir, { recursive: true, mode: 0o700 });
      await mkdir(dirs.tmpDir, { recursive: true, mode: 0o700 });
      for (const [name, text] of Object.entries(FIXTURE_FILES)) {
        await writeFile(join(dirs.cwd, name), text);
      }
      await git(dirs.cwd, ["init", "-q", "-b", "main"]);
      // As the supervisor's worktrees have it: `.foreman/` (hand-offs, the context store) is never
      // a change of the session's (spec M12: test 17's store must not show in test 5's diff).
      await mkdir(join(dirs.cwd, ".git", "info"), { recursive: true });
      await appendFile(
        join(dirs.cwd, ".git", "info", "exclude"),
        ".foreman/\n",
      );
      await git(dirs.cwd, ["add", "-A"]);
      await git(dirs.cwd, ["commit", "-q", "-m", "fixture"]);
      return {
        ...dirs,
        baseSha: await git(dirs.cwd, ["rev-parse", "HEAD"]),
        extraRoots: [],
      };
    },

    async extraRoot(sessionId, name) {
      const dir = join(root, "sessions", sessionId, "roots", safeName(name));
      await mkdir(dir, { recursive: true });
      return dir;
    },

    async scratch(name) {
      scratches += 1;
      const dir = join(root, "scratch", `${name}-${scratches}`);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    },

    async diff(cwd) {
      // Intent-to-add, so untracked files show against HEAD like any other change.
      await git(cwd, ["add", "-A", "-N"]);
      const [names, numbers] = await Promise.all([
        git(cwd, ["diff", "--name-status", "--no-renames", "HEAD"]),
        git(cwd, ["diff", "--numstat", "--no-renames", "HEAD"]),
      ]);
      return parseDiff(names, numbers);
    },

    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),

    read: (path) => readFile(path, "utf8").catch(() => undefined),

    async snapshot(dir) {
      const entries = await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      }).catch(() => []);
      const files = entries.filter((e) => e.isFile());
      const digests = await Promise.all(
        files.map(async (e) => {
          const path = join(e.parentPath, e.name);
          const bytes = await readFile(path).catch(() => Buffer.alloc(0));
          return [
            relative(dir, path),
            createHash("sha256").update(bytes).digest("hex"),
          ] as const;
        }),
      );
      return new Map(digests);
    },

    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
