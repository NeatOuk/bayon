// Who is calling and what it may write (§7). The actor comes from the token's
// session alone: no tool schema carries an actor, so self-reports are never trusted (§11.1).

export interface McpActor {
  readonly kind: "session";
  readonly id: string;
  readonly role: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly ticketId: string | null;
  /** The agent's project, or null for the fleet. */
  readonly workspaceId: string | null;
}

export type Scope =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "cross_ticket_write" };

/** §11.1's "own": a worker writes only its own ticket; the orchestrator writes any. */
export function writeScope(actor: McpActor, target: string | null): Scope {
  if (target === null || actor.role === "orchestrator")
    return { allowed: true };
  return actor.ticketId === target
    ? { allowed: true }
    : { allowed: false, reason: "cross_ticket_write" };
}

/**
 * The one project the actor's ticket tools are held to, or null when none: an
 * orchestrator's agent's project. A fleet orchestrator (no project) is not held; nor is a worker,
 * whose writes writeScope already binds to its own ticket.
 */
export const heldProject = (actor: McpActor): string | null =>
  actor.role === "orchestrator" ? actor.workspaceId : null;

/**
 * Why the actor may not reach a ticket in project `ticketProject` (null: none), or null when it
 * may: an orchestrator held to a project reaches only that project's tickets, never one with no
 * project. The ticket's own project is not named: it is outside what this caller may see.
 */
export function outsideProject(
  actor: McpActor,
  ticketProject: string | null,
): string | null {
  const held = heldProject(actor);
  if (held === null || ticketProject === held) return null;
  return ticketProject === null
    ? `that ticket has no project; this orchestrator works only project ${held}`
    : `that ticket is not in project ${held}, the only one this orchestrator works`;
}
