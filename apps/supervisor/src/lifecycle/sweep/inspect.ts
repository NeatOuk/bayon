// One row's checks: run in phase A outside any mutex, and again from the top in
// phase B inside the row's mirror mutex, so nothing phase A saw is trusted at the moment of removal.
// The first failure decides; a clean row goes only when §3 and §5 allow it.
import { join } from "node:path";
import {
  headFate,
  isSweepable,
  removable,
  sweepVerdict,
  type HeadFate,
  type SweepFlag,
} from "@bayon/core";
import type { SweepWorktree } from "@bayon/db";
import { baseRefOf } from "../workspace-plan.js";
import { rowFacts, type PassState, type SweepDeps } from "./deps.js";
import {
  canon,
  gitdirTarget,
  lstatOrNull,
  namesOrNull,
  textOrNull,
} from "./fs.js";
import { sweepGit } from "./git.js";
import {
  ignoredInventory,
  noChanges,
  noHiddenBits,
  noOperation,
} from "./listings.js";
import {
  findModules,
  publishedModules,
  type ModuleCheckout,
} from "./modules.js";
import { reach } from "./reach.js";
import { go, stop, thrown, type Step } from "./step.js";

/** What phase B removes, as its own re-checks proved it. */
export interface RemovalPlan {
  /** The worktree's realpath. */
  readonly root: string;
  readonly mirror: string;
  readonly admin: string;
  readonly head: string;
  /** `<sha> <refname>` of refs/worktree, refs/bisect and refs/rewritten (L1). */
  readonly worktreeRefs: readonly string[];
  readonly baseRef: string;
  /** Removal rests on the own-branch rule: an archive bundle first (NEW-2). */
  readonly bundleHead: boolean;
  /** Deepest first. */
  readonly modules: readonly ModuleCheckout[];
  readonly bundleModules: readonly ModuleCheckout[];
  /** Disposable ignored entries, absolute (A′ and B12 delete them). */
  readonly disposable: readonly string[];
}

export type Inspection =
  | { readonly kind: "gone" }
  | ({ readonly kind: "flag" } & SweepFlag)
  | { readonly kind: "keep"; readonly why: string }
  | { readonly kind: "remove"; readonly plan: RemovalPlan };

const asFlag = (s: { readonly flag: SweepFlag }): Inspection => ({
  kind: "flag",
  ...s.flag,
});

export async function inspect(
  deps: SweepDeps,
  row: SweepWorktree,
  ps: PassState,
): Promise<Inspection> {
  const notRemovable = removable(rowFacts(row), ps.now, ps.settings.minEndedMs);
  let st;
  try {
    st = await lstatOrNull(row.path);
  } catch (e) {
    return asFlag(thrown(`cannot stat ${row.path}`, e));
  }
  if (st === null) {
    return gonePath(row, row.state === "orphan" || notRemovable === null);
  }
  if (!st.isDirectory()) {
    return asFlag(stop("unverifiable", `${row.path} is not a directory`));
  }
  const found = await gather(deps, row, ps);
  if (!found.ok) return asFlag(found);
  const verdict = sweepVerdict({
    flag: null,
    publishable: found.value.fate !== "unmerged",
    notRemovable,
    removalOn: ps.settings.removalOn,
  });
  if (verdict.kind === "remove")
    return { kind: "remove", plan: found.value.plan };
  if (verdict.kind === "keep") return { kind: "keep", why: verdict.why };
  return { kind: "flag", reason: verdict.reason, detail: verdict.detail };
}

/**
 * Check 2's gone path (M3, NEW-1): its admin entry, found by reading gitdir files (no git), holding
 * modules/ means unpublished submodule work may be there; a submodule-workspace row whose entry
 * cannot be found is unverifiable, never removed.
 */
async function gonePath(
  row: SweepWorktree,
  mayGo: boolean,
): Promise<Inspection> {
  let entry: string | null;
  try {
    entry = await adminEntryOf(row.mirror_path, row.path);
  } catch (e) {
    return asFlag(
      thrown(`cannot read the admin entries of ${row.mirror_path}`, e),
    );
  }
  if (entry !== null && (await lstatOrNull(join(entry, "modules"))) !== null) {
    return asFlag(
      stop(
        "unpublished",
        `${row.path} is gone; its admin entry ${entry} holds modules/`,
      ),
    );
  }
  if (entry === null && row.submodule_shas_json !== null) {
    return asFlag(
      stop(
        "unverifiable",
        `${row.path} is gone and its admin entry cannot be found`,
      ),
    );
  }
  return mayGo
    ? { kind: "gone" }
    : asFlag(stop("unverifiable", `${row.path} is gone`));
}

/** The admin entry of `<mirror>/worktrees/*` whose gitdir file names `<path>/.git`, or null. */
async function adminEntryOf(
  mirror: string,
  path: string,
): Promise<string | null> {
  const dir = join(mirror, "worktrees");
  const want = await canon(join(path, ".git"));
  for (const name of (await namesOrNull(dir)) ?? []) {
    const target = await gitdirTarget(join(dir, name, "gitdir"), "");
    if (target !== null && (await canon(target)) === want)
      return join(dir, name);
  }
  return null;
}

/** Check 3: the path is its own linked worktree of this row's mirror (NEW-1 for its gitdir file). */
async function ownWorktree(
  deps: SweepDeps,
  row: SweepWorktree,
  signal: AbortSignal,
): Promise<Step<{ root: string; mirror: string; admin: string }>> {
  const root = await canon(row.path);
  const mirror = await canon(row.mirror_path);
  const top = await sweepGit(
    deps,
    ["-C", root, "rev-parse", "--show-toplevel"],
    signal,
  );
  if (!top.ok)
    return stop(
      "unverifiable",
      `${row.path} is not a git worktree: ${top.error.message}`,
    );
  if ((await canon(top.value)) !== root) {
    return stop(
      "unverifiable",
      `${row.path} resolves to the worktree at ${top.value}`,
    );
  }
  const gitDir = await sweepGit(
    deps,
    ["-C", root, "rev-parse", "--path-format=absolute", "--git-dir"],
    signal,
  );
  if (!gitDir.ok) return stop("unverifiable", gitDir.error.message);
  const admin = await canon(gitDir.value);
  if (join(admin, "..") !== join(mirror, "worktrees")) {
    return stop(
      "unverifiable",
      `${row.path}'s git dir ${gitDir.value} is not an admin entry of ${row.mirror_path}`,
    );
  }
  const back = await gitdirTarget(join(admin, "gitdir"), "");
  if (
    back === null ||
    (await canon(back)) !== (await canon(join(root, ".git")))
  ) {
    return stop(
      "unverifiable",
      `${admin}/gitdir does not name ${row.path}/.git`,
    );
  }
  return go({ root, mirror, admin });
}

/** Checks 3–11, in order. */
async function gather(
  deps: SweepDeps,
  row: SweepWorktree,
  ps: PassState,
): Promise<Step<{ fate: HeadFate; plan: RemovalPlan }>> {
  try {
    const own = await ownWorktree(deps, row, ps.signal);
    if (!own.ok) return own;
    const { root, mirror, admin } = own.value;
    const lock = await textOrNull(join(admin, "locked"));
    if (lock !== null) return stop("locked", lock === "" ? "locked" : lock);
    const shallowOk = (m: string) => notShallow(deps, m, ps);
    const shallow = await shallowOk(row.mirror_path);
    if (!shallow.ok) return shallow;
    const op = await noOperation(admin);
    if (!op.ok) return op;
    const modules = await findModules(deps, row, root, admin, ps);
    if (!modules.ok) return modules;
    const checkouts = [
      root,
      ...modules.value.filter((m) => m.populated).map((m) => m.checkout),
    ];
    for (const dir of checkouts) {
      const bits = await noHiddenBits(deps, dir, ps.signal);
      if (!bits.ok) return bits;
    }
    for (const dir of checkouts) {
      const changed = await noChanges(deps, dir, ps.signal);
      if (!changed.ok) return changed;
    }
    const disposable: string[] = [];
    for (const dir of checkouts) {
      const ignored = await ignoredInventory(
        deps,
        dir,
        dir === root,
        ps.settings.disposable,
        ps.signal,
      );
      if (!ignored.ok) return ignored;
      disposable.push(...ignored.value);
    }
    const head = await headOf(deps, row, root, ps);
    if (!head.ok) return head;
    const bundled = await publishedModules(deps, modules.value, ps, shallowOk);
    if (!bundled.ok) return bundled;
    return go({
      fate: head.value.fate,
      plan: {
        root,
        mirror,
        admin,
        head: head.value.head,
        worktreeRefs: head.value.refs,
        baseRef: head.value.baseRef,
        bundleHead: head.value.fate === "own_branch",
        modules: modules.value,
        bundleModules: bundled.value,
        disposable,
      },
    });
  } catch (e) {
    return thrown(`cannot check ${row.path}`, e);
  }
}

/** Check 0 (L3), cached per mirror for the pass: a shallow mirror proves no reachability. */
export async function notShallow(
  deps: SweepDeps,
  mirror: string,
  ps: PassState,
): Promise<Step<void>> {
  let shallow = ps.shallow.get(mirror);
  if (shallow === undefined) {
    const said = await sweepGit(
      deps,
      ["-C", mirror, "rev-parse", "--is-shallow-repository"],
      ps.signal,
    );
    if (!said.ok) return stop("unverifiable", said.error.message);
    shallow = said.value === "true";
    ps.shallow.set(mirror, shallow);
  }
  return shallow
    ? stop("unverifiable", `mirror ${mirror} is shallow`)
    : go(undefined);
}

/** Checks 10 (§5.1) and the per-worktree refs (§5.2, L1). */
async function headOf(
  deps: SweepDeps,
  row: SweepWorktree,
  root: string,
  ps: PassState,
): Promise<
  Step<{ head: string; refs: string[]; fate: HeadFate; baseRef: string }>
> {
  const head = await sweepGit(
    deps,
    ["-C", root, "rev-parse", "--verify", "-q", "HEAD"],
    ps.signal,
  );
  if (!head.ok)
    return stop("unverifiable", `HEAD of ${row.path} does not resolve`);
  const refs = await sweepGit(
    deps,
    [
      "-C",
      root,
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      "refs/worktree",
      "refs/bisect",
      "refs/rewritten",
    ],
    ps.signal,
  );
  if (!refs.ok) return stop("unverifiable", refs.error.message);
  const baseRef = baseRefOf(row);
  const lines = refs.value.split("\n").filter((l) => l !== "");
  for (const line of lines) {
    const sha = line.slice(0, line.indexOf(" "));
    const where = await reach(deps, row.mirror_path, sha, baseRef, ps.signal);
    if (!where.ok) return where;
    if (!where.value.onShared) {
      return stop("unpublished", `${line} of ${row.path} is on no shared ref`);
    }
  }
  const where = await reach(
    deps,
    row.mirror_path,
    head.value,
    baseRef,
    ps.signal,
  );
  if (!where.ok) return where;
  const fate = headFate({
    reviewer: row.holder_gate_id !== null,
    sweepable: isSweepable(row.ticket_status),
    onBase: where.value.onBase,
    onSharedRef: where.value.onShared,
  });
  if (fate === "unpublished") {
    return stop(
      "unpublished",
      `HEAD ${head.value} of ${row.path} is on no shared ref`,
    );
  }
  return go({ head: head.value, refs: lines, fate, baseRef });
}
