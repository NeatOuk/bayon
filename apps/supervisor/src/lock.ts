// $FRM_HOME/supervisor.lock: one supervisor per FRM_HOME (Invariant 12). startSupervisor takes it
// before it touches the control socket, holds it for the process lifetime and releases it last.
//
// The lock appears whole or not at all: its content goes to a private staging file that is then
// link(2)ed into place, an atomic create-exclusive (EEXIST when a lock is there). A lock is
// cleared only when its owner is provably dead: no such pid, a zombie, or a pid that now names a
// process started at another time. Clearing renames the file aside and deletes it only if it
// still holds the dead owner's content; a lock a racer took meanwhile is linked back.
import { randomUUID } from "node:crypto";
import {
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { err, ok, type Clock, type ErrorClass, type Result } from "@bayon/core";
import {
  lockHolder,
  readProc,
  type LockOwner,
  type ProcInfo,
} from "@bayon/executors";
import type { Logger } from "pino";

/** Link attempts before giving up: each lost one means the lock changed hands meanwhile. */
const ATTEMPTS = 3;

export interface SupervisorLock {
  readonly path: string;
  /** Removes the lock file if it is still this lock. Idempotent. */
  release(): void;
}

export interface LockOptions {
  readonly path: string;
  readonly clock: Clock;
  readonly log: Logger;
}

const fail = (cls: ErrorClass, message: string): Result<never> =>
  err({ class: cls, message, retryable: false });

/** Errors here are Node's (Error) or @bayon/executors' (FrmError data). */
const messageOf = (e: unknown): string =>
  e instanceof Error
    ? e.message
    : typeof e === "object" &&
        e !== null &&
        "message" in e &&
        typeof e.message === "string"
      ? e.message
      : String(e);

const codeOf = (e: unknown): string | undefined =>
  e instanceof Error && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;

/** Takes the lock at `o.path`, or fails (`conflict`) saying who holds it. */
export async function acquireLock(
  o: LockOptions,
): Promise<Result<SupervisorLock>> {
  const self = await ownerOfThisProcess(o.clock);
  if (!self.ok) return self;
  const content = `${JSON.stringify(self.value)}\n`;
  const staging = `${o.path}.${self.value.nonce}`;
  try {
    writeFileSync(staging, content, { mode: 0o600, flag: "wx" });
  } catch (e) {
    return fail("internal", `cannot write ${staging}: ${messageOf(e)}`);
  }
  try {
    return await takeLock(o, staging, content, self.value.nonce);
  } finally {
    rmSync(staging, { force: true });
  }
}

async function ownerOfThisProcess(clock: Clock): Promise<Result<LockOwner>> {
  let info: ProcInfo | null;
  try {
    info = await readProc(process.pid);
  } catch (e) {
    return fail(
      "internal",
      `cannot read this process's start time: ${messageOf(e)}`,
    );
  }
  if (info === null) {
    return fail("internal", `ps does not list this process (${process.pid})`);
  }
  return ok({
    pid: process.pid,
    started_at: info.start * 1000,
    host: hostname(),
    acquired_at: clock.now(),
    nonce: randomUUID(),
  });
}

async function takeLock(
  o: LockOptions,
  staging: string,
  content: string,
  nonce: string,
): Promise<Result<SupervisorLock>> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const linked = link(staging, o.path);
    if (!linked.ok) return linked;
    if (linked.value) return ok(held(o, content));
    const holder = await lockHolder(o.path);
    if (!holder.ok) return holder;
    if (holder.value === "gone") continue; // released meanwhile
    if (!holder.value.dead) return fail("conflict", holder.value.why);
    const cleared = clearStale(o, holder.value.raw, nonce);
    if (!cleared.ok) return cleared;
    if (cleared.value) {
      o.log.warn(
        { path: o.path, why: holder.value.why },
        "cleared a stale supervisor lock",
      );
    }
  }
  return fail(
    "conflict",
    `${o.path} changed hands ${ATTEMPTS} times while this supervisor started: another one is starting`,
  );
}

/** True if `to` was created; false if it exists. */
function link(from: string, to: string): Result<boolean> {
  try {
    linkSync(from, to);
    return ok(true);
  } catch (e) {
    return codeOf(e) === "EEXIST"
      ? ok(false)
      : fail("internal", `cannot create ${to}: ${messageOf(e)}`);
  }
}

/**
 * Renames the stale lock aside and deletes it if it still holds `staleRaw`: true when cleared. A
 * lock a racer took between the read and the rename is linked back; if that fails, this start
 * gives up rather than take the lock from a live owner.
 */
function clearStale(
  o: LockOptions,
  staleRaw: string,
  nonce: string,
): Result<boolean> {
  const aside = `${o.path}.stale.${nonce}`;
  try {
    renameSync(o.path, aside);
  } catch (e) {
    return codeOf(e) === "ENOENT"
      ? ok(false)
      : fail("internal", `cannot move ${o.path} aside: ${messageOf(e)}`);
  }
  let moved: string | undefined;
  try {
    moved = readFileSync(aside, "utf8");
  } catch {
    moved = undefined;
  }
  if (moved === staleRaw) {
    rmSync(aside, { force: true });
    return ok(true);
  }
  try {
    linkSync(aside, o.path);
  } catch (e) {
    o.log.error(
      { path: o.path, aside, error: messageOf(e) },
      "moved a live supervisor lock aside and could not put it back",
    );
    return fail(
      "conflict",
      `${o.path} changed hands while this supervisor cleared it; its owner's lock is at ${aside}`,
    );
  }
  rmSync(aside, { force: true });
  return ok(false);
}

function held(o: LockOptions, content: string): SupervisorLock {
  let released = false;
  return {
    path: o.path,
    release() {
      if (released) return;
      released = true;
      let now: string;
      try {
        now = readFileSync(o.path, "utf8");
      } catch (e) {
        o.log.warn(
          { path: o.path, error: messageOf(e) },
          "the supervisor lock was already gone",
        );
        return;
      }
      if (now !== content) {
        o.log.error(
          { path: o.path },
          "the supervisor lock is no longer this process's; leaving it",
        );
        return;
      }
      try {
        rmSync(o.path);
      } catch (e) {
        o.log.error(
          { path: o.path, error: messageOf(e) },
          "cannot remove the supervisor lock",
        );
      }
    },
  };
}
