import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

// one source for safe git flags. Every git call in the repo takes its `-c` pairs and its
// environment floor from packages/executors/src/git.ts (safeGitArgs / SAFE_GIT_SH / GIT_ENV_FLOOR),
// so a hook, an fsmonitor or a `gc --auto` configured in an agent-writable worktree or a shared
// mirror never runs. Two ways that breaks, and both are checked here:
//   1. a call site writes its own flags — then the one place can no longer fix them all;
//   2. a file spawns git without reaching the helper at all — then it has no flags.
const HELPER = "packages/executors/src/git.ts";
const SKIP = new Set(["node_modules", "dist", "coverage"]);

/**
 * The flags and env keys the helper owns. Nowhere else may spell one. The GIT_CONFIG_COUNT family
 * is how a session's env carries SAFE_GIT's pairs (SESSION_GIT_ENV): a second builder of
 * it is a second list.
 */
const FLAG =
  /core\.hooksPath|core\.fsmonitor|core\.askpass|credential\.helper|maintenance\.auto|gc\.auto|--no-optional-locks|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|GIT_TERMINAL_PROMPT|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_|GIT_CONFIG_VALUE_/;
/** Running a program: node's spawn family, and the repo's own executor runners. */
const SPAWNS =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|runArgv|runGitGroup)\(/;
/** git named as the program to run. */
const GIT_PROGRAM = /["'`]git["'`]/;
/** Reaching the one source. */
const HELPER_IMPORT = /\b(?:safeGitArgs|SAFE_GIT_SH|SAFE_GIT|GIT_ENV_FLOOR)\b/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/**
 * Every violation as `path:line` (own flags) or `path` (a git spawn that never reaches the helper),
 * relative to `root`. Tests are exempt: asserting on the flags is how the helper itself is checked.
 */
export function findFlagSites(root: string): string[] {
  const workspaces = ["apps", "packages", "tools"].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`),
  );
  return workspaces.flatMap((workspace) =>
    walk(join(root, workspace)).flatMap((file) => {
      const path = `${workspace}/${relative(join(root, workspace), file).split(sep).join("/")}`;
      if (path === HELPER || !/\.ts$/.test(path)) return [];
      // A test, and the `testing/` scaffolding only tests import, drive git with their own identity
      // and assert on the flags: that is how the helper itself is checked.
      if (/\.test\.ts$/.test(path) || path.includes("/testing/")) return [];
      const text = readFileSync(file, "utf8");
      const own = text
        .split("\n")
        .flatMap((line, i) => (FLAG.test(line) ? [`${path}:${i + 1}`] : []));
      const spawnsGit =
        SPAWNS.test(text) &&
        GIT_PROGRAM.test(text) &&
        !HELPER_IMPORT.test(text);
      return [...own, ...(spawnsGit ? [path] : [])];
    }),
  );
}

const repo = dirname(fileURLToPath(import.meta.url));

test("no git call site builds its own flags or skips the helper", () => {
  expect(findFlagSites(repo)).toEqual([]);
});

const planted = mkdtempSync(join(tmpdir(), "frm-git-flags-"));
afterAll(() => rmSync(planted, { recursive: true, force: true }));

test("the scan catches planted sites, so it cannot pass vacuously", () => {
  const plant = (path: string, text: string) => {
    mkdirSync(dirname(join(planted, path)), { recursive: true });
    writeFileSync(join(planted, path), text);
  };
  plant(
    "apps/api/src/ok.ts",
    'import { safeGitArgs } from "@bayon/executors";\nexecFile("git", safeGitArgs(a));\n',
  );
  plant(
    "apps/api/src/own-flags.ts",
    'const a = ["-c", "core.hooksPath=/dev/null"];\n',
  );
  plant("apps/api/src/bare-spawn.ts", 'spawn("git", ["status"]);\n');
  plant(
    "packages/runners/src/adapters/x/env.ts",
    "const e = { GIT_CONFIG_COUNT: String(n) };\n",
  );
  plant("apps/api/src/not-git.ts", 'spawn("tmux", ["ls"]);\n');
  plant("packages/core/src/policy.ts", 'const p = ["git", "status"];\n');
  plant("apps/api/src/bare.test.ts", 'spawn("git", ["-c", "gc.auto=0"]);\n');
  plant("apps/api/src/notes.md", "core.hooksPath\n");
  plant("apps/api/node_modules/dep/index.ts", 'spawn("git", []);\n');
  plant("tools/frm/src/x.ts", "export {};\n");
  plant(
    HELPER,
    'export const SAFE_GIT = ["-c", "core.hooksPath=/dev/null"];\n',
  );

  expect(findFlagSites(planted).toSorted()).toEqual([
    "apps/api/src/bare-spawn.ts",
    "apps/api/src/own-flags.ts:1",
    "packages/runners/src/adapters/x/env.ts:1",
  ]);
});
