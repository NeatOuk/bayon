// Where an install's unix sockets live: the supervisor's control socket, the relay
// socket the API connects to, and the tmux sockets of attach leases. A socket path must fit in 104
// bytes with its NUL (macOS; Linux allows 108), so a home whose path is too long for its longest
// socket gets a short private directory instead: on macOS `frm-<12 hex of the home's real path>` in
// the account's own temp dir (`getconf DARWIN_USER_TEMP_DIR`, 0700, which no other user can squat),
// elsewhere `/tmp/frm-<uid>-<12 hex>`. It is derived from the home and the account alone — not
// from $TMPDIR, which can differ between the shell that started the supervisor and the one that
// started the API — so both find the same sockets. The
// default install's home (`~/.foreman`) and any other short home keep their sockets where they are.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { frmError } from "./errors.js";

/** macOS allows 104 bytes in sun_path, NUL included (Linux 108); the stricter limit applies. */
export const SOCKET_PATH_MAX_BYTES = 104;

/**
 * The longest name any socket takes under the directory: a tmux lease's `s/<12 chars>` (14 bytes);
 * `relay.sock` (10) and `s.sock` (6) are shorter.
 */
export const LONGEST_SOCKET_NAME_BYTES = 14;

/** Where the short directories go when the account has no private temp dir: every host has /tmp. */
const SHARED_ROOT = "/tmp";
const HASH_HEX = 12;

/**
 * A path's realpath, stable across its own creation: the realpath of its nearest existing ancestor
 * joined with the rest. So the supervisor, which creates the home, and the API, which finds it
 * made, derive the same directory even through a symlinked parent (macOS /tmp is /private/tmp).
 */
function real(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let at = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(at), ...tail.toReversed());
    } catch {
      const parent = dirname(at);
      if (parent === at) return absolute;
      tail.push(basename(at));
      at = parent;
    }
  }
}

const uid = (): number => process.getuid?.() ?? 0;

/** Whether `dir`'s longest socket fits in a unix socket address. */
export const socketsFit = (dir: string): boolean =>
  Buffer.byteLength(join(dir, "x".repeat(LONGEST_SOCKET_NAME_BYTES))) <
  SOCKET_PATH_MAX_BYTES;

let userTemp: string | null | undefined;

/**
 * The account's own temp dir on macOS (`getconf DARWIN_USER_TEMP_DIR`): per user, 0700, fixed for
 * the account whatever $TMPDIR says. Null elsewhere, or when it cannot be read. Asked once.
 */
export function darwinUserTempDir(): string | null {
  if (userTemp !== undefined) return userTemp;
  userTemp = null;
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
        encoding: "utf8",
        timeout: 2_000,
      }).trim();
      if (out.startsWith("/")) userTemp = out.replace(/\/+$/, "");
    } catch {
      userTemp = null;
    }
  }
  return userTemp;
}

export interface SocketDirOptions {
  /** Tests only: the root of the short directories (default: the account's temp dir, or /tmp). */
  readonly root?: string;
}

/**
 * The directory `home`'s sockets live in: the home itself when they fit — measured both as given
 * (the string the socket is bound with) and at its real path — else a short one.
 */
export function socketDir(home: string, o: SocketDirOptions = {}): string {
  if (socketsFit(resolve(home)) && socketsFit(real(home))) return home;
  const hash = createHash("sha256")
    .update(real(home))
    .digest("hex")
    .slice(0, HASH_HEX);
  if (o.root !== undefined) return join(o.root, `frm-${uid()}-${hash}`);
  const own = darwinUserTempDir();
  if (own !== null) {
    const dir = join(own, `frm-${hash}`);
    if (socketsFit(dir)) return dir;
  }
  return join(SHARED_ROOT, `frm-${uid()}-${hash}`);
}

const refuse = (message: string): Result<never> =>
  err(frmError("validation", message));

/**
 * Checks, reading only, that `dir` is this user's own before a socket in it is trusted: a real
 * directory (never a symlink), owned by this uid, with no group or other bits. The home itself
 * needs nothing. The API calls this before it connects to the relay socket; the supervisor after
 * it creates the directory.
 */
export function verifySocketDir(dir: string, home: string): Result<void> {
  if (dir === home) return ok(undefined);
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    return refuse(`the socket directory ${dir} cannot be read: ${String(e)}`);
  }
  if (!st.isDirectory() || st.isSymbolicLink())
    return refuse(
      `the socket directory ${dir} is not a directory of its own; remove it and start again`,
    );
  if (st.uid !== uid())
    return refuse(
      `the socket directory ${dir} belongs to another user, so root must remove it (sudo rm -rf ${dir}); then start again`,
    );
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0)
    return refuse(
      `the socket directory ${dir} is mode 0${mode.toString(8)}, open to others; chmod 700 it or remove it`,
    );
  return ok(undefined);
}

/** Checks, reading only, that a socket file is this user's: absent is fine (nothing to trust yet). */
export function verifySocketFile(path: string): Result<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return ok(undefined);
  }
  if (!st.isSocket())
    return refuse(`${path} is not a socket; remove it and start again`);
  if (st.uid !== uid())
    return refuse(
      `the socket ${path} belongs to another user; it is not this install's`,
    );
  return ok(undefined);
}

/**
 * Makes sure the short directory is this user's own before a socket goes in it: created 0700 when
 * absent, then verifySocketDir — a directory someone else left in /tmp is never used.
 */
export function ensureSocketDir(dir: string, home: string): Result<void> {
  if (dir === home) return ok(undefined);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    const code =
      e instanceof Error && "code" in e && typeof e.code === "string"
        ? e.code
        : undefined;
    if (code !== "EEXIST")
      return refuse(`cannot create the socket directory ${dir}: ${String(e)}`);
  }
  return verifySocketDir(dir, home);
}
