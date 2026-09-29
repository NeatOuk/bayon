// GET /agents/:id/sessions: one agent's sessions, newest first, keyset-paged on
// (created_at, id) through sessions_agent_created_idx (031). What a replay list needs; the GUI then
// replays one through GET /sessions/:id/events. Reads only: sessions are the supervisor's (§9.5).
import { err, ok, ticketKey, type Result } from "@bayon/core";
import { sql, type SqlBool } from "kysely";
import { z } from "zod";
import { all, first, qb, read, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";
import type { SessionRow } from "../schema.js";
import { keyPrefix } from "./ticket-key.js";

const AgentSessionsAfterShape = z.object({
  created_at: z.int().nonnegative(),
  id: z.string().min(1).max(64),
});
export type AgentSessionsAfter = z.infer<typeof AgentSessionsAfterShape>;

const AgentSessionsQueryShape = z.object({
  agentId: z.string().min(1),
  after: AgentSessionsAfterShape.optional(),
  limit: z.int().min(1).max(1000),
});
export type AgentSessionsQuery = z.input<typeof AgentSessionsQueryShape>;

export type AgentSessionRow = Pick<
  SessionRow,
  | "id"
  | "ticket_id"
  | "role"
  | "run_class"
  | "runner_id"
  | "state"
  | "created_at"
  | "started_at"
  | "ended_at"
  | "turns"
  | "cost_usd"
  | "exit_reason"
> & { readonly ticket_key: string | null };

export interface AgentSessionsPage {
  readonly rows: AgentSessionRow[];
  readonly hasMore: boolean;
}

/** Where the page after `row` starts. */
export const agentSessionsAfter = (
  row: AgentSessionRow,
): AgentSessionsAfter => ({
  created_at: row.created_at,
  id: row.id,
});

/** One page of an agent's sessions, newest first; an unknown agent is `not_found`. */
export async function listAgentSessions(
  db: Db,
  query: AgentSessionsQuery,
): R<AgentSessionsPage> {
  const parsed = AgentSessionsQueryShape.safeParse(query);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `bad agent sessions query: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { agentId, after, limit } = parsed.data;
  const page = await read(db, (ix): Result<AgentSessionsPage> => {
    const agent = first(
      ix,
      qb.selectFrom("agents").select("id").where("id", "=", agentId),
    );
    if (agent === undefined) {
      return err(failure("not_found", `agent ${agentId} does not exist`));
    }
    const prefix = keyPrefix(ix);
    const rows = all(
      ix,
      qb
        .selectFrom("sessions as s")
        .leftJoin("tickets as t", "t.id", "s.ticket_id")
        .select([
          "s.id",
          "s.ticket_id",
          "t.num as ticket_num",
          "s.role",
          "s.run_class",
          "s.runner_id",
          "s.state",
          "s.created_at",
          "s.started_at",
          "s.ended_at",
          "s.turns",
          "s.cost_usd",
          "s.exit_reason",
        ])
        .where("s.agent_id", "=", agentId)
        .$if(after !== undefined, (b) =>
          b.where(
            sql<SqlBool>`(s.created_at, s.id) < (${after?.created_at}, ${after?.id})`,
          ),
        )
        .orderBy("s.created_at", "desc")
        .orderBy("s.id", "desc")
        .limit(limit + 1),
    );
    return ok({
      rows: rows.slice(0, limit).map(({ ticket_num, ...row }) => ({
        ...row,
        ticket_key: ticket_num === null ? null : ticketKey(prefix, ticket_num),
      })),
      hasMore: rows.length > limit,
    });
  });
  return page.ok ? page.value : page;
}
