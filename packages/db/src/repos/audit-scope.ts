// The project an audit row is about: insertAudit stamps it in the writer's transaction,
// so a project's timeline reads its audit rows by one indexed column. 031's backfill is these same
// rules in SQL; migrate-031.test.ts checks the two agree row for row.
//
// The target decides first; when it names no project, the actor `session:<id>` does; else NULL.
// A session's project is its own workspace, else its agent's (an agent with no project may work a
// project's ticket).
import { first, qb, type Internals } from "../connection.js";

const SESSION_ACTOR = "session:";

type Resolve = (ix: Internals, id: string) => string | null;

/** A session's project: its own workspace, else its agent's. */
const sessionProject: Resolve = (ix, id) =>
  first(
    ix,
    qb
      .selectFrom("sessions as s")
      .innerJoin("agents as a", "a.id", "s.agent_id")
      .select((eb) =>
        eb.fn
          .coalesce("s.workspace_id", "a.workspace_id")
          .$castTo<string | null>()
          .as("workspace_id"),
      )
      .where("s.id", "=", id),
  )?.workspace_id ?? null;

const ticketProject: Resolve = (ix, id) =>
  first(
    ix,
    qb.selectFrom("tickets").select("workspace_id").where("id", "=", id),
  )?.workspace_id ?? null;

/** A human request's project: its ticket's, else its session's. */
const requestProject: Resolve = (ix, id) => {
  const request = first(
    ix,
    qb
      .selectFrom("human_requests")
      .select(["ticket_id", "session_id"])
      .where("id", "=", id),
  );
  if (request === undefined) return null;
  const byTicket =
    request.ticket_id === null ? null : ticketProject(ix, request.ticket_id);
  if (byTicket !== null) return byTicket;
  return request.session_id === null
    ? null
    : sessionProject(ix, request.session_id);
};

// A Map, not an object: a target_kind is caller text, and `constructor` must not find a function.
const BY_TARGET: ReadonlyMap<string, Resolve> = new Map<string, Resolve>([
  ["ticket", ticketProject],
  [
    "project",
    (ix, id) =>
      first(ix, qb.selectFrom("workspaces").select("id").where("id", "=", id))
        ?.id ?? null,
  ],
  [
    "agent",
    (ix, id) =>
      first(
        ix,
        qb.selectFrom("agents").select("workspace_id").where("id", "=", id),
      )?.workspace_id ?? null,
  ],
  ["session", sessionProject],
  ["human_request", requestProject],
  [
    "pulse",
    (ix, id) =>
      first(
        ix,
        qb
          .selectFrom("pulses as p")
          .innerJoin("agents as a", "a.id", "p.agent_id")
          .select("a.workspace_id")
          .where("p.id", "=", id),
      )?.workspace_id ?? null,
  ],
  [
    "finding",
    (ix, id) =>
      first(
        ix,
        qb
          .selectFrom("findings as f")
          .innerJoin("gates as g", "g.id", "f.gate_id")
          .innerJoin("tickets as t", "t.id", "g.ticket_id")
          .select("t.workspace_id")
          .where("f.id", "=", id),
      )?.workspace_id ?? null,
  ],
]);

export interface AuditSubject {
  readonly actor: string;
  readonly target_kind?: string | null;
  readonly target_id?: string | null;
}

/** The project an audit row is about, or null when neither its target nor its actor names one. */
export function auditWorkspace(ix: Internals, e: AuditSubject): string | null {
  const resolve =
    e.target_kind == null ? undefined : BY_TARGET.get(e.target_kind);
  const byTarget =
    resolve === undefined || e.target_id == null
      ? null
      : resolve(ix, e.target_id);
  if (byTarget !== null) return byTarget;
  return e.actor.startsWith(SESSION_ACTOR)
    ? sessionProject(ix, e.actor.slice(SESSION_ACTOR.length))
    : null;
}
