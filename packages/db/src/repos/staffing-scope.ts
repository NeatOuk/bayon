import {
  agentUnfit,
  canonicalJson,
  ok,
  type Result,
  type StaffBinding,
  type StaffCandidate,
  type StaffRole,
} from "@bayon/core";
import { first, qb, type Internals } from "../connection.js";
import type { TicketRow } from "../schema.js";
import {
  actorColumns,
  insertTicketEvent,
  versionMiss,
  type TicketActor,
} from "./ticket-common.js";

// Staffing's project scope, inside staffTicket's transaction: a named agent's checks,
// the no_agent detail, and pinning a ticket with no project to the project it is staffed into.
// the caller's own project, when the caller is a session whose agent has one.

/** A staffing candidate, with the project it belongs to. */
export interface Candidate extends StaffCandidate {
  readonly workspace_id: string | null;
}

/**
 * Why a session caller may not staff the ticket: its agent belongs to a project and the
 * ticket is in another, or in none. Null when it may: the caller is the operator (or anything but
 * a session), its agent has no project, the ticket is in its project, or the ticket does not exist
 * (the caller's not_found says so). The other project is not named.
 */
export function outsideCallerProject(
  ix: Internals,
  by: TicketActor,
  ticketId: string,
): string | null {
  if (by.actor_kind !== "session" || by.actor_id === null) return null;
  const caller = first(
    ix,
    qb
      .selectFrom("sessions as s")
      .innerJoin("agents as a", "a.id", "s.agent_id")
      .select("a.workspace_id")
      .where("s.id", "=", by.actor_id),
  );
  const project = caller?.workspace_id ?? null;
  if (project === null) return null;
  const ticket = first(
    ix,
    qb
      .selectFrom("tickets")
      .select(["num", "workspace_id"])
      .where("id", "=", ticketId),
  );
  if (ticket === undefined || ticket.workspace_id === project) return null;
  return ticket.workspace_id === null
    ? `ticket #${ticket.num} has no project; this caller works only project ${project}`
    : `ticket #${ticket.num} is not in project ${project}, the only one this caller works`;
}

const projectOf = (ticket: TicketRow): string =>
  `ticket #${ticket.num}'s project ${ticket.workspace_id ?? "(none)"}`;

/**
 * The named agent when it may take the ticket now, else why not: it does not exist, is of another
 * kind, is outside the ticket's pool (another project's, or one with no project while the project
 * has its own), is disabled, or has no free slot. `pool` is the ticket's candidates.
 */
export function namedAgent(
  ix: Internals,
  ticket: TicketRow,
  role: StaffRole,
  agentId: string,
  pool: readonly Candidate[],
): Candidate | string {
  const candidate = pool.find((a) => a.id === agentId);
  if (candidate !== undefined) return agentUnfit(role, candidate) ?? candidate;
  const row = first(
    ix,
    qb
      .selectFrom("agents")
      .select(["id", "kind", "workspace_id"])
      .where("id", "=", agentId),
  );
  if (row === undefined) return `agent ${agentId} does not exist`;
  if (row.kind !== role)
    return `agent ${row.id} is a ${row.kind}, not a ${role}`;
  return row.workspace_id === null
    ? `agent ${row.id} has no project, and ${projectOf(ticket)} has ${role} agents of its own`
    : `agent ${row.id} belongs to project ${row.workspace_id}, not ${projectOf(ticket)}`;
}

/** The runners a binding narrows the fleet's agents to, as a detail fragment. */
const boundTo = (binding: StaffBinding | undefined): string =>
  binding === undefined
    ? ""
    : ` on runner ${[binding.runner_id, binding.fallback_runner_id]
        .filter((r) => r !== null)
        .join(" or ")} (role_bindings)`;

/** Why no agent of the pool was free, naming the pool: a project's own, or the fleet's. */
export function noAgent(
  role: StaffRole,
  workspaceId: string | null,
  own: boolean,
  binding: StaffBinding | undefined,
): string {
  const fleet = `${boundTo(binding)} is below its max_concurrency`;
  if (workspaceId === null) return `no enabled ${role} agent${fleet}`;
  return own
    ? `no enabled ${role} agent of project ${workspaceId} is below its max_concurrency`
    : `project ${workspaceId} has no ${role} agent of its own, and no enabled ${role} agent with no project${fleet}`;
}

/**
 * A ticket with no project takes the project of the agent it is staffed onto: the
 * column, a version bump and an `updated` ticket_event naming the staffer, in the caller's
 * transaction. A ticket with a project, or an agent with none, is returned as it is.
 */
export function pinToProject(
  ix: Internals,
  ticket: TicketRow,
  agent: Candidate,
  by: TicketActor,
): Result<TicketRow> {
  const workspaceId = agent.workspace_id;
  if (ticket.workspace_id !== null || workspaceId === null) return ok(ticket);
  const now = ix.clock.now();
  const row = first(
    ix,
    qb
      .updateTable("tickets")
      .set({
        workspace_id: workspaceId,
        version: ticket.version + 1,
        updated_at: now,
      })
      .where("id", "=", ticket.id)
      .where("version", "=", ticket.version)
      .returningAll(),
  );
  if (row === undefined) return versionMiss(ix, ticket.id, ticket.version);
  insertTicketEvent(ix, {
    ticket_id: ticket.id,
    ts: now,
    kind: "updated",
    ...actorColumns(by),
    reason: `staffed onto agent ${agent.id} of project ${workspaceId}`,
    payload_json: canonicalJson({
      fields: ["workspace_id"],
      workspace_id: workspaceId,
      agent_id: agent.id,
    }),
  });
  return ok(row);
}
