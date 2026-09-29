import { err, ok, type FrmError, type Result } from "@bayon/core";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { resolve, sep } from "node:path";

// The full text behind a capped event (§8.5). Large payloads live on disk in the session's runtime
// directory, `<runtime>/sessions/<id>/` (§11.3); a relative `payload_path` is relative to it. A
// file is served only if it is inside that directory once `..` and symlinks are resolved. The same
// check serves a gate's diff.patch from its artifacts directory (session-diff.ts).

export interface PayloadConfig {
  /** `<runtime>`, which holds `sessions/<id>/`; null serves no payloads. */
  readonly runtimeDir: string | null;
}

/** How a file's errors read: its noun, and the directory it must stay inside. */
export interface FileNames {
  readonly what: string;
  readonly where: string;
}

const PAYLOAD: FileNames = { what: "payload", where: "the session directory" };

/** The ids the /ws topics accept: no separators, no dots. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const MISSING = new Set(["ENOENT", "ENOTDIR"]);
const READ_NO_SYMLINK = constants.O_RDONLY | constants.O_NOFOLLOW;

const outside = (n: FileNames): string =>
  `the ${n.what} path is outside ${n.where}`;
const refused = (message: string): FrmError => ({
  class: "validation",
  message,
  retryable: false,
});
const notFound = (message: string): FrmError => ({
  class: "not_found",
  message,
  retryable: false,
});
const within = (dir: string, path: string): boolean =>
  path.startsWith(`${dir}${sep}`);
const errno = (cause: unknown): unknown =>
  cause instanceof Error && "code" in cause ? cause.code : undefined;

/** The session directory and the payload's path, checked lexically before touching the disk. */
export function payloadTarget(
  runtimeDir: string,
  sessionId: string,
  payloadPath: string,
): Result<{ readonly dir: string; readonly file: string }> {
  if (!SESSION_ID.test(sessionId))
    return err(refused(`not a session id: ${JSON.stringify(sessionId)}`));
  const dir = resolve(runtimeDir, "sessions", sessionId);
  const file = resolve(dir, payloadPath); // an absolute payloadPath stays as it is
  return within(dir, file) ? ok({ dir, file }) : err(refused(outside(PAYLOAD)));
}

async function realPath(path: string, n: FileNames): Promise<Result<string>> {
  try {
    return ok(await realpath(path));
  } catch (cause) {
    return MISSING.has(String(errno(cause)))
      ? err(notFound(`the ${n.what} file does not exist`))
      : err({
          class: "internal",
          message: `could not resolve the ${n.what} path`,
          retryable: false,
          cause,
        });
  }
}

/** An open file, already confirmed to live inside its directory. Read it from `handle` directly —
 * never re-open `path` — and close it once done. */
export interface LocatedPayload {
  readonly handle: FileHandle;
  readonly size: number;
  /** Its real path, symlinks resolved: for display, never to re-open. */
  readonly path: string;
}

/**
 * Opens `file` and confirms containment in `dir` on the file descriptor itself, so nothing after
 * this call ever re-resolves the path (TOCTOU: a symlink swapped in between the check and a later
 * re-open by path would otherwise let a caller read outside the directory).
 *
 * `file` is opened with `O_NOFOLLOW` at the point it was already confirmed (by realpath, below) to
 * resolve to a regular file inside `dir`. If that exact path was swapped for a symlink in the
 * window between the check and this open, the kernel refuses to follow it (`ELOOP`) instead of
 * silently escaping. From here on only the fd is `fstat`ed and read — never the path.
 */
export async function openWithin(
  dir: string,
  file: string,
  names: FileNames = PAYLOAD,
): Promise<Result<LocatedPayload>> {
  const realDir = await realPath(dir, names);
  if (!realDir.ok) return realDir;
  const realFile = await realPath(file, names);
  if (!realFile.ok) return realFile;
  if (!within(realDir.value, realFile.value))
    return err(refused(outside(names))); // a symlink out

  let handle: FileHandle;
  try {
    handle = await open(realFile.value, READ_NO_SYMLINK);
  } catch (cause) {
    if (String(errno(cause)) === "ELOOP") return err(refused(outside(names))); // swapped for a symlink after the check above
    return MISSING.has(String(errno(cause)))
      ? err(notFound(`the ${names.what} file does not exist`))
      : err({
          class: "internal",
          message: `could not open the ${names.what} file`,
          retryable: false,
          cause,
        });
  }

  try {
    const info = await handle.stat(); // fstat the fd we hold, not a fresh path-based stat
    if (!info.isFile()) {
      await handle.close();
      return err(notFound(`the ${names.what} is not a file`));
    }
    return ok({ handle, size: info.size, path: realFile.value });
  } catch (cause) {
    await handle.close();
    return err({
      class: "internal",
      message: `could not read the ${names.what} file`,
      retryable: false,
      cause,
    });
  }
}

/** A capped event's payload file, opened inside `<runtime>/sessions/<id>/` (see openWithin). */
export async function locatePayload(
  runtimeDir: string,
  sessionId: string,
  payloadPath: string,
): Promise<Result<LocatedPayload>> {
  const target = payloadTarget(runtimeDir, sessionId, payloadPath);
  if (!target.ok) return target;
  return openWithin(target.value.dir, target.value.file);
}
