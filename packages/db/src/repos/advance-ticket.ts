import {
  decide,
  err,
  lawRefused,
  machineStep,
  ok,
  planRound,
  planTransition,
  type Actor,
  type GateOpen,
  type LawFacts,
  type LawTicket,
  type MachineRule,
  type Result,
  type TicketStatus,
} from "@bayon/core";
import {
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { TicketRow } from "../schema.js";
import type { GateRow } from "../schema-work.js";
import { insertAudit } from "./audit.js";
import {
  failSupersededIn,
  gateEvent,
  gateSettingsIn,
  insertGateIn,
} from "./gate-common.js";
import { lawFacts, lawTicket, parseStatus } from "./law-facts.js";
import { SUPERVISOR_ACTOR } from "./system-requests.js";
import type { TicketActor } from "./ticket-common.js";
import {
  factsOf,
  type TicketFactsSnapshot,
  type TransitionFacts,
} from "./ticket-facts.js";
import { moveTicket, type Decide } from "./ticket-transition.js";

// advanceTicket (§9.5 amendment, the second supervisor ticket write beside blockTicket):
// the machine steps. After a gate is decided, core's `machineStep` reads the stored facts and names
// the one edge they now settle — approve_plan, pass_review, request_fix, pass_harness, fail_harness —
// and this takes it through core's laws as the supervisor, with the patch core's plan builds, a
// transition event and an audit row. decideGate runs it inside its own BEGIN IMMEDIATE, so a
// decision and the step it unlocks commit together. Anything else writes nothing.
//
// It supersedes what the edge says, which for a gate-decided step is nothing in practice:
// machineStep takes those only while no gate they would supersede runs (machine.test.ts pins it).
// `merge_close` is the exception on purpose — every pull request merged, so a QA
// harness still running from `qa_harness` is failed `superseded` in this transaction. It does open one — `pass_review`'s
// `qa_harness` gate, for a project that configured a harness — and it opens it **with no
// command**, because the supervisor never inserts one (§9.5). The gate engine launches whatever
// `AdvanceOutcome.opened` names, exactly as it launches the retry `decideGate` opens beside it. Nor
// does it ship a phase hand-off: the move into the waiting room already released the holder.

const SUPERVISOR: Actor = { kind: "supervisor" };
/** Which of the supervisor's parts acts: its ticket_events rows carry it as actor_id. */
export const GATE_ENGINE_ACTOR_ID = "gate_engine";
export const ADVANCE_ACTION = "supervisor.advance_ticket";

export type AdvanceOutcome =
  | {
      readonly advanced: true;
      readonly rule: MachineRule;
      readonly from: TicketStatus;
      readonly to: TicketStatus;
      readonly ticket: TicketRow;
      /**
       * Gates the edge opened, `running`, with no `gate.run` command: the caller's gate engine
       * launches each. Empty for every step but `pass_review` on a QA project.
       */
      readonly opened: readonly GateRow[];
    }
  | {
      readonly advanced: false;
      readonly status: string;
      /** The edge machineStep named when the laws then refused it; null when none applied. */
      readonly rule: MachineRule | null;
      readonly why: string;
    };

/** What moved the ticket: the gate whose decision this follows, or the merges that closed it. */
export interface AdvanceCause {
  readonly gate_id?: string;
  /**
   * `merge_close`'s: the forge login of the merge that closed the ticket — the last of
   * its requests to merge — carried into the transition's payload and the audit row. Read by the
   * Jira write-back as "Merged by <merged_by>: <pr_urls>".
   */
  readonly merged_by?: string;
  /** `merge_close`'s: every merged pull request of the ticket, oldest merge first. */
  readonly pr_urls?: readonly string[];
}

/** Which of the supervisor's parts takes `merge_close`: the pull-request sweep. */
export const MERGE_ACTOR_ID = "delivery";

/** The facts as the supervisor acts on them: every fact the laws read, and no acting session. */
const snapshotOf = (facts: TransitionFacts): TicketFactsSnapshot => ({
  ticket: facts.ticket,
  children: facts.children(),
  worktrees: facts.worktrees(),
  ticketSessions: facts.ticketSessions(),
  actorSession: null,
  priorStatus: facts.priorStatus(),
  gates: facts.gates(),
  repos: facts.repos(),
  workspaceKind: facts.workspaceKind(),
  lintRepos: facts.lintRepos(),
  qaConfigured: facts.qaConfigured(),
  qaCi: facts.qaCi(),
  qaLatest: facts.qaLatest(),
  merge: facts.merge(),
  openFindings: facts.openFindings(),
});

const stay = (
  status: string,
  why: string,
  rule: MachineRule | null = null,
): Result<AdvanceOutcome> => ok({ advanced: false, status, rule, why });

/** The laws' facts for `ticket`, read now on `ix`, with the gate settings read there too. */
export const lawFactsIn = (ix: Internals, ticket: TicketRow): LawFacts =>
  lawFacts(snapshotOf(factsOf(ix, ticket)), gateSettingsIn(ix));

/**
 * advanceTicket inside the caller's write transaction (decideGate's). A law or facts problem is
 * `advanced: false` with why, never an error: it must not roll back the decision it follows. An
 * error is a write that failed, which fails the caller's transaction as any write would.
 */
export function advanceTicketIn(
  ix: Internals,
  ticketId: string,
  cause: AdvanceCause = {},
): Result<AdvanceOutcome> {
  const ticket = first(
    ix,
    qb.selectFrom("tickets").selectAll().where("id", "=", ticketId),
  );
  if (ticket === undefined) {
    return err(failure("not_found", `ticket ${ticketId}`));
  }
  const law = lawTicket(ticket);
  if (!law.ok) return stay(ticket.status, law.error.message);
  const facts = lawFactsIn(ix, ticket);
  if (facts.gates.state === "unavailable") {
    return stay(ticket.status, `gate facts: ${facts.gates.detail}`);
  }
  const step = machineStep({
    ticket: law.value,
    gates: facts.gates.value,
    merge: facts.merge,
  });
  if (!step.take) return stay(ticket.status, step.why);
  const decided = decide({
    ticket: law.value,
    actor: SUPERVISOR,
    to: step.to,
    input: {},
    facts,
  });
  if (!decided.allowed) {
    return stay(
      ticket.status,
      `${decided.rule} refused ${decided.reason}: ${decided.detail}`,
      step.rule,
    );
  }
  return take(ix, ticket, law.value, step.rule, step.to, cause);
}

/** Takes the edge the laws allowed: the move, its transition event, the audit row. */
function take(
  ix: Internals,
  ticket: TicketRow,
  law: LawTicket,
  rule: MachineRule,
  to: TicketStatus,
  cause: AdvanceCause,
): Result<AdvanceOutcome> {
  const plan = planTransition({
    ticket: law,
    priorStatus: parseStatus(factsOf(ix, ticket).priorStatus()),
    to,
    input: {},
    now: ix.clock.now(),
    actor: SUPERVISOR.kind,
  });
  if (!("patch" in plan)) return stay(ticket.status, plan.detail, rule);
  // moveTicket judges the move again over the facts it reads, in this same transaction.
  const decider: Decide = (f) => {
    const d = decide({
      ticket: law,
      actor: SUPERVISOR,
      to,
      input: {},
      facts: lawFacts(snapshotOf(f), gateSettingsIn(ix)),
    });
    return d.allowed ? ok(undefined) : err(lawRefused(d));
  };
  const by: TicketActor = {
    actor_kind: SUPERVISOR_ACTOR,
    actor_id: rule === "merge_close" ? MERGE_ACTOR_ID : GATE_ENGINE_ACTOR_ID,
  };
  const carried = carriedCause(rule, cause);
  const payload = { ...plan.payload, ...carried };
  const moved = moveTicket(
    ix,
    ticket,
    { id: ticket.id, version: ticket.version, to, by, patch: plan.patch },
    JSON.stringify(payload),
    decider,
  );
  // Nothing is written before moveTicket's own decide, so a refusal there leaves the decision whole.
  if (!moved.ok) {
    return moved.error.class === "law_refused"
      ? stay(ticket.status, moved.error.message, rule)
      : moved;
  }
  const audit = insertAudit(ix, {
    actor: SUPERVISOR_ACTOR,
    action: ADVANCE_ACTION,
    target_kind: "ticket",
    target_id: ticket.id,
    payload: { from: law.status, to, rule, ...carried },
  });
  if (!audit.ok) return audit;
  const superseded = supersedeIn(ix, moved.value, plan.gates.supersede, by);
  if (!superseded.ok) return superseded;
  const opened = openRoundIn(ix, moved.value, plan.gates.opens, by);
  if (!opened.ok) return opened;
  return ok({
    advanced: true,
    rule,
    from: law.status,
    to,
    ticket: moved.value,
    opened: opened.value,
  });
}

/**
 * What of `cause` the move records. The merge (`merged_by`, `pr_urls`) belongs to `merge_close`
 * alone: settlePullRequests hands it in whenever the ticket sits where a merge closes it, and the
 * step machineStep then names may be `pass_harness` or `fail_harness` — a QA move that must never
 * read as "Merged by …" on the timeline, in the audit log or in the Jira write-back ( * review, HIGH 1). A gate's id travels with any rule.
 */
function carriedCause(rule: MachineRule, cause: AdvanceCause): AdvanceCause {
  if (rule === "merge_close") return cause;
  return cause.gate_id === undefined ? {} : { gate_id: cause.gate_id };
}

/**
 * The running gates the edge supersedes, failed `superseded` in this transaction. Only
 * `merge_close` from `qa_harness` has any to fail — a merge ends the harness checking a change that
 * has already shipped; every gate-decided step waits while a gate it would supersede runs
 * (machine.test.ts pins that). No `session.stop` is inserted (§9.5: commands are the API's); the
 * gate engine's poll kills the job of a gate that stopped running.
 */
function supersedeIn(
  ix: Internals,
  ticket: TicketRow,
  kinds: readonly string[] | "all",
  by: TicketActor,
): Result<number> {
  const running = factsOf(ix, ticket)
    .gates()
    .filter(
      (g) =>
        g.state === "running" && (kinds === "all" || kinds.includes(g.kind)),
    );
  for (const gate of running) {
    const failed = failSupersededIn(ix, ticket.id, gate.id, by);
    if (!failed.ok) return failed;
  }
  return ok(running.length);
}

/**
 * The round the machine edge opens, `running`, each gate with its `gate` ticket_event and **no
 * command** (§9.5: the supervisor never inserts one — the caller's gate engine launches these, as
 * it launches `decideGate`'s retry).
 *
 * `planRound` rather than `planGateEffects` on purpose: a machine step must supersede nothing, and
 * the narrower call makes that structural instead of a comment. Today the one edge with anything to
 * open is `pass_review`, whose `qa_harness` gate has to be opened by the edge that *enters*
 * `qa_harness` — `pass_harness` and `fail_harness` are the only ways out, and both read the round's
 * gates. `openOwedHarness` opens the same round through here for a ticket
 * that entered `qa_harness` before its project ran QA.
 */
export function openRoundIn(
  ix: Internals,
  ticket: TicketRow,
  opens: readonly GateOpen[],
  by: TicketActor,
): Result<GateRow[]> {
  // The edge's own `opens`, from the row planTransition resolved for the real `from` and the
  // supervisor: a rule name alone does not name one row (merge_close has three).
  if (opens.length === 0) return ok([]);
  const facts = factsOf(ix, ticket);
  const rounds = planRound({
    opens,
    ticket: {
      non_trivial: ticket.non_trivial === 1,
      plan_path: ticket.plan_path,
    },
    gates: facts.gates(),
    repos: facts.repos(),
    multiRepo: false,
    lintRepos: [],
    qaConfigured: facts.qaConfigured(),
    qaCi: facts.qaCi(),
  });
  const opened: GateRow[] = [];
  for (const round of rounds) {
    const gate = insertGateIn(ix, ticket.id, round);
    if (!gate.ok) return gate;
    gateEvent(ix, gate.value, "open", by, {});
    opened.push(gate.value);
  }
  return ok(opened);
}

/**
 * The machine step for one ticket in its own BEGIN IMMEDIATE, outside a gate decision: the handle a
 * later sweep calls (a ticket unblocked back into code_review after its gates decided). A second
 * call finds the ticket moved on and writes nothing.
 */
export async function advanceTicket(
  db: Db,
  ticketId: string,
): R<AdvanceOutcome> {
  if (ticketId.trim() === "") {
    return err(failure("validation", "advanceTicket: ticketId is empty"));
  }
  return write(db, (ix) => advanceTicketIn(ix, ticketId));
}
