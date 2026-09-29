import {
  HELD_STATUSES,
  decide,
  err,
  isTerminal,
  lawRefused,
  ok,
  planTransition,
  type Actor,
  type GateFacts,
  type Known,
  type Result,
  type SystemHumanRequest,
} from "@bayon/core";
import { z } from "zod";
import { first, qb, write, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";
import type { TicketRow } from "../schema.js";
import type { HumanRequestRow } from "../schema-work.js";
import { insertAudit } from "./audit.js";
import { lawFactsWith, lawTicket, parseStatus } from "./law-facts.js";
import {
  SUPERVISOR_ACTOR,
  WATCHDOG_ACTOR_ID,
  insertSystemHumanRequestIn,
} from "./system-requests.js";
import type { TicketActor } from "./ticket-common.js";
import {
  factsOf,
  type TicketFactsSnapshot,
  type TransitionFacts,
} from "./ticket-facts.js";
import { moveTicket, type Decide } from "./ticket-transition.js";

// blockTicket: the circuit breaker's one ticket
// write. In one BEGIN IMMEDIATE it refuses a held or closed ticket, files the system request, then
// takes the `block` edge through core's laws as the supervisor actor, with the patch core's plan
// builds, and audits. A refusal anywhere rolls the request back too: a blocked ticket always has
// its request, and a refused block leaves none.

const SUPERVISOR: Actor = { kind: "supervisor" };
/** The block edge reads no gate facts; nothing async runs inside the transaction. */
const NO_GATES: Known<GateFacts> = {
  state: "unavailable",
  detail: "the block edge reads no gate facts",
};

export const BlockTicketInput = z.object({
  ticketId: z.string().min(1),
  blockedReason: z.string().trim().min(1).max(200),
  /** The request id is appended: "<this> (human request <id>)". */
  unblockCondition: z.string().trim().min(1).max(300),
});

export interface BlockTicket extends z.infer<typeof BlockTicketInput> {
  /** Filed in the same transaction; its ticket_id is set to the ticket. */
  readonly request: SystemHumanRequest;
}

export type BlockOutcome =
  | {
      readonly blocked: true;
      readonly ticket: TicketRow;
      readonly request: HumanRequestRow;
      /** False when the request's key already named a row. */
      readonly requestCreated: boolean;
    }
  | {
      readonly blocked: false;
      readonly reason: "already_blocked" | "held" | "closed";
      readonly status: string;
    };

/** The facts as the supervisor acts on them: no acting session, and no gate facts. */
const snapshotOf = (facts: TransitionFacts): TicketFactsSnapshot => ({
  ticket: facts.ticket,
  children: facts.children(),
  worktrees: facts.worktrees(),
  ticketSessions: facts.ticketSessions(),
  actorSession: null,
  priorStatus: facts.priorStatus(),
  gates: [],
  repos: [],
  // The circuit breaker's edge (`block`) opens and requires no gate, so none of these is read.
  workspaceKind: null,
  lintRepos: [],
  qaConfigured: false,
  qaCi: false,
  qaLatest: null,
  merge: { closeOnMerge: false, deliveries: [] },
  openFindings: [],
});

const unblocked = (
  reason: "already_blocked" | "held" | "closed",
  status: string,
): Result<BlockOutcome> => ok({ blocked: false, reason, status });

/** Blocks the ticket and files its request, or says why it does not. */
export async function blockTicket(db: Db, b: BlockTicket): R<BlockOutcome> {
  const parsed = BlockTicketInput.safeParse(b);
  if (!parsed.success) {
    return err(
      failure("validation", `blockTicket: ${z.prettifyError(parsed.error)}`),
    );
  }
  const { ticketId, blockedReason, unblockCondition } = parsed.data;
  return write(db, (ix) => {
    const ticket = first(
      ix,
      qb.selectFrom("tickets").selectAll().where("id", "=", ticketId),
    );
    if (ticket === undefined) {
      return err(failure("not_found", `ticket ${ticketId}`));
    }
    const law = lawTicket(ticket);
    if (!law.ok) return law;
    const status = law.value.status;
    if (status === "blocked") return unblocked("already_blocked", status);
    if (HELD_STATUSES.includes(status)) return unblocked("held", status);
    if (isTerminal(status)) return unblocked("closed", status);

    const filed = insertSystemHumanRequestIn(ix, {
      ...b.request,
      ticket_id: ticketId,
    });
    if (!filed.ok) return filed;
    const input = {
      blocked_reason: blockedReason,
      unblock_condition: `${unblockCondition} (human request ${filed.value.row.id})`,
    };
    const plan = planTransition({
      ticket: law.value,
      priorStatus: parseStatus(factsOf(ix, ticket).priorStatus()),
      to: "blocked",
      input,
      now: ix.clock.now(),
    });
    if (!("patch" in plan)) return err(lawRefused(plan));
    const decider: Decide = (facts) => {
      const d = decide({
        ticket: law.value,
        actor: SUPERVISOR,
        to: "blocked",
        input,
        facts: lawFactsWith(snapshotOf(facts), NO_GATES),
      });
      return d.allowed ? ok(undefined) : err(lawRefused(d));
    };
    const by: TicketActor = {
      actor_kind: SUPERVISOR_ACTOR,
      actor_id: WATCHDOG_ACTOR_ID,
      reason: blockedReason,
    };
    const moved = moveTicket(
      ix,
      ticket,
      {
        id: ticketId,
        version: ticket.version,
        to: "blocked",
        by,
        patch: plan.patch,
      },
      JSON.stringify(plan.payload),
      decider,
    );
    if (!moved.ok) return moved;
    const audit = insertAudit(ix, {
      actor: SUPERVISOR_ACTOR,
      action: "supervisor.block_ticket",
      target_kind: "ticket",
      target_id: ticketId,
      payload: {
        from: status,
        blocked_reason: blockedReason,
        human_request_id: filed.value.row.id,
      },
    });
    if (!audit.ok) return audit;
    return ok({
      blocked: true,
      ticket: moved.value,
      request: filed.value.row,
      requestCreated: filed.value.created,
    });
  });
}
