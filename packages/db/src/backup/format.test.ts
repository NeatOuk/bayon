import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, expect, test } from "vitest";
import { unwrap } from "../testing.js";
import {
  BACKUP_MAGIC,
  decryptFile,
  encryptFile,
  readBackupHeader,
} from "./format.js";
import { BackupKey, backupKeyId } from "./key.js";

// The encrypted file format: AES-256-GCM over the snapshot, the header as additional
// data, only the key's id in the clear.
const dir = mkdtempSync(join(tmpdir(), "bayon-backup-format-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const KEY_HEX = "5e".repeat(32);
const key = unwrap(BackupKey.fromHex(KEY_HEX));
const other = unwrap(BackupKey.fromHex("a7".repeat(32)));
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
// More than one 1 MiB chunk, and not a multiple of it.
const plain = Buffer.concat([SQLITE_HEADER, randomBytes(2 * (1 << 20) + 17)]);
const src = join(dir, "plain.db");
writeFileSync(src, plain);

let n = 0;
const fresh = (name: string) => join(dir, `${name}-${(n += 1)}`);

async function encrypted(): Promise<string> {
  const dst = fresh("enc");
  unwrap(await encryptFile({ src, dst, key, createdAt: 1_700_000_000_000 }));
  return dst;
}

/** A copy of `file` with the byte at `at` flipped. */
function flipped(file: string, at: number): string {
  const bytes = readFileSync(file);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  const out = fresh("flipped");
  writeFileSync(out, bytes);
  return out;
}

test("round trip: the file is 0600, starts FRMBAK01 (never SQLite's header) and decrypts to the same bytes", async () => {
  const file = await encrypted();
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).equals(BACKUP_MAGIC)).toBe(true);
  expect(bytes.includes(SQLITE_HEADER)).toBe(false);
  const opened = unwrap(await readBackupHeader(file));
  expect(opened.header).toMatchObject({
    v: 1,
    alg: "aes-256-gcm",
    key_id: key.id,
    created_at: 1_700_000_000_000,
    bytes: plain.length,
  });
  const out = fresh("dec");
  unwrap(await decryptFile({ src: file, dst: out, key }));
  expect(readFileSync(out).equals(plain)).toBe(true);
  expect(statSync(out).mode & 0o777).toBe(0o600);
});

test("a wrong key fails the tag check and leaves no plaintext", async () => {
  const out = fresh("dec");
  const result = await decryptFile({
    src: await encrypted(),
    dst: out,
    key: other,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { class: "validation", message: expect.stringContaining("GCM tag") },
  });
  expect(existsSync(out)).toBe(false);
});

test("a flipped ciphertext byte fails the tag check", async () => {
  const file = await encrypted();
  const { prefix } = unwrap(await readBackupHeader(file));
  const out = fresh("dec");
  const result = await decryptFile({
    src: flipped(file, prefix.length + 12_345),
    dst: out,
    key,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("GCM tag") },
  });
  expect(existsSync(out)).toBe(false);
});

test("a changed header fails the tag check too: it is the additional data", async () => {
  const file = await encrypted();
  const bytes = readFileSync(file);
  // created_at's last digit: still a valid header, no longer the one the tag covers.
  const at = bytes.indexOf("000,") - 1;
  expect(at).toBeGreaterThan(12);
  const result = await decryptFile({
    src: flipped(file, at),
    dst: fresh("dec"),
    key,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("GCM tag") },
  });
});

test("a truncated file or a plain database is refused before anything is decrypted", async () => {
  const file = await encrypted();
  const short = fresh("short");
  writeFileSync(short, readFileSync(file).subarray(0, -1));
  expect(await readBackupHeader(short)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("truncated") },
  });
  expect(await readBackupHeader(src)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("not a foreman backup") },
  });
  const out = fresh("dec");
  expect((await decryptFile({ src: short, dst: out, key })).ok).toBe(false);
  expect(existsSync(out)).toBe(false);
});

test("a key prints, logs and serialises as its id only", () => {
  for (const shown of [
    String(key),
    JSON.stringify(key),
    inspect(key),
    `${key}`,
  ]) {
    expect(shown).toContain(key.id);
    expect(shown).not.toContain(KEY_HEX);
  }
  expect(key.hexForStore()).toBe(KEY_HEX);
});

test("the key id is a stable one-way hash; a malformed key is refused without echoing it", () => {
  expect(key.id).toMatch(/^[0-9a-f]{16}$/);
  expect(backupKeyId(Buffer.from(KEY_HEX, "hex"))).toBe(key.id);
  expect(other.id).not.toBe(key.id);
  expect(KEY_HEX).not.toContain(key.id);
  const secret = "not-hex-but-secret-9f9f9f";
  const bad = BackupKey.fromHex(secret);
  expect(bad).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(JSON.stringify(bad)).not.toContain(secret);
  expect(BackupKey.fromHex("ab".repeat(31)).ok).toBe(false);
  expect(BackupKey.fromHex(`${"AB".repeat(32)}\n`).ok).toBe(true);
  expect(BackupKey.generate().id).not.toBe(BackupKey.generate().id);
});
