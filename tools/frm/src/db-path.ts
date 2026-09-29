// The database frm writes itself: $FRM_DB, else $FRM_HOME/foreman.db, and only a file already there,
// so a wrong path never creates an empty database. `frm pause|resume`'s fallback and `frm agent set`.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { err, ok, type Result } from "@bayon/core";

/** The path, or a validation error naming why there is none. `what` says what it is for. */
export function dbPathOf(
  env: Readonly<Record<string, string | undefined>>,
  what = "the database to write",
): Result<string> {
  const db = env["FRM_DB"];
  const home = env["FRM_HOME"];
  const path =
    db !== undefined && db !== ""
      ? resolve(db)
      : home !== undefined && home !== ""
        ? resolve(join(home, "foreman.db"))
        : null;
  if (path === null) {
    return err({
      class: "validation",
      message: `set FRM_HOME (or FRM_DB): ${what}`,
      retryable: false,
    });
  }
  return existsSync(path)
    ? ok(path)
    : err({
        class: "validation",
        message: `no database at ${path}`,
        retryable: false,
      });
}
