// The process groups opencode's tools run in. opencode
// starts every shell command in a group of its own, which the executor's group signals never reach:
// a `session/cancel` ends them, but a SIGKILLed host sends none. So while a turn runs the host
// records those groups, and whoever next comes (the adapter after stop('kill'), or the next host,
// as an adopt starts) kills the ones still alive.
//
// Nothing here trusts what the model can touch:
// - the record lives in the host's own dir (`hostDirOf`), a sibling of the session home that the
//   Seatbelt profile denies to the model for reads and writes, created 0700 by the host;
// - and at reap time every entry is verified afresh, independently of the file: the group's leader
//   must still be the process recorded (same pid, same start time, still its group's leader) AND
//   its working directory must be inside this session's worktree or home. The supervisor, another
//   session, or any process the operator runs is never inside them; a process that is can only be
//   one of this session's own.
// Plain JS kept as source, like schema-check.ts: the host inlines it, this module compiles it.
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The host's own dir for a session home: never under the home or the worktree. */
export const hostDirOf = (homeDir: string): string =>
  `${homeDir.replace(/\/+$/, "")}.frm-host`;

/** The record, in the host's dir. */
export const TOOL_GROUPS_FILE = "tool-groups.json";

/** `ps` columns: every process, with its parent, group and start time (lstart is five words). */
export const PS_ARGS: readonly string[] = [
  "-A",
  "-o",
  "pid=,ppid=,pgid=,lstart=",
];

/**
 * `parsePs(text)` → rows `{ pid, ppid, pgid, start }`.
 * `toolGroups(rows, root, own)` → the groups of `root`'s descendants other than `own`, each as
 *   `{ pgid, start }` of its leader (a group whose leader is gone cannot be told from a reuse).
 * `stillAlive(rows, recorded)` → the recorded groups whose leader is the same process still.
 * `lsofCwd(text)` → the cwd from `lsof -a -p <pid> -d cwd -Fn`, or undefined.
 * `inside(path, roots)` → whether `path` is one of `roots` or under one.
 */
export const TOOL_GROUPS_SOURCE = `
function parsePs(text) {
  const rows = [];
  for (const line of String(text).split("\\n")) {
    const m = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(.+?)\\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: m[4] });
  }
  return rows;
}
function toolGroups(rows, root, own) {
  const children = new Map();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const groups = new Map();
  const queue = [...(children.get(root) ?? [])];
  while (queue.length > 0) {
    const r = queue.shift();
    queue.push(...(children.get(r.pid) ?? []));
    const leader = byPid.get(r.pgid);
    if (r.pgid !== own && r.pgid > 1 && leader !== undefined) groups.set(r.pgid, { pgid: r.pgid, start: leader.start });
  }
  return [...groups.values()];
}
function stillAlive(rows, recorded) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  return (Array.isArray(recorded) ? recorded : []).filter(
    (g) => g !== null && typeof g === "object" && Number.isInteger(g.pgid) && g.pgid > 1 && byPid.get(g.pgid)?.start === g.start && byPid.get(g.pgid)?.pgid === g.pgid,
  );
}
function lsofCwd(text) {
  const line = String(text).split("\\n").find((l) => l.startsWith("n"));
  return line === undefined ? undefined : line.slice(1);
}
function inside(path, roots) {
  return typeof path === "string" && path !== "" && roots.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : r + "/"));
}
`;

type Row = { pid: number; ppid: number; pgid: number; start: string };
type Group = { pgid: number; start: string };

const compiled = new Function(
  `${TOOL_GROUPS_SOURCE}\nreturn { parsePs, toolGroups, stillAlive, lsofCwd, inside };`,
)() as {
  parsePs: (text: string) => Row[];
  toolGroups: (rows: readonly Row[], root: number, own: number) => Group[];
  stillAlive: (rows: readonly Row[], recorded: unknown) => Group[];
  lsofCwd: (text: string) => string | undefined;
  inside: (path: string | undefined, roots: readonly string[]) => boolean;
};

export const parsePs = compiled.parsePs;
export const toolGroups = compiled.toolGroups;
export const stillAlive = compiled.stillAlive;
export const lsofCwd = compiled.lsofCwd;
export const inside = compiled.inside;

/** A process's working directory, as the kernel reports it; undefined when it cannot be read. */
export function cwdOf(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    try {
      return lsofCwd(
        execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
          encoding: "utf8",
        }),
      );
    } catch {
      return undefined;
    }
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Kills the recorded tool groups that are still the same processes and still this session's (cwd
 * inside `cwd` or `homeDir`), then forgets the record. For a home on this host (a local executor).
 * Best effort: never throws. Returns the groups it killed.
 */
export function reapToolGroups(
  homeDir: string,
  cwd: string,
): readonly number[] {
  const path = join(hostDirOf(homeDir), TOOL_GROUPS_FILE);
  try {
    const recorded: unknown = JSON.parse(readFileSync(path, "utf8"));
    const rows = parsePs(
      execFileSync("ps", [...PS_ARGS], { encoding: "utf8" }),
    );
    const roots = [real(cwd), real(homeDir)];
    const killed: number[] = [];
    for (const g of stillAlive(rows, recorded)) {
      if (!inside(cwdOf(g.pgid), roots)) continue;
      try {
        process.kill(-g.pgid, "SIGKILL");
        killed.push(g.pgid);
      } catch {
        // gone between the check and the kill
      }
    }
    rmSync(path, { force: true });
    return killed;
  } catch {
    return [];
  }
}
