import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { backupKeyEnvWarning, getLastBackup } from "@bayon/db";
import {
  appendEvents,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { envSecrets } from "../lifecycle/secrets.js";
import { backupsDir } from "../paths.js";
import { runBackupJob, type BackupJobResult } from "./backup-job.js";
import { DEFAULT_BACKUP_SETTINGS } from "./backup-settings.js";

// The nightly job with a test-only key in FRM_SECRET_FRM_BACKUP_KEY: never the
// Keychain. Every attempt is recorded; retention follows only a good one; the key is nowhere.
const DAY = 86_400_000;
const KEY_HEX = "d4e1".repeat(16);
const KEY = Buffer.from(KEY_HEX, "hex");
const BAD_VALUE = "not-a-key-SENTINEL-7f3a";

const clock = new FakeClock(Date.UTC(2026, 8, 14, 3));
const t = unwrap(await tempDb(clock));
const home = mkdtempSync(join(tmpdir(), "bayon-backup-job-"));
afterAll(() => {
  t.cleanup();
  rmSync(home, { recursive: true, force: true });
});
unwrap(await seedSpine(t.db, 12));
unwrap(
  await seedRows(t.db, {
    tickets: [
      ticketRow(1, { status: "done", closed_at: clock.now() - 40 * DAY }),
    ],
    sessions: [
      {
        ...newSessionInput(),
        id: "s-done",
        ticket_id: "ticket-1",
        state: "exited",
        created_at: 0,
      },
    ],
  }),
);
unwrap(await appendEvents(t.db, "s-done", 5));

const logs: string[] = [];
const log = pino(
  { level: "trace" },
  {
    write: (line: string) => {
      logs.push(line);
    },
  },
);
const results: BackupJobResult[] = [];

/** The supervisor's stores: `env` as its environment, `keychain` a stand-in for the Keychain. */
async function night(
  env: Record<string, string | undefined>,
  keychain: Record<string, string | undefined> = {},
): Promise<BackupJobResult> {
  await clock.advance(60_000);
  const secrets = {
    env: envSecrets(env),
    host: envSecrets(keychain),
    hostSource: "keychain" as const,
  };
  const result = await runBackupJob(
    { db: t.db, clock, log, home, secrets },
    DEFAULT_BACKUP_SETTINGS,
  );
  results.push(result);
  return result;
}

const backupFiles = () =>
  existsSync(backupsDir(home)) ? readdirSync(backupsDir(home)) : [];

test("a good night: an encrypted 0600 backup, an ok row, then retention", async () => {
  const { backup, retention } = await night({
    FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX,
  });
  const written = unwrap(backup);
  expect(statSync(written.path).mode & 0o777).toBe(0o600);
  expect(
    readFileSync(written.path).includes(Buffer.from("SQLite format 3")),
  ).toBe(false);
  expect(unwrap(await getLastBackup(t.db))).toMatchObject({
    outcome: "ok",
    path: written.path,
    error: null,
  });
  expect(retention && unwrap(retention)).toMatchObject({
    ran: true,
    archived: 5,
  });
  // The key came from the environment, not the Keychain: that is said loudly (a warn line).
  expect(envWarnings()).toHaveLength(1);
});

/** Warn lines saying the environment, not the Keychain, supplied the backup key. */
const envWarnings = () =>
  logs
    .map((line) => JSON.parse(line) as { level: number; msg: string })
    .filter((l) => l.level === 40 && l.msg === backupKeyEnvWarning());

test("the same key from the Keychain logs no override warning; the environment wins when both hold one", async () => {
  const before = envWarnings().length;
  const fromKeychain = await night({}, { FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX });
  expect(fromKeychain.backup.ok).toBe(true);
  expect(envWarnings()).toHaveLength(before);
  const both = await night(
    { FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX },
    { FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX },
  );
  expect(both.backup.ok).toBe(true);
  expect(envWarnings()).toHaveLength(before + 1);
});

test("a key gone after a good backup: a failed row naming the fix, no new file, no retention", async () => {
  const before = backupFiles();
  const { backup, retention, notSetUp } = await night({});
  expect(backup.ok).toBe(false);
  expect(notSetUp).toBeUndefined();
  expect(retention).toBeNull();
  expect(unwrap(await getLastBackup(t.db))).toMatchObject({
    outcome: "failed",
    path: null,
    error: expect.stringMatching(/FRM_BACKUP_KEY.*frm backup init-key/),
  });
  expect(backupFiles()).toEqual(before);
});

test("a Keychain that could not be read is a failed attempt, never 'not set up'", async () => {
  const fresh = unwrap(await tempDb(clock));
  try {
    const locked = {
      get: async () => ({
        ok: false as const,
        error: {
          class: "internal" as const,
          message: "the Keychain did not answer for FRM_BACKUP_KEY",
          retryable: true,
        },
      }),
    };
    const result = await runBackupJob(
      {
        db: fresh.db,
        clock,
        log,
        home,
        secrets: { env: envSecrets({}), host: locked, hostSource: "keychain" },
      },
      DEFAULT_BACKUP_SETTINGS,
    );
    expect(result.notSetUp).toBeUndefined();
    expect(unwrap(await getLastBackup(fresh.db))).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("did not answer"),
    });
  } finally {
    fresh.cleanup();
  }
});

test("no key and no good backup ever: not set up — no row, no file, no error line", async () => {
  const fresh = unwrap(await tempDb(clock));
  const freshHome = mkdtempSync(join(tmpdir(), "bayon-backup-fresh-"));
  try {
    const linesBefore = logs.length;
    const result = await runBackupJob(
      {
        db: fresh.db,
        clock,
        log,
        home: freshHome,
        secrets: {
          env: envSecrets({}),
          host: envSecrets({}),
          hostSource: "keychain",
        },
      },
      DEFAULT_BACKUP_SETTINGS,
    );
    expect(result.backup.ok).toBe(false);
    expect(result.notSetUp).toBe(true);
    expect(result.retention).toBeNull();
    expect(unwrap(await getLastBackup(fresh.db))).toBeNull();
    expect(existsSync(backupsDir(freshHome))).toBe(false);
    const levels = logs
      .slice(linesBefore)
      .map((line) => (JSON.parse(line) as { level: number }).level);
    expect(levels.filter((level) => level >= 50)).toEqual([]);
  } finally {
    fresh.cleanup();
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test("a malformed key is refused without echoing it", async () => {
  const { backup } = await night({ FRM_SECRET_FRM_BACKUP_KEY: BAD_VALUE });
  expect(backup).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("64 hex characters") },
  });
  const last = unwrap(await getLastBackup(t.db));
  expect(last?.outcome).toBe("failed");
  expect(last?.error).not.toContain(BAD_VALUE);
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("sentinel: the key is in no log line, result, database byte or file under FRM_HOME", () => {
  const texts = [
    KEY_HEX,
    KEY_HEX.toUpperCase(),
    KEY.toString("base64"),
    KEY.toString("base64url"),
    BAD_VALUE,
  ];
  const needles = [...texts.map((s) => Buffer.from(s, "utf8")), KEY];
  expect(logs.length).toBeGreaterThan(0);
  const logText = logs.join("");
  const resultText = JSON.stringify(results);
  for (const text of texts) {
    expect(logText).not.toContain(text);
    expect(resultText).not.toContain(text);
  }
  const files = [t.path, `${t.path}-wal`, ...filesUnder(home)].filter((f) =>
    existsSync(f),
  );
  expect(files.some((f) => f.endsWith(".frmbak"))).toBe(true);
  for (const file of files) {
    const bytes = readFileSync(file);
    for (const needle of needles) {
      expect(bytes.includes(needle), `${file} holds the key`).toBe(false);
    }
  }
});
