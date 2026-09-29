import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { err, ok, type Clock, type Result } from "@bayon/core";
import { within } from "./deadline.js";

// The smoke's child processes (supervisor, API). Each leads its own process group, so a signal
// reaches everything it started in that group, and every group still alive is SIGKILLed when this
// process exits, however it exits: the smoke never leaves an orphan behind.

export interface ExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface Child {
  readonly name: string;
  readonly pid: number;
  readonly logPath: string;
  readonly exited: Promise<ExitStatus>;
  /** How it exited, once it has. */
  status(): ExitStatus | undefined;
  /** Signals the child's whole process group; a group already gone is fine. */
  signal(signal: NodeJS.Signals): void;
}

let groups: ReadonlySet<number> = new Set();
let reaperInstalled = false;

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group has already gone.
  }
};

/** SIGKILLs every group this process started and has not yet seen exit. */
export function reapAll(): void {
  for (const pid of groups) signalGroup(pid, "SIGKILL");
}

function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.once("exit", reapAll);
}

/** Starts `argv` in a new process group, stdout and stderr appended to `logPath`. */
export function startChild(o: {
  readonly name: string;
  readonly argv: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly logPath: string;
}): Result<Child> {
  installReaper();
  const log = openSync(o.logPath, "a");
  const [command, ...args] = o.argv;
  const child = spawn(command, args, {
    cwd: o.cwd,
    env: o.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const pid = child.pid;
  if (pid === undefined) {
    child.on("error", () => {});
    return err({
      class: "spawn_failed",
      message: `cannot start ${o.name} (${command})`,
      retryable: false,
    });
  }
  groups = new Set([...groups, pid]);
  let status: ExitStatus | undefined;
  const exited = new Promise<ExitStatus>((resolve) =>
    child.once("exit", (code, signal) => {
      groups = new Set([...groups].filter((g) => g !== pid));
      status = { code, signal };
      resolve(status);
    }),
  );
  return ok({
    name: o.name,
    pid,
    logPath: o.logPath,
    exited,
    status: () => status,
    signal: (signal) => signalGroup(pid, signal),
  });
}

/** SIGTERM, then SIGKILL if the child outlives `graceMs`. Resolves once it has exited. */
export async function stopChild(
  child: Child,
  clock: Clock,
  graceMs: number,
): Promise<ExitStatus> {
  child.signal("SIGTERM");
  const exited = await within(
    { clock, timeoutMs: graceMs, what: `${child.name} exit` },
    child.exited,
  );
  if (exited.ok) return exited.value;
  child.signal("SIGKILL");
  return child.exited;
}

/** True while `pid` exists (EPERM means it exists but is not ours). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

/** The last `lines` lines of a log, for a failure report. */
export function logTail(path: string, lines = 20): string {
  try {
    return readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .slice(-lines)
      .join("\n");
  } catch {
    return "(no log)";
  }
}
