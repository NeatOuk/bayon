import {
  JIRA_TOKEN_SECRET,
  JiraCommentPayload,
  JiraTransitionPayload,
  NOTIFY_BACKOFF_MS,
  NOTIFY_MAX_ATTEMPTS,
  err,
  isJiraSite,
  jiraFingerprintPrefix,
  jiraHost,
  retryAt,
  type Clock,
  type FrmError,
  type Result,
} from "@bayon/core";
import { dueJiraPushes, type Db, type DueJiraPush } from "@bayon/db";
import {
  claimJiraPush,
  settleJiraPush,
  type JiraPushOutcome,
} from "@bayon/db/api";
import type { AtlassianAuth, Fetch } from "../atlassian/client.js";
import { scrubSecret } from "../atlassian/client.js";
import {
  callFor,
  commentIssue,
  transitionIssue,
  type PushDone,
} from "./push-client.js";
import { storeTokenHint, type JiraTokenStore } from "./token.js";

// Each tick's sends, the notifier's discipline (deliver.ts): a due push is checked
// (its project still has a Jira source on the same site), claimed — its attempt counted and its retry
// time set before the send, so a crash mid-send retries after the backoff rather than at once —
// then sent and settled: sent; skipped when Jira needs no move or offers none by that name; pending
// again at the next backoff while the error is retryable; failed when it is not (a 401 or 403: the
// token may not transition or comment), or the retries are spent. The token is read from the host
// store once per tick, at send time, and never stored: every error is scrubbed of it before it is
// written or logged.

export const JIRA_PUSHES_PER_TICK = 20;
export const JIRA_PUSH_TIMEOUT_MS = 30_000;

export interface PushLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface PushDeliverDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly token: JiraTokenStore;
  readonly fetch: Fetch;
  readonly logger: PushLogger;
  readonly timeoutMs?: number;
}

const LAST_BACKOFF = NOTIFY_BACKOFF_MS[NOTIFY_BACKOFF_MS.length - 1] ?? 0;

/** Skip reasons that never reach Jira. */
export const NO_SOURCE = "the project no longer has a Jira source";
export const SITE_MOVED =
  "the project's Jira site changed since this was filed: its issue key is another site's";
export const UNREADABLE = "the push's stored payload is unreadable";

/** What a send's result makes of the push, its `attempts` counting the send just made. */
export function outcomeOf(
  sent: Result<PushDone>,
  attempts: number,
  now: number,
): JiraPushOutcome {
  if (sent.ok)
    return sent.value.state === "sent"
      ? { state: "sent" }
      : { state: "skipped", error: sent.value.reason };
  const e: FrmError = sent.error;
  const next = e.retryable ? retryAt(attempts, now) : null;
  return next === null
    ? { state: "failed", error: e.message }
    : { state: "pending", next_attempt_at: next, error: e.message };
}

/** The send itself, by kind; a payload that does not parse is never sent. */
function send(
  row: DueJiraPush,
  auth: AtlassianAuth,
  deps: PushDeliverDeps,
  signal: AbortSignal | undefined,
): Promise<Result<PushDone>> | Result<PushDone> {
  const site = row.jira_url ?? "";
  const call = callFor(site, auth, {
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? JIRA_PUSH_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  if (row.kind === "transition") {
    const p = JiraTransitionPayload.safeParse(payload);
    if (p.success) return transitionIssue(call, row.issue_key, p.data.status);
  } else if (row.kind === "comment") {
    const p = JiraCommentPayload.safeParse(payload);
    // An attempt was made before this one: its comment may have landed unanswered.
    if (p.success)
      return commentIssue(call, row.issue_key, p.data, row.attempts > 0);
  }
  return { ok: true, value: { state: "skipped", reason: UNREADABLE } };
}

/** Why a push must not be sent at all, before any attempt; null when it may go. */
function refusalOf(row: DueJiraPush): JiraPushOutcome | null {
  if (row.jira_url === null || row.jira_email === null)
    return { state: "skipped", error: NO_SOURCE };
  const prefix = isJiraSite(row.jira_url)
    ? jiraFingerprintPrefix(jiraHost(row.jira_url))
    : null;
  if (prefix === null || row.origin_fingerprint?.startsWith(prefix) !== true)
    return { state: "skipped", error: SITE_MOVED };
  if (row.attempts >= NOTIFY_MAX_ATTEMPTS)
    return { state: "failed", error: "its retries were spent" };
  return null;
}

/** A throw from a send is a retryable failure, never a crashed tick; its message is scrubbed. */
async function guarded(
  run: () => Promise<Result<PushDone>> | Result<PushDone>,
  auth: AtlassianAuth,
): Promise<Result<PushDone>> {
  try {
    return await run();
  } catch (e) {
    return err({
      class: "internal",
      message: scrubSecret(
        `the Jira update failed unexpectedly: ${e instanceof Error ? e.message : "a non-error was thrown"}`,
        auth,
      ),
      retryable: true,
    });
  }
}

function logged(deps: PushDeliverDeps, what: string, r: Result<unknown>): void {
  if (!r.ok) deps.logger.error(`jira push: ${what}: ${r.error.message}`);
}

/** The token for this tick: read once, at the first push that needs it. */
type TokenRead = Result<string>;

async function readToken(deps: PushDeliverDeps): Promise<TokenRead> {
  const token = await deps.token.secrets.get(JIRA_TOKEN_SECRET);
  return token.ok
    ? token
    : err({
        class: "validation",
        message: `${JIRA_TOKEN_SECRET} could not be read from the host secret store: ${storeTokenHint(deps.token)}`,
        // Retryable: the operator may store it before the next attempt.
        retryable: true,
      });
}

async function deliverOne(
  deps: PushDeliverDeps,
  row: DueJiraPush,
  token: () => Promise<TokenRead>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const what = `${row.kind} ${row.moment} of ${row.issue_key} (${row.id})`;
  const refused = refusalOf(row);
  if (refused !== null) {
    logged(
      deps,
      `settle ${what}`,
      await settleJiraPush(deps.db, { id: row.id, outcome: refused }),
    );
    return;
  }
  const now = deps.clock.now();
  const claimed = await claimJiraPush(deps.db, {
    id: row.id,
    retry_at: retryAt(row.attempts + 1, now) ?? now + LAST_BACKOFF,
  });
  if (!claimed.ok) {
    logged(deps, `claim ${what}`, claimed);
    return;
  }
  const secret = await token();
  const auth: AtlassianAuth = {
    email: row.jira_email ?? "",
    token: secret.ok ? secret.value : "",
  };
  const sent = secret.ok
    ? await guarded(() => send(row, auth, deps, signal), auth)
    : secret;
  const attempts = claimed.value.attempts;
  const raw = outcomeOf(sent, attempts, deps.clock.now());
  // Scrubbed again, whatever built the message: nothing stored or logged names the token.
  const outcome: JiraPushOutcome =
    raw.state === "sent"
      ? raw
      : { ...raw, error: scrubSecret(raw.error, auth) };
  if (outcome.state === "pending" || outcome.state === "failed")
    deps.logger.warn(
      `jira push: ${what} (attempt ${attempts}) ${outcome.state === "failed" ? "failed" : "will be retried"}: ${outcome.error}`,
    );
  logged(
    deps,
    `settle ${what}`,
    await settleJiraPush(deps.db, { id: row.id, outcome }),
  );
}

/** Sends what is due now, at most JIRA_PUSHES_PER_TICK, one at a time, oldest filed first. */
export async function deliverDuePushes(
  deps: PushDeliverDeps,
  signal?: AbortSignal,
): Promise<void> {
  const due = await dueJiraPushes(
    deps.db,
    deps.clock.now(),
    JIRA_PUSHES_PER_TICK,
  );
  if (!due.ok) {
    deps.logger.error(
      `jira push: the due pushes are unreadable: ${due.error.message}`,
    );
    return;
  }
  let token: Promise<TokenRead> | null = null;
  const once = () => (token ??= readToken(deps));
  for (const row of due.value) {
    if (signal?.aborted === true) return;
    await deliverOne(deps, row, once, signal);
  }
}
