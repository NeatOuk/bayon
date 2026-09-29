import {
  GATE_SETTING_KEYS,
  StoredGateEvidence,
  canonicalJson,
  err,
  newId,
  ok,
  readGateSettings,
  type GateSettings,
  type JsonValue,
  type Result,
  type RoundGate,
} from "@bayon/core";
import { all, first, qb, returningOne, type Internals } from "../connection.js";
import { failure } from "../errors.js";
import type { GateRow } from "../schema-work.js";
import { insertCommandIn } from "./commands.js";
import { ENDED_STATES } from "./sessions.js";
import { insertTicketEvent, type TicketActor } from "./ticket-common.js";

// What the gate writers share: the API's (rounds, supersede, rerun, waive, resolve) and
// the supervisor's decideGate. Each writes inside its caller's BEGIN IMMEDIATE transaction.

/** The command the gate engine claims: payload {gate_id, session_id}. */
export const GATE_RUN = "gate.run";

/**
 * Test seam: `afterRead` runs inside the writer's BEGIN IMMEDIATE once it has read (and checked) the
 * gate's state, before it writes, so a test can start a rival writer on another connection there.
 */
export interface WriterHooks {
  readonly afterRead?: () => void;
}

/** `gate.run`'s idempotency key: one command per gate row. */
export const gateRunKey = (gateId: string): string => `${GATE_RUN}:${gateId}`;

/** The lifecycle's stop command: payload {session_id, mode}. */
export const SESSION_STOP = "session.stop";

/**
 * A gate that stopped running (superseded, waived) has no use for its reviewer ( * M2): each live session with its gate_id gets a `session.stop {mode: kill}`, keyed
 * `session.stop:<sid>`, in the caller's transaction. The API inserts; the supervisor claims (§9.5).
 */
export function stopGateSessionsIn(
  ix: Internals,
  gateId: string,
): Result<number> {
  const live = all(
    ix,
    qb
      .selectFrom("sessions")
      .select("id")
      .where("gate_id", "=", gateId)
      .where("state", "not in", [...ENDED_STATES])
      .orderBy("id"),
  );
  for (const s of live) {
    const inserted = insertCommandIn(ix, {
      type: SESSION_STOP,
      payload: { session_id: s.id, mode: "kill" },
      idempotencyKey: `${SESSION_STOP}:${s.id}`,
    });
    if (!inserted.ok) return inserted;
  }
  return ok(live.length);
}

const SUPERSEDED = canonicalJson({ reason: "superseded" });

/**
 * Fails running gate `gateId` of `ticketId` with reason `superseded`, and its `supersede`
 * ticket_event, in the caller's transaction. It stops nothing: the API's writers then insert the
 * reviewer's `session.stop` (stopGateSessionsIn); the supervisor's (advanceTicket's `merge_close`,
 *) inserts no command — the gate engine's poll kills the job of a gate that stopped
 * running (§9.5). A gate that is no longer running is an internal error: the caller planned it.
 */
export function failSupersededIn(
  ix: Internals,
  ticketId: string,
  gateId: string,
  by: TicketActor,
): Result<GateRow> {
  const row = first(
    ix,
    qb
      .updateTable("gates")
      .set({
        state: "failed",
        evidence_json: SUPERSEDED,
        decided_at: ix.clock.now(),
      })
      .where("id", "=", gateId)
      .where("ticket_id", "=", ticketId)
      .where("state", "=", "running")
      .returningAll(),
  );
  if (row === undefined) {
    return err(
      failure(
        "internal",
        `gate ${gateId} was planned for superseding but is not running`,
      ),
    );
  }
  gateEvent(ix, row, "supersede", by, { reason: "superseded" });
  return ok(row);
}

/** The reason a decided gate's evidence records, or null (running, passed, or unreadable). */
export function gateReason(evidenceJson: string | null): string | null {
  if (evidenceJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidenceJson);
  } catch {
    return null; // not JSON: no reason to report; the laws treat the evidence as missing
  }
  const stored = StoredGateEvidence.safeParse(parsed);
  return stored.success ? (stored.data.reason ?? null) : null;
}

/** Inserts one `running` gate of `ticketId`, stamped now. */
export function insertGateIn(
  ix: Internals,
  ticketId: string,
  round: RoundGate,
): Result<GateRow> {
  const now = ix.clock.now();
  return returningOne(
    ix,
    qb
      .insertInto("gates")
      .values({
        id: newId(now),
        ticket_id: ticketId,
        kind: round.kind,
        required: 1,
        state: "running",
        attempt: round.attempt,
        round: round.round,
        repo_id: round.repo_id,
        reviewer_session_id: null,
        subject_kind: round.subject_kind,
        subject_ref: round.subject_ref,
        evidence_json: null,
        findings_total: 0,
        findings_unresolved: 0,
        waived_by: null,
        waive_reason: null,
        started_at: now,
        decided_at: null,
      })
      .returningAll(),
  );
}

export type GateStep =
  "open" | "retry" | "supersede" | "decide" | "waive" | "rerun";

/** One `gate` ticket_event: a gate opened, retried, superseded, decided or waived. */
export function gateEvent(
  ix: Internals,
  gate: GateRow,
  step: GateStep,
  by: TicketActor,
  extra: Readonly<Record<string, JsonValue>> = {},
): void {
  insertTicketEvent(ix, {
    ticket_id: gate.ticket_id,
    ts: ix.clock.now(),
    kind: "gate",
    from_status: null,
    to_status: null,
    actor_kind: by.actor_kind,
    actor_id: by.actor_id,
    reason: by.reason ?? null,
    payload_json: canonicalJson({
      gate_id: gate.id,
      step,
      kind: gate.kind,
      repo_id: gate.repo_id,
      attempt: gate.attempt,
      state: gate.state,
      ...extra,
    }),
  });
}

/** Who a gate or finding write names in waived_by/resolved_by: `operator`, or `<kind>:<id>`. */
export const actorLabel = (by: TicketActor): string =>
  by.actor_kind === "operator" || by.actor_id === null
    ? by.actor_kind
    : `${by.actor_kind}:${by.actor_id}`;

/** Recounts a gate's open findings into findings_unresolved. */
export function recountFindings(ix: Internals, gateId: string): void {
  const open = all(
    ix,
    qb
      .selectFrom("findings")
      .select("id")
      .where("gate_id", "=", gateId)
      .where("status", "=", "open"),
  ).length;
  all(
    ix,
    qb
      .updateTable("gates")
      .set({ findings_unresolved: open })
      .where("id", "=", gateId)
      .returning("id"),
  );
}

/** The gate settings, read inside the caller's transaction. */
export function gateSettingsIn(ix: Internals): Result<GateSettings> {
  const rows = all(
    ix,
    qb
      .selectFrom("settings")
      .select(["key", "value_json"])
      .where("key", "in", Object.values(GATE_SETTING_KEYS)),
  );
  const parsed = new Map<string, unknown>();
  for (const { key, value_json } of rows) {
    try {
      parsed.set(key, JSON.parse(value_json) as unknown);
    } catch {
      return err(failure("validation", `setting ${key} is not JSON`));
    }
  }
  return readGateSettings(parsed);
}
