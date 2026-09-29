// Ending the suite's process groups: a process is over when its whole group is, not its
// leader alone. A member can outlive the leader's exit (a tool's child, a group mid-exit after a
// SIGKILL) and keep writing into the session's home, so the suite waits for the group before it
// frees what the group wrote into, and kills what is left. The executor's probe reads a group alive
// while any member lives. Runner-neutral.
import type { Clock } from "@bayon/core";
import type { Executor, ProbeState } from "@bayon/executors";

/** How often a group is probed again: the reconciler's pace after its own SIGKILL (§9.6). */
export const REPROBE_MS = 100;

/**
 * Whether a probe reads dead within `ms`. The exit that settled is the group leader's alone: the
 * rest of its group took the same SIGKILL but exits on its own schedule, and a member still in the
 * process table is alive to the probe until it has (a runner's child, reparented and
 * mid-exit, outlived its host's exit by ~50 ms under load). A group that never dies still fails.
 * `ms` 0 probes once.
 */
export async function probesDeadWithin(
  probe: () => Promise<ProbeState>,
  clock: Clock,
  ms: number,
): Promise<boolean> {
  const deadline = clock.now() + ms;
  for (;;) {
    if ((await probe()) === "dead") return true;
    if (clock.now() >= deadline) return false;
    await clock.after(REPROBE_MS);
  }
}

export interface GroupsEnd {
  /** Alive past their grace: killed. */
  readonly killed: readonly string[];
  /** Still alive after the kill and its wait. */
  readonly alive: readonly string[];
}

export interface EndBounds {
  /** How long a group gets to end on its own; 0: killed at once if alive. */
  readonly graceMs: number;
  /** How long a killed group gets to leave the process table. */
  readonly killMs: number;
}

/**
 * Waits up to `graceMs` for each ref's whole group to be gone, kills (hard) each still alive, and
 * waits up to `killMs` for it. A probe that fails tells nothing, so it reads alive: that group is
 * killed and probed again, and one never read dead is reported alive. Never rejects.
 */
export async function endGroups(
  executor: Pick<Executor, "probe" | "cleanup">,
  refs: readonly string[],
  clock: Clock,
  bounds: EndBounds,
): Promise<GroupsEnd> {
  const ended = await Promise.all(
    [...new Set(refs)].map(async (ref) => {
      const probe = () => executor.probe(ref).catch((): ProbeState => "alive");
      if (await probesDeadWithin(probe, clock, bounds.graceMs)) {
        return { ref, killed: false, dead: true };
      }
      // Gone meanwhile, or unreachable: the probe after it tells which.
      await executor.cleanup(ref, "hard").catch(() => undefined);
      return {
        ref,
        killed: true,
        dead: await probesDeadWithin(probe, clock, bounds.killMs),
      };
    }),
  );
  return {
    killed: ended.filter((e) => e.killed).map((e) => e.ref),
    alive: ended.filter((e) => !e.dead).map((e) => e.ref),
  };
}
