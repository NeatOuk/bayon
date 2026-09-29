// `frm roots list | add <path> | remove <path>`: the folders the GUI's New project form may take a
// repo path from (`projects.local_roots`), one folder at a time. `frm settings set
// projects.local_roots` takes the whole list, so adding one there drops the rest unless every other
// is typed again; this reads the list, changes the one folder, and writes the whole list back through
// the same audited operator writer (settings.put via frm) and the same --yes gate.
// Exit codes: 0 done (or nothing to change), 1 refused path or unreachable database, 2 bad usage, no
// home, or --yes missing.
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  err,
  LOCAL_ROOTS_KEY,
  LocalRoots,
  ok,
  type Clock,
  type Result,
} from "@bayon/core";
import { getSettings, openDb, type Db } from "@bayon/db";
import { updateSettingFromCli } from "@bayon/db/operator";
import { dbPathOf } from "./db-path.js";
import { said, securityConsent } from "./settings.js";

export const ROOTS_USAGE_LINE =
  "frm roots list | frm roots add <path> [--yes] | frm roots remove <path> [--yes]";

export const ROOTS_USAGE = [
  `       ${ROOTS_USAGE_LINE}`,
  "roots: the folders the GUI's New project form may take a repo path from (projects.local_roots).",
  "  add: the folder's real path (symlinks resolved), appended to the list once; a path that does",
  "  not exist or is not a directory is refused. remove: by its real path, or as typed when the",
  "  folder is gone. Both are security changes: they print what the setting does, need --yes, and",
  "  are audited like frm settings set (settings.put via frm).",
].join("\n");

export type RootsCommand =
  | { readonly action: "list" }
  | {
      readonly action: "add" | "remove";
      readonly path: string;
      readonly yes: boolean;
    };

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** `frm roots …`: argv from the command word on. `frm roots` alone lists. */
export function parseRootsCli(argv: readonly string[]): Result<RootsCommand> {
  const yes = argv.includes("--yes");
  const [word, action = "list", path, ...rest] = argv.filter(
    (a) => a !== "--yes",
  );
  const usage = invalid(`usage: ${ROOTS_USAGE_LINE}`);
  if (word !== "roots" || rest.length > 0) return usage;
  if (action === "list") return path === undefined ? ok({ action }) : usage;
  if ((action !== "add" && action !== "remove") || path === undefined)
    return usage;
  return ok({ action, path, yes });
}

export interface RootsIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Where a relative path is from (main passes operatorCwd); default the process's cwd. */
  readonly cwd?: string;
}

/** The folder's real path; refused when it does not exist or is not a directory. */
function realFolder(path: string, cwd: string): Result<string> {
  const given = resolve(cwd, path);
  let real: string;
  try {
    real = realpathSync.native(given);
  } catch {
    return invalid(`${given} does not exist`);
  }
  return statSync(real).isDirectory()
    ? ok(real)
    : invalid(`${given} is not a directory`);
}

/** The list as stored: none when there is no row. */
function rootsOf(value: unknown): Result<readonly string[]> {
  if (value === undefined || value === null) return ok([]);
  const parsed = LocalRoots.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : invalid(
        `${LOCAL_ROOTS_KEY} holds ${JSON.stringify(value)}, not a list of folders`,
      );
}

function list(roots: readonly string[], out: (line: string) => void): void {
  if (roots.length === 0) {
    out(
      `${LOCAL_ROOTS_KEY}: none — no folder is allowed; the New project form takes only a url`,
    );
    return;
  }
  out(`${LOCAL_ROOTS_KEY}:`);
  for (const root of roots) out(`  ${root}`);
}

/** The whole new list for `cmd`: the same list when there is nothing to change. */
function nextRoots(
  cmd: Extract<RootsCommand, { action: "add" | "remove" }>,
  folder: string,
  cwd: string,
  roots: readonly string[],
): string[] {
  if (cmd.action === "add")
    return roots.includes(folder)
      ? [...roots]
      : [...new Set([...roots, folder])];
  const named = new Set([cmd.path, resolve(cwd, cmd.path), folder]);
  return roots.filter((root) => !named.has(root));
}

/**
 * Where a relative path is from: the operator's own directory under `pnpm frm` (pnpm runs the
 * script in the repo root and names the caller's directory INIT_CWD), else the process's cwd. Only
 * the frm script's INIT_CWD counts: any other lifecycle may have left one pointing anywhere.
 */
export function operatorCwd(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): string {
  const init = env["INIT_CWD"];
  return env["npm_lifecycle_event"] === "frm" &&
    init !== undefined &&
    init !== ""
    ? init
    : cwd;
}

async function listRoots(db: Db, io: RootsIo, name: string): Promise<number> {
  const rows = await getSettings(db, [LOCAL_ROOTS_KEY]);
  const roots = rows.ok ? rootsOf(rows.value.get(LOCAL_ROOTS_KEY)) : rows;
  if (!roots.ok) {
    io.err(`${name}: ${roots.error.message}`);
    return 1;
  }
  list(roots.value, io.out);
  return 0;
}

/** Runs `frm roots list|add|remove`. */
export async function runRootsCommand(
  cmd: RootsCommand,
  io: RootsIo,
): Promise<number> {
  const name = `frm roots ${cmd.action}`;
  const cwd = io.cwd ?? process.cwd();
  let folder = "";
  if (cmd.action !== "list") {
    const real = realFolder(cmd.path, cwd);
    if (cmd.action === "add" && !real.ok) {
      io.err(`${name}: nothing written: ${real.error.message}`);
      return 1;
    }
    // A folder that is gone is removed as typed.
    folder = real.ok ? real.value : resolve(cwd, cmd.path);
    const change = `${cmd.action === "add" ? "adding" : "removing"} ${folder}`;
    if (
      !securityConsent({ name, key: LOCAL_ROOTS_KEY, change, yes: cmd.yes }, io)
    )
      return 2;
  }
  const path = dbPathOf(io.env, "the database the settings are in");
  if (!path.ok) {
    io.err(`${name}: ${path.error.message}`);
    return 2;
  }
  const opened = await openDb({ path: path.value, clock: io.clock });
  if (!opened.ok) {
    io.err(`${name}: ${opened.error.message}`);
    return 1;
  }
  try {
    if (cmd.action === "list") return await listRoots(opened.value, io, name);
    // Read, changed and written in one transaction: no other write lands in between.
    const set = await updateSettingFromCli(
      opened.value,
      LOCAL_ROOTS_KEY,
      (from) => {
        const roots = rootsOf(from);
        return roots.ok ? ok(nextRoots(cmd, folder, cwd, roots.value)) : roots;
      },
    );
    if (!set.ok) {
      io.err(`${name}: nothing written: ${set.error.message}`);
      return 1;
    }
    if (set.value.changed) {
      io.out(said(set.value));
      return 0;
    }
    io.out(
      cmd.action === "add"
        ? `${folder}: already allowed; nothing written`
        : `${cmd.path}: not on the list; nothing written`,
    );
    const now = rootsOf(set.value.to);
    list(now.ok ? now.value : [], io.out);
    return 0;
  } finally {
    await opened.value.close();
  }
}
