// A clone or fetch of a project's repo that failed, in plain words: the spawn's first
// clone (mirror.ts) and its base fetch (workspace-plan.ts) report `repo_unreachable` with the
// sentence New project's check shows, and git's own tail, instead of a `spawn_failed` carrying only
// git's stderr. No token value and no URL userinfo reaches the message (Invariant 11).
import {
  NO_REMOTE_BRANCH,
  classifyRemoteFailure,
  displayUrl,
  redactCredentials,
  repoReachText,
  repoTokenSecret,
  type FrmError,
} from "@bayon/core";
import { GIT_TOKEN_ENV } from "@bayon/executors";
import { z } from "zod";
import type { GitAuth } from "../forge/credential.js";
import { frmError } from "./errors.js";

/** The token `auth` hands git, for masking: never printed, only removed. */
export const tokenOf = (auth: GitAuth): readonly string[] => {
  const token = auth.env[GIT_TOKEN_ENV];
  return token === undefined ? [] : [token];
};

/** Why a repo could not be read, beside the message: what `unwind` blocks the ticket with. */
export const RepoReadCause = z.object({
  repo_id: z.string().min(1),
  outcome: z.enum([
    "missing",
    "host_key",
    "unreachable",
    "no_branch",
    "refused",
  ]),
  branch: z.string().nullable(),
});
export type RepoReadCause = z.infer<typeof RepoReadCause>;

export interface RepoReadFailure {
  readonly repoId: string;
  readonly url: string;
  readonly auth: GitAuth;
  readonly stderr: string;
  readonly code: number | null;
  /** Names the git call when git's words mean nothing we know: the old `spawn_failed` message. */
  readonly what: string;
  /** The branch a fetch asked for: a remote without it is `no_branch`. */
  readonly branch?: string;
}

const repoError = (
  message: string,
  cause: RepoReadCause,
  retryable: boolean,
): FrmError => ({ class: "repo_unreachable", message, retryable, cause });

/**
 * A clone or fetch of the repo's remote that exited non-zero, as the error the spawn reports. A
 * reason git's words name — not found or no access, an unknown host key, a host unreachable, no such
 * branch — is `repo_unreachable` with the plain sentence and git's tail, redacted; only an
 * unreachable host is retryable. Anything else stays `spawn_failed`, as before, redacted too.
 */
export function repoReadFailure(f: RepoReadFailure): FrmError {
  const detail = redactCredentials(f.stderr, tokenOf(f.auth), 200);
  const git = detail === "" ? `exit ${String(f.code)}` : detail;
  if (f.branch !== undefined && NO_REMOTE_BRANCH.test(f.stderr)) {
    return repoError(
      `Repo ${f.repoId}: ${displayUrl(f.url)} has no branch ${f.branch}. Check the project's base branch against the branches the repository has. git said: ${git}`,
      { repo_id: f.repoId, outcome: "no_branch", branch: f.branch },
      false,
    );
  }
  const outcome = classifyRemoteFailure(f.stderr);
  if (outcome === "failed") {
    return frmError("spawn_failed", `${f.what} failed: ${git}`);
  }
  const text = repoReachText(
    f.url,
    {
      outcome,
      default_branch: null,
      base_found: null,
      token_secret: repoTokenSecret(f.url),
      token_offered: f.auth.flags.length > 0,
      detail,
    },
    null,
  );
  const fix = text.command === null ? "" : ` Run: ${text.command}`;
  return repoError(
    `Repo ${f.repoId}: ${text.message}${fix} git said: ${git}`,
    { repo_id: f.repoId, outcome, branch: null },
    outcome === "unreachable",
  );
}

/**
 * A URL origin the remote policy refuses (review M1, M2): its host is not allowed, it is plain
 * http, or it carries a credential. `why` is core's own sentence; only the operator can change it.
 */
export const refusedRemote = (repoId: string, why: string): FrmError =>
  repoError(
    `Repo ${repoId}: ${why}`,
    { repo_id: repoId, outcome: "refused", branch: null },
    false,
  );
