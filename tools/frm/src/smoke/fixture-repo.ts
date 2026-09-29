import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  err,
  ok,
  parseConfigList,
  plannedMirrorConfig,
  redactedConfigKey,
  type Result,
} from "@bayon/core";
import { GIT_ENV_FLOOR, safeGitArgs } from "@bayon/executors";

// The repo a smoke session works in: an origin with one commit on `main`, and where its mirror
// goes. The smoke never makes the mirror: the first spawn clones it (§9.2; M4: mirrors are created
// on first use), and worktrees come off it, fetching from origin.

export const BASE_BRANCH = "main";
export const DOCTRINE_PATH = "DOCTRINE.md";
export const DOCTRINE = "# Doctrine\n\nKeep the README short.\n";
export const README = "# smoke fixture\n";

export interface FixtureRepo {
  readonly origin: string;
  /** The repo row's mirror_path: nothing is there until the first spawn clones it. */
  readonly mirror: string;
  readonly baseSha: string;
}

// A fixed identity, so a bare CI machine and a dev laptop agree; the rest of the floor is
// GIT_ENV_FLOOR and the flags are safeGitArgs.
const GIT_ENV = {
  ...GIT_ENV_FLOOR,
  GIT_AUTHOR_NAME: "frm smoke",
  GIT_AUTHOR_EMAIL: "smoke@frm.invalid",
  GIT_COMMITTER_NAME: "frm smoke",
  GIT_COMMITTER_EMAIL: "smoke@frm.invalid",
};
/** This fixture's own: a signing key on the machine must never reach its commits. */
const NO_SIGN = ["-c", "commit.gpgsign=false"];

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", safeGitArgs([...NO_SIGN, ...args]), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function failed(what: string, cause: unknown): Result<never> {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return err({
    class: "internal",
    message: `${what}: ${detail}`,
    retryable: false,
    cause,
  });
}

/** An origin repo under `dir` with README and doctrine committed on `main`; no mirror is made. */
export function createFixtureRepo(dir: string): Result<FixtureRepo> {
  const origin = join(dir, "origin");
  const mirror = join(dir, "mirror.git");
  try {
    mkdirSync(origin, { recursive: true });
    git(origin, ["init", "-q", "-b", BASE_BRANCH]);
    writeFileSync(join(origin, "README.md"), README);
    writeFileSync(join(origin, DOCTRINE_PATH), DOCTRINE);
    git(origin, ["add", "README.md", DOCTRINE_PATH]);
    git(origin, ["commit", "-q", "-m", "fixture: initial commit"]);
    return ok({ origin, mirror, baseSha: git(origin, ["rev-parse", "HEAD"]) });
  } catch (cause) {
    return failed(`cannot create the fixture repo in ${dir}`, cause);
  }
}

/**
 * What is wrong with the mirror the first spawn should have cloned: missing, not a bare
 * repository, or not carrying the hardened repo-local config.
 *
 * The config half is asked of `plannedMirrorConfig` — the supervisor's own table, in `@bayon/core`
 * — over the config git reports with **includes resolved**, so an empty plan is the whole claim:
 * the keys the mirror must carry are there with the right values, and no key that runs a program or
 * redirects a fetch is in effect. The first cut of this check listed the four positive keys it
 * expected, and would not have noticed a surviving `filter.*` or an `include.path` (review, LOW-3).
 */
export function mirrorProblems(mirror: string, originUrl: string): string[] {
  if (!existsSync(mirror)) return [`no mirror at ${mirror}`];
  let config: string;
  try {
    config = git(mirror, ["config", "--local", "--list", "-z", "--includes"]);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return [`${mirror} is not a git repository: ${detail}`];
  }
  const entries = parseConfigList(config);
  const bare = entries.some((e) => e.key === "core.bare" && e.value === "true");
  return [
    ...(bare ? [] : [`${mirror} is not a bare repository`]),
    ...plannedMirrorConfig(entries, { originUrl }).map(
      (c) =>
        `${mirror} is not hardened: ${c.op} ${redactedConfigKey(c.key)} is still outstanding`,
    ),
  ];
}

/**
 * What is wrong with a session's worktree: missing, on another branch, or README unchanged (and,
 * when `readmeLine` is given, lacking it: a real model words its own line).
 */
export function worktreeProblems(
  path: string,
  expected: { readonly branch: string; readonly readmeLine?: string },
): string[] {
  if (!existsSync(join(path, ".git"))) return [`no worktree at ${path}`];
  try {
    const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const changed = git(path, ["status", "--porcelain", "--", "README.md"]);
    const readme = readFileSync(join(path, "README.md"), "utf8");
    return [
      ...(branch === expected.branch
        ? []
        : [`worktree is on ${branch}, not ${expected.branch}`]),
      ...(changed === "" ? ["README.md is unchanged in the worktree"] : []),
      ...(expected.readmeLine === undefined ||
      readme.includes(expected.readmeLine)
        ? []
        : [`README.md lacks the line ${JSON.stringify(expected.readmeLine)}`]),
    ];
  } catch (cause) {
    return [
      `cannot inspect the worktree at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    ];
  }
}
