// Wires a session's tmux pty to its relay channel (§12.5 point 3). attach.ts starts the
// tmux session and owns its lifecycle; this module owns streaming it: attach a real pty to the same
// tmux session (Executor.pty, `tmux attach`), register a relay channel keyed by the session id so
// the API can reach it (relay.ts), and mirror output into a bounded ring-buffer file
// (pty_log_path) so a newly-connecting watcher gets recent scrollback immediately, before any live
// bytes arrive. The wire sub-protocol (data/resize/heartbeat) is @bayon/proto's pty-wire: the API
// forwards a browser frame's bytes verbatim, and this module is the only side that interprets them.
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { renewAttachLease } from "@bayon/db/supervisor";
import type { SessionRow } from "@bayon/db";
import type { Executor } from "@bayon/executors";
import { PtyFrameKind, decodePtyClientFrame } from "@bayon/proto";
import { createStreamRedactor } from "../ingest/redact.js";
import { schedule, type Ctx } from "./context.js";
import { TMUX_SESSION_NAME, tmuxArgv } from "./tmux.js";

/** A ring buffer past this size drops its oldest bytes: generous for a terminal's own scrollback,
 * small enough that a long-attached session's log never becomes its own disk problem. */
export const MAX_PTY_LOG_BYTES = 1_048_576;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Appends `chunk` to `path`, then truncates the file's *front* once it exceeds `maxBytes` — a
 * ring buffer, not a rotating log: exactly one file, always the most recent bytes. Failures are
 * swallowed (scrollback is a convenience, never load-bearing for the pty itself). */
async function appendRing(
  path: string,
  chunk: string,
  maxBytes: number,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, chunk, "utf8");
    const info = await stat(path);
    if (info.size > maxBytes) {
      // Read-modify-write the tail: rare (only once the file is already over budget), and pty
      // output is not high-frequency enough for this to matter.
      const kept = (await readFile(path, "utf8")).slice(-maxBytes);
      await writeFile(path, kept, "utf8");
    }
  } catch {
    // Scrollback is best-effort; a full disk or a permissions slip must never take the pty down.
  }
}

/** Writes a takeover's pty output to its ring-buffer file with the session's redaction list applied
 * first (Invariant 11) — the interactive CLI can print the MCP token, a granted login or the
 * context-proxy bearer, and this file outlives the takeover and is replayed to whoever attaches
 * next. Scoped to the file alone: the live relay to the browser watcher is the operator's own
 * terminal, watched as tmux draws it, and stays unredacted. `appendRing` itself is untouched — same
 * cap, same best-effort failure. */
export function ptyLogWriter(
  path: string,
  redact: readonly string[],
  maxBytes: number = MAX_PTY_LOG_BYTES,
): { write(chunk: string): Promise<void>; end(): Promise<void> } {
  const redactor = createStreamRedactor(redact);
  return {
    write: async (chunk) => {
      const out = redactor.push(chunk);
      if (out.length > 0) await appendRing(path, out, maxBytes);
    },
    end: async () => {
      const out = redactor.end();
      if (out.length > 0) await appendRing(path, out, maxBytes);
    },
  };
}

/** Registers `s`'s tmux session as a live pty and streams it over the relay, keyed by `s.id`.
 * A no-op, successfully, if `s.tmux_target` or `s.pty_log_path` is unset — attach.ts always sets
 * both together, so this only happens if something calls in out of order. */
export async function registerPtyChannel(
  ctx: Ctx,
  s: SessionRow,
  ex: Executor,
  redact: readonly string[],
): Promise<Result<void>> {
  if (ctx.relay === undefined) return ok(undefined);
  if (s.tmux_target === null || s.pty_log_path === null) return ok(undefined);
  let pty;
  try {
    pty = await ex.pty(
      tmuxArgv(s.tmux_target, "attach", "-t", TMUX_SESSION_NAME),
      {
        cwd: s.session_root,
        env: { PATH: ctx.path },
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      },
    );
  } catch (cause) {
    return err({
      class: "spawn_failed",
      message: `cannot attach a pty to ${s.tmux_target}`,
      retryable: true,
      cause,
    });
  }
  const registered = ctx.relay.register(s.id, {
    onData: (bytes) => {
      const frame = decodePtyClientFrame(bytes);
      if (frame === undefined) return;
      if (frame.kind === PtyFrameKind.Data) {
        if (frame.bytes.length > 0)
          pty.write(Buffer.from(frame.bytes).toString("utf8"));
      } else if (frame.kind === PtyFrameKind.Resize) {
        pty.resize(frame.cols, frame.rows);
      } else {
        // Heartbeat: renews the lease, best-effort — a failed renewal just lets the TTL sweep
        // (attach.ts expireAttachLeases) reclaim it on schedule instead, never an error the
        // browser sees.
        const owner = s.attach_lease_owner;
        if (owner !== null) {
          const leaseMs = ctx.settings["lifecycle.attach_lease_ms"];
          void renewAttachLease(ctx.db, s.id, owner, leaseMs);
        }
      }
    },
    onClose: () => {
      // A watcher disconnected; the pty and tmux session keep running (spec: several tabs may
      // watch, detach is the only thing that ends the pty) — nothing to do here.
    },
  });
  if (!registered.ok) {
    pty.kill();
    return registered;
  }
  const sink = registered.value;
  ctx.ptyChannels.set(s.id, { pty, sink });
  const log = ptyLogWriter(s.pty_log_path ?? "", redact, MAX_PTY_LOG_BYTES);
  void (async () => {
    for await (const chunk of pty.output) {
      sink.write(Buffer.from(chunk, "utf8"));
      await log.write(chunk);
    }
    await log.end();
  })();
  void pty.exited.then(() => {
    // On its own session queue: detach may be tearing this same channel down right now, and only
    // one of them should touch ctx.ptyChannels at a time.
    schedule(ctx, s.id, "pty exited", () => {
      if (ctx.ptyChannels.get(s.id)?.pty === pty)
        unregisterPtyChannel(ctx, s.id);
      return Promise.resolve();
    });
  });
  return ok(undefined);
}

/** Tears down `id`'s live pty and relay channel, if any. Idempotent. */
export function unregisterPtyChannel(ctx: Ctx, id: string): void {
  const entry = ctx.ptyChannels.get(id);
  if (entry === undefined) return;
  ctx.ptyChannels.delete(id);
  entry.sink.close();
  entry.pty.kill();
}
