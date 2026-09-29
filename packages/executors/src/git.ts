// Git run by the supervisor, in one place: every call carries
// SAFE_GIT, so a hook or fsmonitor configured on a mirror never runs in the supervisor (M2), and
// git is its own process group, so an abort SIGKILLs the whole group and no transport helper
// (git-remote-*, ssh) or index-pack outlives it. The supervisor's host-git.ts and the container
// executor's mirror push both run git through here.
import { spawn } from "node:child_process";
import { err, ok, type Result } from "@bayon/core";
import { frmError } from "./errors.js";

/**
 * Every git call's prefix (M2): no hook and no fsmonitor whatever a config says, and no
 * auto maintenance. The maintenance pair is the an earlier change re-read (N3): `gc --auto` in a shared
 * mirror can drop unmerged commits and prune a live worktree's admin dir, and any read is enough
 * to trigger it, so no call may leave it on.
 *
 * The last pair is the an earlier change review (HIGH-2). A repo-local `credential.helper` runs a program
 * on any authenticated transport, and `core.askpass` runs one when no helper answers — verified
 * against a server returning 401, with the whole environment floor applied: `GIT_TERMINAL_PROMPT=0`
 * suppresses neither, because neither is a terminal prompt. An empty value resets the helper list
 * and clears the askpass program, and it costs nothing: the global config, which is where an
 * operator's helper would live, is already shut out below. This is what makes a fetch safe at the
 * call sites that run one in a mirror without a hardening pass first (the sweep's base fetch, a
 * gate's subject pin) — the mirror's own file is still reconciled, but no call depends on it.
 */
export const SAFE_GIT: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
  "-c",
  "credential.helper=",
  "-c",
  "core.askpass=",
];

/**
 * git's environment floor (from the an earlier change review LOW-6): system and global config can
 * carry `filter.*`, `url.*.insteadOf` and `core.sshCommand`, which run commands or redirect a
 * remote and which no `-c` can disable by wildcard — so neither file is read at all, and git never
 * stops to ask for a credential. These three keys are the module's guarantee, so they win over a
 * caller's env: a caller still brings its own PATH, HOME or git identity, but no
 * caller can hand back the system and global config this exists to shut out.
 */
export const GIT_ENV_FLOOR: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** SAFE_GIT's `-c` pairs as GIT_CONFIG_COUNT/KEY/VALUE, split at the first `=` of each. */
function configCountEnv(): Record<string, string> {
  const pairs = SAFE_GIT.filter((_, i) => i % 2 === 1).map((setting) => {
    const at = setting.indexOf("=");
    return [setting.slice(0, at), setting.slice(at + 1)] as const;
  });
  return {
    GIT_CONFIG_COUNT: String(pairs.length),
    ...Object.fromEntries(
      pairs.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
  };
}

/**
 * The git environment of every agent session: GIT_ENV_FLOOR, and SAFE_GIT's `-c` pairs
 * as GIT_CONFIG_COUNT/KEY/VALUE. The supervisor's own git carries both on every call; git the
 * **model** runs (its shell, the runner's own git calls) carries no flag of ours, so without this
 * it read the host's system config — a credential helper handing out the operator's forge login
 * among it — ran any hook or fsmonitor a config named, and followed a system `insteadOf`.
 *
 * git reads the COUNT pairs as its command scope, above every config file (the worktree's and the
 * shared mirror's own included), so no repository config can hand a pinned key back. A `-c` on
 * git's command line is read after them and still wins, which keeps the supervisor's own flags
 * (gitTokenFlags) working in a process that inherited this. Derived, never copied: a key SAFE_GIT
 * gains reaches every session at its next spawn or adopt.
 */
export const SESSION_GIT_ENV: Readonly<Record<string, string>> = {
  ...GIT_ENV_FLOOR,
  ...configCountEnv(),
};

/** GIT_ENV_FLOOR as `export` words, for a script that runs git inside a container. */
export const GIT_ENV_FLOOR_SH: string = Object.entries(GIT_ENV_FLOOR)
  .map(([key, value]) => `${key}=${value}`)
  .join(" ");

/**
 * The environment variable a delivery push reads its forge token from (spike §1.5).
 * Named here because the helper below is the only thing that reads it, and because this file is the
 * one place in the repo allowed to spell a git credential setting (`git-flags.test.ts`).
 */
export const GIT_TOKEN_ENV = "FRM_FORGE_TOKEN";

/**
 * The one host the token may be handed to: the forge's, as git names it in a
 * credential request (`host=`, with a port when the URL has one). Set beside GIT_TOKEN_ENV.
 */
export const GIT_TOKEN_HOST_ENV = "FRM_FORGE_HOST";

/**
 * git's credential helper for an authenticated https fetch or push, built on the pattern of
 * `deploy/git-credential-frm`: an inline POSIX `sh` function that reads git's whole request on
 * stdin (so git never takes a SIGPIPE), and answers only a `get` whose `protocol=https` and whose
 * `host=` is exactly GIT_TOKEN_HOST_ENV — a redirect or a submodule on another host is asked for a
 * credential and gets none. It `printf`s the token **from its own environment**. `read`, `case` and
 * `printf` are shell builtins, so the token never reaches any process's argv and never appears in
 * `ps`; nothing is written to disk, in a worktree or anywhere else (Invariant 11).
 *
 * The helper text itself carries no secret, so having it in git's argv costs nothing.
 *
 * `store` and `erase` are ignored: git can neither write the token somewhere nor delete it.
 */
const TOKEN_HELPER =
  `!f() { p=; h=; ` +
  `while IFS= read -r l || [ -n "$l" ]; do case "$l" in ` +
  `protocol=*) p="\${l#protocol=}" ;; host=*) h="\${l#host=}" ;; esac; l=; done; ` +
  `[ "$1" = get ] && [ "$p" = https ] && [ -n "$${GIT_TOKEN_HOST_ENV}" ] && ` +
  `[ "$h" = "$${GIT_TOKEN_HOST_ENV}" ] || exit 0; ` +
  `printf 'username=x-access-token\npassword=%s\n' "$${GIT_TOKEN_ENV}"; }; f`;

/**
 * The `-c` pair that makes git answer an https credential prompt from GIT_TOKEN_ENV. Pass it inside
 * `args`, so `safeGitArgs` puts it **after** SAFE_GIT: SAFE_GIT's empty `credential.helper` resets
 * the list (shutting out every repo-local, system and global helper) and this is then the only one
 * git will run. `core.askpass` stays cleared and `GIT_TERMINAL_PROMPT=0` stays set, so a call with
 * no token in its environment fails rather than asking anybody anything.
 */
export const gitTokenFlags = (): readonly string[] => [
  "-c",
  `credential.helper=${TOKEN_HELPER}`,
];

/** The environment gitTokenFlags' helper reads: the token, and the one host it answers for. */
export const gitTokenEnv = (
  token: string,
  host: string,
): Readonly<Record<string, string>> => ({
  [GIT_TOKEN_ENV]: token,
  [GIT_TOKEN_HOST_ENV]: host,
});

/** Subcommands that only read: they also take `--no-optional-locks` (M2, as the API's git-facts). */
const READS = new Set([
  "cat-file",
  "config",
  "diff",
  "for-each-ref",
  "log",
  "ls-tree",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "status",
]);

/** The subcommand of `args`, past any `-C <dir>` and `-c <k=v>` pairs and `--name=value` options. */
export function gitSubcommand(args: readonly string[]): string {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    if (arg === "-C" || arg === "-c") i += 2;
    else if (arg.startsWith("--") && arg.includes("=")) i += 1;
    else return arg;
  }
  return "";
}

/** git's arguments after `git`: SAFE_GIT, `--no-optional-locks` for a read, then `args`. */
export function safeGitArgs(args: readonly string[]): string[] {
  const read = READS.has(gitSubcommand(args));
  return [...SAFE_GIT, ...(read ? ["--no-optional-locks"] : []), ...args];
}

/**
 * SAFE_GIT as shell words, for a script that runs git inside a container and so cannot call
 * safeGitArgs. `--no-optional-locks` is unconditional here: a shell wrapper does not
 * know the subcommand, and taking it on a write costs nothing. Every word is a fixed literal, so
 * there is nothing to quote.
 */
export const SAFE_GIT_SH: string = [...SAFE_GIT, "--no-optional-locks"].join(
  " ",
);

/** stdout past this SIGKILLs the group: git's answer is never unbounded. */
export const GIT_STDOUT_CAP = 16 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;

export interface GitRan {
  readonly code: number | null;
  readonly stdout: string;
  /** Its last 64 KiB. */
  readonly stderr: string;
  /** Why the group was first SIGKILLed: `signal` aborted, or stdout passed GIT_STDOUT_CAP. */
  readonly killed: "aborted" | "overflow" | null;
}

export interface GitGroupOptions {
  /** Names the call in a `spawn_failed` message. */
  readonly what: string;
  /** git's whole environment: nothing of the caller's own is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** Aborting SIGKILLs git's whole process group. */
  readonly signal: AbortSignal;
  readonly stdout?: "capture" | "ignore";
}

/**
 * `git <safeGitArgs(args)>` detached, as its own process group, to its exit whatever its code.
 * `signal` aborting, or stdout past GIT_STDOUT_CAP, SIGKILLs the whole group: every helper git
 * started dies with it, one that ignores SIGTERM too. `spawn_failed` only when git cannot start.
 */
export function runGitGroup(
  args: readonly string[],
  o: GitGroupOptions,
): Promise<Result<GitRan>> {
  const capture = o.stdout !== "ignore";
  return new Promise<Result<GitRan>>((resolve) => {
    const child = spawn("git", safeGitArgs(args), {
      detached: true,
      // The floor last: a caller brings its own identity or PATH, but none of them can hand back
      // the system and global config the floor exists to shut out.
      env: { ...o.env, ...GIT_ENV_FLOOR },
      stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let killed: GitRan["killed"] = null;
    const killGroup = (why: "aborted" | "overflow"): void => {
      killed ??= why;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is gone already.
      }
    };
    const onAbort = (): void => killGroup("aborted");
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (overflow) return;
      if (stdout.length + chunk.length > GIT_STDOUT_CAP) {
        overflow = true;
        killGroup("overflow");
        return;
      }
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_CAP);
    });
    let settled = false;
    const settle = (result: Result<GitRan>): void => {
      if (settled) return;
      settled = true;
      o.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const exited = (code: number | null): void =>
      settle(ok({ code, stdout, stderr, killed }));
    o.signal.addEventListener("abort", onAbort, { once: true });
    if (o.signal.aborted) onAbort();
    child.once("error", (e) =>
      settle(
        err(
          frmError("spawn_failed", `${o.what}: cannot run git: ${e.message}`),
        ),
      ),
    );
    // After a kill, the exit alone: a descendant that left the group may still hold the pipe.
    child.once("exit", (code) => {
      if (killed !== null) exited(code);
    });
    child.once("close", exited);
  });
}
