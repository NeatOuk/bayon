// One project's pause as the supervisor reads it: `workspaces.paused`, read fresh each
// time admission gathers a spawn's or a turn's facts, and each time the pulse scheduler is about to
// plan, fire or run a project's orchestrator. The fleet's own hold is fleet-hold.ts; work with no
// project reads nothing here, so no project's pause ever holds it.
import { ok, type ProjectFact, type Result } from "@bayon/core";
import { getWorkspace, type Db } from "@bayon/db";

/** Project `workspaceId` and whether it is paused; null (fleet work) when there is none. */
export async function readProjectFact(
  db: Db,
  workspaceId: string | null,
): Promise<Result<ProjectFact | null>> {
  if (workspaceId === null) return ok(null);
  const row = await getWorkspace(db, workspaceId);
  return row.ok
    ? ok({ id: row.value.id, paused: row.value.paused === 1 })
    : row;
}

/** Whether nothing of the project may launch: paused, or its flag cannot be read (as isHeld). */
export const isProjectHeld = (fact: Result<ProjectFact | null>): boolean =>
  !fact.ok || fact.value?.paused === true;
