// The local orphan scan: the processes of
// this uid whose environment holds exactly one FRM_HOME_TAG, equal to ours, and exactly one
// FRM_SESSION_ID. An environment holds secrets (OAuth tokens, API keys, MCP tokens), so each
// record is reduced at once to its two tags and nothing else of it is kept, logged, returned or put
// in an error: errors carry counts only, never output or an `execFile` error (its stdout is the env).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { SESSION_ID } from "../container/route.js";
import { frmError } from "../errors.js";
import { lstartEpoch } from "./proc-info.js";

export const HOME_TAG_ENV = "FRM_HOME_TAG";
export const SESSION_ID_ENV = "FRM_SESSION_ID";

/** A process of ours by its environment: all a scan ever returns of it. */
export interface TaggedProc {
  readonly pid: number;
  /** Start time, epoch seconds (the refs' basis, `local:<pid>:<start>`). */
  readonly start: number;
  readonly uid: number;
  readonly pgid: number;
  readonly sessionId: string;
  readonly homeTag: string;
}

/** One process table row: no argv, no environment. */
export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly uid: number;
  readonly zombie: boolean;
  readonly start: number;
}

/** Runs `ps` with these arguments and resolves to its stdout; rejects with a safe error. */
export type RunPs = (args: readonly string[]) => Promise<string>;

export interface ScanOptions {
  readonly homeTag: string;
  /** Default: process.getuid(). */
  readonly uid?: number;
  /** Default: this process. Never listed, nor its group, nor any ancestor. */
  readonly selfPid?: number;
  /** A session id this process inherited (it runs inside a session): never listed. */
  readonly inheritedSessionId?: string;
  readonly platform?: NodeJS.Platform;
  /** Test seams: the process table and a process's environ. */
  readonly ps?: RunPs;
  readonly readEnviron?: (pid: number) => Promise<Buffer | null>;
}

const META_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart="];
// "  812   1   812   501 Ss   Sat Sep 12 15:21:40 2026", under LC_ALL=C TZ=UTC.
const META_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s*$/;
// A record's first line; a line that does not start with a pid (a value holding a newline) is
// nobody's, so a token can never be matched across lines.
const COMMAND_LINE = /^\s*(\d+) (.*)$/;

/** The process table, parsed. A line it cannot read is skipped, never guessed. */
export function parseRows(stdout: string): ProcRow[] {
  return stdout.split("\n").flatMap((line) => {
    const m = META_LINE.exec(line);
    if (m === null) return [];
    const [, pid, ppid, pgid, uid, stat, mon, day, hh, mm, ss, year] = m;
    const start = lstartEpoch(mon, day, hh, mm, ss, year);
    return start === null
      ? []
      : [
          {
            pid: Number(pid),
            ppid: Number(ppid),
            pgid: Number(pgid),
            uid: Number(uid),
            zombie: stat?.includes("Z") === true,
            start,
          },
        ];
  });
}

/** `pid → the rest of its first line`, for `-o pid=,command=` listings. */
export function parseCommands(stdout: string): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const m = COMMAND_LINE.exec(line);
    if (m !== null) out.set(Number(m[1]), m[2] ?? "");
  }
  return out;
}

interface Tags {
  readonly homeTag: string;
  readonly sessionId: string;
}

/** Exactly one FRM_HOME_TAG= entry and exactly one FRM_SESSION_ID= entry, else null. */
export function tagsOf(entries: readonly string[]): Tags | null {
  const home = entries.filter((e) => e.startsWith(`${HOME_TAG_ENV}=`));
  const session = entries.filter((e) => e.startsWith(`${SESSION_ID_ENV}=`));
  const [h] = home;
  const [s] = session;
  if (home.length !== 1 || session.length !== 1 || h === undefined) return null;
  if (s === undefined) return null;
  return {
    homeTag: h.slice(HOME_TAG_ENV.length + 1),
    sessionId: s.slice(SESSION_ID_ENV.length + 1),
  };
}

/** The pids never listed: the scanner itself and every ancestor up the ppid chain. */
export function excludedPids(
  rows: readonly ProcRow[],
  selfPid: number,
): ReadonlySet<number> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out = new Set([selfPid]);
  let cur = byPid.get(selfPid)?.ppid ?? 0;
  while (cur > 1 && !out.has(cur)) {
    out.add(cur);
    cur = byPid.get(cur)?.ppid ?? 0;
  }
  return out;
}

const PS_ENV = {
  PATH: process.env["PATH"] ?? "/bin:/usr/bin",
  LC_ALL: "C",
  TZ: "UTC",
};

/** The real `ps`. Its failure never carries its output: `ps -E` prints every environment. */
export const runPs: RunPs = (args) => runPsWith("ps")(args);

/** `ps` at `program` (a test's stand-in): what runPs does, and its failures just as safe. */
export const runPsWith =
  (program: string): RunPs =>
  (args) =>
    new Promise((resolve, reject) => {
      execFile(
        program,
        [...args],
        { env: PS_ENV, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (err, stdout) => {
          if (err === null) {
            resolve(stdout);
            return;
          }
          const code = (err as { code?: unknown }).code;
          const why =
            typeof code === "number" || typeof code === "string"
              ? String(code).replace(/[^A-Za-z0-9_-]/g, "")
              : "unknown";
          reject(frmError("internal", `ps ${args[0] ?? ""} failed (${why})`));
        },
      );
    });

const readEnviron = async (pid: number): Promise<Buffer | null> => {
  try {
    return await readFile(`/proc/${pid}/environ`);
  } catch {
    return null; // gone, or not ours to read: never a match
  }
};

/** Linux: each candidate's environ, NUL-separated and exact, reduced to its tags at once. */
async function linuxTags(
  pids: readonly number[],
  read: (pid: number) => Promise<Buffer | null>,
): Promise<ReadonlyMap<number, Tags>> {
  const out = new Map<number, Tags>();
  for (const pid of pids) {
    const raw = await read(pid);
    if (raw === null) continue;
    const tags = tagsOf(raw.toString("utf8").split("\0"));
    if (tags !== null) out.set(pid, tags);
  }
  return out;
}

/**
 * macOS: `ps -E` prints the environment after the command. A record counts only when its `-E`
 * line begins with its plain line and a space; the env is that suffix, so argv never counts.
 */
async function darwinTags(
  pids: readonly number[],
  ps: RunPs,
): Promise<ReadonlyMap<number, Tags>> {
  const plain = parseCommands(await ps(["-A", "-ww", "-o", "pid=,command="]));
  const withEnv = parseCommands(
    await ps(["-A", "-E", "-ww", "-o", "pid=,command="]),
  );
  const out = new Map<number, Tags>();
  for (const pid of pids) {
    const p = plain.get(pid);
    const e = withEnv.get(pid);
    if (p === undefined || e === undefined || !e.startsWith(`${p} `)) continue;
    const tags = tagsOf(e.slice(p.length + 1).split(" "));
    if (tags !== null) out.set(pid, tags);
  }
  return out;
}

/** The processes of ours this host runs, by both tags; see the header for what is never kept. */
export async function listTaggedProcs(
  o: ScanOptions,
): Promise<readonly TaggedProc[]> {
  const ps = o.ps ?? runPs;
  const rows = parseRows(await ps(META_ARGS));
  const uid = o.uid ?? process.getuid?.() ?? -1;
  const selfPid = o.selfPid ?? process.pid;
  const excluded = excludedPids(rows, selfPid);
  const selfGroup = rows.find((r) => r.pid === selfPid)?.pgid;
  const candidates = rows.filter(
    (r) =>
      r.uid === uid &&
      !r.zombie &&
      !excluded.has(r.pid) &&
      r.pgid !== selfGroup,
  );
  const pids = candidates.map((r) => r.pid);
  const tags =
    (o.platform ?? process.platform) === "linux"
      ? await linuxTags(pids, o.readEnviron ?? readEnviron)
      : await darwinTags(pids, ps);
  return candidates.flatMap((r) => {
    const t = tags.get(r.pid);
    if (t === undefined || t.homeTag !== o.homeTag) return [];
    if (!SESSION_ID.test(t.sessionId)) return [];
    if (t.sessionId === o.inheritedSessionId) return [];
    return [
      {
        pid: r.pid,
        start: r.start,
        uid: r.uid,
        pgid: r.pgid,
        sessionId: t.sessionId,
        homeTag: t.homeTag,
      },
    ];
  });
}
