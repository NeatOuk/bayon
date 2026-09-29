// Reads of 007's gate lifecycle (M3): one gate, a gate's findings, the gates in a state, and the
// role bindings a reviewer is picked from. Their writers: the API's gate and role-binding routes,
// and the supervisor's decideGate.
import { ok, type FindingStatus, type GateState } from "@bayon/core";
import { sql } from "kysely";
import { all, first, qb, read, type Db, type R } from "../connection.js";
import { orNotFound } from "../errors.js";
import type { AgentRow } from "../schema.js";
import type { FindingRow, GateRow, RoleBindingRow } from "../schema-work.js";
import { agentPool } from "./agent-scope.js";

/**
 * The enabled agents of one kind and runner that a ticket in `workspaceId` may use (agentPool), by
 * id. Agents are the operator's rows (Invariant 1).
 */
function listAgentsOfKind(
  db: Db,
  kind: AgentRow["kind"],
  runnerId: string,
  workspaceId: string | null,
): R<AgentRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("agents")
        .selectAll()
        .where(agentPool(ix, kind, workspaceId).where)
        .where("runner_id", "=", runnerId)
        .where("enabled", "=", 1)
        .orderBy("id"),
    ),
  );
}

/**
 * The enabled `kind='reviewer'` agents of a runner, by id: whose identity a gate's reviewer session
 * takes. Scoped to the gate's ticket's project like staffing:
 * the project's own reviewers, the ones with no project only when it has none, never another
 * project's; every reviewer for a ticket with no project (null).
 */
export const listReviewerAgents = (
  db: Db,
  runnerId: string,
  workspaceId: string | null,
): R<AgentRow[]> => listAgentsOfKind(db, "reviewer", runnerId, workspaceId);

/**
 * The runners of project `workspaceId`'s own reviewer agents, enabled or not, by id: the runners a
 * gate on its ticket surveys. Null when the ticket has no project or the project has no
 * reviewer agent of its own — the binding and the fleet's reviewers decide, as before.
 */
export async function projectReviewerRunners(
  db: Db,
  workspaceId: string | null,
): R<string[] | null> {
  if (workspaceId === null) return ok(null);
  const rows = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("agents")
        .select("runner_id")
        .distinct()
        .where("kind", "=", "reviewer")
        .where("workspace_id", "=", workspaceId)
        .orderBy("runner_id"),
    ),
  );
  if (!rows.ok) return rows;
  return ok(
    rows.value.length === 0 ? null : rows.value.map((r) => r.runner_id),
  );
}

/**
 * The enabled `kind='util'` agents of a runner, by id: whose identity a script gate's session takes
 *. A `parity_check` runs a job, not a review, so its agent is a util row, never a
 * reviewer one — and the gate fails `no_reviewer` with a readable detail until an operator makes it.
 * Not project-scoped: a job's agent is the fleet's.
 */
export const listUtilAgents = (db: Db, runnerId: string): R<AgentRow[]> =>
  listAgentsOfKind(db, "util", runnerId, null);

/** A keyset position in GET /gates: the last row's (started_at, id). */
export interface GateCursor {
  readonly started_at: number;
  readonly id: string;
}

export interface GatesQuery {
  /** Only gates in these states; every state when absent or empty. */
  readonly states?: readonly GateState[];
  readonly ticket_id?: string;
  /** Only the gates of one project's tickets (`tickets.workspace_id`). */
  readonly workspace_id?: string;
  /** Only the latest attempt of each (ticket, kind, repo): the review queue's view. */
  readonly latest: boolean;
  readonly limit: number;
  readonly after?: GateCursor;
}

/** A gate with the ticket it reviews. */
export interface GateListRow extends GateRow {
  readonly ticket_num: number;
  readonly ticket_title: string;
  readonly ticket_status: string;
}

export interface GatesPage {
  readonly rows: GateListRow[];
  readonly nextCursor: GateCursor | null;
  readonly hasMore: boolean;
}

const startedAt = sql<number>`coalesce(g.started_at, 0)`;

/** GET /gates: newest first by (started_at, id), keyset-paged. */
export async function listGates(db: Db, q: GatesQuery): R<GatesPage> {
  const states = q.states ?? [];
  const after = q.after;
  const rows = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("gates as g")
        .innerJoin("tickets as t", "t.id", "g.ticket_id")
        .selectAll("g")
        .select([
          "t.num as ticket_num",
          "t.title as ticket_title",
          "t.status as ticket_status",
        ])
        .$if(states.length > 0, (w) => w.where("g.state", "in", states))
        .$if(q.ticket_id !== undefined, (w) =>
          w.where("g.ticket_id", "=", q.ticket_id ?? ""),
        )
        .$if(q.workspace_id !== undefined, (w) =>
          w.where("t.workspace_id", "=", q.workspace_id ?? ""),
        )
        .$if(q.latest, (w) =>
          w.where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom("gates as g2")
                  .select("g2.id")
                  .whereRef("g2.ticket_id", "=", "g.ticket_id")
                  .whereRef("g2.kind", "=", "g.kind")
                  .where(
                    sql<boolean>`coalesce(g2.repo_id, '') = coalesce(g.repo_id, '')`,
                  )
                  .whereRef("g2.attempt", ">", "g.attempt"),
              ),
            ),
          ),
        )
        .$if(after !== undefined, (w) =>
          w.where(
            sql<boolean>`(${startedAt} < ${after?.started_at ?? 0} OR (${startedAt} = ${after?.started_at ?? 0} AND g.id < ${after?.id ?? ""}))`,
          ),
        )
        .orderBy(startedAt, "desc")
        .orderBy("g.id", "desc")
        .limit(q.limit + 1),
    ),
  );
  if (!rows.ok) return rows;
  const page = rows.value.slice(0, q.limit);
  const last = page.at(-1);
  const hasMore = rows.value.length > q.limit;
  return ok({
    rows: page,
    hasMore,
    nextCursor:
      hasMore && last !== undefined
        ? { started_at: last.started_at ?? 0, id: last.id }
        : null,
  });
}

/** A reviewer session of a gate (sessions.gate_id), newest first per gate. */
export interface GateSession {
  readonly gate_id: string;
  readonly session_id: string;
}

/** The sessions spawned for these gates, newest first: GateView.session_id before a decision. */
export async function listGateSessions(
  db: Db,
  gateIds: readonly string[],
): R<GateSession[]> {
  if (gateIds.length === 0) return ok([]);
  const rows = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("sessions")
        .select(["id", "gate_id"])
        .where("gate_id", "in", gateIds)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc"),
    ),
  );
  if (!rows.ok) return rows;
  return ok(
    rows.value.flatMap((r) =>
      r.gate_id === null ? [] : [{ gate_id: r.gate_id, session_id: r.id }],
    ),
  );
}

export async function getGate(db: Db, id: string): R<GateRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("gates").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `gate ${id}`);
}

export interface FindingsQuery {
  /** Only findings in this status (findings_gate_status_idx); all of them when absent. */
  readonly status?: FindingStatus;
}

/** A gate's findings, oldest first. */
export function listGateFindings(
  db: Db,
  gateId: string,
  o: FindingsQuery = {},
): R<FindingRow[]> {
  const ofGate = qb
    .selectFrom("findings")
    .selectAll()
    .where("gate_id", "=", gateId);
  const query =
    o.status === undefined ? ofGate : ofGate.where("status", "=", o.status);
  return read(db, (ix) => all(ix, query.orderBy("created_at").orderBy("id")));
}

/** Every gate in `state`, longest-running first (gates_state_idx): the gate engine's sweep. */
export function listGatesInState(db: Db, state: GateState): R<GateRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("gates")
        .selectAll()
        .where("state", "=", state)
        .orderBy("started_at")
        .orderBy("id"),
    ),
  );
}

/** `role_bindings[role]`, or null when the role is unbound (§9.8). */
export async function getRoleBinding(
  db: Db,
  role: string,
): R<RoleBindingRow | null> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb.selectFrom("role_bindings").selectAll().where("role", "=", role),
    ),
  );
  return found.ok ? ok(found.value ?? null) : found;
}

/** Every role binding, by role. */
export function listRoleBindings(db: Db): R<RoleBindingRow[]> {
  return read(db, (ix) =>
    all(ix, qb.selectFrom("role_bindings").selectAll().orderBy("role")),
  );
}
