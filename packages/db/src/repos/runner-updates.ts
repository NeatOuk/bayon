// The runner update check's rows (051). Supervisor-owned: `runner_updates`, upserted by
// (runner_id, latest) on every check (§9.5). API-owned: `runner_update_dismissals`, the operator's
// dismissal, audited. The one read, `openRunnerUpdates`, serves both the Fleet and the notifier: per
// runner, its most recently checked row, when it says `newer` and nothing has dismissed it.
import { compareVersions, err, ok, type Result } from "@bayon/core";
import { sql } from "kysely";
import { check } from "../checks.js";
import {
  all,
  execute,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { insertAudit } from "./audit.js";
import type { RunnerUpdateRow } from "../schema-runner-updates.js";

/** One check's answer, as the supervisor's job records it. */
export interface RunnerUpdateSighting {
  readonly runner_id: string;
  readonly current: string;
  readonly latest: string;
  readonly newer: boolean;
  readonly notes_url?: string;
}

/**
 * Upserts by (runner_id, latest): `found_at` is set only on the row's first insert; `current`,
 * `newer` and `checked_at` are refreshed on every later sighting of the same pair.
 */
export async function recordRunnerUpdate(
  db: Db,
  u: RunnerUpdateSighting,
): R<RunnerUpdateRow> {
  return write(db, (ix) => {
    const now = ix.clock.now();
    const newer = u.newer ? 1 : 0;
    const notesUrl = u.notes_url ?? null;
    return returningOne(
      ix,
      qb
        .insertInto("runner_updates")
        .values({
          runner_id: u.runner_id,
          latest: u.latest,
          current: u.current,
          newer,
          notes_url: notesUrl,
          found_at: now,
          checked_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["runner_id", "latest"]).doUpdateSet({
            current: u.current,
            newer,
            notes_url: notesUrl,
            checked_at: now,
          }),
        )
        .returningAll(),
    );
  });
}

/** An open runner update: not dismissed, as the Fleet and the notifier both read it. */
export interface OpenRunnerUpdate {
  readonly runner_id: string;
  readonly current: string;
  readonly latest: string;
  readonly notes_url: string | null;
  readonly found_at: number;
}

/**
 * Each runner's most recently checked row, when it says `newer` and nothing has dismissed it —
 * and the runner's live installed version (`runners.version_detected`) has not already caught up
 * to `latest`. That second check happens in TS with core's `compareVersions` (no SQL semver): an
 * upgrade the boot pass hasn't rechecked yet (checking off, npm unreachable) must not keep showing
 * a stale item once the runner itself reports it is current.
 */
/** The leading release of a runner's reported version, e.g. `0.3.283` of `0.3.283 (cli 2.1.283)`. */
const INSTALLED = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/;

export function openRunnerUpdatesIn(ix: Internals): OpenRunnerUpdate[] {
  const ranked = qb
    .selectFrom("runner_updates as u")
    .select([
      "u.runner_id",
      "u.current",
      "u.latest",
      "u.newer",
      "u.notes_url",
      "u.found_at",
      sql<number>`row_number() OVER (PARTITION BY u.runner_id ORDER BY u.checked_at DESC)`.as(
        "rank",
      ),
    ]);
  const rows = all(
    ix,
    qb
      .selectFrom(ranked.as("r"))
      .leftJoin("runner_update_dismissals as d", (join) =>
        join
          .onRef("d.runner_id", "=", "r.runner_id")
          .onRef("d.latest", "=", "r.latest"),
      )
      .leftJoin("runners", "runners.id", "r.runner_id")
      .select([
        "r.runner_id",
        "r.current",
        "r.latest",
        "r.notes_url",
        "r.found_at",
        "runners.version_detected",
      ])
      .where("r.rank", "=", 1)
      .where("r.newer", "=", 1)
      .where("d.runner_id", "is", null)
      .orderBy("r.runner_id"),
  );
  return rows
    .filter((r) => {
      // A runner may report more than a version ("0.3.283 (cli 2.1.283)"): judge its leading
      // release only, and keep the item when there is none to judge — never hide one on a guess.
      const installed = INSTALLED.exec(r.version_detected ?? "")?.[1];
      return (
        installed === undefined || compareVersions(installed, r.latest) < 0
      );
    })
    .map(({ runner_id, current, latest, notes_url, found_at }) => ({
      runner_id,
      current,
      latest,
      notes_url,
      found_at,
    }));
}

/** `openRunnerUpdatesIn`, its own read transaction: for callers with no snapshot of their own. */
export async function openRunnerUpdates(db: Db): R<OpenRunnerUpdate[]> {
  return read(db, (ix) => openRunnerUpdatesIn(ix));
}

/** `POST /runners/:id/updates/:version/dismiss`: idempotent, audited. `not_found` for an unseen pair. */
export async function dismissRunnerUpdate(
  db: Db,
  runnerId: string,
  latest: string,
  by: string,
): R<{ readonly runner_id: string; readonly latest: string }> {
  const checked = check(by.trim().length > 0, "a dismissal needs an actor");
  if (!checked.ok) return checked;
  return write(db, (ix): Result<{ runner_id: string; latest: string }> => {
    const seen = all(
      ix,
      qb
        .selectFrom("runner_updates")
        .select(["runner_id"])
        .where("runner_id", "=", runnerId)
        .where("latest", "=", latest),
    );
    if (seen.length === 0) {
      return err(
        failure(
          "not_found",
          `runner ${runnerId} has no recorded update to ${latest}`,
        ),
      );
    }
    execute(
      ix,
      qb
        .insertInto("runner_update_dismissals")
        .values({
          runner_id: runnerId,
          latest,
          dismissed_at: ix.clock.now(),
          dismissed_by: by,
        })
        // Already dismissed: keep the first dismissal, which is the one that happened.
        .onConflict((oc) => oc.columns(["runner_id", "latest"]).doNothing()),
    );
    const audit = insertAudit(ix, {
      actor: by,
      action: "runner_update.dismiss",
      target_kind: "runner",
      target_id: runnerId,
      payload: { latest },
    });
    return audit.ok ? ok({ runner_id: runnerId, latest }) : audit;
  });
}
