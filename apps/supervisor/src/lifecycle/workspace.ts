// Step 2 (§9.2, design §1–§3) on this host: phase R (workspace-plan.ts), then one worktree
// per repo off its mirror, each row inserted before its directory (no directory without a row),
// then the submodules. Git runs through the executor, one mirror's mutex at a time.
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  err,
  hashDoctrine,
  ok,
  rootsOf,
  type DoctrineFile,
  type Result,
} from "@bayon/core";
import {
  insertWorktree,
  setWorktreeState,
  setWorktreeSubmodules,
} from "@bayon/db/supervisor";
import type { Executor } from "@bayon/executors";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";
import { exitedOk, runArgv, type ExecCtx } from "./exec.js";
import { gitSubcommand, safeGitArgs } from "./host-git.js";
import { mirrorKey } from "./mirror.js";
import type { Resolved } from "./resolve.js";
import { checkoutSubmodules } from "./submodules.js";
import { inheritWorktrees } from "./successor.js";
import {
  loadLayout,
  planWorkspace,
  type MirrorGit,
  type PlannedRepo,
  type WorkspacePlan,
} from "./workspace-plan.js";

/** Reads a file relative to a root, null when missing. */
export type RootReader = (rel: string) => Promise<Result<string | null>>;

/** One root's doctrine files: the cwd's under their own paths, an extra root's under its rel_path. */
export interface DoctrineSet {
  readonly prefix: string;
  readonly root: string;
  readonly paths: readonly string[];
  /** Where the root is not this host's (a container), from the supervisor's mirror. */
  readonly read?: RootReader;
}

export interface Workspace {
  /** The runner's cwd: the primary's worktree, or the empty session root without a workspace. */
  readonly cwd: string;
  /** A multi-repo workspace's other worktrees (SpawnSpec.extraRoots). */
  readonly extraRoots: readonly string[];
  readonly baseSha: string | null;
  /** The cwd's set first. */
  readonly doctrine: readonly DoctrineSet[];
}

/** A path inside a root: relative, no `..`. */
const isInside = (rel: string): boolean =>
  !isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");

export async function prepareWorkspace(
  ctx: Ctx,
  r: Resolved,
  executor: Executor,
  signal: AbortSignal,
): Promise<Result<Workspace>> {
  if (r.workspaceId === null) {
    const root = r.paths.root;
    return ok({
      cwd: root,
      extraRoots: [],
      baseSha: null,
      doctrine: [{ prefix: "", root, paths: [] }],
    });
  }
  const layout = await loadLayout(ctx.db, r.workspaceId);
  if (!layout.ok) return layout;
  // A successor whose chain never had a worktree is placed afresh below, every repo of its
  // workspace.
  if (r.successor?.worktree != null) {
    return inheritWorktrees(
      ctx,
      r.sessionId,
      r.successor,
      r.successor.worktree,
      executor,
      layout.value,
    );
  }
  const plan = await planWorkspace(
    ctx,
    r,
    r.workspaceId,
    layout.value,
    {
      git: executorMirrorGit(ctx, executor),
      gitVersion: () => executorGitVersion(ctx, executor, signal),
    },
    signal,
  );
  if (!plan.ok) return plan;
  for (const p of plan.value.repos) {
    const added = await ctx.mirrors.run(mirrorKey(p.repo.mirror_path), () =>
      addWorktree(ctx, r, plan.value, p, executor, signal),
    );
    if (!added.ok) return added;
  }
  const [primary] = plan.value.repos;
  if (primary !== undefined && plan.value.submodules.length > 0) {
    const shas = await checkoutSubmodules(
      ctx,
      executor,
      plan.value,
      primary.path,
      r.at === null ? `frm/${r.sessionId}` : null,
      signal,
    );
    if (!shas.ok) return shas;
    const recorded = await setWorktreeSubmodules(
      ctx.db,
      primary.rowId,
      shas.value,
    );
    if (!recorded.ok) return recorded;
  }
  return workspaceOf(plan.value, r, (p) => (rel) => readLocal(p.path, rel));
}

/** The session's Workspace from its plan: roots by rootsOf (H2), doctrine per root. */
export function workspaceOf(
  plan: WorkspacePlan,
  r: Pick<Resolved, "at">,
  reader: (p: PlannedRepo) => RootReader | undefined,
): Result<Workspace> {
  const { layout } = plan;
  const roots = rootsOf(
    plan.repos.map((p) => ({ id: p.rowId, repo_id: p.repo.id, path: p.path })),
    [layout.primary, ...layout.extras, ...layout.submodules],
    { pinned: r.at !== null },
  );
  if (!roots.ok) return roots;
  if (roots.value === null) {
    return err(
      frmError(
        "internal",
        `workspace ${plan.workspaceId}: no worktree planned`,
      ),
    );
  }
  const { cwd, extraRoots } = roots.value;
  const byPath = new Map(plan.repos.map((p) => [p.path, p]));
  const doctrine = [cwd, ...extraRoots].flatMap((path): DoctrineSet[] => {
    const p = byPath.get(path);
    if (p === undefined) return [];
    const read = reader(p);
    return [
      {
        prefix: path === cwd ? "" : p.repo.rel_path,
        root: p.path,
        paths: p.repo.doctrine,
        ...(read === undefined ? {} : { read }),
      },
    ];
  });
  return ok({
    cwd,
    extraRoots,
    baseSha: byPath.get(cwd)?.baseSha ?? null,
    doctrine,
  });
}

/** The doctrine sets doctrine_hash covers: the profile's hash inputs join the cwd's set. */
export function withHashInputs(
  ws: Workspace,
  inputs: readonly string[],
): DoctrineSet[] {
  const [own, ...rest] = ws.doctrine;
  const first: DoctrineSet = own ?? { prefix: "", root: ws.cwd, paths: [] };
  return [{ ...first, paths: [...first.paths, ...inputs] }, ...rest];
}

/** Phase M for one repo, under its mirror's mutex: the row, then `git worktree add`. */
async function addWorktree(
  ctx: Ctx,
  r: Resolved,
  plan: WorkspacePlan,
  p: PlannedRepo,
  executor: Executor,
  signal: AbortSignal,
): Promise<Result<void>> {
  const detached = r.at !== null;
  const branch = detached
    ? `detached@${p.sha.slice(0, 12)}`
    : `frm/${r.sessionId}`;
  const row = await insertWorktree(ctx.db, {
    id: p.rowId,
    session_root: r.paths.root,
    workspace_id: plan.workspaceId,
    repo_id: p.repo.id,
    path: p.path,
    branch,
    base_sha: p.baseSha,
    ticket_id: r.payload.ticket_id ?? null,
    session_id: r.sessionId,
    state: "active",
  });
  if (!row.ok) return row;
  // A gate reviewer's worktree: --detach, so no ref lands on the mirror.
  const added = await git(
    ctx,
    executor,
    p.repo.mirror_path,
    detached
      ? ["worktree", "add", "--detach", p.path, p.sha]
      : ["worktree", "add", "-b", branch, p.path, p.sha],
    signal,
  );
  if (!added.ok) {
    const orphaned = await setWorktreeState(ctx.db, row.value.id, "orphan");
    if (!orphaned.ok) ctx.log.error({ error: orphaned.error }, "cannot orphan");
    return added;
  }
  if (!detached) {
    await excludeForeman(ctx, executor, p.repo.mirror_path, signal);
  }
  return ok(undefined);
}

/**
 * `git -C <gitDir> <args>` on the executor, with SAFE_GIT (M2); stdout on exit 0. A stop
 * (`signal`) or workspace.git_timeout_ms ends it: the executor SIGKILLs its process group and this
 * returns at once, so a fetch the network never answers cannot hold the per-mirror mutex. A stop
 * is `interrupted`, the timeout `timeout`.
 */
export async function git(
  ctx: ExecCtx,
  executor: Executor,
  gitDir: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<Result<string>> {
  const what = `git ${gitSubcommand(args)}`;
  const ran = exitedOk(
    await runArgv(
      ctx,
      executor,
      ["git", ...safeGitArgs(["-C", gitDir, ...args])],
      { what, ...(signal === undefined ? {} : { signal }) },
    ),
    what,
  );
  return ran.ok ? ok(ran.value.stdout.trim()) : ran;
}

/** Git on a mirror through the executor, to its exit whatever its code (phase R's reads). */
export function executorMirrorGit(ctx: ExecCtx, executor: Executor): MirrorGit {
  const git: MirrorGit = (gitDir, args, signal, env) =>
    runArgv(ctx, executor, ["git", ...safeGitArgs(["-C", gitDir, ...args])], {
      what: `git ${gitSubcommand(args)}`,
      signal,
      ...(env === undefined ? {} : { env }),
    });
  // A forge token goes to a child on this host only (Invariant 11): a git on any other executor is
  // marked, so withGitAuth never offers it one, exactly as before an earlier change.
  return executor.kind === "local"
    ? git
    : Object.assign(git, { offHost: true as const });
}

/** The executor's `git --version` (§3.6). */
async function executorGitVersion(
  ctx: ExecCtx,
  executor: Executor,
  signal: AbortSignal,
): Promise<Result<string>> {
  const what = "git --version";
  const ran = exitedOk(
    await runArgv(ctx, executor, ["git", "--version"], { what, signal }),
    what,
  );
  return ran.ok ? ok(ran.value.stdout.trim()) : ran;
}

const FOREMAN_EXCLUDE = ".foreman/";

/**
 * `.foreman/` in the mirror's info/exclude (MEDIUM 8): linked worktrees read the
 * common dir's, so hand-off packets never show in git status or a no_source_changes diff. Once
 * per mirror, under its mutex; a failure is logged and the spawn goes on.
 */
async function excludeForeman(
  ctx: Ctx,
  executor: Executor,
  mirror: string,
  signal: AbortSignal,
): Promise<void> {
  const info = join(mirror, "info");
  const file = join(info, "exclude");
  const what = `exclude ${FOREMAN_EXCLUDE}`;
  const has = await runArgv(
    ctx,
    executor,
    ["grep", "-qxF", FOREMAN_EXCLUDE, file],
    { what, signal },
  );
  if (has.ok && has.value.code === 0) return;
  const made = exitedOk(
    await runArgv(ctx, executor, ["mkdir", "-p", info], { what, signal }),
    what,
  );
  const added = made.ok
    ? exitedOk(
        await runArgv(ctx, executor, ["tee", "-a", file], {
          what,
          input: `\n${FOREMAN_EXCLUDE}\n`,
          signal,
        }),
        what,
      )
    : made;
  if (!added.ok) {
    ctx.log.warn(
      { mirror, error: added.error },
      "cannot add .foreman/ to the mirror's info/exclude",
    );
  }
}

/** A doctrine file in a worktree on this host; null when missing. */
export async function readLocal(
  root: string,
  path: string,
): Promise<Result<string | null>> {
  try {
    return ok(await readFile(join(root, path), "utf8"));
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "ENOENT"
      ? ok(null)
      : err(frmError("internal", `cannot read doctrine ${path}`, String(e)));
  }
}

/**
 * doctrine_hash over the files that exist in each root: the cwd's under their own paths (so a
 * single-repo session's hash is what it was), an extra root's under `<rel_path>/<path>`.
 */
export async function doctrineHash(
  sets: readonly DoctrineSet[],
): Promise<Result<string>> {
  const files: DoctrineFile[] = [];
  for (const set of sets) {
    const read = set.read ?? ((path: string) => readLocal(set.root, path));
    const unique = [...new Set(set.paths)].filter(isInside).toSorted();
    for (const path of unique) {
      const content = await read(path);
      if (!content.ok) return content;
      if (content.value !== null) {
        files.push({
          path: set.prefix === "" ? path : `${set.prefix}/${path}`,
          content: content.value,
        });
      }
    }
  }
  return ok(await hashDoctrine(files));
}
