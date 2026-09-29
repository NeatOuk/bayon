// A runner process's exit, kept beside its raw log: its code, its signal and the
// stderr tail its adapter kept (ExitInfo, already capped), redacted with the process's own secrets
// before it is written. Forensics only: never in events (§8.5, Invariant 11), never an outcome
// (Invariant 3). Runner-neutral: it reads ExitInfo, nothing an adapter names (Invariant 1).
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { getSession } from "@bayon/db";
import type { ExitInfo } from "@bayon/runners";
import { createStreamRedactor } from "../ingest/redact.js";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";

/** The file, in the raw log's directory. */
export const STDERR_LOG = "stderr.log";
/** Past this size only the header lines are appended: a crash loop cannot fill the disk. */
export const STDERR_LOG_MAX_BYTES = 1024 * 1024;

/** One process's end, as the supervisor saw it. */
export interface ExitRecord {
  readonly ref: string;
  /** Where its segment of the raw log starts. */
  readonly segmentOffset: number;
  readonly exit: ExitInfo;
  /** The secret values its env held: none of them reaches the file. */
  readonly redact: readonly string[];
}

/** The header line: which process, how it ended, when, and where its raw log segment starts. */
export function exitHeader(r: ExitRecord, at: number): string {
  const code = r.exit.code === undefined ? "-" : String(r.exit.code);
  const signal = r.exit.signal ?? "-";
  return `--- frm: process ${r.ref} exited: code=${code} signal=${signal} at ${new Date(at).toISOString()} (raw log segment from offset ${r.segmentOffset})\n`;
}

/** The header, then the redacted stderr tail unless the file is already past its cap. */
export function renderExit(r: ExitRecord, at: number, full: boolean): string {
  const header = exitHeader(r, at);
  if (full)
    return `${header}[frm: ${STDERR_LOG} is past its cap; stderr omitted]\n`;
  if (r.exit.stderrTail === "") return header;
  // As a stream, not a record: the tail is cut at an arbitrary byte, so it may begin inside a
  // secret, whose surviving fields the stream redactor still takes out.
  const redactor = createStreamRedactor(r.redact);
  const tail = redactor.push(r.exit.stderrTail) + redactor.end();
  return tail.endsWith("\n") ? header + tail : `${header}${tail}\n`;
}

/** Appends the record to `stderr.log` beside `rawLogPath`; the file's path, or why not. */
export async function appendExitRecord(
  rawLogPath: string,
  r: ExitRecord,
  at: number,
): Promise<Result<string>> {
  const file = join(dirname(rawLogPath), STDERR_LOG);
  try {
    // One open, never through a link; its size and mode read and set on the descriptor.
    const fh = await open(file, APPEND_FLAGS, 0o600);
    try {
      await fh.chmod(0o600);
      const { size } = await fh.stat();
      await fh.write(renderExit(r, at, size >= STDERR_LOG_MAX_BYTES));
    } finally {
      await fh.close();
    }
    return ok(file);
  } catch (e) {
    return err(frmError("internal", `cannot append to ${file}`, String(e)));
  }
}

const APPEND_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW;

/** attachProcess's hook: the session's raw log names the directory; a failure is logged. */
export async function recordExit(
  ctx: Ctx,
  sessionId: string,
  r: ExitRecord,
): Promise<void> {
  const where = {
    sessionId,
    ref: r.ref,
    code: r.exit.code,
    signal: r.exit.signal,
  };
  const s = await getSession(ctx.db, sessionId);
  if (!s.ok || s.value.raw_log_path === null) {
    ctx.log.warn(
      where,
      "runner process exited; no raw log to keep its stderr beside",
    );
    return;
  }
  const written = await appendExitRecord(
    s.value.raw_log_path,
    r,
    ctx.clock.now(),
  );
  if (!written.ok) {
    ctx.log.error(
      { ...where, error: written.error },
      "cannot keep the runner's stderr",
    );
    return;
  }
  ctx.log.info({ ...where, file: written.value }, "runner process exited");
}
