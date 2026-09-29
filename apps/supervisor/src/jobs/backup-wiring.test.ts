import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeClock } from "@bayon/core";
import { STALE_TEMP_MS, getLastBackup, type Db } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { envSecrets } from "../lifecycle/secrets.js";
import { backupsDir } from "../paths.js";
import { wireBackups } from "./backup-wiring.js";

// The daemon's wiring: the crash sweep, settings from the db, the job with the secret
// stores, the row. The key sits in a stand-in for the Keychain, never the real one.
const clock = new FakeClock(Date.UTC(2026, 8, 14, 5));
const secrets = {
  env: envSecrets({}),
  host: envSecrets({ FRM_SECRET_FRM_BACKUP_KEY: "9b".repeat(32) }),
  hostSource: "keychain" as const,
};
const log = pino({ level: "silent" });
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

async function fixture(): Promise<{ db: Db; home: string; path: string }> {
  const t = unwrap(await tempDb(clock));
  const home = mkdtempSync(join(tmpdir(), "bayon-backup-wiring-"));
  cleanups.push(() => {
    t.cleanup();
    rmSync(home, { recursive: true, force: true });
  });
  return { db: t.db, home, path: t.path };
}

/** Event-loop turns, not time: the job's file I/O completes in between. */
async function until(done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 20_000; i += 1) {
    if (await done()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the condition never held");
}

const disabled = (db: Db) =>
  seedRows(db, {
    settings: [{ key: "backup.enabled", value_json: "0", updated_at: 0 }],
  });

test("at start, the missed night's backup is taken, recorded and kept; stop waits for the job", async () => {
  const { db, home } = await fixture();
  const wiring = wireBackups({ db, clock, log, home, secrets });
  await until(async () => unwrap(await getLastBackup(db)) !== null);
  await wiring.stop();
  expect(unwrap(await getLastBackup(db))).toMatchObject({ outcome: "ok" });
  expect(readdirSync(backupsDir(home))).toHaveLength(1);
});

test("backup.enabled = 0: no backup, no row", async () => {
  const { db, home } = await fixture();
  unwrap(await disabled(db));
  const wiring = wireBackups({ db, clock, log, home, secrets });
  await clock.advance(2 * 86_400_000);
  await wiring.stop();
  expect(unwrap(await getLastBackup(db))).toBeNull();
  expect(existsSync(backupsDir(home))).toBe(false);
});

test("boot sweeps a killed backup's snapshot and a killed restore's copy; fresh ones stay", async () => {
  const { db, home, path } = await fixture();
  unwrap(await disabled(db));
  mkdirSync(backupsDir(home), { recursive: true, mode: 0o700 });
  const at = (file: string, ms: number) => {
    writeFileSync(file, "plaintext");
    utimesSync(file, ms / 1000, ms / 1000);
    return file;
  };
  const old = clock.now() - STALE_TEMP_MS - 60_000;
  const stale = [
    at(join(backupsDir(home), `.snapshot-${randomUUID()}.db`), old),
    at(join(backupsDir(home), `.staged-${randomUUID()}.frmbak`), old),
    at(join(dirname(path), `.foreman.db.restore-${randomUUID()}`), old),
  ];
  const fresh = [
    at(join(backupsDir(home), `.snapshot-${randomUUID()}.db`), clock.now()),
    at(join(dirname(path), `.foreman.db.restore-${randomUUID()}`), clock.now()),
  ];
  const wiring = wireBackups({ db, clock, log, home, secrets, liveDb: path });
  await wiring.stop();
  for (const file of stale) expect(existsSync(file), file).toBe(false);
  for (const file of fresh) expect(existsSync(file), file).toBe(true);
  expect(existsSync(path)).toBe(true);
});
