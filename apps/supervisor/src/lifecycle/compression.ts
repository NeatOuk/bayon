// Context compression for one session (spec M12; the design): whether its model
// calls go through the context proxy, decided once per spawn from the rows that say so, the spec
// field that turns the proxy on, and its store of originals made before the runner starts.
//
// The decision is core's `effectiveCompression` over four facts read here — the project's switch
// (`workspaces.context_compression`), the adapter's own declaration for the executor
// (`compressesContext`, Invariant 1: no runner is named here), a local executor, a session that is
// not MCP-only (the orchestrator's pulse) — and one of the supervisor's own: the session works in a
// worktree. The store is `<session root>/.foreman/ctx`, beside its worktrees; a session with no
// worktree works in the root itself, which would hold the store (the adapters refuse a store inside a
// root the session writes), so it runs uncompressed. Resolve (`Resolved.compression`) and the gate
// reviewer pick both call `sessionCompression`, so a spawn and the certificate that admits it agree.
//
// Retention (review of): the store stays with the session root when the session ends, as
// its logs do; nothing here ever deletes it. A removal would resolve `<root>/.foreman` by path after
// checking it, and a session's own shell (an unconfined runner runs as the operator's user) could
// swap it for a link in between and have the supervisor delete a directory of its choosing. Any
// future cleanup of session roots must remove the store without following links: an operator-run
// sweep with the sessions ended and no agent running, or a removal by file descriptor.
import { randomBytes } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CONTEXT_RULESET,
  CONTEXT_STORE_DIR,
  effectiveCompression,
  err,
  ok,
  type Result,
} from "@bayon/core";
import { getExecutor, getWorkspace, type Db } from "@bayon/db";
import type { RunnerAdapter, SpawnSpec } from "@bayon/runners";
import { frmError } from "./errors.js";
import { builtinToolsFor } from "./mcp.js";

/** What decides a session's compression. */
export interface CompressionFacts {
  readonly db: Db;
  readonly adapter: Pick<RunnerAdapter, "compressesContext">;
  readonly executorId: string;
  /** The session's project (`spawnProject`): whose switch it follows. Null: none, so off. */
  readonly workspaceId: string | null;
  /** The session works in a worktree (a workspace was placed); without one it runs uncompressed. */
  readonly worktree: boolean;
  readonly role: string;
}

/** Whether the project compresses its sessions' context (049); a session of no project does not. */
async function projectOn(
  db: Db,
  workspaceId: string | null,
): Promise<Result<boolean>> {
  if (workspaceId === null) return ok(false);
  const row = await getWorkspace(db, workspaceId);
  return row.ok ? ok(row.value.context_compression === 1) : row;
}

/** Whether this session's model calls go through the context proxy. */
export async function sessionCompression(
  f: CompressionFacts,
): Promise<Result<boolean>> {
  // No worktree (a pulse, a parity job): no store outside what it writes, so off with no read.
  if (!f.worktree) return ok(false);
  const on = await projectOn(f.db, f.workspaceId);
  if (!on.ok) return on;
  // Off needs no more reads: the switch is the common answer.
  if (!on.value) return ok(false);
  const executor = await getExecutor(f.db, f.executorId);
  if (!executor.ok) return executor;
  const kind = { kind: executor.value.kind };
  return ok(
    effectiveCompression({
      projectOn: on.value,
      adapterSupports: f.adapter.compressesContext?.(kind) ?? false,
      executorLocal: executor.value.kind === "local",
      mcpOnly: builtinToolsFor(f.role).builtinTools === "none",
    }),
  );
}

/** The ruleset a session pins (`sessions.context_ruleset`): this build's, or null when off. */
export const pinnedRuleset = (compression: boolean): string | null =>
  compression ? CONTEXT_RULESET : null;

/** Where a session's originals are stored: `<session root>/.foreman/ctx`, outside its worktrees. */
export const contextStoreDir = (sessionRoot: string): string =>
  join(sessionRoot, CONTEXT_STORE_DIR);

/**
 * The spec field that starts a session's proxy (SpawnSpec.contextCompression), with a fresh bearer:
 * 32 random bytes, hex. The token lives in this spec alone: never in the database, a log or argv,
 * and the session's redaction list names it (home.ts redactionList).
 */
export function contextCompressionSpec(
  sessionRoot: string,
  ruleset: string = CONTEXT_RULESET,
): Pick<SpawnSpec, "contextCompression"> {
  return {
    contextCompression: {
      ruleset,
      storeDir: contextStoreDir(sessionRoot),
      token: randomBytes(32).toString("hex"),
    },
  };
}

/**
 * The ruleset an adopt resumes a session on (D12): its pin, which this build runs when it is this
 * build's; a pin from another build resumes on this one's, and `changed` says so. Null: off.
 */
export function adoptRuleset(pinned: string | null): {
  readonly ruleset: string | null;
  readonly changed: boolean;
} {
  if (pinned === null) return { ruleset: null, changed: false };
  return pinned === CONTEXT_RULESET
    ? { ruleset: pinned, changed: false }
    : { ruleset: CONTEXT_RULESET, changed: true };
}

/** What is at `path`: nothing, a real directory, or something else (a file, a link, …). */
async function entryAt(path: string): Promise<"absent" | "dir" | "other"> {
  try {
    const st = await lstat(path);
    return st.isDirectory() && !st.isSymbolicLink() ? "dir" : "other";
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "ENOENT"
      ? "absent"
      : "other"; // unreadable: not a directory we may use
  }
}

/** `.foreman` and `.foreman/ctx`, the two entries the supervisor owns under the session root. */
async function misplacedEntry(storeDir: string): Promise<string | null> {
  for (const path of [dirname(storeDir), storeDir]) {
    if ((await entryAt(path)) === "other") return path;
  }
  return null;
}

/**
 * Makes the session's store of originals (`storeDir`, `<session root>/.foreman/ctx`, 0700) before its
 * runner starts, so the runner is granted a directory that exists (a directory it may read). Called at
 * spawn and at adopt, while no process of the session runs. `.foreman` or `ctx` there as anything but
 * a real directory (a file, a link) refuses the start as `spawn_failed`: the proxy would write where
 * that leads. Checked before and after the mkdir, which creates only what is missing.
 */
export async function ensureContextStore(
  storeDir: string,
): Promise<Result<void>> {
  const refuse = (path: string): Result<void> =>
    err(
      frmError(
        "spawn_failed",
        `the context store's path ${path} is not a plain directory: refusing to start the session`,
      ),
    );
  const before = await misplacedEntry(storeDir);
  if (before !== null) return refuse(before);
  try {
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return err(
      frmError(
        "spawn_failed",
        `cannot create the context store ${storeDir}`,
        String(e),
      ),
    );
  }
  const after = await misplacedEntry(storeDir);
  return after === null ? ok(undefined) : refuse(after);
}
