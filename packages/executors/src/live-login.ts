// A live login file (§14): a credential the operator's own CLI owns, keeps current and
// rewrites as it rotates. Bayon reads it only where the operator granted it (a `settings` row, core
// LOGIN_IN_PLACE_KEY), and returns the rotated value to the same file.
//
// This is a second kind, not a relaxation of the secret-store reader next door. secret-file.ts
// deliberately refuses any write bit (0400/0440): a secret nothing can rewrite cannot be tampered
// with mid-run. A live login is the opposite — its owner must be able to rewrite it, so it carries
// the owner's write bit and is 0600 in practice. What is kept from the other reader: never followed
// through a symlink, never a directory, size-capped, and an error names the path, its mode or its
// size, never a byte of the value.
//
// Runner-neutral: which runner holds a login, and what the file means, live in that runner's adapter
// (Invariant 1). Here it is bytes at a path the operator named.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { frmError } from "./errors.js";

/** A login larger than this is refused: these files hold tokens, not archives. */
export const MAX_LOGIN_BYTES = 64 * 1024;

/** What a granted login file holds, and the mode it was found with (kept on write-back). */
export interface LiveLogin {
  readonly text: string;
  /** The file's permission bits, so returning the value never changes them. */
  readonly mode: number;
}

const refuse = (message: string, cause?: unknown): Result<never> =>
  err(frmError("validation", message, cause === undefined ? {} : { cause }));

const codeOf = (e: unknown): string =>
  e instanceof Error && "code" in e && typeof e.code === "string"
    ? e.code
    : "error";

const octal = (mode: number): string => mode.toString(8).padStart(4, "0");

function openFile(path: string, flags: number): Result<number> {
  if (!isAbsolute(path)) return refuse(`login file ${path} is not absolute`);
  try {
    return ok(openSync(path, flags | constants.O_NOFOLLOW));
  } catch (e) {
    const code = codeOf(e);
    return refuse(
      code === "ELOOP"
        ? `login file ${path} is a symbolic link; it must be a regular file`
        : `login file ${path} cannot be opened (${code})`,
      { code },
    );
  }
}

/**
 * The login at `path`: a regular file, never followed through a symlink, owned-and-writable by this
 * user and closed to everyone else (0600 and 0700 pass; any group or other bit, or no write bit,
 * is refused), 1 B to 64 KiB. The text comes back verbatim — no newline is stripped, since it is
 * returned to the same file byte for byte. Opened non-blocking, so a FIFO at the path is refused
 * as not a regular file instead of waiting for a writer on the event loop. `uid` is the owner it
 * must have: this process's user (tests pass another); where the platform has none, unchecked.
 */
export function readLiveLogin(
  path: string,
  uid: number | undefined = process.getuid?.(),
): Result<LiveLogin> {
  const opened = openFile(path, constants.O_RDONLY | constants.O_NONBLOCK);
  if (!opened.ok) return opened;
  const fd = opened.value;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return refuse(`login file ${path} is not a regular file`);
    if (uid !== undefined && st.uid !== uid) {
      return refuse(
        `login file ${path} is owned by uid ${st.uid}, not by this user (uid ${uid})`,
      );
    }
    const mode = st.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return refuse(
        `login file ${path} has mode ${octal(mode)}: it must be closed to group and others`,
      );
    }
    if ((mode & 0o200) === 0) {
      return refuse(
        `login file ${path} has mode ${octal(mode)}: a live login must be writable by its owner, since its own CLI rewrites it`,
      );
    }
    if (st.size === 0) return refuse(`login file ${path} is empty`);
    if (st.size > MAX_LOGIN_BYTES) {
      return refuse(
        `login file ${path} is larger than ${MAX_LOGIN_BYTES} bytes`,
      );
    }
    const buffer = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buffer, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return ok({ text: buffer.subarray(0, read).toString("utf8"), mode });
  } catch (e) {
    return refuse(`login file ${path} cannot be read (${codeOf(e)})`, {
      code: codeOf(e),
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces the login at `path` with `text`, atomically: a temp file beside it, written with `mode`
 * and fsync'd, then renamed over the target. A crash cannot leave a half-written credential, and a
 * reader never sees one. The target must already exist as a regular file — this returns a value to
 * a file the operator granted; it never creates one.
 */
export function writeLiveLogin(
  path: string,
  text: string,
  mode: number,
): Result<void> {
  const target = readLiveLogin(path);
  if (!target.ok) return target;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength === 0) return refuse(`refusing to empty ${path}`);
  if (bytes.byteLength > MAX_LOGIN_BYTES) {
    return refuse(`refusing to write more than ${MAX_LOGIN_BYTES} bytes`);
  }
  const tmp = join(dirname(path), `.frm-login-${process.pid}.tmp`);
  let fd: number;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
  } catch (e) {
    return refuse(`cannot write beside ${path} (${codeOf(e)})`, {
      code: codeOf(e),
    });
  }
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
    return ok(undefined);
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      // already closed: the rename is what failed, and the temp file is what has to go
    }
    try {
      unlinkSync(tmp);
    } catch {
      // nothing left to remove
    }
    return refuse(`cannot replace ${path} (${codeOf(e)})`, { code: codeOf(e) });
  }
}
