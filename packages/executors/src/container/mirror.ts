// Mirrors on the docker host. The supervisor pushes a repo's refs from its own
// bare mirror into remote_root/mirror/<name>.git with a local `git push` over git's ext::
// transport, whose far end is this executor's own transport (its ssh client on the owned master)
// running one fixed script: no remote shell ever sees a path the executor did not build and check.
// git runs through ../git.ts: SAFE_GIT, and its own process group, so an abort kills
// git-remote-ext and the ssh client it started along with git.
//
// an earlier change adds the other direction, for a gate whose subject was built on a container: the same
// ext:: transport, the far end `git upload-pack` inside the session's own container, and the pack
// received by the supervisor's git into its own mirror. Nothing on the docker host reads session
// content (M3 amendment §6.1), and the supervisor is the one naming what it takes: a commit id it
// already read, onto a pin ref of its own.
import { frmError } from "../errors.js";
import { runGitGroup } from "../git.js";
import { timeoutError, type ProgramSpec } from "./transport.js";

/** What the supervisor pushes: a full object id or a ref, onto a ref; never a deletion. */
const REFSPEC =
  /^\+?(?:[0-9a-f]{40}|[0-9a-f]{64}|refs\/[A-Za-z0-9._/-]+):refs\/[A-Za-z0-9._/-]+$/;
/**
 * What the supervisor fetches back out of a session: a full object id — never a ref the
 * session could move under it — onto one of its own pin refs.
 */
const FETCH_REFSPEC =
  /^\+?(?:[0-9a-f]{40}|[0-9a-f]{64}):refs\/frm\/(?:gate|pin)\/[A-Za-z0-9_-]{1,64}$/;
const STDERR_TAIL = 500;

/** `ext::` and the argv, each argument's `%` and spaces escaped (git-remote-ext: `%%`, `% `). */
export function extUrl(argv: readonly string[]): string {
  const escaped = argv.map((arg) =>
    arg.replaceAll("%", "%%").replaceAll(" ", "% "),
  );
  return `ext::${escaped.join(" ")}`;
}

export interface PushOptions {
  /** The supervisor's bare mirror. */
  readonly localMirror: string;
  readonly refspecs: readonly string[];
  /** The far end: a program that speaks git's protocol on stdin and stdout. */
  readonly program: ProgramSpec;
  /** PATH for git; the program's own PATH goes first, so its ssh is the system's. */
  readonly path: string;
  /** Aborting (a stop or the deadline) SIGKILLs git's whole process group. */
  readonly signal: AbortSignal;
  readonly what: string;
}

/** `git push` into the far end; rejects `timeout` when `signal` aborts first. */
export async function pushMirror(o: PushOptions): Promise<void> {
  const bad = o.refspecs.find((r) => !REFSPEC.test(r) || r.includes(".."));
  if (bad !== undefined || o.refspecs.length === 0) {
    throw frmError(
      "validation",
      `${o.what}: refusing refspec ${JSON.stringify(bad ?? "(none)")}`,
    );
  }
  if (o.signal.aborted) throw timeoutError(o.what);
  const ran = await runGitGroup(
    [
      "-C",
      o.localMirror,
      "-c",
      "protocol.ext.allow=always",
      "push",
      "--quiet",
      extUrl([o.program.file, ...o.program.args]),
      ...o.refspecs,
    ],
    {
      what: o.what,
      env: {
        ...o.program.env,
        PATH: [o.program.env["PATH"], o.path].filter(Boolean).join(":"),
      },
      signal: o.signal,
      stdout: "ignore",
    },
  );
  if (!ran.ok) throw ran.error;
  const { code, stderr } = ran.value;
  // A push that finished stands, even if the deadline passed since: only a failure is a timeout.
  if (code === 0) return;
  if (o.signal.aborted) throw timeoutError(o.what);
  throw frmError(
    "spawn_failed",
    `${o.what}: git push exited ${String(code)}: ${stderr.trim().slice(-STDERR_TAIL)}`,
  );
}

/**
 * `git fetch` out of the far end into the supervisor's own bare mirror, the mirror image
 * of `pushMirror`: `--no-tags` and no FETCH_HEAD, so the only thing this can write in the mirror is
 * the pin refs the refspecs name. Rejects `timeout` when `signal` aborts first.
 */
export async function fetchMirror(o: PushOptions): Promise<void> {
  const bad = o.refspecs.find((r) => !FETCH_REFSPEC.test(r));
  if (bad !== undefined || o.refspecs.length === 0) {
    throw frmError(
      "validation",
      `${o.what}: refusing refspec ${JSON.stringify(bad ?? "(none)")}`,
    );
  }
  if (o.signal.aborted) throw timeoutError(o.what);
  const ran = await runGitGroup(
    [
      "-C",
      o.localMirror,
      "-c",
      "protocol.ext.allow=always",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      extUrl([o.program.file, ...o.program.args]),
      ...o.refspecs,
    ],
    {
      what: o.what,
      env: {
        ...o.program.env,
        PATH: [o.program.env["PATH"], o.path].filter(Boolean).join(":"),
      },
      signal: o.signal,
      stdout: "ignore",
    },
  );
  if (!ran.ok) throw ran.error;
  const { code, stderr } = ran.value;
  if (code === 0) return;
  if (o.signal.aborted) throw timeoutError(o.what);
  throw frmError(
    "spawn_failed",
    `${o.what}: git fetch exited ${String(code)}: ${stderr.trim().slice(-STDERR_TAIL)}`,
  );
}
