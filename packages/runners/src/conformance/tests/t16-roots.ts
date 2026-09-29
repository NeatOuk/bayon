// §15 #16 extra workspace roots: the runner writes in each root it was granted besides its cwd
// (SpawnSpec.extraRoots — a multi-repo workspace's other worktrees) and nowhere outside the roots
// it was given. Both halves matter: a runner that cannot write in a granted root is useless for
// multi-repo work, and one that writes outside every root has no boundary at all.
//
// N/A when the kit declares the runner refuses extra roots rather than granting a boundary it
// cannot enforce (core DECLARED_NA). The fallback branch does not take that on trust: it opens a
// session with extra roots and requires the runner to refuse it, and requires that nothing was
// written outside either.
import { join } from "node:path";
import { StepFailed } from "../harness.js";
import type { StoredEvent } from "../types.js";
import { check, define, type Branch } from "./define.js";

export interface RootsEvidence {
  /** Each granted root and whether its marker arrived. */
  readonly written: readonly { readonly root: string; readonly ok: boolean }[];
  /** Files found in the directory outside every root: none is the pass. */
  readonly outside: readonly string[];
  /** The run that attempted the write outside every root. */
  readonly attempt: readonly StoredEvent[];
  /** Why the runner refused the roots outright; only the fallback branch has one. */
  readonly refused?: string;
}

/**
 * The runner did try to write outside: a tool call, its own refusal of the whole run, or a file
 * that arrived there — which is proof of the attempt and of its success both, so a runner with no
 * boundary fails on `outside_refused` rather than on this precondition.
 */
const attempted = (e: RootsEvidence): boolean =>
  e.outside.length > 0 ||
  e.attempt.some(
    (ev) =>
      ev.kind === "tool_call" ||
      (ev.kind === "terminal" && ev.payload.outcome !== "ok"),
  );

export function judgeRoots(e: RootsEvidence, branch: Branch) {
  const outside = check(
    "outside_refused",
    e.outside.length === 0,
    e.outside.length === 0
      ? "nothing outside the roots"
      : `${e.outside.length} file(s) outside every root: ${e.outside.join(", ")}`,
  );
  if (branch === "fallback") {
    return [
      check(
        "roots_refused",
        e.refused !== undefined,
        e.refused ?? "the runner accepted extra roots its kit says it refuses",
      ),
      outside,
    ];
  }
  const missing = e.written.filter((w) => !w.ok).map((w) => w.root);
  return [
    check(
      "attempted",
      attempted(e),
      `${e.attempt.length} events in the out-of-root turn`,
      { precondition: true },
    ),
    check(
      "roots_written",
      e.written.length > 0 && missing.length === 0,
      e.written.length === 0
        ? "the session was granted no roots"
        : `${e.written.length - missing.length} of ${e.written.length} roots written`,
    ),
    outside,
  ];
}

export const t16 = define({
  id: 16,
  retries: 1,
  declaredFallback: (kit, executorKind) => !kit.grantsExtraRoots(executorKind),
  fallback: () =>
    "the runner refuses extra workspace roots on this executor: it was offered two and refused them, and wrote nothing outside its cwd",
  drive: async (ctx, branch): Promise<RootsEvidence> => {
    const { workspace } = ctx.ports;
    // Made before the session, so an executor that places sessions creates it inside that
    // session's own container, as it does test 15's decoy home.
    const outside = await ctx.harness(
      "workspace",
      workspace.scratch("no-roots"),
    );
    const live = await ctx.open({
      scenario: "roots",
      extraRoots: ["extra-a", "extra-b"],
      vars: { outside },
    });
    const left = async () => [
      ...(await ctx.harness("workspace", workspace.snapshot(outside))).keys(),
    ];
    if (branch === "fallback") {
      try {
        await live.spawn();
      } catch (e) {
        if (!(e instanceof StepFailed)) throw e;
        return {
          written: [],
          outside: await left(),
          attempt: [],
          refused: e.detail,
        };
      }
      return { written: [], outside: await left(), attempt: [] };
    }
    await live.spawn();
    await live.run(live.turn(0));
    const attempt = await live.run(live.turn(1));
    const written = [];
    for (const root of live.dirs.extraRoots) {
      written.push({
        root,
        ok: await ctx.harness(
          "workspace",
          workspace.exists(join(root, live.vars.rootMarker)),
        ),
      });
    }
    return { written, outside: await left(), attempt: attempt.events };
  },
  judge: judgeRoots,
});
