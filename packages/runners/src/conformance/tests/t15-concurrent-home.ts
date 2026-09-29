// §15 #15 concurrent home isolation, gated on `concurrentSessions`: sessions sharing a decoy HOME
// in their env keep all runner state in their own claimed homes and never touch the decoy. An
// adapter that relies on HOME fails `private_state`.
//
// Declared absent, the runner's credential serves one session at a time and admission enforces
// that (§5.1, the `runner_concurrency` gate), so two sessions cannot exist to contend: the
// fallback drives the one session the credential allows and judges the same evidence. That N/A is
// honest only while the gate is there — an adapter may not declare its way out of a non-negotiable
// test, which is why the claim half stayed in test 14.
import { StepFailed } from "../harness.js";
import type { StoredEvent } from "../types.js";
import { check, define, endedWith, outcomeOf, type Branch } from "./define.js";

type Snapshot = ReadonlyMap<string, string>;

export interface ConcurrentHomeEvidence {
  readonly decoy: { readonly before: Snapshot; readonly after: Snapshot };
  /** Where each session holds its own copy of the decoy (one per container). */
  readonly decoyCopies?: number;
  readonly homes: readonly {
    readonly before: Snapshot;
    readonly after: Snapshot;
  }[];
  readonly runs: readonly (readonly StoredEvent[])[];
}

const changed = (a: Snapshot, b: Snapshot): boolean =>
  a.size !== b.size || [...b].some(([path, digest]) => a.get(path) !== digest);

export function judgeConcurrentHome(e: ConcurrentHomeEvidence) {
  const decoyChanged = changed(e.decoy.before, e.decoy.after);
  const homesChanged = e.homes.map((h) => changed(h.before, h.after));
  return [
    check(
      "both_ok",
      e.runs.length > 0 && e.runs.every((r) => endedWith(r, "ok")),
      e.runs.map(outcomeOf).join(", "),
    ),
    check(
      "private_state",
      !decoyChanged && homesChanged.every(Boolean),
      `decoy HOME ${decoyChanged ? "written" : "untouched"}${e.decoyCopies === undefined ? "" : ` (decoy ×${e.decoyCopies} containers)`}, private homes ${homesChanged.map((c) => (c ? "written" : "untouched")).join("/")}`,
    ),
  ];
}

/** Two sessions with the cap, the one the credential allows without it. */
const sessionsFor = (branch: Branch): number => (branch === "cap" ? 2 : 1);

export const t15 = define({
  id: 15,
  retries: 0,
  fallback: () =>
    "concurrentSessions=false; admission admits one session of this runner at a time, and that one kept its state in its own home",
  drive: async (ctx, branch): Promise<ConcurrentHomeEvidence> => {
    const { workspace } = ctx.ports;
    const snapshot = (dir: string) =>
      ctx.harness("workspace", workspace.snapshot(dir));
    const decoy = await ctx.harness(
      "workspace",
      workspace.scratch("decoy-home"),
    );
    const decoyBefore = await snapshot(decoy);
    const sessions = [];
    for (let i = 0; i < sessionsFor(branch); i += 1) {
      sessions.push(
        await ctx.open({ scenario: "plain", env: { HOME: decoy } }),
      );
    }
    for (const live of sessions) {
      const home = await live.prepareHome();
      if (!home.ok) throw new StepFailed("prepare_home", home.error.message);
    }
    const before = await Promise.all(
      sessions.map((live) => snapshot(live.dirs.homeDir)),
    );
    await Promise.all(sessions.map((live) => live.spawn()));
    const ends = await Promise.all(
      sessions.map((live) => live.run(live.turn(0))),
    );
    const after = await Promise.all(
      sessions.map((live) => snapshot(live.dirs.homeDir)),
    );
    const copies = workspace.scratchCopies?.(decoy);
    return {
      ...(copies === undefined ? {} : { decoyCopies: copies }),
      decoy: { before: decoyBefore, after: await snapshot(decoy) },
      homes: sessions.map((_, i) => ({
        before: before[i] ?? new Map(),
        after: after[i] ?? new Map(),
      })),
      runs: ends.map((end) => end.events),
    };
  },
  judge: judgeConcurrentHome,
});
