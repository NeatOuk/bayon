import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { err, ok, type Clock, type Result } from "@bayon/core";
import type { Db, R } from "../connection.js";
import { capture, failure } from "../errors.js";
import { backupFileName, pruneBackups, type Pruned } from "./files.js";
import { encryptFile } from "./format.js";
import type { BackupKey } from "./key.js";
import { snapshotInto } from "./snapshot.js";

// One backup (§13.2, §14): the key first, so a missing key fails before any byte of the
// database reaches the disk (never a plaintext fallback); then VACUUM INTO a private 0600 file,
// AES-256-GCM into the backups directory, link(2) into place (never over another file), and the
// oldest past `keep` pruned. The snapshot is removed whatever happens.

export interface WriteBackupOptions {
  readonly db: Db;
  /** The backups directory; created 0700 when absent. */
  readonly dir: string;
  /** Reads the key from the host secret store. Called before anything touches the disk. */
  readonly key: () => Promise<Result<BackupKey>>;
  /** How many backups to keep, the new one included. */
  readonly keep: number;
  readonly clock: Clock;
}

export interface WrittenBackup {
  readonly path: string;
  readonly key_id: string;
  /** The encrypted file's size. */
  readonly bytes: number;
  readonly pruned: Pruned;
}

/** Removes `paths` and swallows nothing: a leftover plaintext snapshot is reported. */
function removeAll(paths: readonly string[]): Result<void> {
  const left = paths.flatMap((p) => {
    const gone = capture(() => rmSync(p, { force: true }));
    return gone.ok ? [] : [`${p}: ${gone.error.message}`];
  });
  return left.length === 0
    ? ok(undefined)
    : err(failure("internal", `could not remove ${left.join("; ")}`));
}

/** fsync a directory, so a link or rename in it survives a crash. */
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

export async function writeBackup(o: WriteBackupOptions): R<WrittenBackup> {
  if (!Number.isInteger(o.keep) || o.keep < 1) {
    return err(
      failure(
        "validation",
        `backup.keep must be an integer >= 1, not ${o.keep}`,
      ),
    );
  }
  const key = await o.key();
  if (!key.ok) {
    return err(
      failure(
        key.error.class,
        `no backup key, so no backup (never a plaintext one): ${key.error.message}. ` +
          "Create it with: frm backup init-key",
      ),
    );
  }
  const made = capture(() =>
    mkdirSync(o.dir, { recursive: true, mode: 0o700 }),
  );
  if (!made.ok) return made;
  const now = o.clock.now();
  const path = join(o.dir, backupFileName(now));
  if (existsSync(path)) {
    return err(
      failure("conflict", `${path} exists: one backup per millisecond`),
    );
  }
  const nonce = randomUUID();
  const snapshot = join(o.dir, `.snapshot-${nonce}.db`);
  const staged = join(o.dir, `.staged-${nonce}.frmbak`);
  const done = await (async (): R<number> => {
    // Created empty at 0600 first: VACUUM INTO keeps an empty file's mode.
    const created = capture(() => closeSync(openSync(snapshot, "wx", 0o600)));
    if (!created.ok) return created;
    const copied = await snapshotInto(o.db, snapshot);
    if (!copied.ok) return copied;
    const encrypted = await encryptFile({
      src: snapshot,
      dst: staged,
      key: key.value,
      createdAt: now,
    });
    if (!encrypted.ok) return encrypted;
    const linked = capture(() => linkSync(staged, path));
    if (!linked.ok) return linked;
    const synced = syncDir(o.dir);
    if (!synced.ok) return synced;
    return capture(() => statSync(path).size);
  })();
  const cleaned = removeAll([snapshot, `${snapshot}-journal`, staged]);
  if (!done.ok) return done;
  if (!cleaned.ok) return cleaned;
  const pruned = pruneBackups(o.dir, o.keep);
  if (!pruned.ok) return pruned;
  return ok({
    path,
    key_id: key.value.id,
    bytes: done.value,
    pruned: pruned.value,
  });
}
