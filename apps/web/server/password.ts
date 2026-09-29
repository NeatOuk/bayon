// The operator's password: scrypt from node:crypto, no native dependency.
// Stored as `scrypt$<log2 N>$<r>$<p>$<salt b64>$<hash b64>` in the secret FRM_WEB_PASSWORD_HASH; the
// password itself is never stored, logged or echoed.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { err, ok, type Result } from "@bayon/core";

/** The owner's password is at least this long: 24 random characters when generated (M4). */
export const MIN_PASSWORD_LENGTH = 20;
/** Longer input is refused before any hashing. */
export const MAX_PASSWORD_LENGTH = 1000;

const DEFAULT_LOG_N = 15;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/** 128·N·r at the largest accepted parameters is 32 MiB; two at once fit the web container. */
const MAXMEM = 64 * 1024 * 1024;
const B64 = "[A-Za-z0-9+/]+={0,2}";
const FORMAT = new RegExp(
  `^scrypt\\$(\\d{1,2})\\$(\\d{1,2})\\$(\\d)\\$(${B64})\\$(${B64})$`,
);

export interface PasswordHash {
  readonly logN: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** The stored form, checked: parameters within bounds (log N 14–15, r 1–8, p 1–2), salt ≥ 16 B. */
export function parsePasswordHash(text: string): Result<PasswordHash> {
  const m = FORMAT.exec(text.trim());
  if (m === null) {
    return invalid(
      "FRM_WEB_PASSWORD_HASH is not scrypt$<logN>$<r>$<p>$<salt>$<hash>: make it with hash-password",
    );
  }
  const [logN, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (logN < 14 || logN > 15 || r < 1 || r > 8 || p < 1 || p > 2) {
    return invalid(
      "FRM_WEB_PASSWORD_HASH has scrypt parameters out of range (log N 14–15, r 1–8, p 1–2)",
    );
  }
  const salt = Buffer.from(m[4] ?? "", "base64");
  const hash = Buffer.from(m[5] ?? "", "base64");
  if (salt.length < SALT_BYTES || hash.length < 32 || hash.length > 128) {
    return invalid("FRM_WEB_PASSWORD_HASH has a short salt or hash");
  }
  return ok({ logN, r, p, salt, hash });
}

function derive(
  password: string,
  salt: Buffer,
  params: Pick<PasswordHash, "logN" | "r" | "p">,
  keyBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyBytes,
      { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: MAXMEM },
      (e, key) => (e === null ? resolve(key) : reject(e)),
    );
  });
}

/** A new stored form for `password`; `logN` only for tests (14 is the floor). */
export async function hashPassword(
  password: string,
  o: { readonly logN?: number } = {},
): Promise<string> {
  const params = { logN: o.logN ?? DEFAULT_LOG_N, r: DEFAULT_R, p: DEFAULT_P };
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params, KEY_BYTES);
  return `scrypt$${params.logN}$${params.r}$${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Constant-time comparison of `password`'s key against the stored one. */
export async function verifyPassword(
  stored: PasswordHash,
  password: string,
): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const key = await derive(password, stored.salt, stored, stored.hash.length);
  return timingSafeEqual(key, stored.hash);
}
