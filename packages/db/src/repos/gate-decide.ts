import {
  GateEvidence,
  StoredGateEvidence,
  driftFinding,
  err,
  newId,
  ok,
  planRetry,
  verdict,
  type GateFailReason,
  type ReviewFinding,
  type Result,
  type Verdict,
} from "@bayon/core";
import {
  all,
  first,
  qb,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { toJsonText } from "../json.js";
import type { FindingRow, GateRow, QaRunRow } from "../schema-work.js";
import {
  gateEvent,
  gateReason,
  gateSettingsIn,
  insertGateIn,
  type WriterHooks,
} from "./gate-common.js";
import { advanceTicketIn, type AdvanceOutcome } from "./advance-ticket.js";
import { recordGateQaRunIn } from "./qa-runs.js";
import type { TicketActor } from "./ticket-common.js";

// decideGate: the supervisor's only gate writer (cross-milestone rule 2). The
// gate engine hands it the facts; the writer runs core's verdict() itself, so evidence
// that is not a GateEvidence can never be stored as passed (§10.3, Invariant 10). A timeout or a
// supervisor restart reopens the gate in the same transaction, at most gates.timeout_retries times
// in a row; the engine spawns the retry itself (no command: the supervisor never inserts one).
// Last, in the same transaction, the machine step the decision settles, if any (advanceTicket,
//): a decision and the move it unlocks commit together or not at all.

export interface GateDecision {
  readonly gate_id: string;
  /** The reviewer session (sessions.gate_id = gate_id); null when none was spawned. */
  readonly session_id: string | null;
  /** GateEvidence, or GateFailure {reason} for a gate that failed before it had a process. */
  readonly evidence: unknown;
  /** From parseReviewOutput / parseHeuristicFindings; stored open. */
  readonly findings: readonly ReviewFinding[];
}

export interface Decided {
  readonly gate: GateRow;
  readonly findings: FindingRow[];
  /** The next attempt a timeout or restart opened, `running`; the engine spawns it. */
  readonly retry: GateRow | null;
  /** The machine step taken with the decision, or why none was. */
  readonly advance: AdvanceOutcome;
  /** The `qa_runs` row a `qa_harness` gate's decision wrote; null for every other kind. */
  readonly qaRun: QaRunRow | null;
}

/** A finding's detail beyond this is cut; the full review stays in the gate's artifacts. */
export const FINDING_DETAIL_CAP = 4096;
/** A finding's summary is one line. */
export const FINDING_SUMMARY_CAP = 500;
const TRUNCATED = "\n…(truncated; the full review is in the gate's artifacts)";

const cap = (text: string, max: number, tail: string): string =>
  text.length <= max ? text : text.slice(0, max - tail.length) + tail;

/**
 * Decides a running gate in one BEGIN IMMEDIATE. A gate that is not running is a `conflict`
 * carrying `{state}` (a waive or supersede won, or this is a repeat), and nothing is written.
 */
export function decideGate(
  db: Db,
  d: GateDecision,
  /** Test seam (gate-race.test.ts); production passes none. */
  hooks: WriterHooks = {},
): R<Decided> {
  return write(db, (ix) => decideIn(ix, d, hooks));
}

function decideIn(
  ix: Internals,
  d: GateDecision,
  hooks: WriterHooks,
): Result<Decided> {
  const gate = first(
    ix,
    qb.selectFrom("gates").selectAll().where("id", "=", d.gate_id),
  );
  if (gate === undefined) {
    return err(failure("not_found", `gate ${d.gate_id} does not exist`));
  }
  if (gate.state !== "running") {
    return err(
      failure("conflict", `gate ${gate.id} is ${gate.state}, not running`, {
        state: gate.state,
      }),
    );
  }
  hooks.afterRead?.();
  const session = checkSession(ix, gate.id, d.session_id);
  if (!session.ok) return session;
  const settings = gateSettingsIn(ix);
  if (!settings.ok) return settings;
  const v = verdict({
    evidence: d.evidence,
    findings: d.findings.map((f) => ({ severity: f.severity, status: "open" })),
    settings: settings.value,
  });
  const kept = storedEvidence(d.evidence, v);
  const stored = toJsonText(kept, "evidence");
  if (!stored.ok) return stored;
  const findings = [...d.findings, ...systemFindings(ix, gate, v, kept)].map(
    (f) => insertFinding(ix, gate.id, f),
  );
  const decided = first(
    ix,
    qb
      .updateTable("gates")
      .set({
        state: v.state,
        evidence_json: stored.value,
        findings_total: findings.length,
        findings_unresolved: findings.length,
        reviewer_session_id: d.session_id,
        subject_ref: subjectRef(kept) ?? gate.subject_ref,
        decided_at: ix.clock.now(),
      })
      .where("id", "=", gate.id)
      .where("state", "=", "running")
      .returningAll(),
  );
  if (decided === undefined) {
    return err(failure("internal", `gate ${gate.id} did not decide`));
  }
  const by: TicketActor = {
    actor_kind: "supervisor",
    actor_id: d.session_id ?? "supervisor",
  };
  gateEvent(
    ix,
    decided,
    "decide",
    by,
    v.state === "failed" ? { reason: v.reason } : {},
  );
  const retry =
    v.state === "passed"
      ? ok(null)
      : retryIn(ix, decided, v.reason, settings.value.timeout_retries, by);
  if (!retry.ok) return retry;
  // A `qa_harness` gate's decision is also a QA fact (§10.4), and it is written **here**,
  // before the advance: `advanceTicketIn` reads `facts.qa` in this same transaction, so a gate that
  // passed and the `pass_harness` it unlocks have to see the same row. Written after the retry, so a
  // reopened attempt's own row comes later and the newest still speaks for the newest attempt.
  const qaRun = recordGateQaRunIn(
    ix,
    decided,
    kept,
    v.state === "failed" ? v.reason : null,
  );
  if (!qaRun.ok) return qaRun;
  // After the retry: a reopened attempt is running, so the round waits for it.
  const advance = advanceTicketIn(ix, decided.ticket_id, {
    gate_id: decided.id,
  });
  if (!advance.ok) return advance;
  return ok({
    gate: decided,
    findings,
    retry: retry.value,
    advance: advance.value,
    qaRun: qaRun.value,
  });
}

/**
 * The findings the writer files itself, beside the reviewer's: a round gate that failed
 * because its base moved carries one informational finding telling the fix round to bring the
 * branch up to date, naming the gate's repo when it has one. Filed here, not by the engine, so both
 * ways to a base_drift verdict (at pin, and a review failed on its drift flag) carry it.
 */
function systemFindings(
  ix: Internals,
  gate: GateRow,
  v: Verdict,
  kept: unknown,
): readonly ReviewFinding[] {
  if (v.state !== "failed" || v.reason !== "base_drift") return [];
  const repo =
    gate.repo_id === null
      ? undefined
      : first(
          ix,
          qb.selectFrom("repos").select("name").where("id", "=", gate.repo_id),
        );
  const drift = driftFinding(gate.kind, kept, repo?.name ?? null);
  return drift === null ? [] : [drift];
}

function checkSession(
  ix: Internals,
  gateId: string,
  sessionId: string | null,
): Result<void> {
  if (sessionId === null) return ok(undefined);
  const s = first(
    ix,
    qb
      .selectFrom("sessions")
      .select(["id", "gate_id"])
      .where("id", "=", sessionId),
  );
  return s !== undefined && s.gate_id === gateId
    ? ok(undefined)
    : err(
        failure(
          "validation",
          `session ${sessionId} is not gate ${gateId}'s reviewer (sessions.gate_id)`,
        ),
      );
}

/**
 * What evidence_json keeps: the evidence as given, with a failed verdict's reason set. A GateFailure
 * keeps its detail, considered runners, drift and queued_reason; evidence
 * that does not parse keeps the reason alone.
 */
function storedEvidence(evidence: unknown, v: Verdict): unknown {
  if (v.state === "passed") return v.evidence;
  const parsed = StoredGateEvidence.safeParse(evidence);
  return parsed.success
    ? { ...parsed.data, reason: v.reason }
    : { reason: v.reason };
}

/** base..head, when the evidence pinned a subject (passed, or failed after it had one). */
const subjectRef = (kept: unknown): string | null => {
  const parsed = GateEvidence.safeParse(kept);
  return parsed.success
    ? `${parsed.data.subject.base_sha}..${parsed.data.subject.head_sha}`
    : null;
};

function insertFinding(
  ix: Internals,
  gateId: string,
  f: ReviewFinding,
): FindingRow {
  const now = ix.clock.now();
  const row = returningOne(
    ix,
    qb
      .insertInto("findings")
      .values({
        id: newId(now),
        gate_id: gateId,
        severity: f.severity,
        category: f.category,
        file: f.file,
        line: f.line,
        summary: cap(f.summary, FINDING_SUMMARY_CAP, "…"),
        detail_md:
          f.detail_md === null
            ? null
            : cap(f.detail_md, FINDING_DETAIL_CAP, TRUNCATED),
        status: "open",
        created_at: now,
      })
      .returningAll(),
  );
  if (!row.ok) throw new Error(row.error.message); // write() turns it into an error and rolls back
  return row.value;
}

/** Opens the next attempt after a timeout or restart, when planRetry allows one. */
function retryIn(
  ix: Internals,
  decided: GateRow,
  reason: GateFailReason,
  retries: number,
  by: TicketActor,
): Result<GateRow | null> {
  const ticket = first(
    ix,
    qb
      .selectFrom("tickets")
      .select(["id", "status", "non_trivial", "plan_path"])
      .where("id", "=", decided.ticket_id),
  );
  if (ticket === undefined) {
    return err(
      failure("internal", `gate ${decided.id}'s ticket does not exist`),
    );
  }
  const gates = all(
    ix,
    qb.selectFrom("gates").selectAll().where("ticket_id", "=", ticket.id),
  ).map((g) => ({ ...g, reason: gateReason(g.evidence_json) }));
  const round = planRetry({
    decided: { ...decided, reason },
    gates,
    ticket: {
      status: ticket.status,
      non_trivial: ticket.non_trivial === 1,
      plan_path: ticket.plan_path,
    },
    retries,
  });
  if (round === null) return ok(null);
  const row = insertGateIn(ix, ticket.id, round);
  if (!row.ok) return row;
  gateEvent(ix, row.value, "retry", by, { retry_of: decided.id });
  return ok(row.value);
}
