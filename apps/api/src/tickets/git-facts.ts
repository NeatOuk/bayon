import {
  isNonSource,
  type DiffFact,
  type EvidenceRefs,
  type PlanFact,
  type PlanPaths,
  type PreFact,
  type WorktreeEvidence,
} from "@bayon/core";
import { GIT_ENV_FLOOR, safeGitArgs } from "@bayon/executors";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

// The facts no_source_changes and the plan artifact need (§3.2 L2, M1 contract 2), gathered
// before the write transaction: `git diff --name-only` on local worktrees only, anything else
// unverifiable. The worktree is agent-writable, so git runs as argv (no shell) with optional
// locks and fsmonitor off, under a timeout and a buffer cap, and paths are resolved for real.

export interface GitWorktree {
  readonly id: string;
  readonly path: string;
  readonly base_sha: string;
  /** `worktrees.state`; only `active` ones count. */
  readonly state: string;
  readonly session_id: string | null;
  /** The owning session's executor kind: only `local` worktrees are on this host. */
  readonly executor_kind: string | null;
}

export interface GitFactsInput {
  /** The ticket's worktrees, oldest first; the first active one holds the plan (M1: one repo). */
  readonly worktrees: readonly GitWorktree[];
  readonly planPath: string | null;
  readonly need: ReadonlySet<PreFact>;
  readonly planPaths: PlanPaths;
  readonly timeoutMs: number;
  /**
   * `<FRM_HOME>/work`, where the supervisor roots each session's worktrees (its lifecycle's
   * sessionPaths): a worktree must live under it.
   */
  readonly workRoot: string | null;
}

export interface GitFacts {
  readonly plan?: PlanFact;
  readonly diff?: DiffFact;
  readonly evidence: EvidenceRefs;
  /** The active worktrees diffed, sorted: the transaction refuses if the set changed. */
  readonly worktreeIds: readonly string[];
}

export type GitRun =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly detail: string };

export type GitRunner = (
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<GitRun>;

const MIB = 1024 * 1024;
const MAX_BUFFER = MIB;
const MAX_PATHS = 20;
const SHA = /^[0-9a-f]{7,64}$/;

/**
 * Runs `binary` (git) as argv, never through a shell, with a minimal environment; output over
 * `maxBuffer` bytes is a failure, not a truncation. The flags are packages/executors' safeGitArgs
 * — which also shuts off the hook path this built without.
 */
export const runGit =
  (binary = "git", maxBuffer = MAX_BUFFER): GitRunner =>
  (cwd, args, timeoutMs) =>
    new Promise((done) => {
      execFile(
        binary,
        safeGitArgs(["-C", cwd, ...args]),
        {
          timeout: timeoutMs,
          maxBuffer,
          encoding: "utf8",
          env: {
            ...GIT_ENV_FLOOR,
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            LC_ALL: "C",
            GIT_OPTIONAL_LOCKS: "0",
          },
        },
        (error, stdout) => {
          if (error === null) {
            done({ ok: true, stdout });
          } else if (error.killed) {
            done({ ok: false, detail: `git timed out after ${timeoutMs} ms` });
          } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            done({
              ok: false,
              detail: `git output exceeded ${maxBuffer / MIB} MiB`,
            });
          } else {
            const first = error.message
              .split("\n")
              .find((line) => line.startsWith("fatal"));
            done({
              ok: false,
              detail: `git ${args[0] ?? ""} failed: ${first ?? error.message}`,
            });
          }
        },
      );
    });

type Located =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly detail: string };

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The worktree's real path, if it is a local worktree under `workRoot` (<FRM_HOME>/work). Also
 * the session diff's check (diffs/session-diff.ts): git never runs anywhere else on this host.
 */
export async function locateWorktree(
  w: GitWorktree,
  workRoot: string | null,
): Promise<Located> {
  if (w.executor_kind !== "local") {
    return {
      ok: false,
      detail: `worktree ${w.id} is on a ${w.executor_kind ?? "unknown"} executor: it cannot be checked here`,
    };
  }
  if (workRoot === null) {
    return {
      ok: false,
      detail: "the API has no work root (FRM_HOME) to find worktrees in",
    };
  }
  try {
    const real = await realpath(w.path);
    const work = (await realpath(workRoot)) + sep;
    return real.startsWith(work)
      ? { ok: true, root: real }
      : { ok: false, detail: `worktree ${w.id} is not under ${work}` };
  } catch {
    return { ok: false, detail: `worktree ${w.id} is not on this host` };
  }
}

async function planFact(
  active: readonly GitWorktree[],
  planPath: string,
  workRoot: string | null,
): Promise<PlanFact> {
  const primary = active[0];
  if (primary === undefined) {
    return { state: "missing", detail: "no active worktree holds the plan" };
  }
  const where = await locateWorktree(primary, workRoot);
  if (!where.ok) return { state: "unverifiable", detail: where.detail };
  const file = resolve(where.root, planPath);
  const missing = (why: string): PlanFact => ({
    state: "missing",
    detail: `${planPath} ${why} in worktree ${primary.id}`,
  });
  if (!inside(where.root, file)) return missing("leaves the worktree");
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      return missing("is not a regular file");
    return inside(where.root, await realpath(file))
      ? { state: "present" }
      : missing("leaves the worktree");
  } catch {
    return missing("does not exist");
  }
}

const nulSeparated = (text: string): string[] =>
  text.split("\0").filter((path) => path !== "");

type Changes =
  | { readonly ok: true; readonly files: readonly string[] }
  | { readonly ok: false; readonly detail: string };

/** Every path changed since `base_sha`: committed, staged, unstaged, deleted, or untracked. */
async function changesOf(
  w: GitWorktree,
  input: GitFactsInput,
  run: GitRunner,
): Promise<Changes> {
  if (!SHA.test(w.base_sha)) {
    return { ok: false, detail: `worktree ${w.id} has no usable base sha` };
  }
  const where = await locateWorktree(w, input.workRoot);
  if (!where.ok) return where;
  const tracked = await run(
    where.root,
    ["diff", "--name-only", "-z", w.base_sha, "--"],
    input.timeoutMs,
  );
  if (!tracked.ok) return tracked;
  const untracked = await run(
    where.root,
    ["ls-files", "-z", "--others", "--exclude-standard"],
    input.timeoutMs,
  );
  if (!untracked.ok) return untracked;
  const files = new Set([
    ...nulSeparated(tracked.stdout),
    ...nulSeparated(untracked.stdout),
  ]);
  return { ok: true, files: [...files].toSorted() };
}

async function diffFacts(
  active: readonly GitWorktree[],
  input: GitFactsInput,
  run: GitRunner,
): Promise<{
  readonly diff: DiffFact;
  readonly evidence: readonly WorktreeEvidence[];
}> {
  if (active.length === 0) {
    return {
      diff: { state: "unverifiable", detail: "no active worktree to diff" },
      evidence: [],
    };
  }
  let changed: readonly {
    readonly w: GitWorktree;
    readonly files: readonly string[];
  }[] = [];
  for (const w of active) {
    const changes = await changesOf(w, input, run);
    if (!changes.ok) {
      return {
        diff: { state: "unverifiable", detail: changes.detail },
        evidence: [],
      };
    }
    changed = [...changed, { w, files: changes.files }];
  }
  const evidence = changed.map(({ w, files }) => ({
    id: w.id,
    base_sha: w.base_sha,
    files: files.length,
    paths: files.slice(0, MAX_PATHS),
  }));
  const source = changed
    .flatMap(({ files }) =>
      files.filter((path) => !isNonSource(path, input.planPaths)),
    )
    .toSorted();
  const files = changed.reduce((sum, { files }) => sum + files.length, 0);
  const diff: DiffFact =
    source.length === 0
      ? { state: "clean", files }
      : {
          state: "dirty",
          paths: source.slice(0, MAX_PATHS),
          total: source.length,
        };
  return { diff, evidence };
}

/** Gathers only the facts in `need`, never failing: a fact it cannot establish is unverifiable. */
export async function gatherGitFacts(
  input: GitFactsInput,
  run: GitRunner = runGit(),
): Promise<GitFacts> {
  const active = input.worktrees.filter((w) => w.state === "active");
  const planPath = input.planPath;
  const plan =
    input.need.has("plan") && planPath !== null
      ? await planFact(active, planPath, input.workRoot)
      : undefined;
  const diff = input.need.has("diff")
    ? await diffFacts(active, input, run)
    : undefined;
  return {
    ...(plan === undefined ? {} : { plan }),
    ...(diff === undefined ? {} : { diff: diff.diff }),
    evidence: {
      ...(plan === undefined || planPath === null
        ? {}
        : { plan_path: planPath }),
      ...(diff === undefined ? {} : { worktrees: diff.evidence }),
    },
    worktreeIds: active.map((w) => w.id).toSorted(),
  };
}
