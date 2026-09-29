import Database from "better-sqlite3";
import {
  err,
  ok,
  type ErrorClass,
  type FrmError,
  type Result,
} from "@bayon/core";

export const failure = (
  cls: ErrorClass,
  message: string,
  cause?: unknown,
): FrmError => ({
  class: cls,
  message,
  retryable: cls === "db_busy",
  ...(cause === undefined ? {} : { cause }),
});

/** Thrown inside a transaction so better-sqlite3 rolls it back; the write then returns `error`. */
export class Rollback extends Error {
  constructor(readonly error: FrmError) {
    super(error.message);
  }
}

const VALIDATION = new Set([
  "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT_NOTNULL",
  "SQLITE_CONSTRAINT_CHECK",
]);
const CONFLICT = new Set([
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
]);

function classify(code: string): ErrorClass {
  if (code.startsWith("SQLITE_BUSY")) return "db_busy";
  if (VALIDATION.has(code)) return "validation";
  if (CONFLICT.has(code)) return "conflict";
  return "internal";
}

/** Maps anything thrown below this package to an FrmError. */
export function toFrmError(thrown: unknown): FrmError {
  if (thrown instanceof Rollback) return thrown.error;
  if (thrown instanceof Database.SqliteError) {
    return failure(classify(thrown.code), thrown.message, {
      code: thrown.code,
    });
  }
  return failure(
    "internal",
    thrown instanceof Error ? thrown.message : String(thrown),
  );
}

/** Runs `fn`, returning what it throws as an error result. */
export function capture<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (thrown) {
    return err(toFrmError(thrown));
  }
}

/** A lookup's result, with a missing row as `not_found`. */
export function orNotFound<T>(
  found: Result<T | undefined>,
  what: string,
): Result<T> {
  if (!found.ok) return found;
  return found.value === undefined
    ? err(failure("not_found", `${what} does not exist`))
    : ok(found.value);
}

/** Why a compare-and-set matched no row: the row is missing, or it is in another state. */
export function casMiss(
  what: string,
  current: { readonly state: string } | undefined,
  expected: readonly string[],
): Result<never> {
  return err(
    current === undefined
      ? failure("not_found", `${what} does not exist`)
      : failure(
          "conflict",
          `${what} is ${current.state}, not ${expected.join(" | ")}`,
        ),
  );
}
