// Submodule checkouts on this host: each planned submodule, parents
// first, from its declared repo's mirror, with -c-only registration (nothing written to a mirror's
// shared config), git refusing any URL that is not a local path, and .gitmodules' update=, shallow=
// overridden. Each runs under its child mirror's mutex only (L2).
import { realpath } from "node:fs/promises";
import { posix } from "node:path";
import { err, ok, type Result, type SubmoduleShas } from "@bayon/core";
import type { Executor } from "@bayon/executors";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";
import { mirrorKey } from "./mirror.js";
import { git } from "./workspace.js";
import type { PlannedSubmodule, WorkspacePlan } from "./workspace-plan.js";

/**
 * The per-invocation config a submodule update runs with: its registration (url, active, and
 * update=checkout, or `submodule init` copies a .gitmodules `update=` into the mirror's shared
 * config) and the URL guard. Nothing is written to any config.
 */
export const submoduleConfig = (s: PlannedSubmodule): string[] => [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=always",
  "-c",
  `submodule.${s.name}.url=${s.mirror}`,
  "-c",
  `submodule.${s.name}.active=true`,
  "-c",
  `submodule.${s.name}.update=checkout`,
];

async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** M1: a submodule that did not populate would resolve to its parent: refuse to work in that. */
async function ownRepository(
  ctx: Ctx,
  executor: Executor,
  sub: string,
  signal: AbortSignal,
): Promise<Result<void>> {
  const top = await git(
    ctx,
    executor,
    sub,
    ["rev-parse", "--show-toplevel"],
    signal,
  );
  if (!top.ok) return top;
  const [a, b] = await Promise.all([real(top.value), real(sub)]);
  return a === b
    ? ok(undefined)
    : err(
        frmError(
          "spawn_failed",
          `submodule ${sub} did not populate: git resolves it to ${top.value}`,
        ),
      );
}

/**
 * Checks the plan's submodules out under the superproject's worktree at `superPath`; a builder's
 * go on `branch` (`frm/<sid>`), a reviewer's stay detached (null). Each HEAD must be the plan's.
 */
export async function checkoutSubmodules(
  ctx: Ctx,
  executor: Executor,
  plan: WorkspacePlan,
  superPath: string,
  branch: string | null,
  signal: AbortSignal,
): Promise<Result<SubmoduleShas>> {
  const shas: SubmoduleShas["shas"][number][] = [];
  for (const s of plan.submodules) {
    const dir = s.parent === "" ? superPath : posix.join(superPath, s.parent);
    const sub = posix.join(superPath, s.path);
    const updated = await ctx.mirrors.run(mirrorKey(s.mirror), () =>
      git(
        ctx,
        executor,
        dir,
        [
          ...submoduleConfig(s),
          "submodule",
          "--quiet",
          "update",
          "--init",
          "--checkout",
          "--no-recommend-shallow",
          "--",
          s.rel,
        ],
        signal,
      ),
    );
    if (!updated.ok) return updated;
    const own = await ownRepository(ctx, executor, sub, signal);
    if (!own.ok) return own;
    if (branch !== null) {
      const made = await git(
        ctx,
        executor,
        sub,
        ["checkout", "-q", "-b", branch],
        signal,
      );
      if (!made.ok) return made;
    }
    const head = await git(ctx, executor, sub, ["rev-parse", "HEAD"], signal);
    if (!head.ok) return head;
    if (head.value !== s.sha) {
      return err(
        frmError(
          "spawn_failed",
          `submodule ${s.path} is at ${head.value}, not the planned ${s.sha}`,
        ),
      );
    }
    shas.push({ path: s.path, repo_id: s.repoId, sha: head.value });
  }
  return ok({ v: 1, git: plan.gitVersion ?? "unknown", shas });
}
