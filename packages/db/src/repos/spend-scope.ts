import { sql } from "kysely";
import { all, qb, type Internals } from "../connection.js";
import type { TicketEconomicsRow } from "../schema-work.js";

// One project's spend: which spend rows, and which tickets, the IDE's Spend view counts.

/**
 * The ids of project `workspaceId`'s spend rows. A row's project is its ticket's workspace, else its
 * session's, else that session's agent's, else its pulse's agent's: the timeline's and the inbox's
 * rule, with the pulse last. `gate_id` adds nothing: ingest never sets it,
 * and a gate reviewer's session carries the gate's ticket.
 *
 * Not correlated, so SQLite builds it once per statement. A roll-up filters with `spend.id IN (…)`
 * rather than joining, because a join would make `cost_usd` and the token columns ambiguous.
 */
export const projectSpendIds = (workspaceId: string) =>
  qb
    .selectFrom("spend as ps")
    .leftJoin("tickets as pt", "pt.id", "ps.ticket_id")
    .leftJoin("sessions as pss", "pss.id", "ps.session_id")
    .leftJoin("agents as psa", "psa.id", "pss.agent_id")
    .leftJoin("pulses as pp", "pp.id", "ps.pulse_id")
    .leftJoin("agents as ppa", "ppa.id", "pp.agent_id")
    .select("ps.id")
    .where(
      (eb) =>
        eb.fn.coalesce(
          "pt.workspace_id",
          "pss.workspace_id",
          "psa.workspace_id",
          "ppa.workspace_id",
        ),
      "=",
      workspaceId,
    );

/**
 * The ids of the tickets project `workspaceId` owns (`tickets.workspace_id`): the only ones its
 * cost-per-tier roll-up counts. An owned ticket's spend is all the project's (the rule above reads
 * the ticket first), so the ticket's whole cost, rounds and hand-offs are the project's own, and a
 * closed ticket counts in exactly one tier breakdown. A ticket with no project counts in none but
 * the fleet's, however its spend splits.
 */
export const ownTicketIds = (workspaceId: string) =>
  qb
    .selectFrom("tickets")
    .select("tickets.id")
    .where("tickets.workspace_id", "=", workspaceId);

/** Per ticket, the money and tokens of project `workspaceId`'s own spend rows. */
const ownSpendByTicket = (workspaceId: string) =>
  qb
    .selectFrom("spend")
    .select((eb) => [
      "spend.ticket_id",
      eb.fn.sum<number>("spend.cost_usd").as("cost_usd"),
      sql<number>`sum(CASE WHEN spend.wasted = 1 THEN spend.cost_usd ELSE 0 END)`.as(
        "cost_wasted_usd",
      ),
      sql<number>`sum(spend.tokens_in + spend.tokens_out)`.as("tokens"),
      eb.fn.avg<number | null>("spend.cache_hit_ratio").as("cache_ratio"),
    ])
    .where("spend.ticket_id", "is not", null)
    .where("spend.id", "in", projectSpendIds(workspaceId))
    .groupBy("spend.ticket_id");

/**
 * The tickets with spend in project `workspaceId`, newest first, each with the project's share: its
 * cost, waste, tokens and cache ratio from the project's own spend rows, and its sessions from the
 * ones whose project it is (the ticket's, else the session's, else its agent's). So a ticket with no
 * project worked from two projects shows each only its own money, and the projects' shares plus the
 * rows in no project add up to the fleet's figure.
 *
 * Review rounds and hand-offs are the ticket's own facts, not a share: a round is not one project's.
 * They are shown whole wherever the ticket appears, and averaged only in the owning project's tier
 * breakdown (ownTicketIds). A ticket the project owns reads exactly as its fleet row does.
 */
export function projectTicketRows(
  ix: Internals,
  workspaceId: string,
): TicketEconomicsRow[] {
  return all(
    ix,
    qb
      .selectFrom("v_ticket_economics as v")
      .innerJoin(
        ownSpendByTicket(workspaceId).as("own"),
        "own.ticket_id",
        "v.id",
      )
      .select((eb) => [
        "v.id",
        "v.num",
        "v.title",
        "v.status",
        "v.complexity_tier",
        "own.cost_usd",
        "own.cost_wasted_usd",
        "v.review_rounds",
        "v.handoff_count",
        "v.phase_handoff_count",
        eb
          .selectFrom("sessions as s")
          .innerJoin("tickets as st", "st.id", "s.ticket_id")
          .leftJoin("agents as sa", "sa.id", "s.agent_id")
          .select((sub) => sub.fn.countAll<number>().as("n"))
          .whereRef("s.ticket_id", "=", "v.id")
          .where(
            (sub) =>
              sub.fn.coalesce(
                "st.workspace_id",
                "s.workspace_id",
                "sa.workspace_id",
              ),
            "=",
            workspaceId,
          )
          .$asScalar()
          .as("sessions"),
        "own.tokens",
        "own.cache_ratio",
      ])
      .orderBy("v.num", "desc"),
  );
}
