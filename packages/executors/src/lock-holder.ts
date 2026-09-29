// Who holds $FRM_HOME/supervisor.lock, judged read-only: the supervisor's own lock
// (apps/supervisor/src/lock.ts) takes and clears it with this judgement, and `frm start` asks it
// before starting anything on a home. An owner counts as dead only when provably so: no such pid,
// a zombie, or a pid that now names a process started at another time. Anything unknown is alive.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import { readProc, type ProcInfo } from "./local/proc-info.js";

export const LockOwner = z.object({
  pid: z.int().positive(),
  /** When the owning process started, epoch ms (whole seconds: what ps reports). */
  started_at: z.int().nonnegative(),
  host: z.string().min(1),
  /** When it took the lock, by its supervisor's clock. */
  acquired_at: z.int(),
  /** Tells two locks of one process apart. */
  nonce: z.string().min(1),
});
export type LockOwner = z.infer<typeof LockOwner>;

/** What holds the lock file: nothing (gone), or an owner judged dead or not, with why. */
export type LockHolder =
  | "gone"
  | { readonly raw: string; readonly dead: boolean; readonly why: string };

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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads the lock at `path` and judges its owner. Writes nothing. */
export async function lockHolder(path: string): Promise<Result<LockHolder>> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return codeOf(e) === "ENOENT"
      ? ok("gone")
      : err({
          class: "internal",
          message: `cannot read ${path}: ${messageOf(e)}`,
          retryable: false,
        });
  }
  const owner = LockOwner.safeParse(parseJson(raw));
  if (!owner.success) {
    return ok({
      raw,
      dead: false,
      why: `${path} exists but is not a supervisor lock; remove it if no supervisor runs on this FRM_HOME`,
    });
  }
  return ok({ raw, ...(await judgeOwner(path, owner.data)) });
}

async function judgeOwner(
  path: string,
  owner: LockOwner,
): Promise<{ readonly dead: boolean; readonly why: string }> {
  const started = new Date(owner.started_at).toISOString();
  const holds = `another supervisor holds ${path} (pid ${owner.pid} on ${owner.host}, started ${started})`;
  if (owner.host !== hostname()) {
    return {
      dead: false,
      why: `${holds}; it is on another host, so this one cannot tell if it is alive`,
    };
  }
  let info: ProcInfo | null;
  try {
    info = await readProc(owner.pid);
  } catch (e) {
    return {
      dead: false,
      why: `${holds}; cannot tell if it is alive: ${messageOf(e)}`,
    };
  }
  if (info === null) return { dead: true, why: `pid ${owner.pid} is gone` };
  if (info.zombie) return { dead: true, why: `pid ${owner.pid} has exited` };
  if (info.start * 1000 !== owner.started_at) {
    const now = new Date(info.start * 1000).toISOString();
    return {
      dead: true,
      why: `pid ${owner.pid} now names a process started at ${now}`,
    };
  }
  return { dead: false, why: holds };
}
