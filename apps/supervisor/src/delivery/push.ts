import { err, ok, type FrmError, type Result } from "@bayon/core";
import { gitAuthOf, NO_GIT_AUTH } from "../forge/credential.js";
import { frmError } from "../lifecycle/errors.js";
import { hostGitRun, type HostGitCtx } from "../lifecycle/host-git.js";
import { originUrlProblem } from "../lifecycle/mirror.js";

// The push half of delivery (spike §1.3). It runs **from the repo's bare mirror**, never
// from a worktree: the branch ref is in the mirror already (`git worktree add` off a bare mirror
// keeps it there, and `publishSubmodules` fetches each submodule's branch into its own mirror for
// exactly this reason), a mirror is not agent-writable the way a worktree is, and nothing of the
// credential goes anywhere near a directory an agent can read.
//
// The remote is the repo's push target as recorded — `repos.push_url ?? repos.origin_url` (039,
// core `pushTargetOf`), set at creation or by the operator in Settings. `git remote` is never read:
// a remote an agent added inside a worktree, or the folder's own origin today, is not a target.
//
// NOTHING HERE DESTROYS WORK. There is no `--force`, no leading `+` in a refspec, no branch
// deletion and no `--prune` — and the ancestor check exists so that a refusal can say *why* rather
// than handing the operator git's "non-fast-forward" wording (§9.2's rule, applied to the remote).

/** How much of git's own words a failure keeps. */
const STDERR_TAIL = 500;

/**
 * What git said, classified (code review, MEDIUM 4). Every non-zero exit used to be
 * `spawn_failed` and `retryable: false`, so a name that would not resolve for five seconds filed an
 * operator request that only a person could close — the opposite of what the spike promises.
 *
 * Auth first, then transport: git writes `unable to access '<url>'` for both, and only the trailing
 * clause tells them apart. Anything it does not recognise stays non-retryable, because a failure
 * nobody has classified is one the operator should see.
 */
const AUTH =
  /authentication failed|could not read (?:username|password)|terminal prompts disabled|permission denied|access denied|403 forbidden|401 unauthorized|the requested url returned error: 40[13]/i;
const TRANSPORT =
  /could not resolve host|connection (?:refused|reset|timed out)|operation timed out|failed to connect|network is unreachable|temporary failure|early eof|rpc failed|ssl|tls|gnutls|the remote end hung up|returned error: 5\d\d|502 bad gateway|503 service|504 gateway/i;

export function gitFailure(
  what: string,
  r: { readonly code: number | null; readonly stderr: string },
): FrmError {
  const said = r.stderr.trim().slice(-STDERR_TAIL);
  const message = `${what} failed: ${said || `exit ${String(r.code)}`}`;
  if (AUTH.test(said)) return frmError("validation", message);
  // Retryable: the next reconciler pass tries again, and no operator request is filed for it.
  if (TRANSPORT.test(said)) {
    return { class: "runner_error", message, retryable: true };
  }
  return frmError("spawn_failed", message);
}

/** A session's branch, and only that: what a delivery is allowed to push. */
export const deliverableBranch = (branch: string): boolean =>
  branch.startsWith("frm/") &&
  !branch.includes("..") &&
  !/[~^:?*[\\\s]/.test(branch);

export interface PushAsk {
  readonly mirrorPath: string;
  /** The URL recorded on the repo row. */
  readonly remoteUrl: string;
  readonly branch: string;
  /** Offered only when the remote is https and its host has a forge kind; else null (§1.5). */
  readonly token: string | null;
  readonly signal: AbortSignal;
  /** Names the repo in a message. */
  readonly what: string;
}

export type PushOutcome =
  /** The remote did not have this commit; it does now. */
  | { readonly kind: "pushed"; readonly head: string }
  /** The remote already had exactly this commit: a re-run pushes nothing (§1.1). */
  | { readonly kind: "already"; readonly head: string };

/** `git -C <mirror> [credentials] <args>` to exit 0: its stdout, any other exit an error. */
async function git(
  ctx: HostGitCtx,
  ask: PushAsk,
  what: string,
  args: readonly string[],
  o: { readonly authenticated?: boolean } = {},
): Promise<Result<string>> {
  const { flags, env } =
    o.authenticated === true
      ? gitAuthOf(ask.token, ask.remoteUrl)
      : NO_GIT_AUTH;
  const ran = await hostGitRun(ctx, ["-C", ask.mirrorPath, ...flags, ...args], {
    what,
    signal: ask.signal,
    ...(Object.keys(env).length === 0 ? {} : { env }),
  });
  if (!ran.ok) return ran;
  return ran.value.code === 0
    ? ok(ran.value.stdout.trim())
    : err(gitFailure(what, ran.value));
}

/** `<sha>\trefs/heads/<branch>` for `branch`, or null when the remote has no such branch. */
function refSha(stdout: string, branch: string): string | null {
  for (const line of stdout.split("\n")) {
    const [sha = "", ref = ""] = line.split("\t");
    if (ref.trim() === `refs/heads/${branch}` && /^[0-9a-f]{40,}$/.test(sha)) {
      return sha;
    }
  }
  return null;
}

/**
 * The commit `ask.branch` points at in the repo's mirror — a local read, no network. The delivery
 * job asks for it before anything else, because a repo already delivered at this commit needs no
 * `ls-remote` and no forge call at all.
 */
export async function mirrorHead(
  ctx: HostGitCtx,
  ask: PushAsk,
): Promise<Result<string>> {
  const local = await git(ctx, ask, `${ask.what}: read the branch`, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${ask.branch}^{commit}`,
  ]);
  return local.ok
    ? local
    : err(
        frmError(
          "validation",
          `${ask.what}: ${ask.branch} is not in its mirror; there is nothing to deliver`,
        ),
      );
}

/**
 * Puts `ask.branch` on `ask.remoteUrl`, fast-forward only.
 *
 * | the remote's ref              | what happens                                        |
 * | ----------------------------- | --------------------------------------------------- |
 * | absent                        | pushed                                              |
 * | equals the local head         | `already` — nothing is sent                          |
 * | an ancestor of the local head | pushed (a fast-forward needs no force at all)        |
 * | anything else                 | refused, naming what the remote has                  |
 */
export async function pushBranch(
  ctx: HostGitCtx,
  ask: PushAsk,
): Promise<Result<PushOutcome>> {
  if (!deliverableBranch(ask.branch)) {
    return err(
      frmError(
        "validation",
        `${ask.what}: ${JSON.stringify(ask.branch)} is not a session's frm/ branch`,
      ),
    );
  }
  const badUrl = originUrlProblem(ask.remoteUrl);
  if (badUrl !== null) {
    return err(
      frmError(
        "validation",
        `${ask.what}: its recorded remote ${badUrl}; nothing was pushed`,
      ),
    );
  }
  const local = await mirrorHead(ctx, ask);
  if (!local.ok) return local;
  const head = local.value;
  const listed = await git(
    ctx,
    ask,
    `${ask.what}: ask the remote`,
    ["ls-remote", "--heads", "--", ask.remoteUrl, `refs/heads/${ask.branch}`],
    { authenticated: true },
  );
  if (!listed.ok) return listed;
  const remote = refSha(listed.value, ask.branch);
  if (remote === head) return ok({ kind: "already", head });
  if (remote !== null) {
    const ancestor = await ancestorOnRemote(ctx, ask, remote, head);
    if (!ancestor.ok) return ancestor;
    if (!ancestor.value) {
      return err(
        frmError(
          "conflict",
          `${ask.what}: the remote's ${ask.branch} is at ${remote.slice(0, 12)}, which is not an ancestor of ${head.slice(0, 12)}. Refusing to push: a fast-forward is the only update delivery makes, and something else is on that branch.`,
        ),
      );
    }
  }
  const pushed = await git(
    ctx,
    ask,
    `${ask.what}: push ${ask.branch}`,
    [
      "push",
      "--",
      ask.remoteUrl,
      `refs/heads/${ask.branch}:refs/heads/${ask.branch}`,
    ],
    { authenticated: true },
  );
  return pushed.ok ? ok({ kind: "pushed", head }) : pushed;
}

/**
 * Whether the remote's commit is an ancestor of ours. It is fetched into the mirror first — never
 * onto a ref, only into FETCH_HEAD and the object store — because `merge-base` cannot judge a
 * commit this host has never seen, and a push that fails on it would be the only other answer.
 */
async function ancestorOnRemote(
  ctx: HostGitCtx,
  ask: PushAsk,
  remote: string,
  head: string,
): Promise<Result<boolean>> {
  const fetched = await git(
    ctx,
    ask,
    `${ask.what}: read the remote's ${ask.branch}`,
    ["fetch", "--no-tags", "--", ask.remoteUrl, `refs/heads/${ask.branch}`],
    { authenticated: true },
  );
  if (!fetched.ok) return fetched;
  const ran = await hostGitRun(
    ctx,
    ["-C", ask.mirrorPath, "merge-base", "--is-ancestor", remote, head],
    { what: `${ask.what}: compare with the remote`, signal: ask.signal },
  );
  if (!ran.ok) return ran;
  // 0: an ancestor. 1: not. Anything else is git failing, not an answer.
  if (ran.value.code === 0) return ok(true);
  if (ran.value.code === 1) return ok(false);
  return err(gitFailure(`${ask.what}: compare with the remote`, ran.value));
}
