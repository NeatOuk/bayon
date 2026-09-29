import { createHash } from "node:crypto";
import {
  REPO_CHECK_LIMIT_MS,
  RepoCheckResult,
  displayUrl,
  err,
  ok,
  repoReachText,
  type Clock,
  type Result,
  type StoreHint,
} from "@bayon/core";
import type { CommandView, RepoCheckView } from "@bayon/proto";
import type { ApiStore } from "../store.js";

// Whether a repo URL can be read, asked of the supervisor. The check has to run where
// the clone will: only the supervisor may read `FORGE_TOKEN_<KIND>` (Invariant 11), and the API has
// no synchronous channel to it. So the API inserts a `repo.check` command — its one write — and
// reads the row back until the supervisor has recorded the answer, or until the claim loop (1 s)
// and git's own deadline (REPO_CHECK_LIMIT_MS) have had their time. No answer is `null`: the
// supervisor is not running, or is busy, and nothing was checked.

/** The claim loop's poll, git's deadline, and slack. */
export const REPO_PROBE_WAIT_MS = REPO_CHECK_LIMIT_MS + 10_000;
const POLL_MS = 250;

export interface RepoProbe {
  /** The supervisor's answer for `url`, or null when it gave none in time. */
  check(url: string, base?: string): Promise<Result<RepoCheckResult | null>>;
}

/**
 * The key a check is shared under (review H1): the same URL and base within the same minute is the
 * same command, so a form whose field is left and re-entered, or a create right after its check,
 * waits on the one check in flight — or reads its answer — instead of queueing another. Hashed: the
 * key is stored, and a URL is not the key's business.
 */
export function repoCheckKey(
  url: string,
  base: string | undefined,
  now: number,
): string {
  const digest = createHash("sha256")
    .update(`${url}|${base ?? ""}`)
    .digest("hex");
  return `repo.check:${digest}:${Math.floor(now / 60_000)}`;
}

type Store = Pick<ApiStore, "insertCommand" | "command">;

/** The row's answer: a result, an error, or null while it is still queued or running. */
function answerOf(
  id: string,
  row: CommandView,
): Result<RepoCheckResult> | null {
  if (row.state === "done") {
    const parsed = RepoCheckResult.safeParse(row.result);
    return parsed.success
      ? ok(parsed.data)
      : err({
          class: "internal",
          message: `repo check ${id} recorded a result that does not parse`,
          retryable: false,
        });
  }
  if (row.state === "failed") {
    return err({
      class: row.error?.class ?? "internal",
      message: row.error?.message ?? "the supervisor could not check the repo",
      retryable: row.error?.retryable ?? false,
    });
  }
  return null;
}

/** The command to wait on: this minute's shared one, or a fresh one when that one was refused busy. */
async function queued(
  store: Store,
  payload: { readonly url: string; readonly base?: string },
  key: string,
): Promise<Result<string>> {
  const command = { type: "repo.check" as const, payload };
  const shared = await store.insertCommand({ command, idempotencyKey: key });
  if (!shared.ok || shared.value.created) {
    return shared.ok ? ok(shared.value.id) : shared;
  }
  // A shared check the supervisor refused as busy is not this minute's answer: ask again, unkeyed.
  const row = await store.command(shared.value.id);
  if (!row.ok) return row;
  if (row.value.state !== "failed" || row.value.error?.retryable !== true) {
    return ok(shared.value.id);
  }
  const fresh = await store.insertCommand({ command });
  return fresh.ok ? ok(fresh.value.id) : fresh;
}

/** The production probe: a `repo.check` command, read back with the injected clock. */
export function commandRepoProbe(deps: {
  readonly store: Store;
  readonly clock: Clock;
  readonly waitMs?: number;
}): RepoProbe {
  const waitMs = deps.waitMs ?? REPO_PROBE_WAIT_MS;
  return {
    async check(url, base) {
      const id = await queued(
        deps.store,
        { url, ...(base === undefined ? {} : { base }) },
        repoCheckKey(url, base, deps.clock.now()),
      );
      if (!id.ok) return id;
      const deadline = deps.clock.now() + waitMs;
      for (;;) {
        const row = await deps.store.command(id.value);
        if (!row.ok) return row;
        const answer = answerOf(id.value, row.value);
        if (answer !== null) return answer;
        if (deps.clock.now() >= deadline) return ok(null);
        await deps.clock.after(POLL_MS);
      }
    },
  };
}

/** What a create or a check says when the supervisor did not answer. */
export const notCheckedText = (url: string): string =>
  `Bayon has not checked ${displayUrl(url)}: the supervisor did not answer. Is it running? The first session will clone it, and say why if that fails.`;

/**
 * The check as New project shows it. `ok` needs the repo found and, when a base was asked, that
 * base on it. `hint` names this install's secret store in the fix, never a value.
 */
export function repoCheckView(
  url: string,
  base: string | undefined,
  found: RepoCheckResult | null,
  hint: StoreHint | null,
): RepoCheckView {
  if (found === null) {
    return {
      ok: false,
      outcome: null,
      message: notCheckedText(url),
      default_branch: null,
      command: null,
    };
  }
  const text = repoReachText(url, found, hint);
  if (found.outcome === "found" && found.base_found === false) {
    const other =
      found.default_branch === null
        ? ""
        : ` Its default branch is ${found.default_branch}.`;
    return {
      ok: false,
      outcome: found.outcome,
      message: `${displayUrl(url)} has no branch ${base ?? "?"}.${other} Leave the base branch empty to use the default, or give one the repository has.`,
      default_branch: found.default_branch,
      command: null,
    };
  }
  return {
    ok: found.outcome === "found",
    outcome: found.outcome,
    message: text.message,
    default_branch: found.default_branch,
    command: text.command,
  };
}
