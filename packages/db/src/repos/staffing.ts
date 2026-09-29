import {
  STAFFABLE_STATUSES,
  TicketStatus,
  err,
  newId,
  ok,
  pickAgent,
  staffPlanFor,
  type Result,
  type StaffPlan,
  type StaffRefusalReason,
  type StaffRole,
} from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import {
  all,
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { TicketRow } from "../schema.js";
import { audited, type AuditEntry } from "./audit.js";
import { insertCommandIn } from "./commands.js";
import { dailyCap, todayUsd } from "./fleet-overview.js";
import { wherePendingHandoff } from "./handoffs.js";
import {
  auditOverride,
  questionHold,
  type QuestionHold,
} from "./open-questions.js";
import { ENDED_STATES } from "./sessions.js";
import { staffPool, type PoolBinding } from "./staff-pool.js";
import {
  proposalStep,
  type ProposalFiled,
  type ProposalStep,
} from "./staff-proposal.js";
import {
  namedAgent,
  noAgent,
  outsideCallerProject,
  pinToProject,
  type Candidate,
} from "./staffing-scope.js";
import {
  releaseStaleHolder,
  releasingDetail,
  silentMs,
  type Holder,
} from "./stale-holder.js";
import type { TicketActor } from "./ticket-common.js";
import {
  checkTransition,
  moveTicket,
  type Decide,
} from "./ticket-transition.js";

// ticket_staff's writer (§9.5, M2 amendments f and h): the API writes tickets and inserts commands.
// One BEGIN IMMEDIATE holds the idempotency lookup, the checks, the prioritized → staffed move and
// the session.spawn insert, so they commit together or not at all. A refusal writes nothing, with
// one exception: a holder past `watchdog.silent_ms` has its `session.handoff` inserted
// by the refusal that names it, because `ticket_staff` is the whole remedy the `stale_session` arm
// has to offer and refusing it with nothing behind it is the dead end this repo calls an
// operator-dead-end. That one refusal carries its command's id, and commits the caller's audit.
// an earlier change adds the second: in a project that requires approval, a session's staffing files the
// phase's proposal (staff-proposal.ts) and is answered `approval_pending`, carrying it; a new
// proposal commits the caller's audit too. an earlier change: a ticket with an open question to the operator
// is refused `awaiting_human` to a session and writes nothing; the operator's own staffing goes
// ahead, and one that lands is audited `ticket.staff_override` in its transaction.

export interface StaffTicketRequest {
  readonly ticket_id: string;
  readonly role: StaffRole;
  /** Who staffs: the staff transition's actor. */
  readonly by: TicketActor;
  /** A repeat returns the first command and moves nothing. */
  readonly idempotencyKey?: string;
  /**
   * The agent (an id) the caller names instead of the selection rule's pick: taken only
   * if it may work the ticket — its kind, enabled, a free slot, in the ticket's project — else
   * `no_agent`. No role binding narrows it.
   */
  readonly agent?: string;
}

export type StaffOutcome =
  | {
      readonly kind: "staffed";
      readonly command_id: string;
      /** False for a repeated idempotency key. */
      readonly created: boolean;
      /** The session.spawn payload as stored. */
      readonly payload: unknown;
      readonly ticket_status: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: StaffRefusalReason;
      readonly detail: string;
      /** `holder_releasing` only: the `session.handoff` this call inserted. */
      readonly release_command_id?: string;
      /** `approval_pending` only: the proposal awaiting the operator. */
      readonly proposal?: ProposalFiled;
    };

const SPAWN = "session.spawn";
/** A command the supervisor has not finished: its spawn is still coming. */
const QUEUED = ["pending", "claimed"] as const;

type Refused = Extract<StaffOutcome, { kind: "refused" }>;
const refusal = (reason: StaffRefusalReason, detail: string): Refused => ({
  kind: "refused",
  reason,
  detail,
});

interface QueuedSpawn {
  readonly agent_id: string | null;
  readonly ticket_id: string | null;
}
interface Admitted {
  readonly agent: Candidate;
  readonly binding: PoolBinding | undefined;
}

/**
 * Moves (if prioritized) and queues one session on the ticket, or says why not: the status takes
 * no session, one already works it, today's spend reached the cap, or no agent has a slot.
 */
export function staffTicket(
  db: Db,
  req: StaffTicketRequest,
  decide: Decide,
  /** The caller's audit entry, committed with a staffing that lands. */
  audit?: AuditEntry,
): R<StaffOutcome> {
  return write(db, (ix) => {
    const outcome = staffIn(ix, req, decide);
    return !outcome.ok || !wrote(outcome.value)
      ? outcome
      : audited(ix, outcome, audit);
  });
}

/**
 * Whether the outcome wrote: a staffing, the refusal that queues a release, or the one
 * that files a proposal.
 */
const wrote = (outcome: StaffOutcome): boolean =>
  outcome.kind === "staffed" ||
  outcome.release_command_id !== undefined ||
  outcome.proposal?.created === true;

/**
 * staffTicket's body, inside the caller's write transaction: the operator's answer to a proposal
 * staffs through it too (answerStaffProposal), so the answer and the spawn commit together.
 */
export function staffIn(
  ix: Internals,
  req: StaffTicketRequest,
  decide: Decide,
): Result<StaffOutcome> {
  // First, before a replay: a project's orchestrator never staffs outside it.
  const outside = outsideCallerProject(ix, req.by, req.ticket_id);
  if (outside !== null) return ok(refusal("cross_project", outside));
  const key = req.idempotencyKey;
  if (key !== undefined) {
    const earlier = first(
      ix,
      qb
        .selectFrom("commands")
        .select(["id", "type", "payload_json"])
        .where("idempotency_key", "=", key),
    );
    if (earlier !== undefined) return replay(ix, earlier, req, key);
  }
  const ticket = first(
    ix,
    qb.selectFrom("tickets").selectAll().where("id", "=", req.ticket_id),
  );
  if (ticket === undefined) {
    return err(failure("not_found", `ticket ${req.ticket_id} does not exist`));
  }
  const status = TicketStatus.safeParse(ticket.status);
  if (!status.success) {
    return err(
      failure(
        "internal",
        `ticket ${ticket.id} has an unknown status: ${ticket.status}`,
      ),
    );
  }
  // An open question holds the ticket, not the session that asked it (§11.1).
  const hold = questionHold(ix, ticket, req.by);
  if (hold.kind === "wait") return ok(refusal("awaiting_human", hold.detail));
  const pending = pendingHandoff(ix, ticket.id);
  const plan = staffPlanFor(
    status.data,
    ticket.complexity_tier,
    pending?.runClass == null ? null : { runClass: pending.runClass },
  );
  if (plan === null) {
    return ok(
      refusal(
        "not_staffable",
        `ticket ${ticket.id} is ${ticket.status}; staffing takes ${STAFFABLE_STATUSES.join(", ")}, or any open, unheld ticket with a pending hand-off`,
      ),
    );
  }
  const admitted = admit(ix, ticket, req);
  if (!admitted.ok) return admitted;
  if ("kind" in admitted.value) return ok(admitted.value);
  // A project that requires approval gets a proposal from a session, not a spawn.
  const step = proposalStep(ix, {
    ticket,
    by: req.by,
    role: req.role,
    runClass: plan.runClass,
    handoffId: pending?.id ?? null,
    agent: admitted.value.agent,
  });
  if (!step.ok) return step;
  if (step.value.kind !== "proceed") return ok(awaiting(ticket, step.value));
  const moved = plan.transition ? stage(ix, ticket, req, decide) : ok(ticket);
  if (!moved.ok) return moved;
  // A ticket with no project takes the project of the agent it is staffed onto.
  const pinned = pinToProject(ix, moved.value, admitted.value.agent, req.by);
  if (!pinned.ok) return pinned;
  const queued = queueSpawn(
    ix,
    pinned.value,
    plan,
    admitted.value,
    req,
    pending?.id,
  );
  return overridden(ix, queued, ticket.id, req, hold);
}

/** The operator's staffing over open questions, audited once it lands. */
function overridden(
  ix: Internals,
  queued: Result<StaffOutcome>,
  ticketId: string,
  req: StaffTicketRequest,
  hold: QuestionHold,
): Result<StaffOutcome> {
  if (!queued.ok || hold.kind !== "override") return queued;
  const outcome = queued.value;
  if (outcome.kind !== "staffed" || !outcome.created) return queued;
  const audited = auditOverride(ix, {
    ticketId,
    by: req.by,
    requestIds: hold.requestIds,
    role: req.role,
    commandId: outcome.command_id,
  });
  return audited.ok ? queued : audited;
}

/** A proposal's step as staffing's answer: pending for the operator, or rejected by them. */
function awaiting(
  ticket: TicketRow,
  step: Exclude<ProposalStep, { kind: "proceed" }>,
): Refused {
  if (step.kind === "rejected") {
    return refusal(
      "not_staffable",
      `staffing ticket #${ticket.num} in this phase was rejected by the operator (request ${step.request_id}, answered ${JSON.stringify(step.answer)}); it is not proposed again`,
    );
  }
  const p = step.filed;
  const what = `staff ticket #${ticket.num} with ${p.agent_id} (${p.role}, ${p.run_class})`;
  return {
    ...refusal(
      "approval_pending",
      p.created
        ? `proposal ${p.request_id} filed: ${what} waits for the operator's approval; their answer wakes you`
        : `proposal ${p.request_id} to ${what} is still waiting for the operator; their answer wakes you`,
    ),
    proposal: p,
  };
}

/** The first check that fails, as a refusal; else the agent that takes the ticket. */
function admit(
  ix: Internals,
  ticket: TicketRow,
  req: StaffTicketRequest,
): Result<Refused | Admitted> {
  const live = all(
    ix,
    qb
      .selectFrom("sessions")
      .select(["id", "agent_id", "ticket_id", "state", "last_event_at"])
      .where("state", "not in", ENDED_STATES),
  );
  const queued = queuedSpawns(ix);
  const holder = live.find((s) => s.ticket_id === ticket.id);
  if (holder !== undefined) {
    const released = releaseHolder(ix, ticket, holder);
    if (!released.ok) return released;
    if (released.value !== null) return ok(released.value);
    return ok(
      refusal(
        "not_staffable",
        // The ticket's number, not its ULID or the holder's: a GUI reader can act on this without
        // a second lookup. The GUI itself checks the fleet's live sessions before ever offering
        // Staff, so a genuine hit here is the residual race this can't see from the client (a
        // session.spawn command queued but not yet materialized) — this message is its fallback.
        `ticket #${ticket.num} is already held by a live session (${holder.state}); stop it or wait for it to finish`,
      ),
    );
  }
  if (queued.some((s) => s.ticket_id === ticket.id)) {
    return ok(
      refusal(
        "not_staffable",
        `a session for ticket #${ticket.num} is already queued; wait for it to start`,
      ),
    );
  }
  const spent = overBudget(ix);
  if (!spent.ok) return spent;
  if (spent.value !== null) return ok(refusal("over_budget", spent.value));
  const pool = staffPool(ix, req.role, ticket.workspace_id, { live, queued });
  const { agents, binding } = pool;
  if (req.agent !== undefined) {
    const named = namedAgent(ix, ticket, req.role, req.agent, agents);
    return ok(
      typeof named === "string"
        ? refusal("no_agent", named)
        : { agent: named, binding },
    );
  }
  const agent = pickAgent(req.role, binding ?? null, agents, pool.scope);
  if (agent === null) {
    const detail = noAgent(req.role, ticket.workspace_id, pool.own, binding);
    return ok(refusal("no_agent", detail));
  }
  return ok({ agent, binding });
}

/**
 * The `stale_session` arm's remedy, taken: a holder silent past `watchdog.silent_ms`
 * is asked to hand off, and the caller is told to come back — a distinct answer from "no", because
 * the next call staffs. Null: the holder is working, so the old refusal stands.
 */
function releaseHolder(
  ix: Internals,
  ticket: TicketRow,
  holder: Holder,
): Result<Refused | null> {
  const silent = silentMs(ix);
  if (!silent.ok) return silent;
  const released = releaseStaleHolder(ix, holder, silent.value);
  if (!released.ok) return released;
  if (released.value === null) return ok(null);
  return ok({
    ...refusal("holder_releasing", releasingDetail(ticket.num, released.value)),
    release_command_id: released.value.command_id,
  });
}

/** Today's spend at or over a set cap, as the refusal's detail; null: under it, or no cap. */
function overBudget(ix: Internals): Result<string | null> {
  const cap = dailyCap(ix);
  if (!cap.ok) return cap;
  if (cap.value === null) return ok(null);
  const today = todayUsd(ix, ix.clock.now());
  return ok(
    today >= cap.value
      ? `today's spend $${today.toFixed(2)} has reached the daily cap $${cap.value.toFixed(2)}`
      : null,
  );
}

/** Spawns the supervisor has not made a session of yet: each holds its agent's slot and ticket. */
function queuedSpawns(ix: Internals): QueuedSpawn[] {
  return all(
    ix,
    qb
      .selectFrom("commands as c")
      .select([
        sql<string | null>`json_extract(c.payload_json, '$.agent_id')`.as(
          "agent_id",
        ),
        sql<string | null>`json_extract(c.payload_json, '$.ticket_id')`.as(
          "ticket_id",
        ),
      ])
      .where("c.type", "=", SPAWN)
      .where("c.state", "in", QUEUED)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("sessions as s")
              .select("s.id")
              .where(
                "s.id",
                "=",
                sql<string>`json_extract(c.payload_json, '$.session_id')`,
              ),
          ),
        ),
      ),
  );
}

/** prioritized → staffed under the laws (`staff`), in this transaction. */
function stage(
  ix: Internals,
  ticket: TicketRow,
  req: StaffTicketRequest,
  decide: Decide,
): Result<TicketRow> {
  const move = {
    id: ticket.id,
    version: ticket.version,
    to: "staffed",
    by: req.by,
  };
  const payload = checkTransition(move);
  return payload.ok
    ? moveTicket(ix, ticket, move, payload.value, decide)
    : payload;
}

/**
 * The ticket's newest pending hand-off (plan rule 3), by the one predicate, with its
 * predecessor's run class: what a successor continues. Null run class: no predecessor session.
 */
function pendingHandoff(
  ix: Internals,
  ticketId: string,
): { readonly id: string; readonly runClass: string | null } | undefined {
  const row = first(
    ix,
    qb
      .selectFrom("handoffs")
      .select(["id", "from_session_id"])
      .where("ticket_id", "=", ticketId)
      .where(wherePendingHandoff)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc"),
  );
  if (row === undefined) return undefined;
  const from =
    row.from_session_id === null
      ? undefined
      : first(
          ix,
          qb
            .selectFrom("sessions")
            .select("run_class")
            .where("id", "=", row.from_session_id),
        );
  return { id: row.id, runClass: from?.run_class ?? null };
}

function queueSpawn(
  ix: Internals,
  ticket: TicketRow,
  plan: StaffPlan,
  pick: Admitted,
  req: StaffTicketRequest,
  handoffId: string | undefined,
): Result<StaffOutcome> {
  const executorId = pick.binding?.executor_id ?? null;
  const payload = {
    session_id: newId(ix.clock.now()),
    agent_id: pick.agent.id,
    role: req.role,
    run_class: plan.runClass,
    ticket_id: ticket.id,
    ...(ticket.workspace_id === null
      ? {}
      : { workspace_id: ticket.workspace_id }),
    ...(executorId === null ? {} : { executor_id: executorId }),
    ...(handoffId === undefined ? {} : { handoff_id: handoffId }),
  };
  const inserted = insertCommandIn(ix, {
    type: SPAWN,
    payload,
    ...(req.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: req.idempotencyKey }),
  });
  if (!inserted.ok) return inserted;
  return ok({
    kind: "staffed",
    command_id: inserted.value.id,
    created: inserted.value.created,
    payload,
    ticket_status: ticket.status,
  });
}

const StaffedBefore = z.object({
  ticket_id: z.string(),
  role: z.string(),
  agent_id: z.string(),
});

/**
 * A repeated key: the first command, if it staffed this ticket in this role (with the agent named,
 * when one is); else a conflict.
 */
function replay(
  ix: Internals,
  earlier: {
    readonly id: string;
    readonly type: string;
    readonly payload_json: string;
  },
  req: StaffTicketRequest,
  key: string,
): Result<StaffOutcome> {
  let payload: unknown;
  try {
    payload = JSON.parse(earlier.payload_json);
  } catch {
    return err(
      failure(
        "internal",
        `command ${earlier.id} has a payload that is not JSON`,
      ),
    );
  }
  const before = StaffedBefore.safeParse(payload);
  if (
    earlier.type !== SPAWN ||
    !before.success ||
    before.data.ticket_id !== req.ticket_id ||
    before.data.role !== req.role ||
    (req.agent !== undefined && before.data.agent_id !== req.agent)
  ) {
    return err(
      failure(
        "conflict",
        `idempotency key ${key} was used for a different command`,
      ),
    );
  }
  const ticket = first(
    ix,
    qb.selectFrom("tickets").select("status").where("id", "=", req.ticket_id),
  );
  if (ticket === undefined) {
    return err(failure("not_found", `ticket ${req.ticket_id} does not exist`));
  }
  return ok({
    kind: "staffed",
    command_id: earlier.id,
    created: false,
    payload,
    ticket_status: ticket.status,
  });
}
