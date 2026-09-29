import { err, type Result } from "@bayon/core";
import type { Insertable } from "kysely";
import { check } from "../checks.js";
import { execute, first, qb, type Internals } from "../connection.js";
import { failure } from "../errors.js";
import type { TicketEventsTable } from "../schema-work.js";

// What the ticket writers share: the actor every write records, the columns no caller may set,
// and the version compare-and-set miss.

/** Who made a ticket write; every one records it in ticket_events (§3.2). */
export interface TicketActor {
  /** e.g. 'operator', 'session', 'orchestrator', 'system'. */
  readonly actor_kind: string;
  /** The session id, operator name…; null when the kind says it all. */
  readonly actor_id: string | null;
  readonly reason?: string;
}

/** Set by the writers only: the key, the number, the CAS version and the timestamps. */
const MANAGED = ["id", "num", "version", "created_at", "updated_at"] as const;
/** Derived in v_ticket_economics, so nothing writes them (M1 amendment 9). */
const DERIVED = [
  "cost_usd",
  "cost_wasted_usd",
  "review_rounds",
  "handoff_count",
] as const;
export type LockedColumn = (typeof MANAGED)[number] | (typeof DERIVED)[number];

/** A validation error if `row` sets a locked column, or one of `also` (e.g. status). */
export function checkColumns(
  row: object,
  what: string,
  also: readonly string[] = [],
): Result<void> {
  const locked = new Set<string>([...MANAGED, ...DERIVED, ...also]);
  const bad = Object.keys(row).filter((key) => locked.has(key));
  return check(bad.length === 0, `${what} may not set ${bad.join(", ")}`);
}

export const checkActor = (by: TicketActor): Result<void> =>
  check(by.actor_kind.trim().length > 0, "actor_kind is empty");

export const checkVersion = (version: number): Result<void> =>
  check(
    Number.isInteger(version) && version >= 1,
    `version must be an integer >= 1, not ${version}`,
  );

/** The ticket_events columns an actor fills. */
export const actorColumns = (by: TicketActor) => ({
  actor_kind: by.actor_kind,
  actor_id: by.actor_id,
  reason: by.reason ?? null,
});

/** Appends one ticket_events row inside the caller's write transaction. */
export function insertTicketEvent(
  ix: Internals,
  row: Insertable<TicketEventsTable>,
): void {
  execute(ix, qb.insertInto("ticket_events").values(row));
}

/**
 * Why a version compare-and-set matched no row: the ticket is missing, or it is at another
 * version, which the conflict carries as `current_version` (contract 3's 409 body).
 */
export function versionMiss(
  ix: Internals,
  id: string,
  expected: number,
): Result<never> {
  const current = first(
    ix,
    qb.selectFrom("tickets").select("version").where("id", "=", id),
  );
  return err(
    current === undefined
      ? failure("not_found", `ticket ${id} does not exist`)
      : failure(
          "conflict",
          `ticket ${id} is at version ${current.version}, not ${expected}`,
          { current_version: current.version },
        ),
  );
}
