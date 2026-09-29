// Phase R of the workspace step: the layout checked, each repo's
// mirror made on first use, fetched and its commit fixed, and the submodule plan read from the
// mirrors alone. One mirror mutex at a time, never two held, so two spawns sharing mirrors in any
// order cannot deadlock. It reads only (a container's pushes aside, L3): a refusal here leaves no
// worktree row and no directory. Phase M (workspace.ts, remote-workspace.ts) then materializes it.
import { posix } from "node:path";
import {
  childrenOf,
  err,
  gitVersionProblem,
  newId,
  ok,
  parseGitVersion,
  parseGitlinks,
  parseGitmodules,
  workspaceLayout,
  type DeclaredSubmodule,
  type Result,
  type SubmoduleEntry,
  type SubmoduleNode,
  type WorkspaceKind,
  type WorkspaceLayout,
} from "@bayon/core";
import {
  getWorkspace,
  getWorkspaceRepos,
  type Db,
  type WorkspaceRepo,
} from "@bayon/db";
import { z } from "zod";
import { originGitAuth, type GitAuth } from "../forge/credential.js";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";
import type { Exited } from "./exec.js";
import { failedGit } from "./host-git.js";
import { ensureMirror, mirrorKey } from "./mirror.js";
import type { Resolved } from "./resolve.js";

/**
 * Git on one of the supervisor's mirrors, to its exit whatever its code. `env` is added to git's.
 * `offHost` marks a git that runs on a non-local executor: it is never offered a credential.
 */
export type MirrorGit = ((
  gitDir: string,
  args: readonly string[],
  signal: AbortSignal,
  env?: Readonly<Record<string, string>>,
) => Promise<Result<Exited>>) & { readonly offHost?: true };

/**
 * `git`, offering `auth` to the origin: its flags before each call's subcommand, its env
 * beside git's. The token is only ever in that env. No auth is `git` itself, and so is a git off
 * this host (Invariant 11: the token goes to a child on this host only; a remote executor needs an
 * explicit decision first).
 */
export const withGitAuth = (git: MirrorGit, auth: GitAuth): MirrorGit =>
  auth.flags.length === 0 || git.offHost === true
    ? git
    : (dir, args, signal, env) =>
        git(dir, [...auth.flags, ...args], signal, { ...env, ...auth.env });

/** A workspace repo with its doctrine paths parsed. */
export type CheckedRepo = WorkspaceRepo & {
  readonly doctrine: readonly string[];
};

/** One repo's worktree to make, its row id minted in phase R (M6). */
export interface PlannedRepo {
  readonly repo: CheckedRepo;
  readonly rowId: string;
  /** The session root joined with its rel_path. */
  readonly path: string;
  /** What is checked out: the base's tip, or a pinned commit. */
  readonly sha: string;
  readonly baseSha: string;
  /** The base branch as the mirror names it: refs/remotes/origin/<b>, or refs/heads/<b>. */
  readonly baseRef: string;
}

/** A submodule to check out, and the supervisor's mirror of its repo. */
export interface PlannedSubmodule extends SubmoduleEntry {
  readonly mirror: string;
}

export interface WorkspacePlan {
  readonly workspaceId: string;
  readonly kind: WorkspaceKind;
  readonly layout: WorkspaceLayout<CheckedRepo>;
  /** The worktrees to make, the primary's first (a pinned checkout: its one repo). */
  readonly repos: readonly PlannedRepo[];
  /** Parents before children. */
  readonly submodules: readonly PlannedSubmodule[];
  /** A submodule workspace's git (§3.6); null otherwise. */
  readonly gitVersion: string | null;
}

export interface PlanHooks {
  readonly git: MirrorGit;
  /** `git --version` of the git that checks submodules out: the executor's. */
  readonly gitVersion: () => Promise<Result<string>>;
  /** Inside each repo's mutex hold, once its commit is fixed: a container's push. */
  readonly afterRepo?: (p: PlannedRepo) => Promise<Result<void>>;
  /** Inside each submodule repo's hold, once its commit is present: a container's pin push. */
  readonly afterSubmodule?: (s: PlannedSubmodule) => Promise<Result<void>>;
}

const REF_NAME = /^(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const RelPaths = z.array(z.string().min(1));
const isInside = (rel: string): boolean =>
  !posix.isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");

const invalid = (message: string): Result<never> =>
  err(frmError("validation", message));

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A workspace's rows, each checked, and its layout (§1): every refusal is `validation`. */
export async function loadLayout(
  db: Db,
  workspaceId: string,
): Promise<Result<WorkspaceLayout<CheckedRepo>>> {
  const ws = await getWorkspace(db, workspaceId);
  if (!ws.ok) return ws;
  const rows = await getWorkspaceRepos(db, workspaceId);
  if (!rows.ok) return rows;
  const checked: CheckedRepo[] = [];
  for (const repo of rows.value) {
    if (!REF_NAME.test(repo.default_base_branch)) {
      return invalid(
        `workspace ${workspaceId}: repo ${repo.id} has an unsafe base branch`,
      );
    }
    const doctrine = RelPaths.safeParse(parseJson(repo.doctrine_paths_json));
    if (!doctrine.success || !doctrine.data.every(isInside)) {
      return invalid(
        `workspace ${workspaceId}: repo ${repo.id} doctrine_paths_json is not a list of paths`,
      );
    }
    checked.push({ ...repo, doctrine: doctrine.data });
  }
  const layout = workspaceLayout(ws.value.kind, checked);
  return layout.ok
    ? layout
    : invalid(`workspace ${workspaceId}: ${layout.error.message}`);
}

/** git, to exit 0: its stdout, else `spawn_failed` naming it. */
export async function gitOk(
  git: MirrorGit,
  dir: string,
  args: readonly string[],
  signal: AbortSignal,
  o: { readonly trim?: boolean } = {},
): Promise<Result<string>> {
  const ran = await git(dir, args, signal);
  if (!ran.ok) return ran;
  if (ran.value.code !== 0) {
    return err(failedGit(`git ${args[0] ?? ""}`, ran.value));
  }
  return ok(o.trim === false ? ran.value.stdout : ran.value.stdout.trim());
}

/** The base branch fetched with an explicit refspec and no --prune (a mirror's other refs are not ours). */
export async function fetchBase(
  git: MirrorGit,
  repo: Pick<
    WorkspaceRepo,
    "origin_url" | "mirror_path" | "default_base_branch"
  >,
  signal: AbortSignal,
): Promise<Result<void>> {
  if (repo.origin_url === null) return ok(undefined);
  const base = repo.default_base_branch;
  const fetched = await gitOk(
    git,
    repo.mirror_path,
    ["fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`],
    signal,
  );
  return fetched.ok ? ok(undefined) : fetched;
}

/** The base branch's ref in the mirror. */
export const baseRefOf = (
  repo: Pick<WorkspaceRepo, "origin_url" | "default_base_branch">,
): string =>
  `${repo.origin_url === null ? "refs/heads" : "refs/remotes/origin"}/${repo.default_base_branch}`;

/**
 * Whether `sha` is a commit in the repo's mirror, fetching before it answers no (§3.3, L4; H1): its
 * base branch when `fetchBaseFirst`, then every head (`+refs/heads/*:refs/remotes/origin/*`, no
 * --prune). Never a fetch by SHA. A mirror with no origin answers from what it holds.
 */
export async function ensureCommit(
  git: MirrorGit,
  repo: Pick<
    WorkspaceRepo,
    "origin_url" | "mirror_path" | "default_base_branch"
  >,
  sha: string,
  signal: AbortSignal,
  o: { readonly fetchBaseFirst: boolean },
): Promise<Result<boolean>> {
  const has = async (): Promise<Result<boolean>> => {
    const r = await git(
      repo.mirror_path,
      ["cat-file", "-e", `${sha}^{commit}`],
      signal,
    );
    return r.ok ? ok(r.value.code === 0) : r;
  };
  const first = await has();
  if (!first.ok || first.value || repo.origin_url === null) return first;
  if (o.fetchBaseFirst) {
    const base = await fetchBase(git, repo, signal);
    if (!base.ok) return base;
    const again = await has();
    if (!again.ok || again.value) return again;
  }
  const heads = await gitOk(
    git,
    repo.mirror_path,
    ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"],
    signal,
  );
  if (!heads.ok) return heads;
  return has();
}

/**
 * A repo of the submodule tree at one commit, read from its mirror: its `.gitmodules` (through
 * `git config --no-includes --blob`, git's own parser) and its gitlinks.
 */
export async function readNode(
  git: MirrorGit,
  mirror: string,
  repoId: string,
  sha: string,
  prefix: string,
  signal: AbortSignal,
): Promise<Result<SubmoduleNode>> {
  const listed = await gitOk(
    git,
    mirror,
    ["ls-tree", "-z", sha, "--", ".gitmodules"],
    signal,
  );
  if (!listed.ok) return listed;
  let entries: SubmoduleNode["entries"] = [];
  if (listed.value !== "") {
    const cfg = await git(
      mirror,
      [
        "config",
        "--no-includes",
        "--blob",
        `${sha}:.gitmodules`,
        "--null",
        "--get-regexp",
        "^submodule\\.",
      ],
      signal,
    );
    if (!cfg.ok) return cfg;
    // 1: no submodule section at all.
    if (cfg.value.code !== 0 && cfg.value.code !== 1) {
      return err(failedGit("git config", cfg.value));
    }
    const parsed = parseGitmodules(
      cfg.value.code === 0 ? cfg.value.stdout : "",
    );
    if (!parsed.ok) {
      return invalid(
        `repo ${repoId} at ${sha.slice(0, 12)}: ${parsed.error.message}`,
      );
    }
    entries = parsed.value;
  }
  const tree = await gitOk(git, mirror, ["ls-tree", "-r", "-z", sha], signal, {
    trim: false,
  });
  if (!tree.ok) return tree;
  return ok({
    prefix,
    repoId,
    sha,
    entries,
    gitlinks: parseGitlinks(tree.value),
  });
}

/** The repos a session works in: primary and extras, or a pinned checkout's one repo. */
function chosenRepos(
  workspaceId: string,
  layout: WorkspaceLayout<CheckedRepo>,
  at: Resolved["at"],
): Result<CheckedRepo[]> {
  const worktreeRepos = [layout.primary, ...layout.extras];
  if (at === null) return ok(worktreeRepos);
  const want = at.repoId ?? layout.primary.id;
  const found = worktreeRepos.find((r) => r.id === want);
  return found === undefined
    ? invalid(
        `workspace ${workspaceId}: the pinned repo ${want} has no worktree of its own (a submodule, or not a repo of the workspace)`,
      )
    : ok([found]);
}

async function checkVersion(
  ctx: Ctx,
  hooks: PlanHooks,
): Promise<Result<string>> {
  const text = await hooks.gitVersion();
  if (!text.ok) return text;
  const version = parseGitVersion(text.value);
  if (version === null) {
    return invalid(
      `cannot read git's version from ${JSON.stringify(text.value.slice(0, 80))}`,
    );
  }
  const problem = gitVersionProblem(
    version,
    ctx.settings["workspace.git_patched"],
  );
  return problem === null ? ok(version) : invalid(problem);
}

async function resolveRepo(
  ctx: Ctx,
  hooks: PlanHooks,
  r: Resolved,
  repo: CheckedRepo,
  rowId: string,
  signal: AbortSignal,
): Promise<Result<PlannedRepo>> {
  // The origin's forge token, if delivery's rule offers one: for the clone and the fetch.
  const auth = await originGitAuth(ctx.secrets, repo.origin_url);
  const made = await ensureMirror(ctx, repo, signal, auth);
  if (!made.ok) return made;
  const baseRef = baseRefOf(repo);
  const path = posix.join(r.paths.root, repo.rel_path);
  let planned: PlannedRepo;
  if (r.at !== null) {
    planned = {
      repo,
      rowId,
      path,
      sha: r.at.sha,
      baseSha: r.at.baseSha,
      baseRef,
    };
  } else {
    const fetched = await fetchBase(withGitAuth(hooks.git, auth), repo, signal);
    if (!fetched.ok) return fetched;
    const sha = await gitOk(
      hooks.git,
      repo.mirror_path,
      ["rev-parse", "--verify", `${baseRef}^{commit}`],
      signal,
    );
    if (!sha.ok) return sha;
    planned = {
      repo,
      rowId,
      path,
      sha: sha.value,
      baseSha: sha.value,
      baseRef,
    };
  }
  if (hooks.afterRepo !== undefined) {
    const after = await hooks.afterRepo(planned);
    if (!after.ok) return after;
  }
  return ok(planned);
}

/** The submodule tree under the superproject, parents first, each child's commit present. */
async function planSubmodules(
  ctx: Ctx,
  hooks: PlanHooks,
  layout: WorkspaceLayout<CheckedRepo>,
  primary: PlannedRepo,
  signal: AbortSignal,
): Promise<Result<PlannedSubmodule[]>> {
  const declared: DeclaredSubmodule[] = layout.submodules.map((s) => ({
    repoId: s.id,
    path: s.submodule_path ?? "",
  }));
  const root = await ctx.mirrors.run(mirrorKey(primary.repo.mirror_path), () =>
    readNode(
      hooks.git,
      primary.repo.mirror_path,
      primary.repo.id,
      primary.sha,
      "",
      signal,
    ),
  );
  if (!root.ok) return root;
  const first = childrenOf(root.value, declared);
  if (!first.ok) return first;
  const queue = [...first.value];
  const planned: PlannedSubmodule[] = [];
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    const current = entry;
    const repo = layout.submodules.find((s) => s.id === current.repoId);
    if (repo === undefined) {
      return invalid(
        `submodule ${current.path}: repo ${current.repoId} is gone`,
      );
    }
    // Only the child's mutex (L2): never parent and child together.
    const read = await ctx.mirrors.run(mirrorKey(repo.mirror_path), () =>
      planChild(ctx, hooks, repo, current, signal),
    );
    if (!read.ok) return read;
    planned.push(read.value.planned);
    const more = childrenOf(read.value.node, declared);
    if (!more.ok) return more;
    queue.push(...more.value);
  }
  const used = new Set(planned.map((s) => s.repoId));
  for (const s of layout.submodules.filter((row) => !used.has(row.id))) {
    ctx.log.info(
      { repo: s.id, path: s.submodule_path },
      "a declared submodule is not at this commit: not materialized",
    );
  }
  return ok(planned);
}

async function planChild(
  ctx: Ctx,
  hooks: PlanHooks,
  repo: CheckedRepo,
  entry: SubmoduleEntry,
  signal: AbortSignal,
): Promise<Result<{ planned: PlannedSubmodule; node: SubmoduleNode }>> {
  const auth = await originGitAuth(ctx.secrets, repo.origin_url);
  const made = await ensureMirror(ctx, repo, signal, auth);
  if (!made.ok) return made;
  const origin = withGitAuth(hooks.git, auth);
  const fetched = await fetchBase(origin, repo, signal);
  if (!fetched.ok) return fetched;
  const present = await ensureCommit(origin, repo, entry.sha, signal, {
    fetchBaseFirst: false,
  });
  if (!present.ok) return present;
  if (!present.value) {
    return err(
      frmError(
        "spawn_failed",
        `commit ${entry.sha} of submodule ${entry.path} is not in mirror ${repo.mirror_path}, even after fetching every branch`,
      ),
    );
  }
  const planned: PlannedSubmodule = { ...entry, mirror: repo.mirror_path };
  if (hooks.afterSubmodule !== undefined) {
    const after = await hooks.afterSubmodule(planned);
    if (!after.ok) return after;
  }
  const node = await readNode(
    hooks.git,
    repo.mirror_path,
    repo.id,
    entry.sha,
    entry.path,
    signal,
  );
  return node.ok ? ok({ planned, node: node.value }) : node;
}

/** Phase R for the session `r` in `workspaceId`, whose layout the caller loaded (loadLayout). */
export async function planWorkspace(
  ctx: Ctx,
  r: Resolved,
  workspaceId: string,
  layout: WorkspaceLayout<CheckedRepo>,
  hooks: PlanHooks,
  signal: AbortSignal,
): Promise<Result<WorkspacePlan>> {
  const chosen = chosenRepos(workspaceId, layout, r.at);
  if (!chosen.ok) return chosen;
  const submodular =
    layout.kind === "submodule" && chosen.value[0]?.id === layout.primary.id;
  const version = submodular ? await checkVersion(ctx, hooks) : ok(null);
  if (!version.ok) return version;
  // Sorted, so the primary's id is the lowest and (created_at, id) lists it first (M6).
  const ids = chosen.value.map(() => newId(ctx.clock.now())).toSorted();
  const repos: PlannedRepo[] = [];
  for (const [i, repo] of chosen.value.entries()) {
    const rowId = ids[i] ?? newId(ctx.clock.now());
    const planned = await ctx.mirrors.run(mirrorKey(repo.mirror_path), () =>
      resolveRepo(ctx, hooks, r, repo, rowId, signal),
    );
    if (!planned.ok) return planned;
    repos.push(planned.value);
  }
  const primary = repos[0];
  const submodules =
    submodular && primary !== undefined
      ? await planSubmodules(ctx, hooks, layout, primary, signal)
      : ok([]);
  if (!submodules.ok) return submodules;
  return ok({
    workspaceId,
    kind: layout.kind,
    layout: layout,
    repos,
    submodules: submodules.value,
    gitVersion: version.value,
  });
}
