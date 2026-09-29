// The worktree sweep's pass (§9.6 step 6, §9.2; the design): every row not
// removed, oldest first, one at a time. Phase A checks outside any mutex and only flags; a row that
// may go runs phase B (remove.ts) inside its mirror's mutex. Then the stale mirror temp dirs. The
// pass aborts, writing nothing, when $FRM_HOME/work is missing (M3).
import { join } from "node:path";
import { sweepVisit, type SweepFlag } from "@bayon/core";
import { originGitAuth } from "../../forge/credential.js";
import { listSweepWorktrees, type SweepWorktree } from "@bayon/db";
import {
  clearWorktreeFlag,
  flagWorktree,
  markWorktreeRemoved,
} from "@bayon/db/supervisor";
import { hardenMirrorConfig } from "../mirror-config.js";
import { SWEEP_ENV } from "./argv.js";
import { mirrorKey } from "../mirror.js";
import { fetchBase, withGitAuth, type MirrorGit } from "../workspace-plan.js";
import { rowFacts, type PassState, type SweepDeps } from "./deps.js";
import { lstatOrNull } from "./fs.js";
import { sweepGitRun } from "./git.js";
import { inspect } from "./inspect.js";
import type { Cadence } from "./loop.js";
import { sweepMirrorTemps } from "./mirror-tmp.js";
import { removeRow, type Removal } from "./remove.js";
import { loadSweepSettings } from "./settings.js";

export type { SweepDeps, SweepHooks } from "./deps.js";

export interface SweepSummary extends Cadence {
  /** Why the pass wrote nothing, or null. */
  readonly aborted: string | null;
  readonly visited: number;
  readonly removed: number;
  readonly flagged: number;
  readonly kept: number;
  readonly skipped: number;
  readonly temps: number;
}

export async function sweepPass(
  deps: SweepDeps,
  signal: AbortSignal,
): Promise<SweepSummary> {
  const settings = await loadSweepSettings(deps.db);
  if (settings.problems.length > 0) {
    deps.log.warn(
      { problems: settings.problems, removalOn: settings.removalOn },
      "sweep: a setting is missing or malformed",
    );
  }
  const count = {
    visited: 0,
    removed: 0,
    flagged: 0,
    kept: 0,
    skipped: 0,
    temps: 0,
  };
  const cadence = {
    recheckMs: settings.recheckMs,
    minGapMs: settings.minGapMs,
  };
  const work = join(deps.frmHome, "work");
  if ((await lstatOrNull(work).catch(() => null))?.isDirectory() !== true) {
    const aborted = `${work} is missing: an unmounted volume never reads as every worktree gone`;
    deps.log.error({ work }, `sweep: ${aborted}`);
    return { ...cadence, ...count, aborted };
  }
  const rows = await listSweepWorktrees(deps.db);
  if (!rows.ok) {
    deps.log.error({ error: rows.error }, "sweep: cannot list the worktrees");
    return { ...cadence, ...count, aborted: rows.error.message };
  }
  const ps: PassState = {
    now: deps.clock.now(),
    settings,
    signal,
    fetched: new Set(),
    shallow: new Map(),
    repos: new Map(),
  };
  for (const row of rows.value) {
    if (signal.aborted) break;
    try {
      const outcome = await sweepRow(deps, row, ps);
      count[outcome] += 1;
      if (outcome !== "skipped") count.visited += 1;
    } catch (e) {
      deps.log.error(
        { worktree: row.id, err: String(e) },
        "sweep: a row failed",
      );
    }
  }
  if (settings.tmpMinAgeMs !== null && !signal.aborted) {
    count.temps = await sweepMirrorTemps(deps, settings.tmpMinAgeMs, signal);
  }
  deps.log.info(
    { ...count, removalOn: settings.removalOn },
    "sweep: pass done",
  );
  return { ...cadence, ...count, aborted: null };
}

type RowOutcome = "removed" | "flagged" | "kept" | "skipped";

async function sweepRow(
  deps: SweepDeps,
  row: SweepWorktree,
  ps: PassState,
): Promise<RowOutcome> {
  if (sweepVisit(rowFacts(row), deps.liveIds()) !== null) return "skipped";
  // A gone path runs no git at all (M3): the fetch waits for a row that is there.
  if ((await lstatOrNull(row.path).catch(() => null)) !== null) {
    await fetchOnce(deps, row, ps);
  }
  const found = await inspect(deps, row, ps);
  if (found.kind !== "remove") return settle(deps, row, found);
  return settle(deps, row, await removeRow(deps, row, found.plan, ps));
}

async function settle(
  deps: SweepDeps,
  row: SweepWorktree,
  r: Removal,
): Promise<RowOutcome> {
  switch (r.kind) {
    case "flag":
      await flag(deps, row, r);
      return "flagged";
    case "keep":
      if (row.kept_reason !== null) {
        const cleared = await clearWorktreeFlag(deps.db, row);
        if (!cleared.ok)
          deps.log.warn(
            { worktree: row.id, error: cleared.error },
            "sweep: cannot clear a flag",
          );
      }
      return "kept";
    case "gone": {
      const marked = await markWorktreeRemoved(deps.db, row);
      if (!marked.ok)
        deps.log.warn(
          { worktree: row.id, error: marked.error },
          "sweep: cannot mark it removed",
        );
      deps.log.info(
        { worktree: row.id, path: row.path },
        "sweep: its directory is gone: removed, no git ran",
      );
      return marked.ok ? "removed" : "kept";
    }
    case "removed":
      deps.log.info(
        { worktree: row.id, path: row.path, ms: r.ms },
        "sweep: worktree removed",
      );
      return "removed";
    case "skip":
      return "skipped";
    case "remove":
      return "kept"; // inspect's plan without phase B: never reached
  }
}

async function flag(
  deps: SweepDeps,
  row: SweepWorktree,
  f: SweepFlag,
): Promise<void> {
  if (row.kept_reason === f.reason && row.kept_detail === f.detail) return;
  const written = await flagWorktree(deps.db, {
    ...row,
    reason: f.reason,
    detail: f.detail,
  });
  if (!written.ok) {
    deps.log.warn(
      { worktree: row.id, error: written.error },
      "sweep: cannot flag",
    );
    return;
  }
  if (row.kept_reason !== f.reason) {
    deps.log.warn(
      { worktree: row.id, path: row.path, reason: f.reason, detail: f.detail },
      "sweep: worktree kept for a human",
    );
  }
}

/**
 * Q1, M3: the base once per repo per pass, under its mirror's mutex, before its first visited row,
 * with auto maintenance off. A failure is logged; the ref is judged as it stands (stale keeps more).
 *
 * The mirror's own config is reconciled first, inside the same hold (MEDIUM-3):
 * the sweep is the one place that fetches in a mirror on a timer rather than off a spawn, so
 * without this a mirror repointed at another host would be fetched from on every pass with no
 * hardening between. A config the pass cannot read is logged like a failed fetch and the base is
 * left as it stands — the sweep decides what to *keep*, so doing less of it is the safe direction.
 */
async function fetchOnce(
  deps: SweepDeps,
  row: SweepWorktree,
  ps: PassState,
): Promise<void> {
  if (ps.fetched.has(row.repo_id) || row.origin_url === null) return;
  ps.fetched.add(row.repo_id);
  // No maintenance pairs here: SAFE_GIT carries them on every call now, so a fetch
  // cannot run gc --auto whatever it is handed.
  const plain: MirrorGit = (dir, args, signal, env) =>
    sweepGitRun(deps, ["-C", dir, ...args], signal, undefined, env);
  // A private origin's base fetch needs the forge token as much as a spawn's does.
  const git = withGitAuth(
    plain,
    await originGitAuth(deps.secrets, row.origin_url),
  );
  const fetched = await deps.mirrors.run(
    mirrorKey(row.mirror_path),
    async () => {
      const hardened = await hardenMirrorConfig(
        { ...deps, gitEnv: SWEEP_ENV },
        row.mirror_path,
        { originUrl: row.origin_url },
        ps.signal,
      );
      return hardened.ok ? fetchBase(git, row, ps.signal) : hardened;
    },
  );
  if (!fetched.ok) {
    deps.log.warn(
      { repo: row.repo_id, error: fetched.error },
      "sweep: cannot fetch the base",
    );
  }
}
