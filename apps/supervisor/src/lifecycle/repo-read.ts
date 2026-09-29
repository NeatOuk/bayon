// `repo.check`, which the API queues before it creates a project: `git ls-remote` of
// the URL exactly as the mirror's first clone would reach it — SAFE_GIT and its own process group
// (host-git.ts), REMOTE_GIT_ENV's batch-mode ssh, and the forge token under delivery's rule
// (`originGitAuth`), in git's env only. repo-failure.ts words the clone's own failures the same way.
//
// No token value and no URL userinfo reaches a result, a message or a log line (Invariant 11).
import {
  REPO_CHECK_LIMIT_MS,
  classifyRemoteFailure,
  displayUrl,
  err,
  forgeRemote,
  ok,
  parseLsRemote,
  redactCredentials,
  repoTokenSecret,
  type RepoCheckResult,
  type RepoReachOutcome,
  type Result,
} from "@bayon/core";
import { REMOTE_GIT_ENV } from "@bayon/executors";
import { RepoCheckPayload } from "@bayon/proto";
import { originGitAuth } from "../forge/credential.js";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";
import { hostGitRun } from "./host-git.js";
import { originUrlProblem } from "./mirror.js";
import { tokenOf } from "./repo-failure.js";
import {
  LITERAL_POLICY,
  guardRemote,
  type RemotePolicy,
} from "./remote-policy.js";
import type { CommandHandler } from "./ports.js";

/**
 * What a check needs of the lifecycle: the clock for its deadline, PATH, the log, the store, and
 * the remote policy (absent: the literal checks only, no DNS and no private host).
 */
export type RepoCheckCtx = Pick<Ctx, "settings" | "clock" | "path" | "log"> & {
  readonly secrets?: Ctx["secrets"];
  readonly remote?: RemotePolicy;
};

/** How many checks run at once (review H1): each is a git process and a connection out. */
export const REPO_CHECKS_MAX = 3;

/** Said when that many already run: retryable, and the API answers it 429. */
export const REPO_CHECKS_BUSY =
  "Bayon is checking other repositories: try again in a moment.";

/** What `failed` says for a host that is no forge Bayon knows: its own words stay in the log. */
export const UNKNOWN_HOST_DETAIL =
  "the server answered something Bayon does not recognise; the supervisor's log has git's words";

/** A result with nothing found, for an outcome that is not `found`. */
const notFound = (
  outcome: Exclude<RepoReachOutcome, "found">,
  facts: Pick<RepoCheckResult, "token_secret" | "token_offered">,
  detail = "",
): RepoCheckResult => ({
  outcome,
  default_branch: null,
  base_found: null,
  ...facts,
  detail,
});

/**
 * `git ls-remote --symref -- <url> HEAD refs/heads/*` the way the mirror clone reaches `url`. A
 * URL the clone would refuse (a program transport, a leading `-`) is `validation`; a stop is
 * `interrupted`; every answer from the remote, a timeout included, is a result.
 */
export async function checkRepo(
  ctx: RepoCheckCtx,
  p: RepoCheckPayload,
  signal: AbortSignal,
): Promise<Result<RepoCheckResult>> {
  const bad = originUrlProblem(p.url);
  if (bad !== null) {
    return err(
      frmError(
        "validation",
        `repo url ${JSON.stringify(displayUrl(p.url))} ${bad}`,
      ),
    );
  }
  const guarded = await guardRemote(ctx.remote ?? LITERAL_POLICY, p.url);
  if (!guarded.ok) return guarded;
  const auth = await originGitAuth(ctx.secrets, p.url);
  const facts = {
    token_secret: repoTokenSecret(p.url),
    token_offered: auth.flags.length > 0,
  };
  const ran = await hostGitRun(
    ctx,
    [
      ...guarded.value,
      ...auth.flags,
      "ls-remote",
      "--symref",
      "--",
      p.url,
      "HEAD",
      "refs/heads/*",
    ],
    {
      what: "git ls-remote",
      signal,
      limitMs: REPO_CHECK_LIMIT_MS,
      env: { ...REMOTE_GIT_ENV, ...auth.env },
    },
  );
  if (!ran.ok) {
    return ran.error.class === "timeout" ? ok(notFound("timeout", facts)) : ran;
  }
  if (ran.value.code !== 0) {
    const detail = redactCredentials(ran.value.stderr, tokenOf(auth));
    const outcome = classifyRemoteFailure(ran.value.stderr);
    // Review M2: a host that is no known forge does not get to answer the form in its own words,
    // so the check is no way to read what some service on the network says. The log keeps them.
    if (outcome === "failed" && forgeRemote(p.url) === null) {
      ctx.log.warn(
        { url: displayUrl(p.url), detail },
        "repo check: git failed in a way it does not name",
      );
      return ok(notFound(outcome, facts, UNKNOWN_HOST_DETAIL));
    }
    return ok(notFound(outcome, facts, detail));
  }
  const listed = parseLsRemote(ran.value.stdout);
  return ok({
    outcome: "found",
    default_branch: listed.defaultBranch,
    base_found: p.base === undefined ? null : listed.heads.includes(p.base),
    ...facts,
    detail: "",
  });
}

/** `repo.check`: off the claim loop, since a slow host takes REPO_CHECK_LIMIT_MS. */
export function repoCheckHandler(
  ctx: RepoCheckCtx,
  signal: AbortSignal = new AbortController().signal,
): CommandHandler<RepoCheckPayload> {
  let running = 0;
  return {
    type: "repo.check",
    payload: RepoCheckPayload,
    background: true,
    idempotent: true, // a read of a remote: a second run changes nothing
    async handle(p) {
      // At most REPO_CHECKS_MAX at once (review H1): past that, refused at once, and retryable.
      if (running >= REPO_CHECKS_MAX) {
        return err({
          class: "admission_refused",
          message: REPO_CHECKS_BUSY,
          retryable: true,
        });
      }
      running += 1;
      try {
        const checked = await checkRepo(ctx, p, signal);
        if (checked.ok) {
          ctx.log.info(
            { url: displayUrl(p.url), outcome: checked.value.outcome },
            "repo checked",
          );
        }
        return checked;
      } finally {
        running -= 1;
      }
    },
  };
}
