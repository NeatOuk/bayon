// Phase B: inside the row's mirror mutex, one row per hold, every check again
// from the top, then the archive bundle (B11a), the submodules emptied by hand (B12–B15, never
// `deinit`), `git worktree remove` without --force (B16) and the compare-and-set (B17). A′ drops
// disposable ignored entries before the lock. Nothing unverified is ever deleted.
import { rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  GITLINK_MODE,
  parseLsFilesStageZ,
  sweepVisit,
  type SweepFlag,
} from "@bayon/core";
import { getSweepWorktree, type SweepWorktree } from "@bayon/db";
import { markWorktreeRemoved } from "@bayon/db/supervisor";
import { mirrorKey } from "../mirror.js";
import { worktreeRemoveArgs } from "./argv.js";
import { writeBundle } from "./bundle.js";
import { rowFacts, type PassState, type SweepDeps } from "./deps.js";
import {
  isInside,
  lstatOrNull,
  namesOrNull,
  parentIsPlain,
  rmdirIfThere,
  unlinkIfThere,
} from "./fs.js";
import { sweepGit, sweepGitRun } from "./git.js";
import {
  inspect,
  notShallow,
  type Inspection,
  type RemovalPlan,
} from "./inspect.js";
import { ignoredInventory, noChanges, noHiddenBits } from "./listings.js";
import { publishedModules, type ModuleCheckout } from "./modules.js";
import { holds, shaOf } from "./reach.js";

export type Removal =
  | Inspection
  | { readonly kind: "removed"; readonly ms: number }
  | { readonly kind: "skip"; readonly why: string };

const failed = (detail: string): Removal => ({
  kind: "flag",
  reason: "remove_failed",
  detail,
});
const flagOf = (flag: SweepFlag): Removal => ({ kind: "flag", ...flag });

/** Removes one disposable entry after checking it lies inside `root` under plain parents (NEW-4). */
async function dropOne(root: string, path: string): Promise<string | null> {
  if (
    !isInside(root, path) ||
    !(await parentIsPlain(root, relative(root, path)))
  ) {
    return `${path} is not a disposable entry inside ${root}`;
  }
  await rm(path, { recursive: true, force: true });
  return null;
}

/** A′ (N2), before the lock: the disposable entries phase A listed go first. */
async function dropDisposable(plan: RemovalPlan): Promise<string | null> {
  const roots = [plan.root, ...plan.modules.map((m) => m.checkout)];
  for (const path of plan.disposable) {
    const root = roots.findLast((r) => isInside(r, path));
    if (root === undefined) return `${path} lies in no checkout`;
    const problem = await dropOne(root, path);
    if (problem !== null) return problem;
  }
  return null;
}

export async function removeRow(
  deps: SweepDeps,
  row: SweepWorktree,
  planA: RemovalPlan,
  ps: PassState,
): Promise<Removal> {
  try {
    const dropped = await dropDisposable(planA);
    if (dropped !== null) return failed(dropped);
  } catch (e) {
    return failed(`cannot drop disposable entries: ${String(e)}`);
  }
  return deps.mirrors.run(mirrorKey(row.mirror_path), () =>
    locked(deps, row, ps),
  );
}

async function locked(
  deps: SweepDeps,
  row: SweepWorktree,
  ps: PassState,
): Promise<Removal> {
  await deps.hooks?.beforeRecheck?.(row);
  const fresh = await getSweepWorktree(deps.db, row.id);
  if (!fresh.ok || fresh.value === null)
    return { kind: "skip", why: "gone from the table" };
  const now = fresh.value;
  if (now.session_id !== row.session_id || now.state !== row.state) {
    return { kind: "skip", why: "moved since phase A" };
  }
  const skip = sweepVisit(rowFacts(now), deps.liveIds());
  if (skip !== null) return { kind: "skip", why: skip };
  const recheck: PassState = { ...ps, now: deps.clock.now() };
  const again = await inspect(deps, now, recheck);
  if (again.kind !== "remove") return again;
  const started = deps.clock.now();
  const done = await destroy(deps, now, again.plan, recheck);
  if (done !== null) return done;
  const marked = await markWorktreeRemoved(deps.db, {
    id: now.id,
    session_id: now.session_id,
    state: now.state,
  });
  if (!marked.ok) {
    deps.log.error(
      { worktree: now.id, error: marked.error },
      "sweep: the worktree is removed, but its row moved: left as it is",
    );
  }
  return { kind: "removed", ms: deps.clock.now() - started };
}

/** B11a–B16. Null once `git worktree remove` has succeeded. */
async function destroy(
  deps: SweepDeps,
  row: SweepWorktree,
  plan: RemovalPlan,
  ps: PassState,
): Promise<Removal | null> {
  // From here the stop signal no longer applies: each step is bounded on its own (§6).
  const bounded: PassState = { ...ps, signal: new AbortController().signal };
  const archived = await archive(deps, row, plan, bounded.signal);
  if (archived !== null) return archived;
  for (const m of plan.modules) {
    const emptied = await emptyModule(deps, m, bounded);
    if (emptied !== null) return emptied;
    await deps.hooks?.afterModuleEmptied?.(m.checkout);
  }
  const stray = await strayContent(plan.modules);
  if (stray !== null) return failed(stray);
  try {
    const modules = join(plan.admin, "modules");
    const removing = join(plan.admin, "modules.frm-removing");
    // NEW-3: renamed first, so a pass that stopped half way finishes the delete next time.
    await rm(removing, { recursive: true, force: true });
    if ((await lstatOrNull(modules)) !== null) {
      await rename(modules, removing);
      await rm(removing, { recursive: true, force: true });
    }
  } catch (e) {
    return failed(`cannot delete ${plan.admin}/modules: ${String(e)}`);
  }
  const moved = await sameHead(deps, plan, bounded.signal);
  if (moved !== null) return failed(moved);
  await deps.hooks?.beforeRemove?.(row);
  // B15, the last step before git runs (review CRITICAL): git cannot see content in an emptied
  // module directory (g17), so nothing may come between this check and `worktree remove`.
  const again = await strayContent(plan.modules);
  if (again !== null) return failed(again);
  const removed = await sweepGitRun(
    deps,
    worktreeRemoveArgs(plan.mirror, plan.root),
    bounded.signal,
    // L5: a big tree is never killed half deleted at git_timeout_ms; this is its ceiling (N2).
    ps.settings.removeTimeoutMs,
  );
  if (removed.ok && removed.value.code === 0) return null;
  return refused(
    deps,
    plan,
    removed.ok ? removed.value.stderr : removed.error.message,
    bounded,
  );
}

/** B16 refused: what the checks see now is what a human is told, else remove_failed. */
async function refused(
  deps: SweepDeps,
  plan: RemovalPlan,
  stderr: string,
  ps: PassState,
): Promise<Removal> {
  const bits = await noHiddenBits(deps, plan.root, ps.signal);
  if (!bits.ok) return flagOf(bits.flag);
  const changed = await noChanges(deps, plan.root, ps.signal);
  if (!changed.ok) return flagOf(changed.flag);
  const ignored = await ignoredInventory(
    deps,
    plan.root,
    true,
    ps.settings.disposable,
    ps.signal,
  );
  if (!ignored.ok) return flagOf(ignored.flag);
  return failed(`git worktree remove refused: ${stderr.trim().slice(-300)}`);
}

/** B11a (§6.2): the archive bundles, before anything is deleted. */
async function archive(
  deps: SweepDeps,
  row: SweepWorktree,
  plan: RemovalPlan,
  signal: AbortSignal,
): Promise<Removal | null> {
  if (plan.bundleHead) {
    const base = await shaOf(deps, plan.mirror, plan.baseRef, signal);
    if (!base.ok) return flagOf(base.flag);
    const bundled = await writeBundle(deps, {
      name: row.id,
      dir: plan.root,
      revs: [
        "HEAD",
        ...plan.worktreeRefs.map((l) => l.slice(l.indexOf(" ") + 1)),
      ],
      not: base.value,
      verifyIn: plan.mirror,
    });
    if (!bundled.ok) return failed(`archive bundle: ${bundled.error.message}`);
  }
  for (const [i, m] of plan.bundleModules.entries()) {
    if (m.child === null)
      return failed(`submodule ${m.rel} has no child mirror`);
    const own = await sweepGit(
      deps,
      ["-C", m.gitdir, "for-each-ref", "--format=%(refname)"],
      signal,
    );
    if (!own.ok) return failed(own.error.message);
    const base = await shaOf(deps, m.child.mirror, m.child.baseRef, signal);
    if (!base.ok) return flagOf(base.flag);
    const known =
      base.value === null
        ? null
        : await holds(deps, m.gitdir, base.value, signal);
    if (known !== null && !known.ok) return flagOf(known.flag);
    const bundled = await writeBundle(deps, {
      name: `${row.id}.${String(i + 1)}`,
      dir: m.gitdir,
      revs: [
        "HEAD",
        ...own.value
          .split("\n")
          .filter((r) => r !== "" && !r.startsWith("refs/remotes/")),
      ],
      not: known?.value === true ? base.value : null,
      verifyIn: m.child.mirror,
    });
    if (!bundled.ok)
      return failed(`archive bundle of ${m.rel}: ${bundled.error.message}`);
  }
  return null;
}

/**
 * B12 for one module (HIGH-1): its status, index bits, ignored inventory and publishing again;
 * then only the paths its ls-files lists and its disposable entries go, directories rmdir'ed
 * bottom-up, never recursively, every parent checked first (NEW-4), the gitfile last. The checkout
 * directory stays, empty, as an unpopulated submodule looks (g7).
 */
async function emptyModule(
  deps: SweepDeps,
  m: ModuleCheckout,
  ps: PassState,
): Promise<Removal | null> {
  if (!m.populated) return null;
  const bits = await noHiddenBits(deps, m.checkout, ps.signal);
  if (!bits.ok) return flagOf(bits.flag);
  const changed = await noChanges(deps, m.checkout, ps.signal);
  if (!changed.ok) return flagOf(changed.flag);
  const ignored = await ignoredInventory(
    deps,
    m.checkout,
    false,
    ps.settings.disposable,
    ps.signal,
  );
  if (!ignored.ok) return flagOf(ignored.flag);
  const published = await publishedModules(deps, [m], ps, (mirror) =>
    notShallow(deps, mirror, ps),
  );
  if (!published.ok) return flagOf(published.flag);
  const listed = await sweepGit(
    deps,
    ["-C", m.checkout, "ls-files", "-s", "-z"],
    ps.signal,
    {
      trim: false,
    },
  );
  if (!listed.ok) return failed(listed.error.message);
  try {
    for (const path of ignored.value) {
      const problem = await dropOne(m.checkout, path);
      if (problem !== null) return failed(problem);
    }
    const dirs = new Set<string>();
    for (const e of parseLsFilesStageZ(listed.value)) {
      if (!(await parentIsPlain(m.checkout, e.path))) {
        return failed(
          `a parent of ${join(m.checkout, e.path)} is not a plain directory`,
        );
      }
      const target = join(m.checkout, e.path);
      if (e.mode === GITLINK_MODE) {
        const left = await rmdirIfThere(target);
        if (left !== null) return failed(left);
      } else {
        await unlinkIfThere(target);
      }
      for (let d = dirname(e.path); d !== "." && d !== "/"; d = dirname(d))
        dirs.add(d);
    }
    const deepestFirst = [...dirs].toSorted(
      (a, b) => b.split("/").length - a.split("/").length,
    );
    for (const d of deepestFirst) {
      const left = await rmdirIfThere(join(m.checkout, d));
      if (left !== null) return failed(left);
    }
    await unlinkIfThere(join(m.checkout, ".git"));
  } catch (e) {
    return failed(`cannot empty ${m.checkout}: ${String(e)}`);
  }
  return null;
}

/** B13/B15: every emptied checkout still there is still empty (git cannot see it, g17). */
async function strayContent(
  modules: readonly ModuleCheckout[],
): Promise<string | null> {
  for (const m of modules) {
    const names = await namesOrNull(m.checkout);
    if (names !== null && names.length > 0) {
      return `${m.checkout} is no longer empty: ${names.slice(0, 3).join(", ")}`;
    }
  }
  return null;
}

/** NEW-5: HEAD and the per-worktree refs are still what B10–B11 proved. */
async function sameHead(
  deps: SweepDeps,
  plan: RemovalPlan,
  signal: AbortSignal,
): Promise<string | null> {
  const head = await shaOf(deps, plan.root, "HEAD", signal);
  if (!head.ok || head.value !== plan.head)
    return `HEAD of ${plan.root} moved during removal`;
  const refs = await sweepGit(
    deps,
    [
      "-C",
      plan.root,
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      "refs/worktree",
      "refs/bisect",
      "refs/rewritten",
    ],
    signal,
  );
  const now = refs.ok ? refs.value.split("\n").filter((l) => l !== "") : null;
  return now !== null && now.join("\n") === plan.worktreeRefs.join("\n")
    ? null
    : `a per-worktree ref of ${plan.root} moved during removal`;
}
