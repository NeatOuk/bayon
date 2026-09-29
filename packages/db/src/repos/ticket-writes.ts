import {
  canonicalJson,
  err,
  lawRefused,
  needsHumanHeld,
  newId,
  ok,
  type Result,
} from "@bayon/core";
import type { Insertable, Updateable } from "kysely";
import { allOk, definedKeys } from "../checks.js";
import {
  first,
  qb,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { TicketRow, TicketsTable } from "../schema.js";
import {
  actorColumns,
  checkActor,
  checkColumns,
  checkVersion,
  insertTicketEvent,
  versionMiss,
  type LockedColumn,
  type TicketActor,
} from "./ticket-common.js";
import { audited, type AuditEntry } from "./audit.js";
import { openQuestionIds } from "./open-questions.js";

// The API's ticket writers (§9.5, contract 1): create and compare-and-set update. Status moves
// only through transitionTicket (ticket-transition.ts). No laws here, those are the caller's, but
// one: needs_human is not cleared while a question is open (core needsHumanHeld), judged
// over the count this transaction reads, so a question asked mid-PATCH cannot slip past it.

export type { TicketActor } from "./ticket-common.js";

/** A new ticket: every column but the writer's own and amendment 9's derived ones. */
export type NewTicket = Omit<Insertable<TicketsTable>, LockedColumn>;

/** Columns a compare-and-set update may change. Not status: that is a transition. */
export type TicketPatch = Omit<
  Updateable<TicketsTable>,
  LockedColumn | "status"
>;

export interface TicketUpdate {
  readonly id: string;
  /** The version the caller read (If-Match). */
  readonly version: number;
  readonly patch: TicketPatch;
  readonly by: TicketActor;
}

/**
 * createTicket's insert inside the caller's transaction (the Jira mirror files a page of tickets in
 * one): the checks, the row numbered max(num) + 1 at version 1, and its `created` ticket_event.
 */
export function createTicketIn(
  ix: Internals,
  t: NewTicket,
  by: TicketActor,
): Result<TicketRow> {
  const checked = allOk(checkColumns(t, "a new ticket"), checkActor(by));
  if (!checked.ok) return checked;
  const now = ix.clock.now();
  const top = first(
    ix,
    qb
      .selectFrom("tickets")
      .select((eb) => eb.fn.max<number | null>("num").as("num")),
  );
  const row = returningOne(
    ix,
    qb
      .insertInto("tickets")
      .values({
        ...t,
        id: newId(now),
        num: (top?.num ?? 0) + 1,
        version: 1,
        created_at: now,
        updated_at: now,
      })
      .returningAll(),
  );
  if (!row.ok) return row;
  insertTicketEvent(ix, {
    ticket_id: row.value.id,
    ts: now,
    kind: "created",
    to_status: row.value.status,
    ...actorColumns(by),
  });
  return row;
}

/**
 * Files a ticket numbered max(num) + 1 at version 1, with a `created` ticket_event naming its
 * actor, in one transaction. BEGIN IMMEDIATE takes the write lock first, so two creates never
 * read the same max.
 */
export async function createTicket(
  db: Db,
  t: NewTicket,
  by: TicketActor,
  /** An MCP write's audit entry, committed with the ticket; its target is the new ticket. */
  audit?: AuditEntry,
): R<TicketRow> {
  const checked = allOk(checkColumns(t, "a new ticket"), checkActor(by));
  if (!checked.ok) return checked;
  return write(db, (ix) => {
    const row = createTicketIn(ix, t, by);
    return audited(
      ix,
      row,
      audit === undefined || !row.ok
        ? undefined
        : { ...audit, target_kind: "ticket", target_id: row.value.id },
    );
  });
}

/** A patch's checks: it changes something, never status, at a real version, by someone. */
function checkUpdate(u: TicketUpdate): Result<readonly string[]> {
  const fields = definedKeys(u.patch);
  const checked = allOk(
    fields.length > 0
      ? checkColumns(u.patch, "a ticket patch", ["status"])
      : err(failure("validation", "the patch changes nothing")),
    checkVersion(u.version),
    checkActor(u.by),
  );
  return checked.ok ? ok(fields) : checked;
}

/**
 * updateTicketCas's compare-and-set inside the caller's transaction (the Jira mirror): the checks,
 * the patch at `version` with its bump, and the `updated` ticket_event listing the changed fields.
 */
export function updateTicketIn(
  ix: Internals,
  u: TicketUpdate,
): Result<TicketRow> {
  const fields = checkUpdate(u);
  if (!fields.ok) return fields;
  if (u.patch.needs_human === 0) {
    const held = needsHumanHeld(openQuestionIds(ix, u.id).length);
    if (held !== null) return err(lawRefused(held));
  }
  const now = ix.clock.now();
  const row = first(
    ix,
    qb
      .updateTable("tickets")
      .set({ ...u.patch, version: u.version + 1, updated_at: now })
      .where("id", "=", u.id)
      .where("version", "=", u.version)
      .returningAll(),
  );
  if (row === undefined) return versionMiss(ix, u.id, u.version);
  insertTicketEvent(ix, {
    ticket_id: u.id,
    ts: now,
    kind: "updated",
    ...actorColumns(u.by),
    payload_json: canonicalJson({ fields: fields.value.toSorted() }),
  });
  return ok(row);
}

/**
 * Applies `patch` if the ticket is still at `version`, bumping it, and records an `updated`
 * ticket_event listing the changed fields, in one transaction. A miss is `not_found`, or a
 * `conflict` carrying `current_version`.
 */
export async function updateTicketCas(
  db: Db,
  u: TicketUpdate,
  /** An MCP write's audit entry, committed in the same transaction. */
  audit?: AuditEntry,
): R<TicketRow> {
  const checked = checkUpdate(u);
  if (!checked.ok) return checked;
  return write(db, (ix) => audited(ix, updateTicketIn(ix, u), audit));
}
