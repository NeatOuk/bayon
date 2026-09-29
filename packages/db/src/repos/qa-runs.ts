import {
  CiGateEvidence,
  GateEvidence,
  canonicalJson,
  isCiGate,
  newId,
  ok,
  type QaEvidence,
  type Result,
} from "@bayon/core";
import { sql } from "kysely";
import {
  all,
  first,
  qb,
  read,
  returningOne,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import type {
  GateRow,
  QaRunRow,
  QaRunSource,
  QaRunState,
} from "../schema-work.js";

// `qa_runs` (036): the supervisor's record of what a `qa_harness` gate decided, and the
// one fact `qa_passed` reads (§10.4). Written inside `decideGate`'s own transaction, before the
// machine step it settles — so a decision, the fact it produces and the move they unlock commit
// together or not at all. Nothing else writes here (Invariant 5).

/**
 * What a decided gate says about the project's QA.
 *
 * `error` is not decoration. A gate that failed because nothing judged the code — no reviewer, the
 * harness never started, a timeout, a restart, a superseding transition — must not read as a harness
 * that found a bug, or `qa_passed` would be told a lie in the one direction that matters and
 * fix path would be walked for nothing.
 */
export const qaRunState = (
  gateState: string,
  reason: string | null,
): QaRunState =>
  gateState === "passed" || gateState === "waived"
    ? "passed"
    : reason === "blocking_findings"
      ? "failed"
      : "error";

/** The `qa` block of a gate's stored evidence, when it has one (the harness actually ran). */
export function qaEvidenceOf(evidence: unknown): QaEvidence | null {
  const parsed = GateEvidence.safeParse(evidence);
  return parsed.success ? (parsed.data.qa ?? null) : null;
}

export interface NewQaRun {
  readonly ticket_id: string;
  /** Which kind of gate decided (043); a harness command unless said otherwise. */
  readonly source?: QaRunSource;
  readonly gate_id: string | null;
  readonly state: QaRunState;
  readonly command: string | null;
  readonly exit_code: number | null;
  readonly report_paths: readonly string[];
  readonly started_at: number;
  readonly ended_at: number | null;
}

/** Inserts one run inside the caller's transaction. */
export function insertQaRunIn(ix: Internals, run: NewQaRun): Result<QaRunRow> {
  return returningOne(
    ix,
    qb
      .insertInto("qa_runs")
      .values({
        id: newId(ix.clock.now()),
        ticket_id: run.ticket_id,
        gate_id: run.gate_id,
        source: run.source ?? "command",
        state: run.state,
        command: run.command,
        exit_code: run.exit_code,
        report_paths_json: canonicalJson([...run.report_paths]),
        started_at: run.started_at,
        ended_at: run.ended_at,
      })
      .returningAll(),
  );
}

/**
 * The row a decided `qa_harness` gate leaves. A gate that never ran a harness still gets one, with
 * no command and `error`: the newest row has to speak for the newest attempt, or a stale `passed`
 * from attempt 1 would carry a failed attempt 2 past `qa_passed`.
 */
export function recordGateQaRunIn(
  ix: Internals,
  gate: GateRow,
  evidence: unknown,
  reason: string | null,
): Result<QaRunRow | null> {
  if (gate.kind !== "qa_harness") return ok(null);
  const now = ix.clock.now();
  if (isCiGate(gate)) return recordCiRunIn(ix, gate, evidence, reason, now);
  const qa = qaEvidenceOf(evidence);
  return insertQaRunIn(ix, {
    ticket_id: gate.ticket_id,
    gate_id: gate.id,
    state: qaRunState(gate.state, reason),
    command: qa?.command ?? null,
    exit_code: qa?.exit_code ?? null,
    report_paths: qa?.reports ?? [],
    started_at: qa?.started_at ?? gate.started_at ?? now,
    ended_at: qa?.ended_at ?? gate.decided_at ?? now,
  });
}

/**
 * A CI gate's row: `source='ci'`, the gate's `ci checks …` command line and exit code,
 * and its check list artifact as the report — or, for a gate that failed before it read anything
 * (no checks within the grace, the deadline, a forge that refused), `error` with none of them.
 */
function recordCiRunIn(
  ix: Internals,
  gate: GateRow,
  evidence: unknown,
  reason: string | null,
  now: number,
): Result<QaRunRow> {
  const parsed = CiGateEvidence.safeParse(evidence);
  const ci = parsed.success ? parsed.data : null;
  return insertQaRunIn(ix, {
    ticket_id: gate.ticket_id,
    gate_id: gate.id,
    source: "ci",
    state: qaRunState(gate.state, reason),
    command: ci?.command ?? null,
    exit_code: ci?.exit_code ?? null,
    report_paths: ci?.artifact_paths ?? [],
    started_at: gate.started_at ?? now,
    ended_at: gate.decided_at ?? now,
  });
}

/**
 * The ticket's newest run, or null. The tie breaks on `rowid` — the order the rows actually went in
 * — because two decisions can land in the same millisecond (a test's frozen clock makes it certain)
 * and a ULID's random suffix is not an ordering. 035 broke the same tie the same way.
 */
export const latestQaRunIn = (
  ix: Internals,
  ticketId: string,
): QaRunRow | null =>
  first(
    ix,
    qb
      .selectFrom("qa_runs")
      .selectAll()
      .where("ticket_id", "=", ticketId)
      .orderBy("started_at", "desc")
      .orderBy(sql<number>`rowid`, "desc")
      .limit(1),
  ) ?? null;

/** The ticket's runs, newest first: the gate view and the ticket screen read them. */
export function listQaRuns(
  db: Db,
  ticketId: string,
  limit = 20,
): R<QaRunRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("qa_runs")
        .selectAll()
        .where("ticket_id", "=", ticketId)
        .orderBy("started_at", "desc")
        .orderBy(sql<number>`rowid`, "desc")
        .limit(limit),
    ),
  );
}

/** The ticket's newest run, read on its own connection. */
export const latestQaRun = (db: Db, ticketId: string): R<QaRunRow | null> =>
  read(db, (ix) => latestQaRunIn(ix, ticketId));
