// One project's pause: `POST /projects/:id/pause|resume` writes `workspaces.paused`
// through @bayon/db/api, shaped as the fleet's kill switch (fleet-control.ts's writePause). One
// transaction: the project is read, and each real change writes the column with its audit row; the
// state it already has writes neither. Admission (`project_paused`) and the pulse scheduler read it.
import { err, ok, type Result } from "@bayon/core";
import {
  execute,
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { insertAudit } from "./audit.js";

export interface ProjectPauseChange {
  /** The project: its workspace's id. */
  readonly project: string;
  readonly paused: boolean;
  /** False when the project already was in that state: nothing was written or audited. */
  readonly changed: boolean;
}

function writeProjectPause(
  ix: Internals,
  workspaceId: string,
  paused: boolean,
  actor: string,
): Result<ProjectPauseChange> {
  if (actor.trim() === "") {
    return err(failure("validation", "a pause or resume needs an actor"));
  }
  const row = first(
    ix,
    qb.selectFrom("workspaces").select("paused").where("id", "=", workspaceId),
  );
  if (row === undefined) {
    return err(failure("not_found", `project ${workspaceId} does not exist`));
  }
  const value = paused ? 1 : 0;
  if (row.paused === value) {
    return ok({ project: workspaceId, paused, changed: false });
  }
  execute(
    ix,
    qb
      .updateTable("workspaces")
      .set({ paused: value })
      .where("id", "=", workspaceId),
  );
  const audit = insertAudit(ix, {
    actor,
    action: paused ? "project.pause" : "project.resume",
    target_kind: "project",
    target_id: workspaceId,
    payload: { via: "rest" },
  });
  return audit.ok ? ok({ project: workspaceId, paused, changed: true }) : audit;
}

/**
 * Pauses or resumes project `workspaceId`, audited `project.pause` / `project.resume` as `actor`'s.
 * The same state again changes nothing. Refused, writing nothing: an unknown project (not_found),
 * an empty actor (validation).
 */
export function setProjectPaused(
  db: Db,
  workspaceId: string,
  paused: boolean,
  actor: string,
): R<ProjectPauseChange> {
  return write(db, (ix) => writeProjectPause(ix, workspaceId, paused, actor));
}
