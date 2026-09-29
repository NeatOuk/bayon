import { err, newId, ok, type JsonValue, type Result } from "@bayon/core";
import type { ExpressionBuilder, Insertable, Updateable } from "kysely";
import { z } from "zod";
import {
  all,
  first,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { capture, failure, orNotFound } from "../errors.js";
import type { DB, SessionRow } from "../schema.js";
import type { HandoffRow, HandoffsTable } from "../schema-work.js";
import { audited, type AuditEntry } from "./audit.js";
import { casSession, ENDED_STATES, type SessionCas } from "./sessions.js";
import { insertTicketEvent } from "./ticket-common.js";

// Hand-off rows (§7, §8). The supervisor writes the facts columns
// (insertHandoffFacts, sealHandoff, finalizeHandoffPacket), each audited in ticket_events with
// actor_kind='supervisor' (M2 rule 2); the API writes the judgement columns (writeHandoffJudgement)
// and, the accept columns. The three sets partition the table (handoffs.test.ts).

export const HANDOFF_FACT_COLUMNS = [
  "id",
  "ticket_id",
  "from_session_id",
  "reason",
  "phase_from",
  "phase_to",
  "facts_json",
  "quality",
  "packet_path",
  "packet_hash",
  "tokens_est",
  "created_at",
] as const satisfies readonly (keyof HandoffsTable)[];

export const HANDOFF_JUDGEMENT_COLUMNS = [
  "goal_line",
  "decisions_md",
  "traps_md",
  "next_steps_md",
  "open_questions_md",
  "pointers_json",
] as const satisfies readonly (keyof HandoffsTable)[];

export const HANDOFF_ACCEPT_COLUMNS = [
  "accepted_at",
  "to_session_id",
] as const satisfies readonly (keyof HandoffsTable)[];

type FactColumn = (typeof HANDOFF_FACT_COLUMNS)[number];
/** The supervisor's writes are typed to the facts columns: a crossed write does not compile. */
type FactInsert = Pick<Insertable<HandoffsTable>, FactColumn>;
type FactPatch = Pick<Updateable<HandoffsTable>, FactColumn>;
type JudgementPatch = Pick<
  Updateable<HandoffsTable>,
  (typeof HANDOFF_JUDGEMENT_COLUMNS)[number]
>;

/**
 * Pending: not accepted and not being written. The one predicate: every read
 * that lists or takes pending hand-offs uses it, and v_needs_attention's arm (005) is its SQL twin.
 */
export const wherePendingHandoff = (eb: ExpressionBuilder<DB, "handoffs">) =>
  eb.and([
    eb("handoffs.accepted_at", "is", null),
    eb("handoffs.quality", "<>", "writing"),
  ]);

/** What rendering a packet gives its row: the path, the hash of its bytes, its size. */
export interface RenderedPacket {
  readonly packet_path: string;
  readonly packet_hash: string;
  readonly tokens_est: number;
}

type AuditStep = "begin" | "degraded" | "seal" | "finalize";

/** The supervisor's audit row for a hand-off write, in the writer's transaction (rule 2). */
function auditHandoff(
  ix: Internals,
  row: HandoffRow,
  step: AuditStep,
  extra: Readonly<Record<string, JsonValue>> = {},
): void {
  insertTicketEvent(ix, {
    ticket_id: row.ticket_id,
    ts: ix.clock.now(),
    actor_kind: "supervisor",
    actor_id: row.from_session_id,
    kind: "handoff",
    from_status: null,
    to_status: null,
    reason: row.reason,
    payload_json: JSON.stringify({
      handoff_id: row.id,
      step,
      quality: row.quality,
      packet_path: row.packet_path,
      ...extra,
    }),
  });
}

/** Runs a render inside a transaction: a throw becomes an error, and rolls it back. */
const rendered = <T>(fn: () => T): Result<T> => capture(fn);

export interface NewHandoffFacts {
  readonly ticket_id: string;
  readonly from_session_id: string;
  readonly reason: string;
  readonly phase_from: string | null;
  readonly phase_to: string | null;
  readonly facts_json: string;
  /** `writing` for a hand-off being written (with `begin`); `degraded` for one synthesized final. */
  readonly quality: "writing" | "degraded";
  /**
   * Renders hand-off `n`'s packet (row `id`, which its header shows) inside the transaction; the
   * caller writes the file after commit.
   */
  readonly render: (n: number, id: string) => RenderedPacket;
  /** beginHandoff's compare-and-set, taken in the same transaction (its patch gains handoff_out_id). */
  readonly begin?: SessionCas;
}

export interface InsertedHandoff {
  readonly row: HandoffRow;
  /** False: the session already had its row, which is returned and nothing is written. */
  readonly created: boolean;
  /** The ticket's hand-off number: `.foreman/handoff-<n>.md`. */
  readonly n: number;
}

/**
 * Inserts the facts half of a hand-off, with its packet rendered in the same transaction so the
 * ticket's hand-off number `n` cannot race. Idempotent per session: one row per from-session.
 * The session's `handoff_out_id` points at it, set by `begin`'s compare-and-set or directly.
 */
export async function insertHandoffFacts(
  db: Db,
  h: NewHandoffFacts,
): R<InsertedHandoff> {
  const facts = checkFacts(h.facts_json);
  if (!facts.ok) return facts;
  return write<InsertedHandoff>(db, (ix) => {
    const existing = first(
      ix,
      qb
        .selectFrom("handoffs")
        .selectAll()
        .where("from_session_id", "=", h.from_session_id)
        .orderBy("created_at")
        .orderBy("id"),
    );
    if (existing !== undefined) {
      return ok({ row: existing, created: false, n: packetNumberOf(existing) });
    }
    const counted = first(
      ix,
      qb
        .selectFrom("handoffs")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("ticket_id", "=", h.ticket_id),
    );
    const n = (counted?.count ?? 0) + 1;
    const now = ix.clock.now();
    const id = newId(now);
    const packet = rendered(() => h.render(n, id));
    if (!packet.ok) return packet;
    const linked = linkSession(ix, h, id);
    if (!linked.ok) return linked;
    const values: FactInsert = {
      id,
      ticket_id: h.ticket_id,
      from_session_id: h.from_session_id,
      reason: h.reason,
      phase_from: h.phase_from,
      phase_to: h.phase_to,
      facts_json: h.facts_json,
      quality: h.quality,
      packet_path: packet.value.packet_path,
      packet_hash: packet.value.packet_hash,
      tokens_est: packet.value.tokens_est,
      created_at: now,
    };
    const row = returningOne(
      ix,
      qb.insertInto("handoffs").values(values).returningAll(),
    );
    if (!row.ok) return row;
    auditHandoff(ix, row.value, h.begin === undefined ? "degraded" : "begin", {
      n,
    });
    return ok({ row: row.value, created: true, n });
  });
}

/** Points the session at its new row: through begin's compare-and-set, else directly. */
function linkSession(
  ix: Internals,
  h: NewHandoffFacts,
  id: string,
): Result<void> {
  if (h.begin !== undefined) {
    const moved = casSession(ix, h.from_session_id, {
      ...h.begin,
      patch: { ...h.begin.patch, handoff_out_id: id },
    });
    return moved.ok ? ok(undefined) : moved;
  }
  const row = first(
    ix,
    qb
      .updateTable("sessions")
      .set({ handoff_out_id: id })
      .where("id", "=", h.from_session_id)
      .returning("id"),
  );
  return row === undefined
    ? err(failure("not_found", `session ${h.from_session_id} does not exist`))
    : ok(undefined);
}

const PACKET_NUMBER = /handoff-(\d+)\.md$/;
/** A row's hand-off number `n`, from its packet path (`.foreman/handoff-<n>.md`); 0 for none. */
export const packetNumberOf = (row: Pick<HandoffRow, "packet_path">): number =>
  Number(PACKET_NUMBER.exec(row.packet_path)?.[1] ?? 0);

function checkFacts(json: string): Result<void> {
  try {
    JSON.parse(json);
    return ok(undefined);
  } catch {
    return err(failure("validation", "facts_json is not JSON"));
  }
}

export interface SealHandoff {
  readonly session_id: string;
  /** handOff (handoff_writing → handed_off): taken when the judgement is in and nothing failed. */
  readonly handOff: SessionCas;
  /** handoffFail (handoff_writing → exited): taken otherwise. */
  readonly handoffFail: SessionCas;
  /** The run failed or hit a cap: the packet is degraded whatever the judgement. */
  readonly failed: boolean;
}

export interface Sealed {
  readonly session: SessionRow;
  /** The row as sealed: its judgement can no longer change (the API's write needs handoff_writing). */
  readonly handoff: HandoffRow;
  readonly judged: boolean;
  readonly handedOff: boolean;
}

/**
 * The seal: reads the session's hand-off row and takes handOff or
 * handoffFail in one transaction, so a judgement committed first is in and a later one is refused.
 */
export async function sealHandoff(db: Db, s: SealHandoff): R<Sealed> {
  return write(db, (ix) => {
    const handoff = sessionHandoff(ix, s.session_id);
    if (!handoff.ok) return handoff;
    const h = handoff.value;
    const judged = h.goal_line !== null && h.next_steps_md !== null;
    const handedOff = judged && !s.failed;
    const moved = casSession(
      ix,
      s.session_id,
      handedOff ? s.handOff : s.handoffFail,
    );
    if (!moved.ok) return moved;
    auditHandoff(ix, h, "seal", {
      edge: handedOff ? "handOff" : "handoffFail",
    });
    return ok({ session: moved.value, handoff: h, judged, handedOff });
  });
}

function sessionHandoff(ix: Internals, sessionId: string): Result<HandoffRow> {
  const s = first(
    ix,
    qb
      .selectFrom("sessions")
      .select("handoff_out_id")
      .where("id", "=", sessionId),
  );
  const id = s?.handoff_out_id ?? null;
  const row =
    id === null
      ? undefined
      : first(ix, qb.selectFrom("handoffs").selectAll().where("id", "=", id));
  return row === undefined
    ? err(failure("not_found", `session ${sessionId} has no hand-off row`))
    : ok(row);
}

export interface FinalizeHandoff {
  readonly id: string;
  readonly facts_json: string;
  readonly quality: "full" | "degraded";
  /** Renders the packet from the row as sealed, with the new facts and quality, in the transaction. */
  readonly render: (row: HandoffRow) => RenderedPacket;
}

/**
 * Finalizes a `writing` row: fresh facts, its quality and the packet's hash. Matches no row once
 * accepted, or once finalized, so a late finalize never rewrites a packet a successor took.
 */
export async function finalizeHandoffPacket(
  db: Db,
  f: FinalizeHandoff,
): R<HandoffRow> {
  const facts = checkFacts(f.facts_json);
  if (!facts.ok) return facts;
  return write(db, (ix) => {
    const h = first(
      ix,
      qb
        .selectFrom("handoffs")
        .selectAll()
        .where("id", "=", f.id)
        .where("accepted_at", "is", null)
        .where("quality", "=", "writing"),
    );
    if (h === undefined) {
      return err(
        failure(
          "conflict",
          `hand-off ${f.id} is not being written, or was accepted`,
        ),
      );
    }
    const packet = rendered(() =>
      f.render({ ...h, facts_json: f.facts_json, quality: f.quality }),
    );
    if (!packet.ok) return packet;
    const patch: FactPatch = {
      facts_json: f.facts_json,
      quality: f.quality,
      packet_hash: packet.value.packet_hash,
      tokens_est: packet.value.tokens_est,
    };
    const row = returningOne(
      ix,
      qb
        .updateTable("handoffs")
        .set(patch)
        .where("id", "=", f.id)
        .where("accepted_at", "is", null)
        .returningAll(),
    );
    if (!row.ok) return row;
    auditHandoff(ix, row.value, "finalize");
    return ok(row.value);
  });
}

const text = (max: number) => z.string().trim().min(1).max(max);
const HandoffJudgement = z.strictObject({
  goal_line: text(200),
  decisions_md: text(4_000).nullable(),
  traps_md: text(4_000).nullable(),
  next_steps_md: text(2_000),
  open_questions_md: text(2_000).nullable(),
  pointers: z.array(text(300)).max(10),
});
export type HandoffJudgement = z.input<typeof HandoffJudgement>;

/**
 * The API's judgement write (handoff_write): the session's own `writing` row, and only
 * while the session is in handoff_writing. Any edge out of that state is the seal, so a write that
 * loses the race is `conflict` (handoff_not_writable) and changes nothing.
 */
export async function writeHandoffJudgement(
  db: Db,
  sessionId: string,
  j: HandoffJudgement,
  /** An MCP write's audit entry, committed in the same transaction. */
  audit?: AuditEntry,
): R<HandoffRow> {
  const parsed = HandoffJudgement.safeParse(j);
  if (!parsed.success) {
    return err(failure("validation", z.prettifyError(parsed.error)));
  }
  const v = parsed.data;
  return write(db, (ix) => {
    const s = first(
      ix,
      qb
        .selectFrom("sessions")
        .select(["state", "handoff_out_id"])
        .where("id", "=", sessionId),
    );
    const notWritable = err(
      failure(
        "conflict",
        `handoff_not_writable: session ${sessionId} is not writing a hand-off`,
      ),
    );
    if (s === undefined) {
      return err(failure("not_found", `session ${sessionId} does not exist`));
    }
    if (s.state !== "handoff_writing" || s.handoff_out_id === null) {
      return notWritable;
    }
    const patch: JudgementPatch = {
      goal_line: v.goal_line,
      decisions_md: v.decisions_md,
      traps_md: v.traps_md,
      next_steps_md: v.next_steps_md,
      open_questions_md: v.open_questions_md,
      pointers_json: JSON.stringify(v.pointers),
    };
    const row = first(
      ix,
      qb
        .updateTable("handoffs")
        .set(patch)
        .where("id", "=", s.handoff_out_id)
        .where("quality", "=", "writing")
        .returningAll(),
    );
    return row === undefined ? notWritable : audited(ix, ok(row), audit);
  });
}

export async function getHandoff(db: Db, id: string): R<HandoffRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("handoffs").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `hand-off ${id}`);
}

/** Pending hand-offs (wherePendingHandoff), oldest first; one ticket's when `ticketId` is given. */
export function listPendingHandoffs(
  db: Db,
  ticketId?: string,
): R<HandoffRow[]> {
  return read(db, (ix) => {
    const pending = qb
      .selectFrom("handoffs")
      .selectAll()
      .where(wherePendingHandoff);
    return all(
      ix,
      (ticketId === undefined
        ? pending
        : pending.where("ticket_id", "=", ticketId)
      )
        .orderBy("created_at")
        .orderBy("id"),
    );
  });
}

export interface HandoffQuery {
  readonly ticketId?: string;
  /** Only the takeable ones (wherePendingHandoff). */
  readonly pending?: boolean;
  readonly limit: number;
}

export interface HandoffPage {
  readonly rows: HandoffRow[];
  readonly hasMore: boolean;
}

/** Hand-offs oldest first: a ticket's chain, or with `pending` the queue; at most `limit`. */
export async function listHandoffs(db: Db, q: HandoffQuery): R<HandoffPage> {
  const rows = await read(db, (ix) => {
    const every = qb.selectFrom("handoffs").selectAll();
    const own =
      q.ticketId === undefined
        ? every
        : every.where("ticket_id", "=", q.ticketId);
    const shown = q.pending === true ? own.where(wherePendingHandoff) : own;
    return all(
      ix,
      shown
        .orderBy("created_at")
        .orderBy("id")
        .limit(q.limit + 1),
    );
  });
  if (!rows.ok) return rows;
  return ok({
    rows: rows.value.slice(0, q.limit),
    hasMore: rows.value.length > q.limit,
  });
}

export type StrandedHandoff = HandoffRow & { readonly session_state: string };

/**
 * `writing` rows whose session has ended: sealed but never finalized, as a crash between the two
 * leaves them. The reconciler finalizes them.
 */
export function listStrandedHandoffs(db: Db): R<StrandedHandoff[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("handoffs")
        .innerJoin("sessions", "sessions.id", "handoffs.from_session_id")
        .selectAll("handoffs")
        .select("sessions.state as session_state")
        .where("handoffs.quality", "=", "writing")
        .where("sessions.state", "in", ENDED_STATES)
        .orderBy("handoffs.created_at")
        .orderBy("handoffs.id"),
    ),
  );
}
