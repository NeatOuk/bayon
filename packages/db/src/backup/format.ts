import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { open, rm, stat, type FileHandle } from "node:fs/promises";
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import { failure } from "../errors.js";
import type { BackupKey } from "./key.js";

// The encrypted backup file (§14), version 1:
//
//   magic   8 bytes   "FRMBAK01" (never SQLite's "SQLite format 3\0": a stray copy is not a DB)
//   length  4 bytes   the header's byte length, big-endian, at most MAX_HEADER
//   header  JSON      BackupHeader: v, alg, key_id, iv, created_at, bytes
//   data    `bytes`   the SQLite snapshot, AES-256-GCM
//   tag     16 bytes  the GCM tag
//
// magic, length and header are the GCM additional data, so a changed header fails the tag like a
// changed byte of data. The header holds the key's id (a one-way hash), never the key.

export const BACKUP_MAGIC = Buffer.from("FRMBAK01", "ascii");
const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HEADER = 4_096;
const PREFIX_FIXED = BACKUP_MAGIC.length + 4;
const CHUNK = 1 << 20;

export const BackupHeader = z.strictObject({
  v: z.literal(1),
  alg: z.literal(ALG),
  /** backupKeyId of the key that encrypted it. */
  key_id: z.string().regex(/^[0-9a-f]{16}$/),
  /** The GCM nonce, hex: fresh per file. */
  iv: z.string().regex(/^[0-9a-f]{24}$/),
  created_at: z.int().nonnegative(),
  /** The plaintext (and ciphertext) length. */
  bytes: z.int().nonnegative(),
});
export type BackupHeader = z.infer<typeof BackupHeader>;

const invalid = (message: string): Result<never> =>
  err(failure("validation", message));

const ioFailure = (what: string, e: unknown): Result<never> =>
  err(
    failure(
      "internal",
      `${what}: ${e instanceof Error ? e.message : String(e)}`,
    ),
  );

function prefixOf(header: BackupHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([BACKUP_MAGIC, length, json]);
}

/** Reads exactly `length` bytes at `position`, or fewer at end of file. */
async function readAt(
  fh: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(
      buffer,
      got,
      length - got,
      position + got,
    );
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buffer.subarray(0, got);
}

async function writeAll(fh: FileHandle, data: Uint8Array): Promise<void> {
  let done = 0;
  while (done < data.length) {
    const { bytesWritten } = await fh.write(data, done, data.length - done);
    done += bytesWritten;
  }
}

export interface OpenedBackup {
  readonly header: BackupHeader;
  /** magic + length + header: the GCM additional data. */
  readonly prefix: Buffer;
  /** The file's size in bytes. */
  readonly size: number;
}

/** Reads and checks a backup file's header; nothing is decrypted. */
export async function readBackupHeader(
  path: string,
): Promise<Result<OpenedBackup>> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const fixed = await readAt(fh, PREFIX_FIXED, 0);
    if (
      fixed.length < PREFIX_FIXED ||
      !fixed.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)
    ) {
      return invalid(`${path} is not a foreman backup (no FRMBAK01 header)`);
    }
    const length = fixed.readUInt32BE(BACKUP_MAGIC.length);
    if (length === 0 || length > MAX_HEADER) {
      return invalid(`${path}: a header of ${length} bytes is not a backup's`);
    }
    const json = await readAt(fh, length, PREFIX_FIXED);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(json.toString("utf8")) as unknown;
    } catch {
      return invalid(`${path}: the backup header is not JSON`);
    }
    const header = BackupHeader.safeParse(parsedJson);
    if (!header.success) {
      return invalid(
        `${path}: the backup header is not version 1: ${z.prettifyError(header.error)}`,
      );
    }
    const prefix = Buffer.concat([fixed, json]);
    if (size !== prefix.length + header.data.bytes + TAG_BYTES) {
      return invalid(
        `${path} is ${size} bytes; its header says ${prefix.length + header.data.bytes + TAG_BYTES}: truncated or extended`,
      );
    }
    return ok({ header: header.data, prefix, size });
  } catch (e) {
    return ioFailure(`cannot read ${path}`, e);
  } finally {
    await fh?.close();
  }
}

export interface EncryptOptions {
  /** The plaintext: a snapshot file. */
  readonly src: string;
  /** Created here (exclusive, mode 0600); removed again if anything fails. */
  readonly dst: string;
  readonly key: BackupKey;
  readonly createdAt: number;
}

/** Encrypts `src` into a new file `dst`, synced before it resolves. */
export async function encryptFile(
  o: EncryptOptions,
): Promise<Result<BackupHeader>> {
  let src: FileHandle | undefined;
  let dst: FileHandle | undefined;
  let created = false;
  let finished = false;
  try {
    const { size } = await stat(o.src);
    const iv = randomBytes(IV_BYTES);
    const header: BackupHeader = {
      v: 1,
      alg: ALG,
      key_id: o.key.id,
      iv: iv.toString("hex"),
      created_at: o.createdAt,
      bytes: size,
    };
    const prefix = prefixOf(header);
    const cipher = createCipheriv(ALG, o.key.bytes(), iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(prefix);
    src = await open(o.src, "r");
    dst = await open(o.dst, "wx", 0o600);
    created = true;
    await writeAll(dst, prefix);
    let done = 0;
    for (;;) {
      const chunk = await readAt(src, CHUNK, done);
      if (chunk.length === 0) break;
      done += chunk.length;
      await writeAll(dst, cipher.update(chunk));
    }
    if (done !== size) {
      return invalid(`${o.src} changed while it was encrypted`);
    }
    await writeAll(dst, cipher.final());
    await writeAll(dst, cipher.getAuthTag());
    await dst.datasync();
    finished = true;
    return ok(header);
  } catch (e) {
    return ioFailure(`cannot encrypt ${o.src} into ${o.dst}`, e);
  } finally {
    await src?.close();
    await dst?.close();
    // A failure leaves no partial ciphertext behind.
    if (created && !finished) await rm(o.dst, { force: true });
  }
}

export interface DecryptOptions {
  readonly src: string;
  /** Created here (exclusive, mode 0600); removed again unless the tag verifies. */
  readonly dst: string;
  readonly key: BackupKey;
}

/**
 * Decrypts `src` into a new file `dst`. The GCM tag is checked at the end: a wrong key, or any
 * changed byte of header or data, fails it, and then `dst` is removed, so no unverified plaintext
 * is left behind.
 */
export async function decryptFile(
  o: DecryptOptions,
): Promise<Result<BackupHeader>> {
  const opened = await readBackupHeader(o.src);
  if (!opened.ok) return opened;
  const { header, prefix, size } = opened.value;
  let src: FileHandle | undefined;
  let dst: FileHandle | undefined;
  let verified = false;
  let created = false;
  try {
    src = await open(o.src, "r");
    const tag = await readAt(src, TAG_BYTES, size - TAG_BYTES);
    const decipher = createDecipheriv(
      ALG,
      o.key.bytes(),
      Buffer.from(header.iv, "hex"),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(prefix);
    decipher.setAuthTag(tag);
    dst = await open(o.dst, "wx", 0o600);
    created = true;
    let done = 0;
    while (done < header.bytes) {
      const chunk = await readAt(
        src,
        Math.min(CHUNK, header.bytes - done),
        prefix.length + done,
      );
      if (chunk.length === 0) break;
      done += chunk.length;
      await writeAll(dst, decipher.update(chunk));
    }
    try {
      await writeAll(dst, decipher.final());
    } catch {
      return invalid(
        `${o.src}: the GCM tag does not verify: the wrong key, or the file was altered`,
      );
    }
    await dst.datasync();
    verified = true;
    return ok(header);
  } catch (e) {
    return ioFailure(`cannot decrypt ${o.src} into ${o.dst}`, e);
  } finally {
    await src?.close();
    await dst?.close();
    if (created && !verified) await rm(o.dst, { force: true });
  }
}
