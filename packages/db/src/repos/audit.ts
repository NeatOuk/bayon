// audit_log is API-written: operator REST writes and
// MCP session writes. `insertAudit` runs inside another API writer's transaction, so a write and
// its audit row commit together; `appendAudit` stands alone, for a refused attempt.
import { err, ok, type JsonValue, type Result } from "@bayon/core";
import {
  qb,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { auditWorkspace } from "./audit-scope.js";

export interface AuditEntry {
  /** Who acted, e.g. `session:<id>` or `operator`. */
  readonly actor: string;
  /** What, e.g. `mcp.human_ask`. */
  readonly action: string;
  readonly target_kind?: string | null;
  readonly target_id?: string | null;
  /** Facts about the attempt (a digest, never a body); stored as JSON. */
  readonly payload?: JsonValue;
}

function checkEntry(e: AuditEntry): Result<void> {
  if (e.actor.trim() === "") {
    return err(failure("validation", "an audit entry needs an actor"));
  }
  if (e.action.trim() === "") {
    return err(failure("validation", "an audit entry needs an action"));
  }
  return ok(undefined);
}

/**
 * One audit row, stamped now and with the project it is about (audit-scope.ts), inside
 * the caller's write transaction.
 */
export function insertAudit(
  ix: Internals,
  e: AuditEntry,
): Result<{ readonly id: number }> {
  const checked = checkEntry(e);
  if (!checked.ok) return checked;
  return returningOne(
    ix,
    qb
      .insertInto("audit_log")
      .values({
        ts: ix.clock.now(),
        actor: e.actor,
        action: e.action,
        target_kind: e.target_kind ?? null,
        target_id: e.target_id ?? null,
        payload_json:
          e.payload === undefined ? null : JSON.stringify(e.payload),
        workspace_id: auditWorkspace(ix, e),
      })
      .returning("id"),
  );
}

/** One audit row in its own transaction: a refused attempt, which wrote nothing else. */
export function appendAudit(db: Db, e: AuditEntry): R<{ readonly id: number }> {
  return write(db, (ix) => insertAudit(ix, e));
}

/**
 * A write's result with its audit entry, inside the same transaction: an entry that cannot be
 * written fails the result, and write() then rolls both back.
 */
export function audited<T>(
  ix: Internals,
  written: Result<T>,
  audit: AuditEntry | undefined,
): Result<T> {
  if (!written.ok || audit === undefined) return written;
  const entry = insertAudit(ix, audit);
  return entry.ok ? written : entry;
}
