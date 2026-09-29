import { err, ok, type Result } from "@bayon/core";
import { first, qb, type Internals } from "../connection.js";
import { failure } from "../errors.js";

// At most one enabled orchestrator per project. Held inside each writer's transaction
// that could make a second: `createProjectAgent` adding one, and `writeAgent` enabling one
// (`PATCH /agents/:id`, `frm agent set`). A disabled orchestrator does not count, so the operator
// replaces one by disabling it and adding another. A fleet orchestrator (no project) is outside it.

/** `agents.kind` of the agent that pulses a project (core's project plan). */
export const ORCHESTRATOR_KIND = "orchestrator";

/**
 * Refused (`conflict`) when project `workspace` already has an enabled orchestrator other than
 * `except`, naming it; ok otherwise. `doing` is the refused write, in the message's words.
 */
export function oneEnabledOrchestrator(
  ix: Internals,
  workspace: string,
  doing: string,
  except?: string,
): Result<void> {
  const other = first(
    ix,
    qb
      .selectFrom("agents")
      .select("id")
      .where("workspace_id", "=", workspace)
      .where("kind", "=", ORCHESTRATOR_KIND)
      .where("enabled", "=", 1)
      .$if(except !== undefined, (q) => q.where("id", "!=", except ?? ""))
      .orderBy("id")
      .limit(1),
  );
  return other === undefined
    ? ok(undefined)
    : err(
        failure(
          "conflict",
          `project ${workspace} already has an enabled orchestrator, ${other.id}: disable it before ${doing}`,
        ),
      );
}
