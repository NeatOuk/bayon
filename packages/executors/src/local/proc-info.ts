// The host process table: refs, liveness and signals for the local executor.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { frmError, isErrno } from "../errors.js";
import type { KillSignal } from "../types.js";

const execFileAsync = promisify(execFile);

export interface ProcInfo {
  /** Start time, epoch seconds. With the pid it names one process, so a reused pid cannot match. */
  readonly start: number;
  /** Exited but not yet reaped by its parent. */
  readonly zombie: boolean;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
// `ps -o lstart= -o stat=` under LC_ALL=C TZ=UTC, on macOS and procps alike:
// "Sat Sep 12 15:21:40 2026     ZN"
const PS_LINE =
  /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s+(\S+)$/;

/** Reads `pid` from the process table; null when no such process exists. */
export async function readProc(pid: number): Promise<ProcInfo | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "ps",
      ["-o", "lstart=", "-o", "stat=", "-p", String(pid)],
      {
        env: {
          PATH: process.env.PATH ?? "/bin:/usr/bin",
          LC_ALL: "C",
          TZ: "UTC",
        },
      },
    ));
  } catch (err) {
    // ps exits non-zero when the pid is not in the table. Any other failure (no ps at all) must
    // surface: reading it as "dead" would have the reconciler abandon live sessions.
    if (err instanceof Error && "code" in err && typeof err.code === "number")
      return null;
    throw frmError("internal", `ps failed for pid ${pid}`, { cause: err });
  }
  const match = PS_LINE.exec(stdout.trim());
  const [, mon, day, hours, minutes, seconds, year, stat] = match ?? [];
  const start = lstartEpoch(mon, day, hours, minutes, seconds, year);
  if (start === null) {
    throw frmError(
      "internal",
      `unexpected ps output for pid ${pid}: ${JSON.stringify(stdout)}`,
    );
  }
  return { start, zombie: stat?.includes("Z") === true };
}

/**
 * `lstart`'s fields (under TZ=UTC) as epoch seconds: the basis of every local ref, shared with the
 * orphan scan (proc-scan.ts) so a listed process and its probe agree. Null when they do not parse.
 */
export function lstartEpoch(
  mon: string | undefined,
  day: string | undefined,
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  year: string | undefined,
): number | null {
  const month = MONTHS.indexOf(mon ?? "");
  if (month < 0 || day === undefined || year === undefined) return null;
  return (
    Date.UTC(
      Number(year),
      month,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
    ) / 1000
  );
}

export interface LocalRef {
  readonly pid: number;
  readonly start: number;
}

const REF = /^local:(\d+):(\d+)$/;

export function parseRef(ref: string): LocalRef {
  const match = REF.exec(ref);
  const pid = Number(match?.[1]);
  const start = Number(match?.[2]);
  // Never ours, and dangerous: kill(-0) signals the supervisor's own group, kill(-1) everything.
  if (
    match === null ||
    !Number.isSafeInteger(pid) ||
    pid < 2 ||
    !Number.isSafeInteger(start)
  ) {
    throw frmError(
      "validation",
      `not a local executor ref: ${JSON.stringify(ref)}`,
    );
  }
  return { pid, start };
}

// `ps -A -o pid= -o pgid= -o stat=`: "  812   812 Ss", one process a line.
const GROUP_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/;

/** Whether any process of group `pgid`, zombies aside, is still in the process table. */
export async function groupAlive(pgid: number): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "ps",
      ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="],
      {
        env: { PATH: process.env.PATH ?? "/bin:/usr/bin", LC_ALL: "C" },
        maxBuffer: 16 * 1024 * 1024,
      },
    ));
  } catch (err) {
    // Unlike `ps -p`, listing every process never exits non-zero on its own: surface it, since a
    // wrong "dead" would have the reconciler adopt next to a live process.
    throw frmError("internal", `ps failed listing group ${pgid}`, {
      cause: err,
    });
  }
  return stdout.split("\n").some((line) => {
    const match = GROUP_LINE.exec(line);
    return (
      match !== null &&
      Number(match[2]) === pgid &&
      match[3]?.includes("Z") !== true
    );
  });
}

/** A process that is already gone gets start 0, which probes as dead. */
export async function mintRef(pid: number): Promise<string> {
  const info = await readProc(pid);
  return `local:${pid}:${info?.start ?? 0}`;
}

/** Signals pid's process group (reaching every descendant in it), or pid alone if it leads none. */
export function signalTree(pid: number, signal: KillSignal): void {
  if (!Number.isSafeInteger(pid) || pid < 2) {
    throw frmError("validation", `refusing to signal pid ${pid}`);
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
      return;
    } catch (err) {
      if (!isErrno(err, "ESRCH")) {
        throw frmError("internal", `cannot signal ${target}`, {
          cause: err,
        });
      }
    }
  }
}
