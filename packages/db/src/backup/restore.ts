import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { err, ok, type Clock, type Result } from "@bayon/core";
import { openDb, type R } from "../connection.js";
import { capture, failure } from "../errors.js";
import {
  migrationStatus,
  migrationTag,
  type MigrationStatus,
} from "../migrate.js";
import { utcStamp } from "./files.js";
import { decryptFile, readBackupHeader } from "./format.js";
import type { BackupKey } from "./key.js";
import { checkIntegrity, probeUnused } from "./snapshot.js";

// `frm restore` (§13.2, §14). Refuses a target that is locked or in use, decrypts into a
// private temp file beside it (the GCM tag verified, else nothing is left), checks the copy with
// integrity_check and migration status, and only then renames it into place. It never overwrites
// silently: an existing target needs `replace`, nothing may have it open, and it is moved aside,
// never deleted.

export interface RestoreOptions {
  /** The encrypted backup. */
  readonly file: string;
  /** The database file to create. */
  readonly to: string;
  /** Allow `to` to exist: it is moved aside to `<to>.replaced-<stamp>`, never deleted. */
  readonly replace: boolean;
  /** Files whose presence means a supervisor may own `to` (its FRM_HOME's supervisor.lock). */
  readonly lockFiles: readonly string[];
  /** The key with this id: the current one, or a rotated one the store kept. */
  readonly key: (keyId: string) => Promise<Result<BackupKey>>;
  readonly clock: Clock;
}

export interface Restored {
  readonly path: string;
  readonly key_id: string;
  /** When the backup was taken. */
  readonly created_at: number;
  /** integrity_check's rows: ["ok"]. */
  readonly integrity: readonly string[];
  readonly migrations: MigrationStatus;
  /** Where the replaced database was moved, if there was one. */
  readonly replaced: string | null;
}

const SIDECARS = ["-wal", "-shm", "-journal"] as const;

const refuse = (message: string): Result<never> =>
  err(failure("conflict", message));

/** Refuses a target a supervisor may hold, or a live database something has open. */
function checkTarget(o: RestoreOptions, to: string): Result<void> {
  const lock = [...new Set(o.lockFiles.map((f) => resolve(f)))].find((f) =>
    existsSync(f),
  );
  if (lock !== undefined) {
    return refuse(
      `${lock} exists: a supervisor may be running on ${to}. Stop it first ` +
        "(remove the lock only if no supervisor runs)",
    );
  }
  if (!existsSync(to)) {
    const sidecar = SIDECARS.map((s) => `${to}${s}`).find((p) => existsSync(p));
    return sidecar === undefined
      ? ok(undefined)
      : refuse(
          `${sidecar} exists: a new ${to} would inherit it; move it away first`,
        );
  }
  if (!o.replace) {
    return refuse(
      `${to} exists: restore to a new path, or pass --replace with the supervisor and API stopped`,
    );
  }
  const probe = probeUnused(to);
  if (!probe.ok) return probe;
  if (probe.value === "in_use") {
    return refuse(
      `${to} is open in another process (the supervisor, the API or a CLI): stop it first`,
    );
  }
  const sidecar = SIDECARS.map((s) => `${to}${s}`).find((p) => existsSync(p));
  return sidecar === undefined
    ? ok(undefined)
    : refuse(
        `${sidecar} is still there after a checkpoint: ${to} is not closed cleanly`,
      );
}

function syncDir(dir: string): Result<void> {
  return capture(() => {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}

/** Opens the decrypted copy, checks it, closes it. */
async function verifyCopy(
  path: string,
  clock: Clock,
): R<{ integrity: readonly string[]; migrations: MigrationStatus }> {
  const opened = await openDb({ path, clock });
  if (!opened.ok) return opened;
  const integrity = await checkIntegrity(opened.value);
  const migrations = await migrationStatus(opened.value);
  const closed = await opened.value.close();
  if (!integrity.ok) return integrity;
  if (!migrations.ok) return migrations;
  if (!closed.ok) return closed;
  if (integrity.value.length !== 1 || integrity.value[0] !== "ok") {
    return err(
      failure(
        "validation",
        `integrity_check failed: ${integrity.value.slice(0, 5).join("; ")}`,
      ),
    );
  }
  if (migrations.value.drifted.length > 0) {
    return err(
      failure(
        "validation",
        `the restored database applied migrations this code changed since: ${migrations.value.drifted.map(migrationTag).join(", ")}`,
      ),
    );
  }
  return ok({ integrity: integrity.value, migrations: migrations.value });
}

export async function restoreBackup(o: RestoreOptions): R<Restored> {
  const file = resolve(o.file);
  const to = resolve(o.to);
  if (file === to) return refuse("--to names the backup itself");
  const target = checkTarget(o, to);
  if (!target.ok) return target;
  const opened = await readBackupHeader(file);
  if (!opened.ok) return opened;
  const { header } = opened.value;
  const key = await o.key(header.key_id);
  if (!key.ok) return key;
  if (key.value.id !== header.key_id) {
    return err(
      failure(
        "validation",
        `${file} was written with backup key ${header.key_id}; the secret store's key is ${key.value.id}`,
      ),
    );
  }
  const staged = join(dirname(to), `.${basename(to)}.restore-${randomUUID()}`);
  const stagedFiles = [staged, ...SIDECARS.map((s) => `${staged}${s}`)];
  const cleanup = () => {
    for (const p of stagedFiles) rmSync(p, { force: true });
  };
  const decrypted = await decryptFile({
    src: file,
    dst: staged,
    key: key.value,
  });
  if (!decrypted.ok) return decrypted;
  const verified = await verifyCopy(staged, o.clock);
  if (!verified.ok) {
    cleanup();
    return verified;
  }
  // Checked again at the last moment: a supervisor may have started meanwhile.
  const still = checkTarget(o, to);
  if (!still.ok) {
    cleanup();
    return still;
  }
  const aside = existsSync(to)
    ? `${to}.replaced-${utcStamp(o.clock.now())}`
    : null;
  if (aside !== null) {
    const movedAside = capture(() => renameSync(to, aside));
    if (!movedAside.ok) {
      cleanup();
      return movedAside;
    }
  }
  const placed = capture(() => renameSync(staged, to));
  if (!placed.ok) {
    // Never leave `to` empty-handed: the old database goes back, and the verified copy is kept.
    const back =
      aside === null ? ok(undefined) : capture(() => renameSync(aside, to));
    const where =
      aside === null
        ? ""
        : back.ok
          ? `; ${to} is back as it was`
          : `; the old database is at ${aside}`;
    return err(
      failure(
        "internal",
        `cannot move the restored copy into ${to}: ${placed.error.message}${where}; the verified copy is at ${staged}`,
      ),
    );
  }
  cleanup();
  const synced = syncDir(dirname(to));
  if (!synced.ok) return synced;
  return ok({
    path: to,
    key_id: header.key_id,
    created_at: header.created_at,
    integrity: verified.value.integrity,
    migrations: verified.value.migrations,
    replaced: aside,
  });
}
