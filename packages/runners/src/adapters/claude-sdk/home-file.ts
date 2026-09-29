// The files this adapter writes where a session lives: the doctrine and CLI config in its
// home, and a run's structured output at SendSpec.output.path in the session's own dir. On a local
// executor it is this host's disk, as before. Where the session is the executor's own (a
// container's), one fixed program runs through Executor.exec with the content on its
// stdin, never on argv. (The MCP bearer has no file: it goes over the CLI's stdin, an earlier change.)
import { chmodSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import type { Argv, Executor, Proc } from "@bayon/executors";
import { asFrmError, frmError } from "../../errors.js";

/** `$1` the file: created 0600 under the umask, filled from stdin, and 0600 if it existed. */
const WRITE_SH = 'umask 077 && cat > "$1" && chmod 600 "$1"';

/** As claimHome decides: a home is this host's only on a local executor. */
const onThisHost = (ex: Executor): boolean => ex.kind === "local";

/** Writes `content` to `path` at 0600, where `ex` keeps the home. */
export async function writeHomeFile(
  ex: Executor,
  path: string,
  content: string,
): Promise<Result<void>> {
  if (onThisHost(ex)) {
    try {
      writeFileSync(path, content, { mode: 0o600 });
      chmodSync(path, 0o600); // a file that already existed keeps its old mode through a write
      return ok(undefined);
    } catch (e) {
      return err(asFrmError(e, "spawn_failed", `cannot write ${path}`));
    }
  }
  return run(ex, ["/bin/sh", "-c", WRITE_SH, "frm-write", path], path, content);
}

async function run(
  ex: Executor,
  argv: Argv,
  path: string,
  stdin: string,
): Promise<Result<void>> {
  const what = `write ${path}`;
  let proc: Proc;
  try {
    proc = await ex.exec(argv, {
      cwd: dirname(path),
      env: { PATH: ex.envPath ?? "/usr/bin:/bin" },
      stdin: "pipe",
    });
  } catch (e) {
    // Named for the file; the executor's own error is the cause.
    return err(
      frmError("spawn_failed", `cannot ${what}`, {
        cause: asFrmError(e, "spawn_failed", "exec failed").message,
      }),
    );
  }
  const fed = feed(proc, stdin);
  const [stderr, status] = await Promise.all([
    text(proc.stderr),
    proc.exited,
    text(proc.stdout),
  ]);
  const wrote = await fed;
  if (status.code === 0 && wrote) return ok(undefined);
  return err(
    frmError("spawn_failed", `cannot ${what}`, {
      cause: `exit ${String(status.code ?? status.signal)}: ${stderr.trim().slice(-300)}`,
    }),
  );
}

/** Writes the content and closes stdin; false when the program stopped reading first. */
async function feed(proc: Proc, stdin: string): Promise<boolean> {
  if (proc.stdin === null) return false;
  try {
    await proc.stdin.write(stdin);
    await proc.stdin.end();
    return true;
  } catch {
    return false; // it exited early: its status and stderr say why
  }
}

async function text(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
