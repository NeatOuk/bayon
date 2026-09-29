import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  BackupKey,
  STALE_TEMP_MS,
  getLastBackup,
  openDb,
  type BackupRow,
} from "@bayon/db";
import { migrateUp } from "@bayon/db/operator";
import { keychainScope } from "@bayon/executors";
import { afterAll, expect, test, vi } from "vitest";
import {
  parseBackupCli,
  runBackupCommand,
  type BackupCommand,
  type BackupIo,
} from "./backup.js";
import { USAGE, parseCli } from "./cli.js";

// Real sqlite, encryption and a stand-in `security` per case: more than the default 5 s on a
// loaded host.
vi.setConfig({ testTimeout: 30_000 });

// frm backup, init-key and restore in temp homes, with a stand-in `security` over a
// directory of items: the real Keychain is never read or written.
const root = mkdtempSync(join(tmpdir(), "bayon-frm-backup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const clock = new FakeClock(Date.UTC(2026, 8, 14, 10));

const KEY_HEX = "7a".repeat(32);
const OTHER_HEX = "a7".repeat(32);
const ENV_WARNING =
  "frm: warning: backup key read from FRM_SECRET_FRM_BACKUP_KEY, not the host secret store";
/** Every line frm printed, and every argv the stand-in saw: the sentinel test reads them all. */
const printed: string[] = [];

/** A stand-in for macOS `security`: one file per item, every argv appended to argv.log. */
function fakeSecurity(name: string): { bin: string; kc: string; argv: string } {
  const dir = join(root, name);
  const kc = join(dir, "kc");
  mkdirSync(kc, { recursive: true });
  const bin = join(dir, "security");
  const argv = join(dir, "argv.log");
  writeFileSync(
    bin,
    `${[
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${argv}"`,
      'if [ "$1" = "-i" ]; then IFS= read -r line; set -- $line; fi',
      'cmd="$1"; shift',
      'update=0; svc=""; acct=""; val=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      "    -U) update=1 ;;",
      '    -s) svc="$2"; shift ;;',
      '    -a) acct="$2"; shift ;;',
      '    -w) if [ $# -gt 1 ]; then val="$2"; shift; fi ;;',
      "  esac",
      "  shift",
      "done",
      `item="${kc}/$svc.$acct"`,
      'case "$cmd" in',
      '  find-generic-password) [ -f "$item" ] || exit 44; cat "$item"; echo ;;',
      '  add-generic-password) if [ -f "$item" ] && [ "$update" = 0 ]; then echo "exists" >&2; exit 45; fi; printf "%s" "$val" > "$item" ;;',
      "  *) exit 2 ;;",
      "esac",
    ].join("\n")}\n`,
  );
  chmodSync(bin, 0o700);
  writeFileSync(argv, "");
  return { bin, kc, argv };
}

function ioFor(
  env: Record<string, string | undefined>,
  bin: string,
): { io: BackupIo; out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  return {
    out,
    errs,
    io: {
      env,
      clock,
      out: (line) => {
        out.push(line);
        printed.push(line);
      },
      err: (line) => {
        errs.push(line);
        printed.push(line);
      },
      keychain: { bin },
    },
  };
}

async function run(
  cmd: BackupCommand,
  env: Record<string, string | undefined>,
  bin: string,
) {
  await clock.advance(1_000);
  const { io, out, errs } = ioFor(env, bin);
  return { code: await runBackupCommand(cmd, io), out, errs };
}

/** A migrated database in a fresh FRM_HOME. */
async function home(name: string): Promise<string> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const db = await openDb({ path: join(dir, "foreman.db"), clock });
  if (!db.ok) throw new Error(db.error.message);
  await migrateUp(db.value, {});
  await db.value.close();
  return dir;
}

async function lastBackup(dir: string): Promise<BackupRow | null> {
  const db = await openDb({ path: join(dir, "foreman.db"), clock });
  if (!db.ok) throw new Error(db.error.message);
  const last = await getLastBackup(db.value);
  await db.value.close();
  if (!last.ok) throw new Error(last.error.message);
  return last.value;
}

test("parses backup, init-key and restore; anything else is refused", () => {
  expect(parseBackupCli(["backup"])).toEqual({
    ok: true,
    value: { action: "backup" },
  });
  expect(parseBackupCli(["backup", "init-key", "--rotate"])).toEqual({
    ok: true,
    value: { action: "init-key", rotate: true },
  });
  expect(
    parseBackupCli(["restore", "b.frmbak", "--to", "x.db", "--replace"]),
  ).toEqual({
    ok: true,
    value: {
      action: "restore",
      file: resolve("b.frmbak"),
      to: resolve("x.db"),
      replace: true,
    },
  });
  for (const bad of [
    ["restore", "b.frmbak"],
    ["restore", "a", "b", "--to", "x"],
    ["restore", "a", "--to", "x", "--rotate"],
    ["backup", "--to", "x"],
    ["backup", "--rotate"],
    ["backup", "now"],
    ["backup", "--key", "x"],
  ]) {
    expect(parseBackupCli(bad).ok, bad.join(" ")).toBe(false);
  }
  expect(parseCli(["restore", "b", "--to", "x"])).toMatchObject({
    ok: true,
    value: { command: "backup", options: { action: "restore" } },
  });
  expect(USAGE).toContain("frm backup init-key [--rotate]");
  expect(USAGE).toContain("frm restore <file> --to <db-path> [--replace]");
});

/** This home's Keychain service: a test home is never the owner's `foreman`. */
const serviceOf = (dir: string): string => {
  const scope = keychainScope({ FRM_HOME: dir });
  expect(scope.owner).toBe(false);
  return scope.service;
};

test("init-key creates a key through stdin, refuses a second, and --rotate keeps the old one", async () => {
  const kc = fakeSecurity("init");
  const initEnv = { FRM_HOME: join(root, "init-home") };
  const svc = serviceOf(initEnv.FRM_HOME);
  const created = await run(
    { action: "init-key", rotate: false },
    initEnv,
    kc.bin,
  );
  expect(created.code).toBe(0);
  expect(created.out[0]).toContain(`(service ${svc}, account FRM_BACKUP_KEY)`);
  const item = join(kc.kc, `${svc}.FRM_BACKUP_KEY`);
  const first = readFileSync(item, "utf8");
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  const firstId = BackupKey.fromHex(first);
  if (!firstId.ok) throw new Error("not a key");
  expect(created.out[0]).toContain(`backup key ${firstId.value.id} created`);

  const again = await run(
    { action: "init-key", rotate: false },
    initEnv,
    kc.bin,
  );
  expect(again.code).toBe(1);
  expect(again.errs.join("\n")).toContain("--rotate");
  expect(readFileSync(item, "utf8")).toBe(first);

  const rotated = await run(
    { action: "init-key", rotate: true },
    initEnv,
    kc.bin,
  );
  expect(rotated.code).toBe(0);
  const second = readFileSync(item, "utf8");
  expect(second).toMatch(/^[0-9a-f]{64}$/);
  expect(second).not.toBe(first);
  expect(
    readFileSync(
      join(kc.kc, `${svc}.FRM_BACKUP_KEY.${firstId.value.id}`),
      "utf8",
    ),
  ).toBe(first);
  expect(rotated.out.join("\n")).toContain(
    `kept as FRM_BACKUP_KEY.${firstId.value.id}`,
  );
  // Only names ever reached argv; the values went through stdin.
  const argv = readFileSync(kc.argv, "utf8");
  expect(argv).toContain("-i");
  // Only this home's service: never the live install's.
  expect(argv).not.toMatch(/-s foreman /);
  for (const value of [first, second]) {
    expect(argv).not.toContain(value);
    expect(printed.join("\n")).not.toContain(value);
  }
});

test("frm backup writes an encrypted 0600 file and an ok row; frm restore passes integrity_check", async () => {
  const kc = fakeSecurity("round-trip");
  const dir = await home("home-rt");
  const env = { FRM_HOME: dir, FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX };
  const backup = await run({ action: "backup" }, env, kc.bin);
  expect(backup.errs).toEqual([ENV_WARNING]);
  expect(backup.code).toBe(0);
  const path = /^backup +(\S+)/.exec(backup.out[0] ?? "")?.[1] ?? "";
  expect(path).toMatch(/backups\/foreman-\d{8}T\d{9}Z\.frmbak$/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path).includes(Buffer.from("SQLite format 3"))).toBe(
    false,
  );
  expect(await lastBackup(dir)).toMatchObject({ outcome: "ok", path });

  const check = join(root, "check");
  mkdirSync(check);
  const restored = await run(
    { action: "restore", file: path, to: join(check, "r.db"), replace: false },
    env,
    kc.bin,
  );
  expect(restored.errs).toEqual([ENV_WARNING]);
  expect(restored.code).toBe(0);
  expect(restored.out).toContain("integrity ok");
  expect(restored.out.join("\n")).toContain("none pending");
  expect(existsSync(join(check, "r.db"))).toBe(true);
});

test("frm restore refuses the live database while its supervisor lock is there, and without --replace", async () => {
  const kc = fakeSecurity("live");
  const dir = await home("home-live");
  const env = { FRM_HOME: dir, FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX };
  const backup = await run({ action: "backup" }, env, kc.bin);
  const path = /^backup +(\S+)/.exec(backup.out[0] ?? "")?.[1] ?? "";
  const live = join(dir, "foreman.db");
  writeFileSync(join(dir, "supervisor.lock"), "{}");
  const locked = await run(
    { action: "restore", file: path, to: live, replace: true },
    env,
    kc.bin,
  );
  expect(locked.code).toBe(1);
  expect(locked.errs.join("\n")).toContain("supervisor.lock");
  rmSync(join(dir, "supervisor.lock"));
  const noReplace = await run(
    { action: "restore", file: path, to: live, replace: false },
    env,
    kc.bin,
  );
  expect(noReplace.code).toBe(1);
  expect(noReplace.errs.join("\n")).toContain("--replace");
});

test("a backup written with a rotated key restores through FRM_BACKUP_KEY.<id>", async () => {
  const kc = fakeSecurity("rotated");
  const dir = await home("home-rot");
  const old = BackupKey.fromHex(KEY_HEX);
  if (!old.ok) throw new Error("not a key");
  const backup = await run(
    { action: "backup" },
    { FRM_HOME: dir, FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX },
    kc.bin,
  );
  const path = /^backup +(\S+)/.exec(backup.out[0] ?? "")?.[1] ?? "";
  writeFileSync(
    join(kc.kc, `${serviceOf(dir)}.FRM_BACKUP_KEY.${old.value.id}`),
    KEY_HEX,
  );
  const restored = await run(
    { action: "restore", file: path, to: join(dir, "r.db"), replace: false },
    { FRM_HOME: dir, FRM_SECRET_FRM_BACKUP_KEY: OTHER_HEX },
    kc.bin,
  );
  // The current key came from the environment (flagged); the rotated one from the Keychain.
  expect(restored.errs).toEqual([ENV_WARNING]);
  expect(restored.code).toBe(0);
});

test("a key from the Keychain prints no warning; FRM_SECRET_FRM_BACKUP_KEY overriding it is flagged", async () => {
  const kc = fakeSecurity("from-keychain");
  const dir = await home("home-kc");
  writeFileSync(join(kc.kc, `${serviceOf(dir)}.FRM_BACKUP_KEY`), KEY_HEX);
  const quiet = await run({ action: "backup" }, { FRM_HOME: dir }, kc.bin);
  expect(quiet.code).toBe(0);
  expect(quiet.errs).toEqual([]);
  const loud = await run(
    { action: "backup" },
    { FRM_HOME: dir, FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX },
    kc.bin,
  );
  expect(loud.code).toBe(0);
  expect(loud.errs).toEqual([ENV_WARNING]);
});

test("frm backup and frm restore first sweep what a killed backup or restore left; fresh temp files stay", async () => {
  const kc = fakeSecurity("sweep");
  const dir = await home("home-sweep");
  const env = { FRM_HOME: dir, FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX };
  const at = (file: string, ms: number) => {
    writeFileSync(file, "plaintext");
    utimesSync(file, ms / 1000, ms / 1000);
    return file;
  };
  const old = clock.now() - STALE_TEMP_MS - 60_000;
  const backups = join(dir, "backups");
  mkdirSync(backups, { mode: 0o700 });
  const staleSnapshot = at(join(backups, `.snapshot-${randomUUID()}.db`), old);
  const freshStaged = at(
    join(backups, `.staged-${randomUUID()}.frmbak`),
    clock.now(),
  );
  const backup = await run({ action: "backup" }, env, kc.bin);
  expect(backup.code).toBe(0);
  expect(existsSync(staleSnapshot)).toBe(false);
  expect(existsSync(freshStaged)).toBe(true);
  const printedOut = backup.out.join("\n");
  expect(printedOut).toContain(`swept     ${staleSnapshot}`);
  const path = /^backup +(\S+)/m.exec(printedOut)?.[1] ?? "";

  const target = join(root, "sweep-target");
  mkdirSync(target);
  const u = randomUUID();
  const staleCopy = [
    at(join(target, `.r.db.restore-${u}`), old),
    at(join(target, `.r.db.restore-${u}-wal`), old),
  ];
  const freshCopy = at(
    join(target, `.r.db.restore-${randomUUID()}`),
    clock.now(),
  );
  const restored = await run(
    { action: "restore", file: path, to: join(target, "r.db"), replace: false },
    env,
    kc.bin,
  );
  expect(restored.code).toBe(0);
  for (const file of staleCopy) expect(existsSync(file), file).toBe(false);
  expect(existsSync(freshCopy)).toBe(true);
  expect(existsSync(join(target, "r.db"))).toBe(true);
});

test("no key: frm backup fails, records the attempt, and writes nothing", async () => {
  const kc = fakeSecurity("nokey");
  const dir = await home("home-nokey");
  const failed = await run({ action: "backup" }, { FRM_HOME: dir }, kc.bin);
  expect(failed.code).toBe(1);
  expect(failed.errs.join("\n")).toContain("frm backup init-key");
  expect(await lastBackup(dir)).toMatchObject({
    outcome: "failed",
    path: null,
  });
  expect(existsSync(join(dir, "backups"))).toBe(false);
  expect(readdirSync(dir).filter((f) => f.startsWith("."))).toEqual([]);
});

test("frm backup needs FRM_HOME and an existing database, and never creates one", async () => {
  const kc = fakeSecurity("usage");
  expect((await run({ action: "backup" }, {}, kc.bin)).code).toBe(2);
  const empty = join(root, "empty-home");
  mkdirSync(empty);
  const missing = await run(
    { action: "backup" },
    { FRM_HOME: empty, FRM_SECRET_FRM_BACKUP_KEY: KEY_HEX },
    kc.bin,
  );
  expect(missing.code).toBe(1);
  expect(missing.errs.join("\n")).toContain("no database");
  expect(readdirSync(empty)).toEqual([]);
});

test("sentinel: no key appears in anything frm printed", () => {
  const all = printed.join("\n");
  expect(all.length).toBeGreaterThan(0);
  for (const value of [
    KEY_HEX,
    OTHER_HEX,
    Buffer.from(KEY_HEX, "hex").toString("base64"),
  ]) {
    expect(all).not.toContain(value);
  }
});
