import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { err, FakeClock, ok } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf, openDb, type Db } from "../connection.js";
import {
  appendEvents,
  seedSpine,
  SPINE_SEED,
  tempDb,
  unwrap,
} from "../testing.js";
import { writeBackup } from "./backup.js";
import { listBackupFiles } from "./files.js";
import { BACKUP_MAGIC, readBackupHeader } from "./format.js";
import { BackupKey } from "./key.js";
import { restoreBackup, type RestoreOptions } from "./restore.js";

// writeBackup and restoreBackup against real temp files: never the operator's disk.
const clock = new FakeClock(Date.UTC(2026, 8, 14, 3));
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 12));
unwrap(await appendEvents(t.db, SPINE_SEED.sessionId, 40));
const scratch = mkdtempSync(join(tmpdir(), "bayon-backup-"));
afterAll(() => {
  t.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const key = unwrap(BackupKey.fromHex("3c".repeat(32)));
const other = unwrap(BackupKey.fromHex("c3".repeat(32)));
const theKey = async () => ok(key);

let n = 0;
const freshDir = (name: string) => join(scratch, `${name}-${(n += 1)}`);

async function backupInto(dir: string, keep = 14): Promise<string> {
  await clock.advance(1_000);
  return unwrap(await writeBackup({ db: t.db, dir, key: theKey, keep, clock }))
    .path;
}

const restoreOptions = (
  file: string,
  to: string,
  o: Partial<RestoreOptions> = {},
): RestoreOptions => ({
  file,
  to,
  replace: false,
  lockFiles: [join(dirname(to), "supervisor.lock")],
  key: theKey,
  clock,
  ...o,
});

/** Rows per table, the way a restore is compared with its source. */
function rowCounts(db: Db): Record<string, number> {
  const raw = unwrap(internalsOf(db)).raw;
  const tables = raw
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (
        raw.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
}

const leftovers = (dir: string) =>
  readdirSync(dir).filter((f) => f.startsWith("."));

test("a backup is an encrypted 0600 file; its restore passes integrity_check with the same rows", async () => {
  const dir = freshDir("backups");
  const path = await backupInto(dir);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).equals(BACKUP_MAGIC)).toBe(true);
  expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
  // No snapshot or staged file survives: only the backup.
  expect(readdirSync(dir)).toEqual([path.slice(dir.length + 1)]);
  expect(unwrap(await readBackupHeader(path)).header.key_id).toBe(key.id);

  const to = join(freshDir("restore"), "foreman.db");
  mkdirSync(dirname(to));
  const restored = unwrap(await restoreBackup(restoreOptions(path, to)));
  expect(restored).toMatchObject({
    path: to,
    key_id: key.id,
    integrity: ["ok"],
    replaced: null,
    migrations: { pending: [], drifted: [] },
  });
  expect(statSync(to).mode & 0o777).toBe(0o600);
  expect(leftovers(dirname(to))).toEqual([]);
  const copy = unwrap(await openDb({ path: to, clock }));
  try {
    expect(rowCounts(copy)).toEqual(rowCounts(t.db));
    expect(rowCounts(copy)["events"]).toBe(40);
  } finally {
    await copy.close();
  }
});

test("the 15th backup prunes the oldest: backup.keep = 14", async () => {
  const dir = freshDir("keep");
  const paths: string[] = [];
  for (let i = 0; i < 15; i += 1) paths.push(await backupInto(dir, 14));
  const kept = unwrap(listBackupFiles(dir));
  expect(kept).toHaveLength(14);
  expect(existsSync(paths[0] ?? "")).toBe(false);
  expect(kept.map((f) => join(dir, f))).toEqual(paths.slice(1));
  // Other files in the directory are never pruned.
  writeFileSync(join(dir, "notes.txt"), "mine");
  const last = await backupInto(dir, 1);
  expect(readdirSync(dir).toSorted()).toEqual(
    [last.slice(dir.length + 1), "notes.txt"].toSorted(),
  );
});

test("a missing key fails before anything touches the disk: no backup and no plaintext", async () => {
  const dir = freshDir("nokey");
  const failed = await writeBackup({
    db: t.db,
    dir,
    keep: 14,
    clock,
    key: async () =>
      err({
        class: "validation",
        message: "secret FRM_BACKUP_KEY is not in the secret store",
        retryable: false,
      }),
  });
  expect(failed).toMatchObject({
    ok: false,
    error: {
      message: expect.stringMatching(/never a plaintext.*frm backup init-key/),
    },
  });
  expect(existsSync(dir)).toBe(false);
});

test("restore refuses an existing target unless --replace", async () => {
  const path = await backupInto(freshDir("b"));
  const home = freshDir("home");
  mkdirSync(home);
  const to = join(home, "foreman.db");
  writeFileSync(to, "");
  expect(await restoreBackup(restoreOptions(path, to))).toMatchObject({
    ok: false,
    error: { class: "conflict", message: expect.stringContaining("--replace") },
  });
  expect(readFileSync(to, "utf8")).toBe("");
});

test("restore refuses a target whose supervisor lock is there, replace or not", async () => {
  const path = await backupInto(freshDir("b"));
  const home = freshDir("home");
  mkdirSync(home);
  writeFileSync(join(home, "supervisor.lock"), "{}");
  for (const replace of [false, true]) {
    expect(
      await restoreBackup(
        restoreOptions(path, join(home, "foreman.db"), { replace }),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        class: "conflict",
        message: expect.stringContaining("supervisor.lock"),
      },
    });
  }
  expect(existsSync(join(home, "foreman.db"))).toBe(false);
});

test("restore refuses a live database another connection has open, even with --replace", async () => {
  const path = await backupInto(freshDir("b"));
  // t.db holds t.path open in WAL mode, as the supervisor or the API would.
  const refused = await restoreBackup(
    restoreOptions(path, t.path, { replace: true }),
  );
  expect(refused).toMatchObject({
    ok: false,
    error: {
      class: "conflict",
      message: expect.stringContaining("open in another process"),
    },
  });
  expect(leftovers(dirname(t.path))).toEqual([]);
});

test("--replace moves an unused target aside, never deletes it", async () => {
  const path = await backupInto(freshDir("b"));
  const home = freshDir("home");
  mkdirSync(home);
  const to = join(home, "foreman.db");
  const old = unwrap(await openDb({ path: to, clock }));
  await old.close();
  const restored = unwrap(
    await restoreBackup(restoreOptions(path, to, { replace: true })),
  );
  expect(restored.replaced).toMatch(/foreman\.db\.replaced-\d{8}T\d{9}Z$/);
  expect(existsSync(restored.replaced ?? "")).toBe(true);
  expect(existsSync(to)).toBe(true);
});

test("restore refuses leftover sidecars a new target would inherit", async () => {
  const path = await backupInto(freshDir("b"));
  const home = freshDir("home");
  mkdirSync(home);
  const to = join(home, "foreman.db");
  closeSync(openSync(`${to}-wal`, "w"));
  expect(await restoreBackup(restoreOptions(path, to))).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("foreman.db-wal") },
  });
  expect(existsSync(to)).toBe(false);
});

test("restore with another key, or of an altered file, fails and leaves nothing behind", async () => {
  const path = await backupInto(freshDir("b"));
  const home = freshDir("home");
  mkdirSync(home);
  const to = join(home, "foreman.db");
  expect(
    await restoreBackup(
      restoreOptions(path, to, { key: async () => ok(other) }),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining(other.id) },
  });
  const altered = join(home, "altered.frmbak");
  copyFileSync(path, altered);
  const bytes = readFileSync(altered);
  bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 0xff;
  writeFileSync(altered, bytes);
  expect(await restoreBackup(restoreOptions(altered, to))).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("GCM tag") },
  });
  expect(existsSync(to)).toBe(false);
  expect(leftovers(home)).toEqual([]);
});
