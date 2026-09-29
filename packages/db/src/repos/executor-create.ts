import { ok, type JsonValue, type Result } from "@bayon/core";
import type { Insertable } from "kysely";
import { execute, qb, write, type Db, type R } from "../connection.js";
import type { ExecutorsTable } from "../schema.js";
import { insertAudit } from "./audit.js";

// `createExecutor` (§9.5 amendment): `POST /executors`'s one writer, exported from
// `@bayon/db/api` only — the second, narrower carve-out alongside `createProject`.
// Exactly one `executors` row, insert-only, in one transaction with its `executor.create` audit
// row — never `executors.untrusted_roles` (a global policy, unlike one row; the CLI's alone),
// never a `run_class`, never any other setting. Not built on `seedConfig`, for the same reason
// `createProject` isn't: `ConfigRows` names tables this door may never write.

export interface NewExecutor {
  /** The audit row's `target_id`, and `row.id`. */
  readonly id: string;
  readonly host: string;
  readonly user: string;
  readonly network: string;
  readonly slots: number;
  readonly row: Insertable<ExecutorsTable>;
}

/** `executor.create`'s audit payload — never `identity_ref` or anything that hints at key location. */
function auditPayload(p: NewExecutor): JsonValue {
  return {
    via: "rest",
    host: p.host,
    user: p.user,
    network: p.network,
    slots: p.slots,
  };
}

/**
 * Writes one executor row and its `executor.create` audit row, in one transaction. A repeated id
 * is `conflict` (the table's own primary key), the same way a repeated repo id is for
 * `createProject` — no separate pre-check, and nothing is written either way.
 */
export function createExecutor(db: Db, p: NewExecutor): R<void> {
  return write(db, (ix) => {
    execute(ix, qb.insertInto("executors").values(p.row));
    const audit = insertAudit(ix, {
      actor: "operator",
      action: "executor.create",
      target_kind: "executor",
      target_id: p.id,
      payload: auditPayload(p),
    });
    return audit.ok ? ok(undefined) : (audit as Result<void>);
  });
}
