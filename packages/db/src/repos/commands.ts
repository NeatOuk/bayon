import {
  canonicalJson,
  err,
  newId,
  ok,
  type FrmError,
  type Result,
} from "@bayon/core";
import { sql, type Updateable } from "kysely";
import { z } from "zod";
import {
  all,
  execute,
  first,
  qb,
  read,
  readSnapshot,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { casMiss, failure, orNotFound } from "../errors.js";
import type { CommandRow, CommandsTable } from "../schema.js";
import { audited, insertAudit, type AuditEntry } from "./audit.js";

export interface NewCommand {
  readonly type: string;
  readonly payload: unknown;
  /** From the Idempotency-Key header. */
  readonly idempotencyKey?: string;
}

export type CompleteCommand =
  | { readonly state: "done"; readonly result?: unknown }
  | { readonly state: "failed"; readonly error: FrmError };

const Json = z.json();

/** Canonical JSON (sorted keys), so equal payloads compare equal as text. */
function toJson(value: unknown, what: string): Result<string> {
  const parsed = Json.safeParse(value);
  return parsed.success
    ? ok(canonicalJson(parsed.data))
    : err(
        failure(
          "validation",
          `${what} is not JSON: ${z.prettifyError(parsed.error)}`,
        ),
      );
}

/** An FrmError as JSON. A cause that is not JSON is left out rather than failing the write. */
function errorJson(e: FrmError): string {
  const cause = Json.safeParse(e.cause);
  return canonicalJson({
    class: e.class,
    message: e.message,
    retryable: e.retryable,
    ...(e.cause !== undefined && cause.success ? { cause: cause.data } : {}),
  });
}

/**
 * The API's one M0 writer (§9.5, amendment 10). A repeated idempotency key returns the first
 * command's id with `created: false`; the same key with another type or payload is a conflict.
 * An MCP tool's audit entry commits with it.
 */
export async function insertCommand(
  db: Db,
  c: NewCommand,
  audit?: AuditEntry,
): R<{ id: string; created: boolean }> {
  return write(db, (ix) => audited(ix, insertCommandIn(ix, c), audit));
}

/** insertCommand inside the caller's transaction (staffTicket's spawn commits with its move). */
export function insertCommandIn(
  ix: Internals,
  c: NewCommand,
): Result<{ id: string; created: boolean }> {
  if (c.type.length === 0)
    return err(failure("validation", "command type is empty"));
  const payload = toJson(c.payload, "payload");
  if (!payload.ok) return payload;
  if (c.idempotencyKey !== undefined) {
    const existing = first(
      ix,
      qb
        .selectFrom("commands")
        .select(["id", "type", "payload_json"])
        .where("idempotency_key", "=", c.idempotencyKey),
    );
    if (existing !== undefined) {
      return existing.type === c.type && existing.payload_json === payload.value
        ? ok({ id: existing.id, created: false })
        : err(
            failure(
              "conflict",
              `idempotency key ${c.idempotencyKey} was used for a different command`,
            ),
          );
    }
  }
  const now = ix.clock.now();
  const id = newId(now);
  execute(
    ix,
    qb.insertInto("commands").values({
      id,
      ts: now,
      type: c.type,
      payload_json: payload.value,
      idempotency_key: c.idempotencyKey ?? null,
      state: "pending",
      attempts: 0,
    }),
  );
  return ok({ id, created: true });
}

/**
 * Claims the oldest pending command, by (ts, id), and counts the attempt; null when none. With
 * `types`, only a command of one of those types: a supervisor still wiring its handlers leaves
 * the rest pending (an empty list claims nothing).
 */
export function claimCommand(
  db: Db,
  o: { readonly types?: readonly string[] } = {},
): R<CommandRow | null> {
  const { types } = o;
  if (types !== undefined && types.length === 0) {
    return Promise.resolve(ok(null));
  }
  return write(db, (ix) => {
    const pending = qb
      .selectFrom("commands")
      .select("id")
      .where("state", "=", "pending");
    const oldest = (
      types === undefined ? pending : pending.where("type", "in", [...types])
    )
      .orderBy("ts")
      .orderBy("id")
      .limit(1);
    const row = first(
      ix,
      qb
        .updateTable("commands")
        .set({
          state: "claimed",
          claimed_at: ix.clock.now(),
          attempts: sql<number>`coalesce(attempts, 0) + 1`,
        })
        .where("id", "=", oldest)
        .returningAll(),
    );
    return ok(row ?? null);
  });
}

function completion(o: CompleteCommand): Result<Updateable<CommandsTable>> {
  if (o.state === "failed")
    return ok({ state: "failed", error: errorJson(o.error) });
  if (o.result === undefined) return ok({ state: "done" });
  const result = toJson(o.result, "result");
  return result.ok ? ok({ state: "done", result_json: result.value }) : result;
}

/** Finishes a claimed command: a compare-and-set from `claimed` to `done` or `failed`. */
export async function completeCommand(
  db: Db,
  id: string,
  o: CompleteCommand,
): R<CommandRow> {
  const values = completion(o);
  if (!values.ok) return values;
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("commands")
        .set(values.value)
        .where("id", "=", id)
        .where("state", "=", "claimed")
        .returningAll(),
    );
    if (row !== undefined) return ok(row);
    const current = first(
      ix,
      qb.selectFrom("commands").select("state").where("id", "=", id),
    );
    return casMiss(`command ${id}`, current, ["claimed"]);
  });
}

/** What the reconciler hands requeueClaimedCommands. */
export interface RequeueClaimed {
  /** Claimed at or before this epoch ms; at boot, the ms before the new process's first claim. */
  readonly claimedBefore: number;
  /** Types whose handler is marked idempotent: only these go back to `pending`. */
  readonly idempotentTypes: readonly string[];
  /** Every registered type: any other type fails `unknown_command`, as the claimer would. */
  readonly knownTypes: readonly string[];
  /** Ids in flight in this process: never touched. */
  readonly exclude: readonly string[];
  /** reconciler.command_max_attempts: claims before an idempotent command is failed. */
  readonly maxAttempts: number;
  /** Why a non-idempotent command was not retried (boot and runtime say different things). */
  readonly why: string;
}

export interface Requeued {
  readonly requeued: readonly string[];
  readonly failed: readonly string[];
}

type RequeueOutcome =
  | { readonly state: "pending" }
  | { readonly state: "failed"; readonly error: FrmError };

/** One claimed row's fate: requeued, or failed with the reason it will not run again. */
export function requeueOutcome(
  row: { readonly type: string; readonly attempts: number | null },
  o: Pick<
    RequeueClaimed,
    "idempotentTypes" | "knownTypes" | "maxAttempts" | "why"
  >,
): RequeueOutcome {
  const attempts = row.attempts ?? 0;
  if (!o.knownTypes.includes(row.type)) {
    return {
      state: "failed",
      error: {
        class: "unknown_command",
        message: `no handler for command type ${row.type}`,
        retryable: false,
      },
    };
  }
  if (!o.idempotentTypes.includes(row.type)) {
    return {
      state: "failed",
      error: {
        class: "interrupted",
        message: `${o.why}; ${row.type} is not idempotent, so it was not retried`,
        retryable: true,
      },
    };
  }
  if (attempts >= o.maxAttempts) {
    return {
      state: "failed",
      error: {
        class: "interrupted",
        message: `claimed ${attempts} times without completing`,
        retryable: false,
        cause: { attempts },
      },
    };
  }
  return { state: "pending" };
}

/**
 * The supervisor's named writer for claimed commands (plan rule 2; the command requeue amendment):
 * each claimed row past `claimedBefore` and not in flight is requeued or failed, one audit row each,
 * in one transaction. A requeue keeps `attempts`: the next claim adds one.
 */
export async function requeueClaimedCommands(
  db: Db,
  o: RequeueClaimed,
): R<Requeued> {
  if (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1) {
    return err(
      failure(
        "validation",
        `maxAttempts must be an integer >= 1, not ${o.maxAttempts}`,
      ),
    );
  }
  if (o.why.trim() === "") {
    return err(failure("validation", "a requeue needs its why"));
  }
  const exclude = new Set(o.exclude);
  return write(db, (ix): Result<Requeued> => {
    const claimed = all(
      ix,
      qb
        .selectFrom("commands")
        .select(["id", "type", "attempts", "claimed_at"])
        .where("state", "=", "claimed")
        .orderBy("ts")
        .orderBy("id"),
    ).filter(
      (row) =>
        !exclude.has(row.id) &&
        (row.claimed_at === null || row.claimed_at <= o.claimedBefore),
    );
    const requeued: string[] = [];
    const failed: string[] = [];
    for (const row of claimed) {
      const fate = requeueOutcome(row, o);
      const values: Updateable<CommandsTable> =
        fate.state === "pending"
          ? { state: "pending", claimed_at: null }
          : { state: "failed", error: errorJson(fate.error) };
      execute(
        ix,
        qb
          .updateTable("commands")
          .set(values)
          .where("id", "=", row.id)
          .where("state", "=", "claimed"),
      );
      const entry = insertAudit(ix, {
        actor: "supervisor",
        action:
          fate.state === "pending" ? "command.requeued" : "command.abandoned",
        target_kind: "command",
        target_id: row.id,
        payload: {
          type: row.type,
          attempts: row.attempts ?? 0,
          ...(fate.state === "failed" ? { class: fate.error.class } : {}),
        },
      });
      if (!entry.ok) return entry;
      (fate.state === "pending" ? requeued : failed).push(row.id);
    }
    return ok({ requeued, failed });
  });
}

/** A command by id, for GET /commands/:id. */
export async function getCommand(db: Db, id: string): R<CommandRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("commands").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `command ${id}`);
}

/** A command and what the queue around it looked like at the read. */
export interface QueuedCommandRow {
  readonly row: CommandRow;
  /** The db's clock at the read: `now - ts` and `ts` are then two stamps from one clock. */
  readonly now: number;
  /**
   * The unsettled rows of the same type the claimer takes before this one, in that order.
   * Empty when it is settled.
   */
  readonly ahead: readonly CommandRow[];
}

/** The states a command is still in its type's queue in — said once, for the test and the query. */
const UNSETTLED_STATES = [
  "pending",
  "claimed",
] as const satisfies readonly CommandRow["state"][];

const unsettled = (state: CommandRow["state"]): boolean =>
  (UNSETTLED_STATES as readonly string[]).includes(state);

/**
 * The unsettled commands of `of`'s type the claimer takes before it, in that order: `ts`, then
 * `id`. Not arrival order — two commands minted in the same millisecond are ordered by id alone,
 * and ids come from a stateless ULID mint (core id.ts). A settled command has none: it is no
 * longer in any queue.
 */
function aheadOf(ix: Internals, of: CommandRow): CommandRow[] {
  if (!unsettled(of.state)) return [];
  return all(
    ix,
    qb
      .selectFrom("commands")
      .selectAll()
      .where("type", "=", of.type)
      .where("state", "in", [...UNSETTLED_STATES])
      .where((eb) =>
        eb.or([
          eb("ts", "<", of.ts),
          eb.and([eb("ts", "=", of.ts), eb("id", "<", of.id)]),
        ]),
      )
      .orderBy("ts")
      .orderBy("id"),
  );
}

/**
 * GET /commands/:id with the queue facts an operator needs to tell a slow run from a wedged one
 *: the clock the row's timestamps were written against, and what is queued ahead of
 * it. One snapshot, so the three answers describe the same instant: read outside a transaction
 * each statement opens its own, and the supervisor claiming between them would show a pending row
 * with nothing ahead of it — "nobody has picked it up" for a run already going.
 */
export async function getCommandQueued(
  db: Db,
  id: string,
): R<QueuedCommandRow> {
  const found = await readSnapshot(db, (ix) => {
    const row = first(
      ix,
      qb.selectFrom("commands").selectAll().where("id", "=", id),
    );
    return row === undefined
      ? undefined
      : { row, now: ix.clock.now(), ahead: aheadOf(ix, row) };
  });
  return orNotFound(found, `command ${id}`);
}

/**
 * The command an idempotency key created, or null. A repeated POST /sessions mints a fresh
 * session_id, so insertCommand would report a conflict; the API looks the key up first.
 */
export async function getCommandByIdempotencyKey(
  db: Db,
  key: string,
): R<CommandRow | null> {
  if (key.length === 0) {
    return err(failure("validation", "idempotency key is empty"));
  }
  const found = await read(db, (ix) =>
    first(
      ix,
      qb.selectFrom("commands").selectAll().where("idempotency_key", "=", key),
    ),
  );
  return found.ok ? ok(found.value ?? null) : found;
}
