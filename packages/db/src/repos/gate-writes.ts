import {
  GATE_REVIEW_STATUS,
  canonicalJson,
  err,
  isCiGate,
  isPerRepoGate,
  isRoundGateKind,
  newId,
  ok,
  planRound,
  type FrmError,
  type GateEffects,
  type JsonValue,
  type Result,
  type RoundGate,
} from "@bayon/core";
import { check } from "../checks.js";
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
import type { FindingRow, GateRow } from "../schema-work.js";
import { audited, type AuditEntry } from "./audit.js";
import { insertCommandIn } from "./commands.js";
import {
  GATE_RUN,
  actorLabel,
  failSupersededIn,
  gateEvent,
  gateRunKey,
  insertGateIn,
  recountFindings,
  stopGateSessionsIn,
  type WriterHooks,
} from "./gate-common.js";
import {
  checkActor,
  insertTicketEvent,
  type TicketActor,
} from "./ticket-common.js";
import { factsOf, type TransitionFacts } from "./ticket-facts.js";

// The API's gate and finding writers. Each runs in one
// BEGIN IMMEDIATE with every check inside it, and appends a `gate` or `finding` ticket_event.
// Rounds open inside the transition's own transaction (transitionTicket's `gates`), and each gate
// opened inserts its `gate.run` command with it, so the status, the gates and the commands commit
// together or not at all.

/** A gate a round opened, with the command the gate engine claims and the session id it spawns. */
export interface OpenedGate {
  readonly gate: GateRow;
  readonly command_id: string;
  readonly session_id: string;
}

/** A transition's gate effects, planned from the facts the writer reads in its transaction. */
export type PlanGates = (facts: TransitionFacts) => Result<GateEffects>;

const NOTE_MAX = 500;

/** Fails each running gate the plan names (reason superseded), then opens its rounds. */
export function applyGateEffectsIn(
  ix: Internals,
  ticket: TicketRow,
  plan: PlanGates,
  by: TicketActor,
): Result<OpenedGate[]> {
  const planned = plan(factsOf(ix, ticket));
  if (!planned.ok) return planned;
  for (const gateId of planned.value.supersede) {
    const superseded = supersedeIn(ix, ticket.id, gateId, by);
    if (!superseded.ok) return superseded;
  }
  return openRoundsIn(ix, ticket.id, planned.value.open, by, "open");
}

function supersedeIn(
  ix: Internals,
  ticketId: string,
  gateId: string,
  by: TicketActor,
): Result<void> {
  const row = failSupersededIn(ix, ticketId, gateId, by);
  if (!row.ok) return row;
  const stopped = stopGateSessionsIn(ix, row.value.id);
  return stopped.ok ? ok(undefined) : stopped;
}

/** Inserts each gate `running` with its `gate.run` command {gate_id, session_id}. */
function openRoundsIn(
  ix: Internals,
  ticketId: string,
  rounds: readonly RoundGate[],
  by: TicketActor,
  step: "open" | "rerun",
): Result<OpenedGate[]> {
  let opened: readonly OpenedGate[] = [];
  for (const round of rounds) {
    const gate = insertGateIn(ix, ticketId, round);
    if (!gate.ok) return gate;
    // The API mints the reviewer's session id, as for session.spawn; the engine creates the row.
    const sessionId = newId(ix.clock.now());
    const command = insertCommandIn(ix, {
      type: GATE_RUN,
      payload: { gate_id: gate.value.id, session_id: sessionId },
      idempotencyKey: gateRunKey(gate.value.id),
    });
    if (!command.ok) return command;
    gateEvent(ix, gate.value, step, by, {
      command_id: command.value.id,
      session_id: sessionId,
    });
    opened = [
      ...opened,
      {
        gate: gate.value,
        command_id: command.value.id,
        session_id: sessionId,
      },
    ];
  }
  return ok([...opened]);
}

export interface RerunGate {
  readonly gate_id: string;
  readonly by: TicketActor;
}

const refused = (rule: string, reason: string, detail: string): FrmError => ({
  class: "law_refused",
  message: `${rule}: ${detail}`,
  retryable: false,
  cause: { rule, reason, detail },
});

/**
 * POST /gates/:id/run: a new attempt of the gate's kind for its repo, while the ticket waits in
 * that kind's review status, the repo is still the ticket's, and no gate of the kind runs. Its
 * attempt is one past the kind's highest, so it counts as a review round.
 */
export async function rerunGate(
  db: Db,
  r: RerunGate,
  audit?: AuditEntry,
): R<OpenedGate> {
  const checked = checkActor(r.by);
  if (!checked.ok) return checked;
  return write(db, (ix) => audited(ix, rerunIn(ix, r), audit));
}

function rerunIn(ix: Internals, r: RerunGate): Result<OpenedGate> {
  const gate = first(
    ix,
    qb.selectFrom("gates").selectAll().where("id", "=", r.gate_id),
  );
  if (gate === undefined) {
    return err(failure("not_found", `gate ${r.gate_id} does not exist`));
  }
  const refuse = (detail: string) =>
    err(refused("rerun_gate", "illegal_transition", detail));
  // Every kind an edge opens a round of may be reopened by one: the reviews, `parity_check`
  //, `lint_check`, and `qa_harness`, which `pass_review` opens as the ticket enters
  // that status. `human_qa` is the one kind no edge opens, and the message says so.
  if (!isRoundGateKind(gate.kind)) {
    return refuse(`a ${gate.kind} gate is not opened by any round`);
  }
  const ticket = first(
    ix,
    qb.selectFrom("tickets").selectAll().where("id", "=", gate.ticket_id),
  );
  if (ticket === undefined) {
    return err(failure("not_found", `ticket ${gate.ticket_id} does not exist`));
  }
  const status = GATE_REVIEW_STATUS[gate.kind];
  if (ticket.status !== status) {
    return refuse(
      `ticket ${ticket.id} is ${ticket.status}; a ${gate.kind} gate reruns in ${status}`,
    );
  }
  const facts = factsOf(ix, ticket);
  const repos = facts.repos();
  // A kind that is not per repo is opened repo-less however many repos the ticket touches
  // (§3.1), so `ticket_repos` says nothing about it: holding it to that set would refuse every
  // rerun of a parity_check. Not hypothetical since an earlier change gave the table a writer — a
  // multi-repo ticket now has rows here, and this arm is what keeps its parity reruns working.
  const inSet = !isPerRepoGate(gate.kind)
    ? gate.repo_id === null
    : repos.length === 0
      ? gate.repo_id === null
      : gate.repo_id !== null && repos.includes(gate.repo_id);
  if (!inSet) {
    return refuse(
      `repo ${gate.repo_id ?? "(none)"} is not one of ticket ${ticket.id}'s repos`,
    );
  }
  const gates = facts.gates();
  const running = gates.find(
    (g) => g.kind === gate.kind && g.state === "running",
  );
  if (running !== undefined) {
    return err(
      failure(
        "conflict",
        `${gate.kind} attempt ${running.attempt} is already running on ticket ${ticket.id}`,
        { state: "running" },
      ),
    );
  }
  const round = planRound({
    opens: [{ gate: gate.kind, when: "always" }],
    ticket: {
      non_trivial: ticket.non_trivial === 1,
      plan_path: ticket.plan_path,
    },
    gates,
    repos,
    // A rerun names one existing gate of a round kind (isRoundGateKind above) and opens it with
    // `when: "always"`, so no other `when` is consulted; and `only` below names the repo, which
    // wins over `lintRepos`. These facts decide nothing here.
    multiRepo: false,
    lintRepos: [],
    qaConfigured: false,
    // A rerun keeps the subject of the gate it reruns: a CI gate's rerun waits on CI
    // again, a command harness's runs the command, whatever the project's mode is now.
    qaCi: isCiGate(gate),
    only: { repo_id: gate.repo_id },
  });
  const opened = openRoundsIn(ix, ticket.id, round, r.by, "rerun");
  if (!opened.ok) return opened;
  const [first_] = opened.value;
  return first_ === undefined
    ? err(failure("internal", `no ${gate.kind} gate was opened`))
    : ok(first_);
}

/** A 1–500 character note, trimmed; `what` names it in the error. */
function checkNote(text: string, what: string): Result<string> {
  const trimmed = text.trim();
  const checked = check(
    trimmed.length > 0 && trimmed.length <= NOTE_MAX,
    `${what} must be 1-${NOTE_MAX} characters`,
  );
  return checked.ok ? ok(trimmed) : checked;
}

/** A compare-and-set on a gate missed: it is gone, or in another state. */
function gateMiss(ix: Internals, id: string, expected: string): Result<never> {
  const current = first(
    ix,
    qb.selectFrom("gates").select("state").where("id", "=", id),
  );
  return err(
    current === undefined
      ? failure("not_found", `gate ${id} does not exist`)
      : failure("conflict", `gate ${id} is ${current.state}, not ${expected}`, {
          state: current.state,
        }),
  );
}

export interface WaiveGate {
  readonly gate_id: string;
  readonly reason: string;
  readonly by: TicketActor;
}

/** POST /gates/:id/waive: running | failed → waived, with the reason shown forever (§10.3). */
export async function waiveGate(
  db: Db,
  w: WaiveGate,
  audit?: AuditEntry,
  /** Test seam (gate-race.test.ts); production passes none. */
  hooks: WriterHooks = {},
): R<GateRow> {
  const reason = checkNote(w.reason, "a waive reason");
  const actor = checkActor(w.by);
  if (!actor.ok) return actor;
  if (!reason.ok) return reason;
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("gates")
        .set({
          state: "waived",
          waived_by: actorLabel(w.by),
          waive_reason: reason.value,
          decided_at: ix.clock.now(),
        })
        .where("id", "=", w.gate_id)
        .where("state", "in", ["running", "failed"])
        .returningAll(),
    );
    if (row === undefined) return gateMiss(ix, w.gate_id, "running | failed");
    hooks.afterRead?.();
    gateEvent(ix, row, "waive", w.by, { reason: reason.value });
    // A waived running gate's reviewer has nothing left to decide.
    const stopped = stopGateSessionsIn(ix, row.id);
    if (!stopped.ok) return stopped;
    return audited(ix, ok(row), audit);
  });
}

function findingEvent(
  ix: Internals,
  ticketId: string,
  finding: FindingRow,
  step: "resolve" | "waive",
  by: TicketActor,
  extra: Readonly<Record<string, JsonValue>>,
): void {
  insertTicketEvent(ix, {
    ticket_id: ticketId,
    ts: ix.clock.now(),
    kind: "finding",
    from_status: null,
    to_status: null,
    actor_kind: by.actor_kind,
    actor_id: by.actor_id,
    reason: null,
    payload_json: canonicalJson({
      finding_id: finding.id,
      gate_id: finding.gate_id,
      step,
      severity: finding.severity,
      ...extra,
    }),
  });
}

/** The open finding `id` and its gate's ticket; not_found, or a conflict when it is not open. */
function openFinding(
  ix: Internals,
  id: string,
): Result<{ readonly finding: FindingRow; readonly ticketId: string }> {
  const found = first(
    ix,
    qb
      .selectFrom("findings")
      .innerJoin("gates", "gates.id", "findings.gate_id")
      .selectAll("findings")
      .select("gates.ticket_id as ticket_id")
      .where("findings.id", "=", id),
  );
  if (found === undefined) {
    return err(failure("not_found", `finding ${id} does not exist`));
  }
  const { ticket_id, ...finding } = found;
  if (finding.status !== "open") {
    return err(
      failure("conflict", `finding ${id} is ${finding.status}, not open`, {
        status: finding.status,
      }),
    );
  }
  return ok({ finding, ticketId: ticket_id });
}

export interface ResolveFinding {
  readonly finding_id: string;
  /** The fixing run (§10.3): it must work the finding's ticket. */
  readonly run_id: string;
  readonly note: string;
  readonly by: TicketActor;
}

/** open → resolved, naming the fixing run; a run on another ticket is refused (cross_ticket_write). */
export async function resolveFinding(
  db: Db,
  r: ResolveFinding,
  audit?: AuditEntry,
): R<FindingRow> {
  const note = checkNote(r.note, "a resolution note");
  const actor = checkActor(r.by);
  if (!actor.ok) return actor;
  if (!note.ok) return note;
  return write(db, (ix) => {
    const open = openFinding(ix, r.finding_id);
    if (!open.ok) return open;
    const { finding, ticketId } = open.value;
    const run = first(
      ix,
      qb
        .selectFrom("runs")
        .innerJoin("sessions", "sessions.id", "runs.session_id")
        .select(["runs.id as id", "sessions.ticket_id as ticket_id"])
        .where("runs.id", "=", r.run_id),
    );
    if (run === undefined) {
      return err(failure("not_found", `run ${r.run_id} does not exist`));
    }
    if (run.ticket_id !== ticketId) {
      return err(
        refused(
          "resolve_finding",
          "cross_ticket_write",
          `run ${r.run_id} works ${run.ticket_id ?? "no ticket"}, not ${ticketId}`,
        ),
      );
    }
    const row = first(
      ix,
      qb
        .updateTable("findings")
        .set({
          status: "resolved",
          resolved_by_run_id: r.run_id,
          resolution_note: note.value,
          resolved_by: actorLabel(r.by),
          resolved_at: ix.clock.now(),
        })
        .where("id", "=", finding.id)
        .where("status", "=", "open")
        .returningAll(),
    );
    if (row === undefined) {
      return err(failure("internal", `finding ${finding.id} did not resolve`));
    }
    recountFindings(ix, row.gate_id);
    findingEvent(ix, ticketId, row, "resolve", r.by, { run_id: r.run_id });
    return audited(ix, ok(row), audit);
  });
}

export interface WaiveFinding {
  readonly finding_id: string;
  readonly reason: string;
  readonly by: TicketActor;
}

/** open → waived, with who and why, shown forever (§10.3). */
export async function waiveFinding(
  db: Db,
  w: WaiveFinding,
  audit?: AuditEntry,
): R<FindingRow> {
  const reason = checkNote(w.reason, "a waive reason");
  const actor = checkActor(w.by);
  if (!actor.ok) return actor;
  if (!reason.ok) return reason;
  return write(db, (ix) => {
    const open = openFinding(ix, w.finding_id);
    if (!open.ok) return open;
    const { finding, ticketId } = open.value;
    const row = first(
      ix,
      qb
        .updateTable("findings")
        .set({
          status: "waived",
          waived_by: actorLabel(w.by),
          waive_reason: reason.value,
        })
        .where("id", "=", finding.id)
        .where("status", "=", "open")
        .returningAll(),
    );
    if (row === undefined) {
      return err(failure("internal", `finding ${finding.id} did not waive`));
    }
    recountFindings(ix, row.gate_id);
    findingEvent(ix, ticketId, row, "waive", w.by, { reason: reason.value });
    return audited(ix, ok(row), audit);
  });
}
