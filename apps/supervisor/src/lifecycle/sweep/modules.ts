// Submodules: the walk of <admin>/modules, which fails closed; the
// gitlink cross-check in both directions; each module's child repo; and publishing, with NEW-6's
// start SHA. A module gitdir is deleted only after all of it passed here, inside the same hold.
import { readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  GITLINK_MODE,
  SubmoduleShas,
  parseLsFilesStageZ,
  type Result,
} from "@bayon/core";
import {
  getWorkspaceRepos,
  type SweepWorktree,
  type WorkspaceRepo,
} from "@bayon/db";
import { baseRefOf } from "../workspace-plan.js";
import type { PassState, SweepDeps } from "./deps.js";
import {
  canon,
  gitdirTarget,
  isInside,
  lstatOrNull,
  namesOrNull,
} from "./fs.js";
import { sweepGit } from "./git.js";
import { noOperation } from "./listings.js";
import { holds, reach, shaOf } from "./reach.js";
import { go, stop, thrown, type Step } from "./step.js";

const MAX_DEPTH = 16;
const MAX_GITDIRS = 256;

export interface ChildRepo {
  readonly repoId: string;
  readonly mirror: string;
  readonly baseRef: string;
}

/** One module: its checkout (a realpath under the worktree), its gitdir, and its child repo. */
export interface ModuleCheckout {
  readonly checkout: string;
  /** Relative to the worktree's root, as submodule_shas_json names it. */
  readonly rel: string;
  readonly gitdir: string;
  /** False for a gitdir whose checkout an earlier pass already emptied (§6). */
  readonly populated: boolean;
  readonly child: ChildRepo | null;
  readonly startSha: string | null;
}

const isGitdir = async (dir: string): Promise<boolean> =>
  (await lstatOrNull(join(dir, "HEAD")))?.isFile() === true &&
  (await lstatOrNull(join(dir, "objects")))?.isDirectory() === true &&
  (await lstatOrNull(join(dir, "refs")))?.isDirectory() === true;

/**
 * Every gitdir under `dir`, descending through directories that are not gitdirs (a name with `/`,
 * g16). Fails closed: a file outside any gitdir, a directory with no gitdir beneath it (half made),
 * or a symlink is the problem it returns.
 */
async function descend(
  dir: string,
  depth: number,
  out: string[],
): Promise<string | null> {
  if (depth > MAX_DEPTH) return `${dir} is deeper than ${MAX_DEPTH} levels`;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isSymbolicLink()) return `${path} is a symlink`;
    if (!e.isDirectory()) return `${path} lies in no module gitdir`;
    if (await isGitdir(path)) {
      out.push(await realpath(path));
      if (out.length > MAX_GITDIRS)
        return `more than ${MAX_GITDIRS} module gitdirs`;
      const inner = join(path, "modules");
      if ((await lstatOrNull(inner)) !== null) {
        const problem = await descend(inner, depth + 1, out);
        if (problem !== null) return problem;
      }
      continue;
    }
    const before = out.length;
    const problem = await descend(path, depth + 1, out);
    if (problem !== null) return problem;
    if (out.length === before) return `${path} holds no module gitdir`;
  }
  return null;
}

async function walk(admin: string): Promise<Step<string[]>> {
  const dir = join(admin, "modules");
  try {
    const st = await lstatOrNull(dir);
    if (st === null) return go([]);
    if (!st.isDirectory())
      return stop("unverifiable", `${dir} is not a directory`);
    const out: string[] = [];
    const problem = await descend(dir, 0, out);
    return problem === null ? go(out) : stop("unverifiable", problem);
  } catch (e) {
    return thrown(`cannot walk ${dir}`, e);
  }
}

/** Each gitdir's checkout, by its own core.worktree, which must lie inside the worktree. */
async function checkoutsOf(
  deps: SweepDeps,
  root: string,
  gitdirs: readonly string[],
  signal: AbortSignal,
): Promise<Step<Map<string, string>>> {
  const byCheckout = new Map<string, string>();
  for (const gitdir of gitdirs) {
    const wt = await sweepGit(
      deps,
      ["config", "--file", join(gitdir, "config"), "--get", "core.worktree"],
      signal,
    );
    if (!wt.ok) return stop("unverifiable", `${gitdir} names no checkout`);
    const checkout = await canon(resolve(gitdir, wt.value));
    if (!isInside(root, checkout) || byCheckout.has(checkout)) {
      return stop(
        "unverifiable",
        `${gitdir}'s checkout ${checkout} is not its own, inside the worktree`,
      );
    }
    byCheckout.set(checkout, gitdir);
  }
  return go(byCheckout);
}

async function childRepos(
  deps: SweepDeps,
  row: SweepWorktree,
  ps: PassState,
): Promise<Result<readonly WorkspaceRepo[]>> {
  const cached = ps.repos.get(row.workspace_id);
  if (cached !== undefined) return { ok: true, value: cached };
  const got = await getWorkspaceRepos(deps.db, row.workspace_id);
  if (got.ok) ps.repos.set(row.workspace_id, got.value);
  return got;
}

function startShas(row: SweepWorktree): SubmoduleShas["shas"] {
  if (row.submodule_shas_json === null) return [];
  try {
    const parsed = SubmoduleShas.safeParse(JSON.parse(row.submodule_shas_json));
    return parsed.success ? parsed.data.shas : [];
  } catch {
    return [];
  }
}

/**
 * Check 6: the walk, then the gitlink cross-check. Every populated gitlink (its directory holds a
 * `.git` gitfile) resolves to exactly one found gitdir whose core.worktree is that directory; every
 * gitdir is one gitlink's, or its checkout is gone or empty (a pass stopped after emptying it); an
 * unpopulated gitlink's directory is empty, since git cannot see content there (g17).
 */
export async function findModules(
  deps: SweepDeps,
  row: SweepWorktree,
  root: string,
  admin: string,
  ps: PassState,
): Promise<Step<ModuleCheckout[]>> {
  const gitdirs = await walk(admin);
  if (!gitdirs.ok) return gitdirs;
  const byCheckout = await checkoutsOf(deps, root, gitdirs.value, ps.signal);
  if (!byCheckout.ok) return byCheckout;
  const repos = await childRepos(deps, row, ps);
  if (!repos.ok) return stop("unverifiable", repos.error.message);
  const shas = startShas(row);
  const childOf = (rel: string): Pick<ModuleCheckout, "child" | "startSha"> => {
    const entry = shas.find((s) => s.path === rel);
    const repo = repos.value.find((r) => r.id === entry?.repo_id);
    return entry === undefined || repo === undefined
      ? { child: null, startSha: null }
      : {
          child: {
            repoId: repo.id,
            mirror: repo.mirror_path,
            baseRef: baseRefOf(repo),
          },
          startSha: entry.sha,
        };
  };
  const found: ModuleCheckout[] = [];
  const claimed = new Set<string>();
  const queue = [root];
  try {
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      const staged = await sweepGit(
        deps,
        ["-C", dir, "ls-files", "-s", "-z"],
        ps.signal,
        {
          trim: false,
        },
      );
      if (!staged.ok)
        return stop("unverifiable", `${dir}: ${staged.error.message}`);
      for (const e of parseLsFilesStageZ(staged.value)) {
        if (e.mode !== GITLINK_MODE) continue;
        const sub = join(dir, e.path);
        const st = await lstatOrNull(sub);
        if (st === null) continue;
        if (!st.isDirectory())
          return stop("unverifiable", `${sub} is not a directory`);
        const gitfile = await lstatOrNull(join(sub, ".git"));
        if (gitfile === null) {
          const inside = (await namesOrNull(sub)) ?? [];
          if (inside.length > 0) {
            return stop(
              "dirty",
              `${relative(root, sub)}: content in an unpopulated submodule`,
            );
          }
          continue;
        }
        const target = await gitdirTarget(join(sub, ".git"), "gitdir:");
        const checkout = await canon(sub);
        const gitdir = byCheckout.value.get(checkout);
        if (
          !gitfile.isFile() ||
          target === null ||
          gitdir === undefined ||
          (await canon(target)) !== gitdir ||
          claimed.has(gitdir)
        ) {
          return stop(
            "unverifiable",
            `${relative(root, sub)}'s gitdir is not one found in ${admin}/modules`,
          );
        }
        claimed.add(gitdir);
        const rel = relative(root, checkout);
        found.push({ checkout, rel, gitdir, populated: true, ...childOf(rel) });
        queue.push(checkout);
      }
    }
    for (const [checkout, gitdir] of byCheckout.value) {
      if (claimed.has(gitdir)) continue;
      const inside = await namesOrNull(checkout);
      if (inside !== null && inside.length > 0) {
        return stop(
          "unverifiable",
          `module gitdir ${gitdir} has no populated gitlink`,
        );
      }
      const rel = relative(root, checkout);
      found.push({ checkout, rel, gitdir, populated: false, ...childOf(rel) });
    }
    for (const m of found) {
      const op = await noOperation(m.gitdir);
      if (!op.ok) return op;
    }
  } catch (e) {
    return thrown(`cannot check the submodules of ${root}`, e);
  }
  // Deepest first: B12 empties a leaf before its parent.
  return go(
    found.toSorted((a, b) => b.rel.split("/").length - a.rel.split("/").length),
  );
}

/**
 * Check 11: every ref (all namespaces) and HEAD of every module gitdir is reachable in its child's
 * mirror from a shared ref, or is the checkout's start SHA held there (NEW-6). Resolves to the
 * modules whose own work (HEAD and non-remote refs) rests on a ref other than the child's base:
 * those get an archive bundle (§6.2).
 */
export async function publishedModules(
  deps: SweepDeps,
  modules: readonly ModuleCheckout[],
  ps: PassState,
  shallowOk: (mirror: string) => Promise<Step<void>>,
): Promise<Step<ModuleCheckout[]>> {
  const bundled: ModuleCheckout[] = [];
  for (const m of modules) {
    if (m.child === null) {
      return stop(
        "unpublished",
        `submodule ${m.rel} maps to no repo of the workspace`,
      );
    }
    const shallow = await shallowOk(m.child.mirror);
    if (!shallow.ok) return shallow;
    const listed = await sweepGit(
      deps,
      ["-C", m.gitdir, "for-each-ref", "--format=%(objectname) %(refname)"],
      ps.signal,
    );
    if (!listed.ok)
      return stop("unverifiable", `${m.gitdir}: ${listed.error.message}`);
    const head = await shaOf(deps, m.gitdir, "HEAD", ps.signal);
    if (!head.ok) return head;
    const refs = listed.value
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => ({
        sha: l.slice(0, l.indexOf(" ")),
        name: l.slice(l.indexOf(" ") + 1),
      }));
    const own = [
      ...(head.value === null ? [] : [{ sha: head.value, name: "HEAD" }]),
      ...refs.filter((r) => !r.name.startsWith("refs/remotes/")),
    ];
    let offBase = false;
    for (const r of [
      ...own,
      ...refs.filter((x) => x.name.startsWith("refs/remotes/")),
    ]) {
      if (r.sha === m.startSha) {
        const held = await holds(deps, m.child.mirror, r.sha, ps.signal);
        if (!held.ok) return held;
        if (held.value) continue;
      }
      const where = await reach(
        deps,
        m.child.mirror,
        r.sha,
        m.child.baseRef,
        ps.signal,
      );
      if (!where.ok) return where;
      if (!where.value.onShared) {
        return stop(
          "unpublished",
          `submodule ${m.rel}: ${r.name} at ${r.sha} is on no shared ref of ${m.child.repoId}'s mirror`,
        );
      }
      if (!where.value.onBase && own.includes(r)) offBase = true;
    }
    if (offBase) bundled.push(m);
  }
  return go(bundled);
}
