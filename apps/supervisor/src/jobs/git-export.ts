// Git steps for the exporter (design doc §3 step 7): a marker file gates which directories the job
// is allowed to touch (never an arbitrary existing repo by a config mistake), staging is scoped to
// the two export subdirectories, and the commit is isolated from whatever git config or hooks
// happen to exist on the host. Each step is returned as evidence (argv, exit code, duration,
// output) so the caller can turn it into a `command` canonical event -- the run's evidence, per
// §10.5.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "@bayon/core";
import { GIT_ENV_FLOOR, safeGitArgs } from "@bayon/executors";

export const MARKER_FILE = ".foreman-exports";
export const TICKETS_DIR = "tickets";
export const MISSION_DIR = "mission";

export interface GitStep {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  cwd: string,
  args: readonly string[],
  clock: Clock,
): Promise<GitStep> {
  const start = clock.now();
  // The flags and the env floor are packages/executors'; the evidence records the argv
  // as spawned, so a step's `command` event is what actually ran.
  const argv = safeGitArgs(args);
  return new Promise((resolve, reject) => {
    const child = spawn("git", argv, {
      cwd,
      env: { ...process.env, ...GIT_ENV_FLOOR },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        argv: ["git", ...argv],
        exitCode: code ?? -1,
        durationMs: clock.now() - start,
        stdout,
        stderr,
      });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export type EnsureRepoResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Creates `repoPath` (and its two export subdirectories) and marks it as ours on first use;
 * refuses a directory that already has a `.git` without the marker, so a `settings.exports.
 * repo_path` misconfiguration can never make this job commit into someone else's repository.
 */
export async function ensureExportRepo(
  repoPath: string,
  clock: Clock,
): Promise<EnsureRepoResult> {
  await mkdir(join(repoPath, TICKETS_DIR), { recursive: true });
  await mkdir(join(repoPath, MISSION_DIR), { recursive: true });
  const markerPath = join(repoPath, MARKER_FILE);
  if (await exists(markerPath)) return { ok: true };
  if (await exists(join(repoPath, ".git", "HEAD"))) {
    return {
      ok: false,
      error: `${repoPath} is a git repository without ${MARKER_FILE}; refusing to touch it`,
    };
  }
  const init = await run(repoPath, ["init"], clock);
  if (init.exitCode !== 0) {
    return { ok: false, error: `git init failed: ${init.stderr.trim()}` };
  }
  await writeFile(
    markerPath,
    "This directory is managed by the foreman markdown exporter. Do not edit its contents by hand.\n",
  );
  return { ok: true };
}

export interface CommitOutcome {
  readonly committed: boolean;
  readonly steps: readonly GitStep[];
}

export type CommitResult =
  | { readonly ok: true; readonly value: CommitOutcome }
  | {
      readonly ok: false;
      readonly error: string;
      readonly steps: readonly GitStep[];
    };

/** A pathspec git will not choke on: only directories that actually hold a file, so an empty
 * `mission/` on a ticket-only run is never passed to `git add` (it would refuse: "did not match
 * any files"). */
async function nonEmptyDirs(
  repoPath: string,
  dirs: readonly string[],
): Promise<readonly string[]> {
  const present = await Promise.all(
    dirs.map(async (d) => {
      try {
        return (await readdir(join(repoPath, d))).length > 0 ? d : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return present.filter((d): d is string => d !== undefined);
}

/**
 * Commits only `tickets/` and `mission/`, only on a non-empty diff there (never `git add -A`:
 * nothing else in the repo is this job's business). `--no-verify` and an inline identity keep the
 * commit isolated from whatever hooks or config happen to exist on the host.
 */
export async function commitExportChanges(
  repoPath: string,
  message: string,
  clock: Clock,
): Promise<CommitResult> {
  const steps: GitStep[] = [];
  const dirs = await nonEmptyDirs(repoPath, [TICKETS_DIR, MISSION_DIR]);
  if (dirs.length === 0)
    return { ok: true, value: { committed: false, steps } };

  const status = await run(
    repoPath,
    ["status", "--porcelain", "--", ...dirs],
    clock,
  );
  steps.push(status);
  if (status.exitCode !== 0) {
    return {
      ok: false,
      error: `git status failed: ${status.stderr.trim()}`,
      steps,
    };
  }
  if (status.stdout.trim() === "") {
    return { ok: true, value: { committed: false, steps } };
  }

  const add = await run(repoPath, ["add", "--", ...dirs], clock);
  steps.push(add);
  if (add.exitCode !== 0) {
    return { ok: false, error: `git add failed: ${add.stderr.trim()}`, steps };
  }

  const commit = await run(
    repoPath,
    [
      "-c",
      "user.name=foreman",
      "-c",
      "user.email=foreman@localhost",
      "commit",
      "--no-verify",
      "-m",
      message,
    ],
    clock,
  );
  steps.push(commit);
  if (commit.exitCode !== 0) {
    return {
      ok: false,
      error: `git commit failed: ${commit.stderr.trim()}`,
      steps,
    };
  }
  return { ok: true, value: { committed: true, steps } };
}
