// Step 2 (§9.2) on an executor whose programs cannot see this host's files: a container (design
//). Phase R runs on the supervisor's own mirrors (host git) and pushes
// each repo's base, and each submodule's commit as refs/frm/pin/<sid>, into the executor's mirror
// (L3: so it is not read-only here). Then every worktree row is inserted (M4), then one fixed
// script in the session's container clones --reference each repo from its mirror (mounted
// read-only at its host path) and checks each submodule out. Git on session content runs in the
// container, never on the docker host (M3 amendment §6.1).
import { posix } from "node:path";
import {
  GIT_OBJECT_ID,
  RESERVED_MIRROR_PREFIX,
  err,
  isReservedRepoId,
  ok,
  submoduleNameProblem,
  submodulePathProblem,
  type Result,
  type SubmoduleShas,
} from "@bayon/core";
import type { WorktreeRow } from "@bayon/db";
import {
  insertWorktree,
  setWorktreeState,
  setWorktreeSubmodules,
} from "@bayon/db/supervisor";
import {
  GIT_ENV_FLOOR_SH,
  PIN_REF,
  SAFE_GIT_SH,
  type Executor,
  type ExecutorMirrors,
} from "@bayon/executors";
import type { Ctx } from "./context.js";
import { asFrmError, frmError } from "./errors.js";
import { exitedOk, runArgv, type ExecCtx } from "./exec.js";
import { gitSubcommand, hostGit, hostGitRun } from "./host-git.js";
import type { Resolved } from "./resolve.js";
import { workspaceOf, type Workspace } from "./workspace.js";
import {
  loadLayout,
  planWorkspace,
  type PlannedRepo,
  type WorkspacePlan,
} from "./workspace-plan.js";

// Host git, where the conformance workspace takes it from.
export { hostGit } from "./host-git.js";

/**
 * What the clone checks out: a new `frm/<sid>` at the base (a session's own branch), or a pinned
 * commit, detached, kept alive in the executor's mirror under `ref` (a gate's
 * `refs/frm/gate/<gate id>`), so gc never drops it.
 */
export type RemoteCheckout =
  | { readonly kind: "branch" }
  | {
      readonly kind: "detached";
      readonly sha: string;
      readonly baseSha: string;
      readonly ref: string;
    };

/**
 * The container's side, one exec (each costs ~0.6 s over ssh). `$1` home, `$2` tmp, `$3` the mode
 * (`dirs` | `branch` | `detached`); then 4-tuples `mirror dest rev branch`, the primary first; `--`;
 * then 5-tuples `parent name path mirror sha`, parents first. It prints NUL-delimited
 * `<dest> <HEAD>` and `<parent/path> <HEAD>` records. Hardened (L1): tuple counts checked, every
 * expansion quoted, `cd --`, paths re-checked here.
 */
export const WORKSPACE_SH = [
  "set -eu",
  "umask 077",
  'bad() { echo "frm-workspace: $1" >&2; exit 64; }',
  '[ "$#" -ge 3 ] || bad "missing arguments"',
  "home=$1 tmp=$2 mode=$3",
  "shift 3",
  'mkdir -p -- "$home" "$tmp"',
  'if [ "$mode" = dirs ]; then exit 0; fi',
  'case $mode in branch|detached) ;; *) bad "unknown mode $mode" ;; esac',
  `export HOME="$home" ${GIT_ENV_FLOOR_SH}`,
  `g() { git ${SAFE_GIT_SH} "$@"; }`,
  'rel() { case $1 in ""|/*|-*|*//*|*/) return 1 ;; esac; case /$1/ in */../*|*/./*) return 1 ;; esac; return 0; }',
  "super= sbranch=",
  'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do',
  '  [ "$#" -ge 4 ] || bad "a clone takes 4 arguments"',
  "  mirror=$1 dest=$2 rev=$3 branch=$4",
  "  shift 4",
  '  case $dest in /*) ;; *) bad "a destination is an absolute path" ;; esac',
  '  g clone --quiet --no-checkout --reference "$mirror" "file://$mirror" "$dest"',
  '  cd -- "$dest"',
  '  if [ "$mode" = branch ]; then',
  '    case $branch in frm/*) ;; *) bad "a branch is frm/<session>" ;; esac',
  '    g checkout --quiet -b "$branch" "$rev"',
  "  else",
  '    g -c advice.detachedHead=false checkout --quiet --detach "$rev"',
  "  fi",
  "  mkdir -p .git/info",
  "  printf '\\n.foreman/\\n' >> .git/info/exclude",
  "  head=$(g rev-parse HEAD)",
  '  printf \'%s\\0%s\\0\' "$dest" "$head"',
  '  if [ -z "$super" ]; then super=$dest sbranch=$branch; fi',
  "done",
  'if [ "$#" -gt 0 ]; then shift; fi',
  'while [ "$#" -gt 0 ]; do',
  '  [ "$#" -ge 5 ] || bad "a submodule takes 5 arguments"',
  "  parent=$1 name=$2 path=$3 mirror=$4 sha=$5",
  "  shift 5",
  '  [ -n "$super" ] || bad "a submodule needs a clone"',
  '  if [ -n "$parent" ]; then rel "$parent" || bad "a parent is a relative path"; fi',
  '  rel "$path" || bad "a submodule path is a relative path"',
  "  full=$parent${parent:+/}$path",
  '  cd -- "$super${parent:+/}$parent"',
  '  g -c protocol.allow=never -c protocol.file.allow=always -c "submodule.$name.url=$mirror" -c "submodule.$name.active=true" -c "submodule.$name.update=checkout" submodule --quiet update --init --checkout --no-recommend-shallow -- "$path"',
  '  cd -- "$super/$full"',
  "  top=$(g rev-parse --show-toplevel)",
  '  [ "$top" = "$(pwd -P)" ] || bad "$full is not its own repository"',
  '  if [ "$mode" = branch ]; then g checkout --quiet -b "$sbranch"; fi',
  "  head=$(g rev-parse HEAD)",
  '  printf \'%s\\0%s\\0\' "$full" "$head"',
  '  [ "$head" = "$sha" ] || bad "$full is at $head, not $sha"',
  "done",
].join("\n");

/** One repo the script clones. `branch` is `frm/<sid>`, or "" for a detached checkout. */
export interface CloneStep {
  readonly mirror: string;
  readonly dest: string;
  readonly rev: string;
  readonly branch: string;
}

/** One submodule the script checks out; `parent` and `path` as the plan's `parent` and `rel`. */
export interface SubmoduleStep {
  readonly parent: string;
  readonly name: string;
  readonly path: string;
  readonly mirror: string;
  readonly sha: string;
}

export type WorkspaceStep =
  | { readonly mode: "dirs" }
  | {
      readonly mode: "branch" | "detached";
      readonly clones: readonly CloneStep[];
      readonly submodules?: readonly SubmoduleStep[];
    };

/** The argv the container runs for the workspace step. */
export function workspaceArgv(
  paths: { readonly home: string; readonly tmp: string },
  step: WorkspaceStep,
): readonly [string, ...string[]] {
  const rest =
    step.mode === "dirs"
      ? []
      : [
          ...step.clones.flatMap((c) => [c.mirror, c.dest, c.rev, c.branch]),
          "--",
          ...(step.submodules ?? []).flatMap((s) => [
            s.parent,
            s.name,
            s.path,
            s.mirror,
            s.sha,
          ]),
        ];
  return [
    "/bin/sh",
    "-c",
    WORKSPACE_SH,
    "frm-workspace",
    paths.home,
    paths.tmp,
    step.mode,
    ...rest,
  ];
}

const BRANCH = /^frm\/[A-Za-z0-9_-]{1,64}$/;

/** Why the step's arguments may not reach the script, or null (L1): checked before any exec. */
export function workspaceStepProblem(
  root: string,
  step: WorkspaceStep,
): string | null {
  if (step.mode === "dirs") return null;
  if (step.clones.length === 0) return "no repo to clone";
  for (const c of step.clones) {
    if (!c.dest.startsWith(`${root}/`) || posix.normalize(c.dest) !== c.dest) {
      return `destination ${JSON.stringify(c.dest)} is not under ${root}`;
    }
    if (!GIT_OBJECT_ID.test(c.rev)) {
      return `rev ${JSON.stringify(c.rev)} is not an object id`;
    }
    const fits =
      step.mode === "branch" ? BRANCH.test(c.branch) : c.branch === "";
    if (!fits) {
      return `branch ${JSON.stringify(c.branch)} does not fit ${step.mode}`;
    }
  }
  for (const s of step.submodules ?? []) {
    const name = submoduleNameProblem(s.name);
    if (name !== null) {
      return `submodule name ${JSON.stringify(s.name)} ${name}`;
    }
    const path = submodulePathProblem(s.path);
    if (path !== null) {
      return `submodule path ${JSON.stringify(s.path)} ${path}`;
    }
    const parent = s.parent === "" ? null : submodulePathProblem(s.parent);
    if (parent !== null) {
      return `submodule parent ${JSON.stringify(s.parent)} ${parent}`;
    }
    if (!GIT_OBJECT_ID.test(s.sha)) {
      return `sha ${JSON.stringify(s.sha)} is not an object id`;
    }
  }
  return null;
}

/** The script's NUL-delimited records: path → HEAD. */
export function parseWorkspaceOutput(stdout: string): Map<string, string> {
  const fields = stdout.split("\0");
  const heads = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i];
    const head = fields[i + 1];
    if (key !== undefined && head !== undefined) heads.set(key, head);
  }
  return heads;
}

export async function prepareRemoteWorkspace(
  ctx: Ctx,
  r: Resolved,
  executor: Executor,
  signal: AbortSignal,
  checkout: RemoteCheckout = { kind: "branch" },
): Promise<Result<Workspace>> {
  if (r.workspaceId === null) {
    const made = await inContainer(ctx, r, executor, { mode: "dirs" }, signal);
    const root = r.paths.root;
    return made.ok
      ? ok({
          cwd: root,
          extraRoots: [],
          baseSha: null,
          doctrine: [
            { prefix: "", root, paths: [], read: async () => ok(null) },
          ],
        })
      : made;
  }
  // A successor placed afresh (its chain never had a worktree) clones as usual.
  if (r.successor?.worktree != null) {
    return err(
      frmError(
        "validation",
        `session ${r.sessionId}: a worktree is not inherited across containers until M4's sync-back`,
      ),
    );
  }
  // A pinned commit is kept only under a pin ref, never a branch another session sees.
  if (checkout.kind === "detached" && !PIN_REF.test(checkout.ref)) {
    return err(
      frmError(
        "validation",
        `refusing the pin ref ${JSON.stringify(checkout.ref)}`,
      ),
    );
  }
  const { mirrors } = executor;
  if (mirrors === undefined) {
    return err(
      frmError(
        "validation",
        `executor ${executor.id} places sessions but keeps no mirrors`,
      ),
    );
  }
  const layout = await loadLayout(ctx.db, r.workspaceId);
  if (!layout.ok) return layout;
  // The executor's own mirrors take this prefix: a repo with it would share one (H1).
  // Every repo of the workspace is refused before any push, submodules included.
  const { primary, extras, submodules } = layout.value;
  const reserved = [primary, ...extras, ...submodules].find((repo) =>
    isReservedRepoId(repo.id),
  );
  if (reserved !== undefined) {
    return err(
      frmError(
        "validation",
        `repo ${reserved.id}: the prefix ${RESERVED_MIRROR_PREFIX} is reserved for executor mirrors`,
      ),
    );
  }
  const pinRefs =
    checkout.kind === "detached" ? [`+${checkout.sha}:${checkout.ref}`] : [];
  const plan = await planWorkspace(
    ctx,
    r,
    r.workspaceId,
    layout.value,
    {
      git: (dir, args, s, env) =>
        hostGitRun(ctx, ["-C", dir, ...args], {
          what: `git ${gitSubcommand(args)}`,
          signal: s,
          ...(env === undefined ? {} : { env }),
        }),
      gitVersion: () => containerGitVersion(ctx, r, executor, signal),
      afterRepo: (p) =>
        push(
          executor,
          mirrors,
          p.repo,
          [
            `+${p.baseRef}:refs/heads/${p.repo.default_base_branch}`,
            ...pinRefs,
          ],
          signal,
        ),
      afterSubmodule: (s) =>
        push(
          executor,
          mirrors,
          { id: s.repoId, mirror_path: s.mirror },
          [`+${s.sha}:refs/frm/pin/${r.sessionId}`],
          signal,
        ),
    },
    signal,
  );
  if (!plan.ok) return plan;
  return materialize(ctx, r, executor, mirrors, plan.value, checkout, signal);
}

/** Phase M: every row first (M4), then the one exec that makes every directory. */
async function materialize(
  ctx: Ctx,
  r: Resolved,
  executor: Executor,
  mirrors: ExecutorMirrors,
  plan: WorkspacePlan,
  checkout: RemoteCheckout,
  signal: AbortSignal,
): Promise<Result<Workspace>> {
  const detached = checkout.kind === "detached";
  const branchOf = (p: PlannedRepo): string =>
    detached ? `detached@${p.sha.slice(0, 12)}` : `frm/${r.sessionId}`;
  const step: WorkspaceStep = {
    mode: checkout.kind,
    clones: plan.repos.map((p) => ({
      mirror: mirrors.path(p.repo.id),
      dest: p.path,
      rev: p.sha,
      branch: detached ? "" : branchOf(p),
    })),
    submodules: plan.submodules.map((s) => ({
      parent: s.parent,
      name: s.name,
      path: s.rel,
      mirror: mirrors.path(s.repoId),
      sha: s.sha,
    })),
  };
  const problem = workspaceStepProblem(r.paths.root, step);
  if (problem !== null) {
    return err(
      frmError(
        "validation",
        `the workspace step for ${r.sessionId}: ${problem}`,
      ),
    );
  }
  const rows: WorktreeRow[] = [];
  for (const p of plan.repos) {
    const row = await insertWorktree(ctx.db, {
      id: p.rowId,
      session_root: r.paths.root,
      workspace_id: plan.workspaceId,
      repo_id: p.repo.id,
      path: p.path,
      branch: branchOf(p),
      base_sha: p.baseSha,
      ticket_id: r.payload.ticket_id ?? null,
      session_id: r.sessionId,
      state: "active",
    });
    if (!row.ok) {
      await orphanAll(ctx, rows);
      return row;
    }
    rows.push(row.value);
  }
  const ran = await inContainer(ctx, r, executor, step, signal);
  const verified = ran.ok ? verify(plan, parseWorkspaceOutput(ran.value)) : ran;
  if (!verified.ok) {
    await orphanAll(ctx, rows);
    return verified;
  }
  const [primary] = plan.repos;
  if (primary !== undefined && plan.submodules.length > 0) {
    const shas: SubmoduleShas = {
      v: 1,
      git: plan.gitVersion ?? "unknown",
      shas: plan.submodules.map((s) => ({
        path: s.path,
        repo_id: s.repoId,
        sha: s.sha,
      })),
    };
    const recorded = await setWorktreeSubmodules(ctx.db, primary.rowId, shas);
    if (!recorded.ok) return recorded;
  }
  return workspaceOf(
    plan,
    r,
    (p) => (file) => showAt(ctx, p.repo.mirror_path, p.sha, file),
  );
}

/** Every clone and submodule at the plan's commit, as the script printed. */
function verify(
  plan: WorkspacePlan,
  heads: ReadonlyMap<string, string>,
): Result<void> {
  const wrong = [
    ...plan.repos.map((p) => [p.path, p.sha] as const),
    ...plan.submodules.map((s) => [s.path, s.sha] as const),
  ].find(([key, sha]) => heads.get(key) !== sha);
  return wrong === undefined
    ? ok(undefined)
    : err(
        frmError(
          "spawn_failed",
          `the workspace step left ${wrong[0]} at ${heads.get(wrong[0]) ?? "nothing"}, not ${wrong[1]}`,
        ),
      );
}

async function orphanAll(
  ctx: Ctx,
  rows: readonly WorktreeRow[],
): Promise<void> {
  for (const row of rows) {
    const orphaned = await setWorktreeState(ctx.db, row.id, "orphan");
    if (!orphaned.ok) ctx.log.error({ error: orphaned.error }, "cannot orphan");
  }
}

const push = (
  executor: Executor,
  mirrors: ExecutorMirrors,
  repo: { readonly id: string; readonly mirror_path: string },
  refspecs: readonly string[],
  signal: AbortSignal,
): Promise<Result<void>> =>
  pushToExecutorMirror(executor, mirrors, {
    localMirror: repo.mirror_path,
    name: repo.id,
    refspecs,
    signal,
  });

/**
 * Pushes `refspecs` from the supervisor's bare mirror into the executor's mirror `name` (design
 * an earlier change §3 step 2). `attempts` above 1 retries a failed push: two supervisors creating the same
 * content-addressed ref race, and the loser's old-value check fails once (L3).
 */
export async function pushToExecutorMirror(
  executor: Executor,
  mirrors: ExecutorMirrors,
  o: {
    readonly localMirror: string;
    readonly name: string;
    readonly refspecs: readonly string[];
    readonly signal: AbortSignal;
    readonly attempts?: number;
  },
): Promise<Result<void>> {
  const attempts = Math.max(1, o.attempts ?? 1);
  let failure: unknown;
  for (let i = 0; i < attempts && !o.signal.aborted; i += 1) {
    try {
      await mirrors.push({
        localMirror: o.localMirror,
        name: o.name,
        refspecs: o.refspecs,
        signal: o.signal,
      });
      return ok(undefined);
    } catch (e) {
      failure = e;
    }
  }
  return err(
    asFrmError(
      failure,
      "spawn_failed",
      `cannot push ${o.name} to ${executor.id}`,
    ),
  );
}

/** The session container's `git --version` (§3.6): the git that checks submodules out. */
async function containerGitVersion(
  ctx: Ctx,
  r: Resolved,
  executor: Executor,
  signal: AbortSignal,
): Promise<Result<string>> {
  const what = `git --version in the container of ${r.sessionId}`;
  const ran = exitedOk(
    await runArgv(ctx, executor, ["git", "--version"], {
      what,
      signal,
      cwd: r.paths.root,
    }),
    what,
  );
  return ran.ok ? ok(ran.value.stdout.trim()) : ran;
}

/** Where a session's workspace step runs: its root, home and tmp on the executor. */
export interface ClonePlace {
  readonly sessionId: string;
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
}

/**
 * The workspace step in the session's container, one exec: cwd its root, PATH its executor's.
 * Its stdout is the script's NUL-delimited records (parseWorkspaceOutput). Shared with the
 * conformance workspace.
 */
export async function cloneInContainer(
  exec: ExecCtx,
  executor: Executor,
  place: ClonePlace,
  step: WorkspaceStep,
  signal: AbortSignal,
): Promise<Result<string>> {
  const what = `the workspace step for ${place.sessionId} on ${executor.id}`;
  const ran = exitedOk(
    await runArgv(exec, executor, workspaceArgv(place, step), {
      what,
      signal,
      cwd: place.root,
    }),
    what,
  );
  return ran.ok ? ok(ran.value.stdout) : ran;
}

/** The workspace step in the session's container: cwd its root, PATH its executor's. */
function inContainer(
  ctx: Ctx,
  r: Resolved,
  executor: Executor,
  step: WorkspaceStep,
  signal: AbortSignal,
): Promise<Result<string>> {
  const { root, home, tmp } = r.paths;
  return cloneInContainer(
    ctx,
    executor,
    { sessionId: r.sessionId, root, home, tmp },
    step,
    signal,
  );
}

const MISSING =
  /does not exist in|exists on disk, but not in|not a valid object name|invalid object name/i;

/** A file at a commit of the supervisor's mirror: the clone holds exactly that commit. */
async function showAt(
  ctx: Ctx,
  mirror: string,
  rev: string,
  file: string,
): Promise<Result<string | null>> {
  // Untrimmed: a file's bytes, trailing newline and all, are what doctrine_hash covers.
  const shown = await hostGit(
    ctx,
    mirror,
    ["show", `${rev}:${file}`],
    new AbortController().signal,
    { trim: false },
  );
  if (shown.ok) return shown;
  return MISSING.test(shown.error.message) ? ok(null) : shown;
}
