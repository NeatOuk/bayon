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
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { unwrap } from "../testing.js";
import { STALE_TEMP_MS, sweepBackupTemps, sweepRestoreTemps } from "./sweep.js";

// The crash sweep (security review): a dead backup's or restore's plaintext temp files go,
// a live one's stay, and nothing that is not one of them is ever touched.
const root = mkdtempSync(join(tmpdir(), "bayon-sweep-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.now();
const STALE = NOW - STALE_TEMP_MS - 60_000;

/** A file (or directory) named `name` in `dir`, last modified at `at`. */
function place(dir: string, name: string, at: number, directory = false) {
  const path = join(dir, name);
  if (directory) mkdirSync(path);
  else writeFileSync(path, "plaintext");
  utimesSync(path, at / 1000, at / 1000);
  return name;
}

test("the backups directory: stale snapshots and staged files go, fresh ones and backups stay", () => {
  const dir = join(root, "backups");
  mkdirSync(dir);
  const u = randomUUID();
  const stale = [
    place(dir, `.snapshot-${u}.db`, STALE),
    place(dir, `.snapshot-${u}.db-journal`, STALE),
    place(dir, `.staged-${randomUUID()}.frmbak`, STALE),
  ];
  const kept = [
    place(dir, `.snapshot-${randomUUID()}.db`, NOW),
    place(dir, `.staged-${randomUUID()}.frmbak`, NOW - 60_000),
    place(dir, "foreman-20260914T030000123Z.frmbak", STALE),
    place(dir, "foreman.db", STALE),
    place(dir, ".snapshot-not-a-uuid.db", STALE),
    place(dir, ".notes", STALE),
    place(dir, `.snapshot-${randomUUID()}.db`, STALE, true),
    place(dir, `.x.restore-${randomUUID()}`, STALE),
  ];
  const swept = unwrap(sweepBackupTemps(dir, NOW));
  expect(swept.failed).toEqual([]);
  expect(swept.removed.toSorted()).toEqual(
    stale.map((n) => join(dir, n)).toSorted(),
  );
  expect(readdirSync(dir).toSorted()).toEqual(kept.toSorted());
});

test("beside a restore target: a stale decrypted copy and its sidecars go, the live database stays", () => {
  const dir = join(root, "home");
  mkdirSync(dir);
  const u = randomUUID();
  const stale = [
    place(dir, `.foreman.db.restore-${u}`, STALE),
    place(dir, `.foreman.db.restore-${u}-wal`, STALE),
    place(dir, `.foreman.db.restore-${u}-shm`, STALE),
  ];
  const kept = [
    place(dir, `.foreman.db.restore-${randomUUID()}`, NOW),
    place(dir, "foreman.db", STALE),
    place(dir, "foreman.db-wal", STALE),
    place(dir, "foreman.db.replaced-20260914T030000123Z", STALE),
    place(dir, "supervisor.lock", STALE),
    place(dir, `.snapshot-${randomUUID()}.db`, STALE),
  ];
  const swept = unwrap(sweepRestoreTemps(dir, NOW));
  expect(swept.removed.toSorted()).toEqual(
    stale.map((n) => join(dir, n)).toSorted(),
  );
  expect(readdirSync(dir).toSorted()).toEqual(kept.toSorted());
});

test("an absent directory has nothing to sweep; the threshold is the caller's to lower", () => {
  expect(unwrap(sweepBackupTemps(join(root, "nowhere"), NOW))).toEqual({
    removed: [],
    failed: [],
  });
  const dir = join(root, "fresh");
  mkdirSync(dir);
  const name = place(dir, `.staged-${randomUUID()}.frmbak`, NOW - 5_000);
  expect(unwrap(sweepBackupTemps(dir, NOW, 1_000)).removed).toEqual([
    join(dir, name),
  ]);
  expect(existsSync(join(dir, name))).toBe(false);
});
