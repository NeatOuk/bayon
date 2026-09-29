import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import { first, qb, type Internals } from "../connection.js";
import type { AgentRow, DB } from "../schema.js";

// Whose agents a ticket may use: staffing's candidates and a gate's reviewer agent read
// the same rule, so a project's work never lands on another project's agent.

/** The agents of one kind a ticket may use, as a filter on an `agents` query. */
export interface AgentPool {
  /**
   * The pool is the ticket's project's own agents. Its runners are then the operator's choice for
   * that project (§9.8), so the role binding does not narrow them; the fleet's pools it does.
   */
  readonly own: boolean;
  readonly where: (eb: ExpressionBuilder<DB, "agents">) => Expression<SqlBool>;
}

/** Whether project `workspaceId` has any agent of `kind`, enabled or not, busy or not. */
function hasOwnAgents(
  ix: Internals,
  kind: AgentRow["kind"],
  workspaceId: string,
): boolean {
  return (
    first(
      ix,
      qb
        .selectFrom("agents")
        .select("id")
        .where("kind", "=", kind)
        .where("workspace_id", "=", workspaceId),
    ) !== undefined
  );
}

/**
 * The agents of `kind` a ticket in project `workspaceId` may use: the project's own; the agents with
 * no project only while the project has no agent of that kind at all — a busy or disabled one still
 * counts, so a busy project waits rather than borrows; never another project's. A ticket with no
 * project (null) may use every agent of the kind.
 */
export function agentPool(
  ix: Internals,
  kind: AgentRow["kind"],
  workspaceId: string | null,
): AgentPool {
  if (workspaceId === null) {
    return { own: false, where: (eb) => eb("agents.kind", "=", kind) };
  }
  const own = hasOwnAgents(ix, kind, workspaceId);
  return {
    own,
    where: (eb) =>
      eb.and([
        eb("agents.kind", "=", kind),
        own
          ? eb("agents.workspace_id", "=", workspaceId)
          : eb("agents.workspace_id", "is", null),
      ]),
  };
}
