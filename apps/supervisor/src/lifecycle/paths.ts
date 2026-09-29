import { dirname, join } from "node:path";
import type { Executor } from "@bayon/executors";
import { rawLogPath, sessionDir } from "../paths.js";

/** Where one session lives on disk (§11.3). */
export interface SessionPaths {
  /** The session root: its worktrees, `work/<id>` (its executor's own path when `remote`). */
  readonly root: string;
  /** `runtime/sessions/<id>`. */
  readonly dir: string;
  readonly home: string;
  readonly tmp: string;
  readonly logs: string;
  readonly prompts: string;
  /** The raw log, the write-ahead log for events, as ingest names it. */
  readonly rawLog: string;
  /** Root, home and tmp are the executor's (a container's), not this host's; `dir`, logs, prompts
   * and the raw log stay here. */
  readonly remote: boolean;
  /** PATH for the session's programs when not the supervisor's (a container image's). */
  readonly path?: string;
}

/** Session ids name directories and a git branch: letters, digits, `_` and `-` only. */
export const SESSION_ID = /^[0-9A-Za-z_-]{1,64}$/;

export function sessionPaths(frmHome: string, sessionId: string): SessionPaths {
  const dir = sessionDir(frmHome, sessionId);
  const rawLog = rawLogPath(frmHome, sessionId);
  return {
    root: join(frmHome, "work", sessionId),
    dir,
    home: join(dir, "home"),
    tmp: join(dir, "tmp"),
    logs: dirname(rawLog),
    prompts: join(dir, "prompts"),
    rawLog,
    remote: false,
  };
}

/**
 * A session's paths on its executor: an executor that places sessions itself
 * (a container) names the root, home and tmp, and the PATH its programs get; the rest is local.
 */
export function sessionPathsOn(
  frmHome: string,
  sessionId: string,
  executor: Pick<Executor, "placeSession" | "envPath"> | undefined,
): SessionPaths {
  const local = sessionPaths(frmHome, sessionId);
  const place = executor?.placeSession?.(sessionId);
  if (place === undefined) return local;
  return {
    ...local,
    root: place.root,
    home: place.home,
    tmp: place.tmp,
    remote: true,
    ...(executor?.envPath === undefined ? {} : { path: executor.envPath }),
  };
}

export const promptFile = (paths: SessionPaths, seq: number): string =>
  join(paths.prompts, `run-${seq}.md`);

/**
 * Where run n's structured output goes (SendSpec.output.path): the session's own directory, never
 * a worktree, so it cannot dirty one. The runner writes it; the gate engine reads it back through
 * the executor. A remote session's runner cannot reach this host's directory:
 * its file lives beside its home, in the root its executor mounts.
 */
export const outputFile = (paths: SessionPaths, seq: number): string =>
  paths.remote
    ? join(paths.root, ".frm", "output", `run-${seq}.json`)
    : join(paths.dir, "output", `run-${seq}.json`);
