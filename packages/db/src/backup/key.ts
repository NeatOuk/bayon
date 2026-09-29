import { createHash, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { err, ok, type Result } from "@bayon/core";
import { failure } from "../errors.js";

// The backup key (§14): 32 random bytes held in the host secret store (the Keychain,
// service foreman, account FRM_BACKUP_KEY) as 64 hex characters. Never in the DB, a log, argv, an
// error or any file but the ciphertext, whose header carries only the key id below.

/** The secret-store name of the current backup key. */
export const BACKUP_KEY_NAME = "FRM_BACKUP_KEY";

/** Where `frm backup init-key --rotate` keeps a replaced key, so its backups stay restorable. */
export const rotatedKeyName = (keyId: string): string =>
  `${BACKUP_KEY_NAME}.${keyId}`;

/**
 * Said loudly whenever FRM_SECRET_<name> in the environment, not the host secret store (the
 * Keychain, or the files on a Linux host), supplied a backup key: a stray variable would otherwise
 * redirect every backup to another key without a sign.
 */
export const backupKeyEnvWarning = (name: string = BACKUP_KEY_NAME): string =>
  `backup key read from FRM_SECRET_${name}, not the host secret store`;

const KEY_BYTES = 32;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
/** Domain-separates the id hash from any other use of the key. */
const KEY_ID_DOMAIN = "foreman backup key id v1\0";

/** A key id: the first 8 bytes of SHA-256 over a domain tag and the key, in hex. One-way. */
export function backupKeyId(bytes: Uint8Array): string {
  return createHash("sha256")
    .update(KEY_ID_DOMAIN)
    .update(bytes)
    .digest("hex")
    .slice(0, 16);
}

/**
 * An AES-256 key. Printing, logging or serialising one shows only its id: the bytes leave through
 * `bytes()` (for node:crypto) and `hexForStore()` (for the secret store's writer), nowhere else.
 */
export class BackupKey {
  readonly #bytes: Buffer;
  readonly id: string;

  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
    this.id = backupKeyId(bytes);
  }

  /** A key read from the secret store. A malformed value is refused without echoing it. */
  static fromHex(text: string, name = BACKUP_KEY_NAME): Result<BackupKey> {
    const trimmed = text.trim();
    return HEX_KEY.test(trimmed)
      ? ok(new BackupKey(Buffer.from(trimmed, "hex")))
      : err(
          failure(
            "validation",
            `${name} is not a backup key: it must be ${KEY_BYTES} bytes as ${KEY_BYTES * 2} hex characters`,
          ),
        );
  }

  /** A fresh random key: `frm backup init-key`. */
  static generate(): BackupKey {
    return new BackupKey(randomBytes(KEY_BYTES));
  }

  /** A copy of the raw bytes, for node:crypto. */
  bytes(): Buffer {
    return Buffer.from(this.#bytes);
  }

  /** The hex text the secret store holds. Only the store's writer calls this. */
  hexForStore(): string {
    return this.#bytes.toString("hex");
  }

  toString(): string {
    return `BackupKey(${this.id})`;
  }

  toJSON(): { readonly key_id: string } {
    return { key_id: this.id };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}
