// Returning the operator's login (§14). auth.json's refresh token rotates when the CLI
// refreshes it: the copy in the session home is the current login from the moment it does, and the
// operator's own file is one rotation behind. Discarding our copy would log them out of their own
// CLI, so using their login in place obliges writing it back.
//
// Where, and when:
//
//   - **The same path it came from**, never another. The value stays out of the DB, a worktree, a
//     prompt, an event payload and a backup (§14): it moves between two 0600 files and nothing else.
//   - **At the end of every turn**, because that is the only moment the refreshed file reliably
//     exists. The turn host unlinks auth.json itself before it exits (host.ts, `exitNow`), so a
//     write-back that ran only at teardown would find nothing on every clean session and would work
//     only after a SIGKILL. `stop()` calls this once more for exactly that kill path, where the
//     home copy outlives the host.
//
// Only this process's own rotation is written back. A home copy still equal to what the
// process was handed — or to what it last returned — rotated nothing, so the granted file is not
// read, let alone written, whatever it holds now: the operator's own CLI may have rotated it since,
// and the session's copy is then a refresh token the provider has already consumed. What is written
// back is validated first, and anything that fails leaves the operator's file untouched: a
// credential we cannot vouch for is worth less than the working one already on disk (// rule). No copy, no rotation and no write is not a failure — it is the common case.
//
// Both rotating at once — this session and the operator's CLI, each from the same token — is the
// race §14 concedes: this process did rotate, so its copy is validated against the operator's newer
// file like any other rotation and, if it passes, replaces it.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { readLiveLogin, writeLiveLogin } from "@bayon/executors";
import { frmError } from "../../errors.js";
import { AUTH_FILE, authKeys } from "./home.js";

/** What one write-back did. Nothing here carries a byte of the credential. */
export type LoginReturn =
  /** The rotated login replaced the granted file. */
  | { readonly kind: "written"; readonly path: string }
  /**
   * Nothing to return: this process rotated nothing since it was handed the login or last returned
   * one (`not-rotated`), the file already holds its copy (`same`), or there is no copy (`no-copy`).
   */
  | {
      readonly kind: "unchanged";
      readonly reason: "not-rotated" | "same" | "no-copy";
    }
  /** The copy is not a login we can vouch for; the granted file was left as it was. */
  | { readonly kind: "refused"; readonly why: string };

const KEPT_KEYS = "it no longer carries every field the granted file has";
const SHORTER = "it is shorter than the granted file";
const NOT_OBJECT = "it is not a JSON object";

/**
 * Why `refreshed` may not replace `current`, or `null` when it may (§14): it parses as an object,
 * carries every key the file it replaces has, and is no shorter. Pure, and it never quotes either
 * value.
 */
export function writeBackRefusal(
  current: string,
  refreshed: string,
): string | null {
  const keys = authKeys(refreshed);
  if (keys === undefined) return NOT_OBJECT;
  const had = authKeys(current);
  if (had !== undefined && !had.every((key) => keys.includes(key))) {
    return KEPT_KEYS;
  }
  return Buffer.byteLength(refreshed, "utf8") <
    Buffer.byteLength(current, "utf8")
    ? SHORTER
    : null;
}

/** The session home's copy, or `undefined` when there is none (the host unlinked it, or no login). */
function refreshedCopy(homeDir: string): string | undefined {
  const path = join(homeDir, AUTH_FILE);
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** One write-back's outcome, and the login both sides now hold when they agree (kept in memory). */
interface Attempt {
  readonly outcome: Result<LoginReturn>;
  readonly agreed?: string;
}

function attempt(homeDir: string, path: string, known: string): Attempt {
  const refreshed = refreshedCopy(homeDir);
  if (refreshed === undefined) {
    return { outcome: ok({ kind: "unchanged", reason: "no-copy" }) };
  }
  // This process rotated nothing: the granted file is not this process's to touch.
  if (refreshed === known) {
    return { outcome: ok({ kind: "unchanged", reason: "not-rotated" }) };
  }
  const current = readLiveLogin(path);
  // The granted file is gone or no longer readable: the grant's subject is gone, and this never
  // creates a login where the operator removed one.
  if (!current.ok) return { outcome: current };
  if (current.value.text === refreshed) {
    return {
      outcome: ok({ kind: "unchanged", reason: "same" }),
      agreed: refreshed,
    };
  }
  const refusal = writeBackRefusal(current.value.text, refreshed);
  if (refusal !== null) {
    return {
      outcome: ok({
        kind: "refused",
        why: `${path} was left as it was: ${refusal}`,
      }),
    };
  }
  const written = writeLiveLogin(path, refreshed, current.value.mode);
  return written.ok
    ? { outcome: ok({ kind: "written", path }), agreed: refreshed }
    : { outcome: written };
}

/**
 * Returns the session's rotated login to the path the operator granted, when this process rotated
 * it: `known` is the login it was handed, or the one it last returned. Local executors only: the
 * home copy is read from this host's disk, which is why a granted login is refused off `local`.
 */
export function returnLogin(
  homeDir: string,
  path: string,
  known: string,
): Result<LoginReturn> {
  return attempt(homeDir, path, known).outcome;
}

/** The warning's name, so a listener (and a test) can tell it from any other. */
export const LOGIN_WARNING = "FrmLoginWriteBack";

/** `attempt`, never throwing: an exception is a refusal like any other. */
function attemptSafely(homeDir: string, path: string, known: string): Attempt {
  try {
    return attempt(homeDir, path, known);
  } catch (e) {
    return {
      outcome: err(
        frmError("internal", `the granted login at ${path} was not returned`, {
          cause: String(e),
        }),
      ),
    };
  }
}

/**
 * Never passes silently. An adapter has no logger and may not emit an event outside its mapper, so
 * a problem is raised as a process warning — the supervisor's own stderr — naming the path and the
 * reason and never a byte of the credential.
 */
function warned(outcome: Result<LoginReturn>): LoginReturn {
  if (!outcome.ok) {
    process.emitWarning(outcome.error.message, LOGIN_WARNING);
    return { kind: "refused", why: outcome.error.message };
  }
  if (outcome.value.kind === "refused") {
    process.emitWarning(outcome.value.why, LOGIN_WARNING);
  }
  return outcome.value;
}

/**
 * The write-back as one process's turns and its teardown call it (§14): `placed` is the login this
 * process was handed. Each call returns only this process's own rotation, then remembers what it
 * returned, so a later call cannot overwrite a newer rotation the operator's CLI has made since with
 * one this process already gave back. One per process: an adopt is handed the file afresh and gets
 * its own. The next turn, and `stop()`, try again after a refusal: the check re-reads both files,
 * so a transient problem repairs itself.
 */
export function loginReturner(
  homeDir: string,
  path: string,
  placed: string,
): () => LoginReturn {
  let known = placed;
  return () => {
    const a = attemptSafely(homeDir, path, known);
    if (a.agreed !== undefined) known = a.agreed;
    return warned(a.outcome);
  };
}
