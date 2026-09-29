// The FRM_HOME layout (§11.3): every path the supervisor and the lifecycle share.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SUPERVISOR_LOCK_FILE } from "@bayon/core";
import { BACKUPS_DIR } from "@bayon/db";
import { socketDir } from "@bayon/executors";

// Every unix socket lives in socketDir(home): FRM_HOME itself when its sockets fit in
// the 104-byte sun_path limit (the default install's does), else a short private directory under
// /tmp derived from the home alone, so the API finds the relay socket there too.

/** The control socket: one supervisor per FRM_HOME. */
export const socketPath = (home: string): string =>
  join(socketDir(home), "s.sock");

/**
 * An attach lease's tmux socket (§12.5; the design's reserved convention: tmux `-S`
 * goes under `<socket dir>/s/<short>`). The last 12 characters of a ULID, not the whole id, keep
 * the path inside the 104-byte sun_path limit (socket.ts); socketDir keeps the rest short.
 */
export const tmuxSocketPath = (home: string, sessionId: string): string =>
  join(socketDir(home), "s", sessionId.slice(-12));

/** The byte-relay socket (§12.5): a separate channel from the control socket, for
 * multiplexed binary streams (e.g. a session's pty) between the supervisor and the API. */
export const relaySocketPath = (home: string): string =>
  join(socketDir(home), "relay.sock");

/** The supervisor lock (lock.ts): taken before the socket, released last. */
export const lockPath = (home: string): string =>
  join(home, SUPERVISOR_LOCK_FILE);

/** The database file, as the db CLI finds it ($FRM_HOME/foreman.db). */
export const dbPath = (home: string): string => join(home, "foreman.db");

export const sessionDir = (home: string, sessionId: string): string =>
  join(home, "runtime", "sessions", sessionId);

/** A session's raw log: the runner's stdout, verbatim, across all its process segments. */
export const rawLogPath = (home: string, sessionId: string): string =>
  join(sessionDir(home, sessionId), "logs", "stdout.jsonl");

/** A session's pty scrollback (§12.5 point 3): a bounded ring buffer, handed to a newly-connecting
 * watcher before any live bytes, so a reattached tab isn't staring at a blank pane. */
export const ptyLogPath = (home: string, sessionId: string): string =>
  join(sessionDir(home, sessionId), "logs", "pty.log");

/** Foreman's own logs: what the log_scan probe reads (004_pulse, amendment g). */
export const logsDir = (home: string): string => join(home, "logs");

/** A pulse's probe outputs kept whole (§8.5). Not under logs/, which log_scan reads. */
export const probeOutputDir = (home: string, pulseId: string): string =>
  join(home, "runtime", "pulses", pulseId, "probes");

/** A gate's evidence files: diff.patch, subject.json, output.*, exit.json. */
export const gateArtifactsDir = (home: string, gateId: string): string =>
  join(home, "artifacts", "gates", gateId);

/** The encrypted backups (§13.2, §14), 0700: `frm backup` writes here too. */
export const backupsDir = (home: string): string => join(home, BACKUPS_DIR);

/** Archived events as gzipped JSONL (§4 retention): archive/events/<UTC day>/. */
export const eventsArchiveDir = (home: string): string =>
  join(home, "archive", "events");

/** Where capped payloads go (§8.5): logs/tool/, next to the session's raw log. */
export const toolDir = (rawLog: string): string =>
  join(dirname(rawLog), "tool");

/**
 * FRM_HOME_TAG: `fh-` and the first 24 hex of the sha256 of FRM_HOME's real
 * path. Each home has its own, stable across restarts, and nothing is stored; a moved home stops
 * matching its old processes, the safe direction. Create the home first: one that does not exist
 * yet is tagged by its absolute path, which a symlinked parent (macOS /tmp) would change.
 */
export function homeTag(home: string): string {
  let real: string;
  try {
    real = realpathSync.native(home);
  } catch {
    real = resolve(home);
  }
  return `fh-${createHash("sha256").update(real).digest("hex").slice(0, 24)}`;
}
