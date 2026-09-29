// the worked-on repository's doctrine, delivered in the system prompt. The CLI starts
// with no settings source, because a repository's own settings files can set the env the CLI and
// its tools run with and name commands it runs (hooks, helpers) with the session's credential in
// reach. Without the project source the CLI loads no CLAUDE.md either, so the adapter reads the two
// files that source loaded at the worktree's root and appends them to the preset system prompt.
// Not delivered: CLAUDE.local.md (a personal file; only the local source ever loaded it), CLAUDE.md
// files in subdirectories, and `@path` imports, which are left as written (the design).
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import { err, ok, type FrmError, type Result } from "@bayon/core";
import type { Executor, Proc } from "@bayon/executors";
import { asFrmError, frmError } from "../../errors.js";
import { writeHomeFile } from "./home-file.js";

/** The files the project source loaded at the root, in its order: delivered, and hashed. */
export const DOCTRINE_FILES = ["CLAUDE.md", ".claude/CLAUDE.md"] as const;

/** The most of the files' content one session is given; past it, the file is named instead. */
export const DOCTRINE_CAP_BYTES = 64 * 1024;

/** The CLI's own framing for these files, so the model weighs them as it did before. */
const INTRO =
  "Codebase instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: " +
  "These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

const heading = (rel: string): string =>
  `Contents of ${rel} (project instructions, checked into the codebase):`;

/** The one line that stands for whatever of `rel` is over the cap. */
export const truncationMarker = (rel: string): string =>
  `[truncated: ${rel} goes on past the ${DOCTRINE_CAP_BYTES} bytes of repository instructions a session is given; read the file itself for the rest]`;

/**
 * The text to append to the system prompt, or undefined when the worktree at `cwd` has neither
 * file (or both are empty). Read where `ex` keeps the worktree, at most DOCTRINE_CAP_BYTES of
 * content in all. A file that resolves outside the worktree, or is not a regular file, is refused
 * as `validation`: a committed symlink must not become a way to read the operator's files. The check
 * guards committed content; a live agent racing it already runs as the same user (the spike).
 */
export async function readDoctrine(
  ex: Executor,
  cwd: string,
): Promise<Result<string | undefined>> {
  const sections: string[] = [];
  let left = DOCTRINE_CAP_BYTES;
  for (const rel of DOCTRINE_FILES) {
    // One byte past what is left: enough to know the file goes on.
    const read = await readRootFile(ex, cwd, rel, left + 1);
    if (!read.ok) return read;
    if (read.value === undefined || read.value.length === 0) continue;
    const whole = read.value.length <= left;
    const shown = whole ? read.value : read.value.subarray(0, left);
    left -= shown.length;
    const text = decode(shown);
    sections.push(
      [
        heading(rel),
        "",
        whole ? text : `${text}\n${truncationMarker(rel)}`,
      ].join("\n"),
    );
  }
  return ok(
    sections.length === 0 ? undefined : [INTRO, ...sections].join("\n\n"),
  );
}

/** The takeover's copy of the doctrine, in the session's home. */
export const DOCTRINE_HOME_FILE = "repo-doctrine.md";

/**
 * The doctrine for a takeover, as a 0600 file in `homeDir` its CLI reads
 * (`--append-system-prompt-file`): tmux refuses a command over 16 KB, so the text cannot ride on
 * argv. Its path, or undefined when the worktree has no doctrine.
 */
export async function writeDoctrineFile(
  ex: Executor,
  cwd: string,
  homeDir: string,
): Promise<Result<string | undefined>> {
  const doctrine = await readDoctrine(ex, cwd);
  if (!doctrine.ok || doctrine.value === undefined) return doctrine;
  const path = join(homeDir, DOCTRINE_HOME_FILE);
  const written = await writeHomeFile(ex, path, doctrine.value);
  return written.ok ? ok(path) : written;
}

/** UTF-8, leaving out a character the cap cut in half rather than showing a replacement for it. */
const decode = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8").decode(bytes, { stream: true });

const outside = (rel: string): FrmError =>
  frmError("validation", `${rel} resolves outside the worktree`);
const notAFile = (rel: string): FrmError =>
  frmError("validation", `${rel} is not a regular file`);

/** Up to `limit` bytes of `rel` under `root`; undefined when there is no such file. */
function readRootFile(
  ex: Executor,
  root: string,
  rel: string,
  limit: number,
): Promise<Result<Uint8Array | undefined>> {
  // As claimHome decides: a worktree is this host's only on a local executor.
  return ex.kind === "local"
    ? readHere(root, rel, limit)
    : readThere(ex, root, rel, limit);
}

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
const isAbsent = (e: unknown): boolean =>
  e instanceof Error && "code" in e && ABSENT.has(String(e.code));

async function readHere(
  root: string,
  rel: string,
  limit: number,
): Promise<Result<Uint8Array | undefined>> {
  let file: string;
  let top: string;
  try {
    top = await realpath(root);
    file = await realpath(join(root, rel));
  } catch (e) {
    return isAbsent(e)
      ? ok(undefined)
      : err(asFrmError(e, "spawn_failed", `cannot read ${rel}`));
  }
  if (!file.startsWith(`${top}${sep}`)) return err(outside(rel));
  let handle: FileHandle;
  try {
    // Non-blocking, so a FIFO put in its place cannot hold the spawn open; the fstat decides.
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    return err(asFrmError(e, "spawn_failed", `cannot read ${rel}`));
  }
  try {
    if (!(await handle.stat()).isFile()) return err(notAFile(rel));
    return ok(await readUpTo(handle, limit));
  } catch (e) {
    return err(asFrmError(e, "spawn_failed", `cannot read ${rel}`));
  } finally {
    await handle.close();
  }
}

async function readUpTo(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit);
  let filled = 0;
  while (filled < limit) {
    const { bytesRead } = await handle.read(buffer, filled, limit - filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * `$1` the worktree, `$2` the file under it, `$3` how many bytes: nothing (exit 0) when it is not
 * there, 4 when it resolves outside the worktree, 5 when it is not a regular file.
 */
const READ_SH = [
  'top=$(realpath "$1") || exit 3',
  '[ -e "$1/$2" ] || exit 0',
  'file=$(realpath "$1/$2") || exit 3',
  'case "$file" in "$top"/*) ;; *) exit 4 ;; esac',
  '[ -f "$file" ] || exit 5',
  'exec head -c "$3" "$file"',
].join("\n");

/** Where the worktree is the executor's own (a container's): one fixed program, run there. */
async function readThere(
  ex: Executor,
  root: string,
  rel: string,
  limit: number,
): Promise<Result<Uint8Array | undefined>> {
  let proc: Proc;
  try {
    proc = await ex.exec(
      ["/bin/sh", "-c", READ_SH, "frm-doctrine", root, rel, String(limit)],
      {
        cwd: root,
        env: { PATH: ex.envPath ?? "/usr/bin:/bin" },
        stdin: "ignore",
      },
    );
  } catch (e) {
    return err(
      frmError("spawn_failed", `cannot read ${rel}`, {
        cause: asFrmError(e, "spawn_failed", "exec failed").message,
      }),
    );
  }
  const [stdout, stderr, status] = await Promise.all([
    bytesOf(proc.stdout),
    bytesOf(proc.stderr),
    proc.exited,
  ]);
  if (status.code === 0) {
    return ok(stdout.length === 0 ? undefined : stdout.subarray(0, limit));
  }
  if (status.code === 4) return err(outside(rel));
  if (status.code === 5) return err(notAFile(rel));
  const why = Buffer.from(stderr).toString("utf8").trim().slice(-300);
  return err(
    frmError("spawn_failed", `cannot read ${rel}`, {
      cause: `exit ${String(status.code ?? status.signal)}: ${why}`,
    }),
  );
}

async function bytesOf(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
