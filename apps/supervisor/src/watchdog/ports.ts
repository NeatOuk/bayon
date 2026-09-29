// What the watchdog reads from the lifecycle: functions over its state, so the
// watchdog never holds a session-queue op and the lifecycle never imports a rule.
import { statfs } from "node:fs/promises";
import type { Clock } from "@bayon/core";
import type { Db } from "@bayon/db";
import type { Executor } from "@bayon/executors";
import type { Log } from "../lifecycle/context.js";
import type { ReleaseCandidates } from "./candidates.js";

/** A live session's process, as silence reads it. */
export interface LiveProcessView {
  readonly sessionId: string;
  readonly executor: Executor;
  readonly ref: string;
}

export interface WatchdogDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Log;
  readonly candidates: ReleaseCandidates;
  /** lifecycle.kill_grace_ms: the stuck timer's period, and the grace after an exit. */
  readonly killGraceMs: () => number;
  /** executor.health_timeout_ms: a silence probe's bound. */
  readonly probeTimeoutMs: () => number;
  /** The live sessions with a process, not dead (§3.2). */
  readonly liveProcesses: () => readonly LiveProcessView[];
  /** Queues one coalesced ceilings check per live session; never awaited (§3.4). */
  readonly checkCeilings: () => void;
  /**
   * Asks the worktree sweep for one coalesced pass; never awaited (and §3.4's rule that
   * a watchdog op never waits on another queue — awaiting the sweep's queue from inside the
   * watchdog's own op is exactly the deadlock an earlier change MEDIUM-1 warns about). Absent where no
   * sweep is wired, and the rule then asks for nothing.
   */
  readonly requestSweep?: () => void;
  /** Paths on the supervisor's own disk: the DB directory and FRM_HOME/runtime (§7). */
  readonly diskPaths: readonly string[];
  /** Free % of the filesystem holding `path`; null when unmeasured. Default: statfs. */
  readonly freePct?: (path: string) => Promise<number | null>;
}

/** statfs's free share, for an unprivileged writer: available over total blocks. */
export async function statfsFreePct(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return s.blocks > 0 ? (s.bavail / s.blocks) * 100 : null;
  } catch {
    return null;
  }
}
