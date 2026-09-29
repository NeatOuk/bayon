// `frm backup`, `frm backup init-key [--rotate]` and `frm restore <file> --to <db-path>
// [--replace]` (§13.2, §14). The key is read the way the supervisor reads every secret
// (FRM_SECRET_<NAME>, then the Keychain under service foreman), is written to the Keychain through
// security -i on stdin, and is never printed: only its id is.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  SUPERVISOR_LOCK_FILE,
  err,
  ok,
  type Clock,
  type Result,
} from "@bayon/core";
import {
  BACKUP_KEY_NAME,
  BACKUPS_DIR,
  BackupKey,
  backupKeyEnvWarning,
  getSettings,
  migrationTag,
  openDb,
  rotatedKeyName,
  sweepBackupTemps,
  sweepRestoreTemps,
  type Db,
  type Swept,
} from "@bayon/db";
import {
  recordOperatorBackup,
  restoreBackup,
  writeBackup,
  type Restored,
} from "@bayon/db/operator";
import {
  getSourced,
  hostSecrets,
  putKeychainSecret,
  type HostSecrets,
  type KeychainOptions,
} from "@bayon/executors";
import { z } from "zod";

export const BACKUP_USAGE = [
  "       frm backup",
  "       frm backup init-key [--rotate]",
  "       frm restore <file> --to <db-path> [--replace]",
  "backup: an encrypted backup of $FRM_DB (else $FRM_HOME/foreman.db) into $FRM_HOME/backups now:",
  "  a consistent snapshot, AES-256-GCM with the backup key, mode 0600; keeps the newest backup.keep",
  "  and records the attempt. The key: FRM_SECRET_FRM_BACKUP_KEY, else the Keychain (service foreman,",
  "  account FRM_BACKUP_KEY); a warning says so when the environment supplies it. No key, no",
  "  backup: never a plaintext one. Temp files a killed backup or restore left are swept first.",
  "backup init-key: 32 random bytes into the Keychain, through security -i on stdin (never argv),",
  "  never printed (only its id). Refused when a key exists; --rotate replaces it and keeps the old",
  "  one as FRM_BACKUP_KEY.<id>, so the backups it wrote stay restorable.",
  "restore: decrypts (the GCM tag must verify), checks integrity_check and migration status, then",
  "  writes <db-path>. Refused when a supervisor lock is beside it or another process has it open;",
  "  an existing <db-path> needs --replace and is moved aside to <db-path>.replaced-<time>.",
].join("\n");

export type BackupCommand =
  | { readonly action: "backup" }
  | { readonly action: "init-key"; readonly rotate: boolean }
  | {
      readonly action: "restore";
      readonly file: string;
      readonly to: string;
      readonly replace: boolean;
    };

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

function readFlags(argv: readonly string[]) {
  try {
    return ok(
      parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: {
          rotate: { type: "boolean", default: false },
          replace: { type: "boolean", default: false },
          to: { type: "string" },
        },
      }),
    );
  } catch (cause) {
    return invalid(cause instanceof Error ? cause.message : "bad arguments");
  }
}

/** `frm backup …` or `frm restore …`: argv from the command word on. */
export function parseBackupCli(argv: readonly string[]): Result<BackupCommand> {
  const read = readFlags(argv);
  if (!read.ok) return read;
  const { values, positionals } = read.value;
  const [command, ...rest] = positionals;
  if (command === "restore") {
    const [file, ...extra] = rest;
    if (file === undefined || extra.length > 0 || values.to === undefined)
      return invalid("usage: frm restore <file> --to <db-path> [--replace]");
    if (values.rotate)
      return invalid("--rotate belongs to frm backup init-key");
    return ok({
      action: "restore",
      file: resolve(file),
      to: resolve(values.to),
      replace: values.replace,
    });
  }
  if (values.to !== undefined || values.replace)
    return invalid("--to and --replace belong to frm restore");
  if (rest.length === 0) {
    return values.rotate
      ? invalid("--rotate belongs to frm backup init-key")
      : ok({ action: "backup" });
  }
  return rest.length === 1 && rest[0] === "init-key"
    ? ok({ action: "init-key", rotate: values.rotate })
    : invalid(`unknown command: backup ${rest.join(" ")}`);
}

export interface BackupIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** The `security` binary; tests point it at a stand-in, never the real Keychain. */
  readonly keychain?: KeychainOptions;
}

/**
 * The supervisor's selection (FRM_SECRET_STORE): FRM_SECRET_<NAME>, then the Keychain under this
 * FRM_HOME's own service, kept apart to say which won; or, on a Linux host, the files
 * only.
 */
const hostOf = (io: BackupIo): Result<HostSecrets> =>
  hostSecrets(
    io.env,
    io.keychain === undefined ? {} : { keychain: io.keychain },
  );

/** A key from the store; when the environment supplied it, a warning on stderr names the source. */
async function readKey(io: BackupIo, name: string): Promise<Result<BackupKey>> {
  const host = hostOf(io);
  if (!host.ok) return host;
  const text = await getSourced(host.value.stores, name);
  if (!text.ok) return text;
  if (text.value.source === "env")
    io.err(`frm: warning: ${backupKeyEnvWarning(name)}`);
  return BackupKey.fromHex(text.value.value, name);
}

/** The key a backup names: the current one, else the rotated one kept under its id. */
const keyForId =
  (io: BackupIo) =>
  async (keyId: string): Promise<Result<BackupKey>> => {
    const current = await readKey(io, BACKUP_KEY_NAME);
    if (current.ok && current.value.id === keyId) return current;
    const rotated = await readKey(io, rotatedKeyName(keyId));
    return rotated.ok ? rotated : current;
  };

/** Removes what a dead backup or restore left (plaintext temp files); says what it removed. */
function reportSwept(swept: Result<Swept>, io: BackupIo): void {
  if (!swept.ok) {
    io.err(`frm: cannot sweep stale temp files: ${swept.error.message}`);
    return;
  }
  for (const path of swept.value.removed)
    io.out(
      `swept     ${path} (a stale temp file a dead backup or restore left)`,
    );
  for (const failed of swept.value.failed)
    io.err(`frm: stale temp file not removed: ${failed}`);
}

/** Runs the command. Exit 0 done, 1 failed or refused, 2 usage. */
export async function runBackupCommand(
  cmd: BackupCommand,
  io: BackupIo,
): Promise<number> {
  const name = cmd.action === "restore" ? "frm restore" : "frm backup";
  const live = liveOf(io);
  if (cmd.action === "backup" && !live.ok) {
    io.err(`${name}: ${live.error.message}`);
    return 2;
  }
  const done =
    cmd.action === "init-key"
      ? await initKey(cmd.rotate, io)
      : cmd.action === "restore"
        ? await restore(cmd, io)
        : await backupNow(io);
  if (done.ok) return 0;
  io.err(`${name}: ${done.error.message}`);
  return 1;
}

async function initKey(rotate: boolean, io: BackupIo): Promise<Result<void>> {
  const host = hostOf(io);
  if (!host.ok) return host;
  if (host.value.kind === "file") {
    return invalid(
      "this home keeps its secrets in files, which frm does not write: on the host, run " +
        "deploy/secrets.sh gen <project> FRM_BACKUP_KEY supervisor migrate",
    );
  }
  // The Keychain alone (never the environment), under the service hostSecrets derived for this home.
  const keychain = host.value.stores.host;
  const service = host.value.keychain?.service;
  if (service === undefined)
    return invalid("no Keychain service for this home");
  const existing = await keychain.get(BACKUP_KEY_NAME);
  let previous: BackupKey | null = null;
  if (existing.ok) {
    const old = BackupKey.fromHex(existing.value);
    if (!old.ok) {
      return invalid(
        `${BACKUP_KEY_NAME} in the Keychain is not a backup key; delete it with security ` +
          `delete-generic-password -s ${service} -a ${BACKUP_KEY_NAME}, then run init-key`,
      );
    }
    if (!rotate) {
      return err({
        class: "conflict",
        message: `a backup key exists in the Keychain (key id ${old.value.id}); --rotate replaces it and keeps it as ${rotatedKeyName(old.value.id)}`,
        retryable: false,
      });
    }
    previous = old.value;
    const kept = await putKeychainSecret({
      ...io.keychain,
      service,
      account: rotatedKeyName(old.value.id),
      value: old.value.hexForStore(),
      replace: true,
    });
    if (!kept.ok) return kept;
  }
  const fresh = BackupKey.generate();
  const put = await putKeychainSecret({
    ...io.keychain,
    service,
    account: BACKUP_KEY_NAME,
    value: fresh.hexForStore(),
    replace: previous !== null,
  });
  if (!put.ok) return put;
  // Read back from the Keychain itself (never the environment): the id must match.
  const stored = await keychain.get(BACKUP_KEY_NAME);
  if (!stored.ok) return stored;
  const back = BackupKey.fromHex(stored.value);
  if (!back.ok) return back;
  if (back.value.id !== fresh.id) {
    return err({
      class: "internal",
      message: `the Keychain returned key ${back.value.id}, not the ${fresh.id} just written`,
      retryable: false,
    });
  }
  io.out(
    `backup key ${fresh.id} ${previous === null ? "created" : "rotated"} in the Keychain (service ${service}, account ${BACKUP_KEY_NAME})`,
  );
  if (previous !== null) {
    io.out(
      `previous  ${previous.id} kept as ${rotatedKeyName(previous.id)}: the backups it wrote stay restorable`,
    );
  }
  return ok(undefined);
}

interface Live {
  readonly home: string;
  readonly db: string;
}

function liveOf(io: BackupIo): Result<Live> {
  const home = io.env["FRM_HOME"];
  if (home === undefined || home === "") return invalid("set FRM_HOME");
  return ok({
    home: resolve(home),
    db: resolve(io.env["FRM_DB"] ?? join(home, "foreman.db")),
  });
}

const Keep = z.int().min(1).max(1_000).default(14);

async function backupNow(io: BackupIo): Promise<Result<void>> {
  const live = liveOf(io);
  if (!live.ok) return live;
  reportSwept(
    sweepBackupTemps(join(live.value.home, BACKUPS_DIR), io.clock.now()),
    io,
  );
  // Never create an empty database by opening a wrong path.
  if (!existsSync(live.value.db))
    return invalid(`no database at ${live.value.db}`);
  const opened = await openDb({ path: live.value.db, clock: io.clock });
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    return await backupWith(db, live.value, io);
  } finally {
    await db.close();
  }
}

async function backupWith(
  db: Db,
  live: Live,
  io: BackupIo,
): Promise<Result<void>> {
  const settings = await getSettings(db, ["backup.keep"]);
  if (!settings.ok) return settings;
  const keep = Keep.safeParse(settings.value.get("backup.keep"));
  if (!keep.success) return invalid("backup.keep is not an integer >= 1");
  const startedAt = io.clock.now();
  const written = await writeBackup({
    db,
    dir: join(live.home, BACKUPS_DIR),
    key: () => readKey(io, BACKUP_KEY_NAME),
    keep: keep.data,
    clock: io.clock,
  });
  const endedAt = Math.max(io.clock.now(), startedAt);
  const recorded = await recordOperatorBackup(
    db,
    written.ok
      ? {
          started_at: startedAt,
          ended_at: endedAt,
          outcome: "ok",
          path: written.value.path,
        }
      : {
          started_at: startedAt,
          ended_at: endedAt,
          outcome: "failed",
          error: written.error.message,
        },
  );
  if (!recorded.ok)
    io.err(
      `frm backup: the attempt was not recorded: ${recorded.error.message}`,
    );
  if (!written.ok) return written;
  const { path, bytes, key_id, pruned } = written.value;
  io.out(`backup    ${path}  ${bytes} bytes  key ${key_id}  mode 0600`);
  io.out(
    `pruned    ${pruned.removed.length} older backup(s); keeping the newest ${keep.data}`,
  );
  for (const failed of pruned.failed)
    io.err(`frm backup: not pruned: ${failed}`);
  return ok(undefined);
}

async function restore(
  cmd: Extract<BackupCommand, { action: "restore" }>,
  io: BackupIo,
): Promise<Result<void>> {
  reportSwept(sweepRestoreTemps(dirname(cmd.to), io.clock.now()), io);
  const lockFiles = [join(dirname(cmd.to), SUPERVISOR_LOCK_FILE)];
  const live = liveOf(io);
  // The live database of this FRM_HOME is locked by its supervisor's lock, wherever FRM_DB puts it.
  if (live.ok && live.value.db === cmd.to)
    lockFiles.push(join(live.value.home, SUPERVISOR_LOCK_FILE));
  const restored = await restoreBackup({
    file: cmd.file,
    to: cmd.to,
    replace: cmd.replace,
    lockFiles,
    key: keyForId(io),
    clock: io.clock,
  });
  if (!restored.ok) return restored;
  for (const line of describe(cmd.file, restored.value)) io.out(line);
  return ok(undefined);
}

function describe(file: string, r: Restored): string[] {
  const { applied, pending } = r.migrations;
  const latest = applied.at(-1);
  return [
    `restored  ${r.path}  from ${file}`,
    `taken     ${new Date(r.created_at).toISOString()}  key ${r.key_id}`,
    `integrity ${r.integrity.join("; ")}`,
    `migrations ${applied.length} applied (latest ${latest === undefined ? "none" : migrationTag(latest)}), ` +
      `${pending.length === 0 ? "none pending" : `pending ${pending.map(migrationTag).join(", ")}: the supervisor applies them when it starts on it`}`,
    ...(r.replaced === null ? [] : [`replaced  moved aside to ${r.replaced}`]),
  ];
}
