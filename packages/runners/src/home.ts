// A session's private runner home (§11.3). Runner-neutral: each adapter keeps its state inside.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import type { Executor, Proc } from "@bayon/executors";
import { frmError } from "./errors.js";

export const HOME_LOCK = ".frm-home.lock";

const isErrno = (e: unknown, code: string): boolean =>
  e instanceof Error && "code" in e && e.code === code;

/** The claim, as one fixed program where the home is not this host's: `$1` the home, `$2` the
 * session. Exit 0 claimed (or already this session's), 3 another's (its id on stdout). */
const CLAIM_SH = [
  "set -eu",
  "umask 077",
  'mkdir -p "$1"',
  `if ( set -C; printf %s "$2" > "$1/${HOME_LOCK}" ) 2>/dev/null; then exit 0; fi`,
  `holder=$(cat "$1/${HOME_LOCK}" 2>/dev/null || true)`,
  '[ "$holder" = "$2" ] && exit 0',
  'printf %s "$holder"',
  "exit 3",
].join("\n");

const HELD = 3;

/**
 * Creates `homeDir` (0700) and claims it for one session, so two sessions never share runner
 * state (§15 #14). The same session may claim it again, e.g. to adopt after a restart. A home that
 * is its executor's (`ex` not local: a container's) is claimed there, in one program.
 */
export async function claimHome(
  homeDir: string,
  sessionId: string,
  ex?: Executor,
): Promise<Result<{ files: string[] }>> {
  if (ex !== undefined && ex.kind !== "local") {
    return claimOn(ex, homeDir, sessionId);
  }
  const lock = join(homeDir, HOME_LOCK);
  try {
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    await writeFile(lock, sessionId, { flag: "wx", mode: 0o600 });
    return ok({ files: [lock] });
  } catch (e) {
    if (!isErrno(e, "EEXIST")) {
      return err(
        frmError("internal", `cannot claim runner home ${homeDir}`, {
          cause: String(e),
        }),
      );
    }
  }
  const holder = (await readFile(lock, "utf8").catch(() => "")).trim();
  return holder === sessionId
    ? ok({ files: [lock] })
    : belongs(homeDir, holder);
}

const belongs = (homeDir: string, holder: string): Result<never> =>
  err(
    frmError(
      "conflict",
      `runner home ${homeDir} belongs to session ${holder || "(unknown)"}`,
    ),
  );

async function claimOn(
  ex: Executor,
  homeDir: string,
  sessionId: string,
): Promise<Result<{ files: string[] }>> {
  let proc: Proc;
  try {
    proc = await ex.exec(
      ["/bin/sh", "-c", CLAIM_SH, "frm-claim", homeDir, sessionId],
      {
        cwd: dirname(homeDir),
        env: { PATH: ex.envPath ?? "/usr/bin:/bin" },
        stdin: "ignore",
      },
    );
  } catch (e) {
    return err(
      frmError("internal", `cannot claim runner home ${homeDir}`, {
        cause: String(e),
      }),
    );
  }
  const [stdout, stderr, status] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
    proc.exited,
  ]);
  if (status.code === 0) return ok({ files: [join(homeDir, HOME_LOCK)] });
  if (status.code === HELD) return belongs(homeDir, stdout.trim());
  return err(
    frmError("internal", `cannot claim runner home ${homeDir}`, {
      cause: `exit ${String(status.code ?? status.signal)}: ${stderr.trim().slice(-300)}`,
    }),
  );
}

async function text(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
