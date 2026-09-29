import Database from "better-sqlite3";
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import { read, type Db, type R } from "../connection.js";
import { capture, failure } from "../errors.js";

// The SQL a backup and a restore need (§13.2, §14). A snapshot is VACUUM INTO: one read
// transaction, so the copy is consistent while the supervisor keeps writing (WAL). better-sqlite3
// runs it synchronously, so the event loop waits for it: seconds for a large database, nightly.

/**
 * Writes a consistent copy of `db` to `path`. `path` must not exist or be an empty file; the
 * caller creates it empty at mode 0600 first, so the plaintext copy is never world-readable.
 */
export async function snapshotInto(db: Db, path: string): R<void> {
  return read(db, (ix) => {
    ix.raw.prepare("VACUUM INTO ?").run(path);
  });
}

const IntegrityRows = z.array(z.object({ integrity_check: z.string() }));

/** SQLite's integrity check: `["ok"]` when the file is sound, else what it found (at most 100). */
export async function checkIntegrity(db: Db): R<readonly string[]> {
  const rows = await read(db, (ix) => ix.raw.pragma("integrity_check"));
  if (!rows.ok) return rows;
  const parsed = IntegrityRows.safeParse(rows.value);
  return parsed.success
    ? ok(parsed.data.map((r) => r.integrity_check))
    : err(failure("internal", "integrity_check returned an unexpected shape"));
}

/**
 * Whether any connection (the supervisor, the API, a CLI) has `path` open: it takes SQLite's
 * exclusive lock with no busy wait. A database open in WAL mode holds a shared lock on its file,
 * so the lock is refused while anyone uses it. When it is free, the WAL is checkpointed into the
 * file and removed as the probe closes, so the file alone is the whole database.
 */
export function probeUnused(path: string): Result<"unused" | "in_use"> {
  const opened = capture(() => new Database(path, { fileMustExist: true }));
  if (!opened.ok) {
    return err(
      failure("validation", `cannot open ${path}: ${opened.error.message}`),
    );
  }
  const raw = opened.value;
  try {
    const locked = capture(() => {
      raw.pragma("busy_timeout = 0");
      raw.pragma("locking_mode = EXCLUSIVE");
      raw.exec("BEGIN EXCLUSIVE");
      raw.exec("COMMIT");
    });
    if (!locked.ok) {
      return locked.error.class === "db_busy" ? ok("in_use") : locked;
    }
    const checkpointed = capture(() => {
      raw.pragma("wal_checkpoint(TRUNCATE)");
    });
    return checkpointed.ok ? ok("unused") : checkpointed;
  } finally {
    raw.close();
  }
}
