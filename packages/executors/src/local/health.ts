// The local executor's health (§6.1): free disk on every path the supervisor writes for
// this host, each measured through its nearest existing directory (a mirror not cloned yet counts
// by the filesystem it will land on), and the clock, which is the supervisor's own: skew 0. It
// never rejects: a path that cannot be measured is a failure, not an exception.
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import {
  judgeExecutorHealth,
  type DiskReading,
  type HealthLimits,
} from "@bayon/core";
import type { ExecutorHealthReport } from "../types.js";

/** The paths whose disk matters, asked on every check: a repo added at runtime counts. */
export type DiskPaths = () => readonly string[] | Promise<readonly string[]>;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const reason = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
const codeOf = (e: unknown): unknown =>
  typeof e === "object" && e !== null && "code" in e ? e.code : undefined;

/** The space we may use (df's Avail) on the filesystem holding `path`, as % of its size. */
export async function measureDisk(path: string): Promise<DiskReading> {
  let at = path;
  for (;;) {
    try {
      const fs = await statfs(at);
      return fs.blocks > 0
        ? { path, free_pct: round1((fs.bavail / fs.blocks) * 100), error: null }
        : { path, free_pct: null, error: `${at} reports no blocks` };
    } catch (e) {
      const parent = dirname(at);
      if (codeOf(e) !== "ENOENT" || parent === at) {
        return { path, free_pct: null, error: reason(e) };
      }
      at = parent;
    }
  }
}

/** Measures each distinct path and judges disk and clock against `limits`. */
export async function localHealth(o: {
  readonly paths: DiskPaths;
  readonly limits: HealthLimits;
  readonly now: () => number;
}): Promise<ExecutorHealthReport> {
  const listed = await Promise.resolve()
    .then(o.paths)
    .then(
      (paths) => ({ paths, failures: [] as readonly string[] }),
      (e: unknown) => ({
        paths: [] as readonly string[],
        failures: [`disk: cannot list the paths to measure: ${reason(e)}`],
      }),
    );
  const disk = await Promise.all([...new Set(listed.paths)].map(measureDisk));
  return judgeExecutorHealth({
    checkedAt: o.now(),
    disk,
    clockSkewMs: 0,
    limits: o.limits,
    failures: listed.failures,
  });
}
