// A crashed conformance run's leftovers. Each run keeps a journal in its own
// directory: `placed <executor> <session>` before a session's container exists, `released
// <session>` once it is gone. The sweep releases, by label and on its own executor, every session
// placed and never released, then removes the run's directory. It is the conformance queue's first
// job and runs again at the start of every run, so no run is in flight while it looks. A session
// whose executor is not loaded here keeps its line, and its directory, for a later sweep.
import { appendFile, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Executor } from "@bayon/executors";
import type { Logger } from "pino";

/** The journal's name in a run's directory. */
export const JOURNAL = "placed";

export interface RecoverOptions {
  readonly frmHome: string;
  readonly executors: ReadonlyMap<string, Executor>;
  readonly log: Logger;
}

/** The sessions a journal names as placed and never released: session id → executor id. */
export function pendingOf(journal: string): ReadonlyMap<string, string> {
  const placed = new Map<string, string>();
  for (const line of journal.split("\n")) {
    const [verb, first, second] = line.trim().split(" ");
    if (verb === "placed" && first !== undefined && second !== undefined) {
      placed.set(second, first);
    } else if (verb === "released" && first !== undefined) {
      placed.delete(first);
    }
  }
  return placed;
}

/** Every leftover run directory under FRM_HOME: its sessions released, then the directory gone. */
export async function recoverConformanceRuns(o: RecoverOptions): Promise<void> {
  const runs = join(o.frmHome, "conformance", "runs");
  const entries = await readdir(runs, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await sweepRun(o, join(runs, entry.name));
  }
}

async function sweepRun(o: RecoverOptions, dir: string): Promise<void> {
  const journal = join(dir, JOURNAL);
  const text = await readFile(journal, "utf8").catch(() => "");
  let left = 0;
  for (const [sessionId, executorId] of pendingOf(text)) {
    const executor = o.executors.get(executorId);
    if (executor?.release === undefined) {
      left += 1;
      o.log.warn(
        { dir, sessionId, executor: executorId },
        "a crashed conformance run left a session on an executor not loaded here: kept for a later sweep",
      );
      continue;
    }
    try {
      // The executor bounds its own release (a container's by timeouts.prepare_ms).
      await executor.release(sessionId, { root: "remove" });
      await appendFile(journal, `released ${sessionId}\n`);
      o.log.info(
        { dir, sessionId, executor: executorId },
        "released a crashed conformance run's session",
      );
    } catch (e) {
      left += 1;
      o.log.error(
        { dir, sessionId, executor: executorId, err: String(e) },
        "cannot release a crashed conformance run's session: the next sweep retries",
      );
    }
  }
  if (left === 0) await rm(dir, { recursive: true, force: true });
}
