// Low disk. The gate is admission's `disk`, fed by health. Here: when the
// supervisor's own disk (the DB directory, FRM_HOME/runtime) is under admission.disk_min_free_pct,
// ask the worktree sweep for a pass, and ask retention to run early, at most
// once per UTC day. Retention's precondition (today's backup succeeded) stays the only gate; this
// never starts a backup and never deletes anything itself.
// Nearly a no-op: the nightly job already ran retention after the day's backup, and deleted rows do
// not shrink the database file.
import type { WatchdogDeps } from "./ports.js";
import { statfsFreePct } from "./ports.js";

export interface DiskMemory {
  /** The UTC day retention was last asked for: once per day. */
  lastDay: string | null;
}

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The lowest free % over the supervisor's own paths; outside the queue. */
export async function lowestFreePct(d: WatchdogDeps): Promise<number | null> {
  const measure = d.freePct ?? statfsFreePct;
  const readings = await Promise.all(d.diskPaths.map((p) => measure(p)));
  const known = readings.filter((r): r is number => r !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/** In a queue op: asks for retention once per UTC day while the disk is low. */
export async function diskRule(
  d: WatchdogDeps,
  freePct: number | null,
  minFreePct: number,
  memory: DiskMemory,
  retention: ((reason: string) => Promise<void>) | undefined,
): Promise<void> {
  if (freePct === null || freePct >= minFreePct) return;
  // A coalesced sweep pass, on every low tick and never awaited. Before the retention
  // gate below on purpose: that one fires once a UTC day, while a disk that stays low should keep
  // asking — the sweep coalesces the repeats itself, so asking often costs nothing. It relaxes no
  // check: a dirty or unmerged worktree is kept by the sweep's own rules exactly as always.
  d.requestSweep?.();
  if (retention === undefined) return;
  const day = utcDay(d.clock.now());
  if (memory.lastDay === day) return;
  memory.lastDay = day;
  d.log.warn(
    { freePct, minFreePct },
    "disk: the supervisor's disk is low; asking retention to run early",
  );
  await retention(`${freePct.toFixed(1)} % free, under ${minFreePct} %`);
}
