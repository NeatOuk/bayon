import { createHash } from "node:crypto";
import {
  NOT_A_QUESTION_KIND,
  canonicalJson,
  normalizeQuestion,
  ok,
  type Result,
} from "@bayon/core";
import { sql } from "kysely";
import {
  all,
  first,
  qb,
  read,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { insertAudit } from "./audit.js";
import {
  actorColumns,
  insertTicketEvent,
  type TicketActor,
} from "./ticket-common.js";

// A ticket's questions to the operator: its open human requests of any kind but a
// staffing proposal. A question never blocks the session that asks it (§11.1); it holds the
// ticket. While one is open the ticket is not pulse work, a session's staffing is refused
// `awaiting_human`, and needs_human stays set; the answer that leaves none open clears it and
// wakes the orchestrator. These are the reads and in-transaction writes the API's writers share.

const OPEN = "open";
const DISMISSED = "dismissed";

/** The open questions on the ticket `ticketColumn` names (correlated; the ticket_id, status index). */
export const openQuestionOn = (ticketColumn: string) =>
  qb
    .selectFrom("human_requests as oq")
    .select("oq.id")
    .where("oq.ticket_id", "=", sql.ref<string>(ticketColumn))
    .where("oq.status", "=", OPEN)
    .where("oq.kind", "<>", NOT_A_QUESTION_KIND);

/**
 * The order questions were asked in: by asked_at, then by rowid, the order the rows went in. One
 * human_ask batch shares a millisecond, and a ULID's random suffix is not an order.
 */
const ASKED = sql`rowid`;

/** The ticket's open questions, oldest first, by id. */
export function openQuestionIds(ix: Internals, ticketId: string): string[] {
  return all(
    ix,
    qb
      .selectFrom("human_requests")
      .select("id")
      .where("ticket_id", "=", ticketId)
      .where("status", "=", OPEN)
      .where("kind", "<>", NOT_A_QUESTION_KIND)
      .orderBy("asked_at")
      .orderBy(ASKED),
  ).map((r) => r.id);
}

/** The digest a question's dedupe key carries: of its normalized text, 16 hex characters. */
export const questionDigest = (question: string): string =>
  createHash("sha256")
    .update(normalizeQuestion(question))
    .digest("hex")
    .slice(0, 16);

/**
 * Sets the ticket's needs_human to `to` when it is not already, bumping its version and writing an
 * `updated` ticket_event (fields `needs_human`) as `by`. True when it moved.
 */
function flagIn(
  ix: Internals,
  ticketId: string,
  to: 0 | 1,
  by: TicketActor,
): boolean {
  const now = ix.clock.now();
  const moved = first(
    ix,
    qb
      .updateTable("tickets")
      .set({
        needs_human: to,
        version: sql<number>`version + 1`,
        updated_at: now,
      })
      .where("id", "=", ticketId)
      .where("needs_human", "<>", to)
      .returning("id"),
  );
  if (moved === undefined) return false;
  insertTicketEvent(ix, {
    ticket_id: ticketId,
    ts: now,
    kind: "updated",
    ...actorColumns(by),
    payload_json: canonicalJson({ fields: ["needs_human"] }),
  });
  return true;
}

/** Asking raises the flag: the ticket now waits on the operator. */
export const raiseNeedsHumanIn = (
  ix: Internals,
  ticketId: string,
  by: TicketActor,
): boolean => flagIn(ix, ticketId, 1, by);

/** The answer that leaves the ticket no open question clears the flag; any other leaves it. */
export function clearNeedsHumanIfAnsweredIn(
  ix: Internals,
  ticketId: string,
  by: TicketActor,
): boolean {
  if (openQuestionIds(ix, ticketId).length > 0) return false;
  return flagIn(ix, ticketId, 0, by);
}

/** What staffing does about the ticket's questions (staffIn). */
export type QuestionHold =
  | { readonly kind: "free" }
  /** A session's call: refused `awaiting_human`, with this detail. */
  | { readonly kind: "wait"; readonly detail: string }
  /** The operator's call: it goes ahead, and a staffing that lands is audited. */
  | { readonly kind: "override"; readonly requestIds: readonly string[] };

const questionsText = (n: number): string =>
  n === 1 ? "1 open question" : `${n} open questions`;

/** Whether the ticket's open questions hold `by`'s staffing. Only the operator overrides. */
export function questionHold(
  ix: Internals,
  ticket: { readonly id: string; readonly num: number },
  by: TicketActor,
): QuestionHold {
  const ids = openQuestionIds(ix, ticket.id);
  if (ids.length === 0) return { kind: "free" };
  if (by.actor_kind === "operator")
    return { kind: "override", requestIds: ids };
  return {
    kind: "wait",
    detail: `ticket #${ticket.num} waits on ${questionsText(ids.length)} to the operator (${ids.join(", ")}): it is theirs until answered, and the last answer wakes you. Do not staff it, and do not ask its questions again.`,
  };
}

/** The operator staffed over open questions: one audit row, in the staffing's transaction. */
export function auditOverride(
  ix: Internals,
  o: {
    readonly ticketId: string;
    readonly by: TicketActor;
    readonly requestIds: readonly string[];
    readonly role: string;
    readonly commandId: string;
  },
): Result<void> {
  const row = insertAudit(ix, {
    actor: o.by.actor_id ?? o.by.actor_kind,
    action: "ticket.staff_override",
    target_kind: "ticket",
    target_id: o.ticketId,
    payload: {
      reason: "awaiting_human",
      request_ids: [...o.requestIds],
      role: o.role,
      command_id: o.commandId,
    },
  });
  return row.ok ? ok(undefined) : row;
}

/** One question on a ticket, as a session staffed onto it is told. */
export interface TicketQuestion {
  readonly id: string;
  readonly kind: string;
  readonly question: string;
  readonly status: string;
  /** The operator's answer as they wrote it; null while open. */
  readonly answer: string | null;
  readonly asked_at: number;
  readonly answered_at: number | null;
}

/** The questions a session's context lists: the newest this many. */
export const TICKET_QUESTIONS_SHOWN = 20;

/** answer_json holds the answer as JSON text (answerHumanRequest); anything else is shown as is. */
function answerText(json: string | null): string | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "string" ? value : json;
  } catch {
    return json;
  }
}

/**
 * The ticket's questions and answers, oldest first by when each was asked: the newest `limit` of
 * them. Every answer is there, in order, with its time, so a session can tell which came last. A
 * question the operator dismissed is left out: it is no longer relevant, and never an instruction.
 */
export async function listTicketQuestions(
  db: Db,
  ticketId: string,
  limit: number = TICKET_QUESTIONS_SHOWN,
): R<TicketQuestion[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("human_requests")
        .select([
          "id",
          "kind",
          "question",
          "status",
          "answer_json",
          "asked_at",
          "answered_at",
        ])
        .where("ticket_id", "=", ticketId)
        .where("kind", "<>", NOT_A_QUESTION_KIND)
        // A dismissed question was withdrawn by the operator: nothing for a session to act on.
        .where("status", "<>", DISMISSED)
        .orderBy("asked_at", "desc")
        .orderBy(ASKED, "desc")
        .limit(limit),
    )
      .toReversed()
      .map(({ answer_json, ...q }) => ({
        ...q,
        answer: answerText(answer_json),
      })),
  );
}

/**
 * Each of `ticketIds`' open questions, counted: the live number a ticket's "needs human"
 * badge reads, since the supervisor's own requests never write the flag. A ticket with none is 0.
 */
export async function openQuestionCounts(
  db: Db,
  ticketIds: readonly string[],
): R<ReadonlyMap<string, number>> {
  if (ticketIds.length === 0) return ok(new Map());
  return read(
    db,
    (ix) =>
      new Map(
        all(
          ix,
          qb
            .selectFrom("human_requests")
            .select("ticket_id")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("ticket_id", "in", [...ticketIds])
            .where("status", "=", OPEN)
            .where("kind", "<>", NOT_A_QUESTION_KIND)
            .groupBy("ticket_id"),
        ).flatMap((r) => (r.ticket_id === null ? [] : [[r.ticket_id, r.n]])),
      ),
  );
}
