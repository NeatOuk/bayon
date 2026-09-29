import {
  forgeRemote,
  forgeTokenSecret,
  remoteHost,
  type Result,
} from "@bayon/core";
import {
  listPullRequestCandidates,
  pullRequestWatch,
  type DeliveryCursor,
  type PullRequestCandidate,
  type WatchedPullRequest,
} from "@bayon/db";
import {
  settlePullRequests,
  type PullRequestSeen,
  type PullRequestsSettled,
} from "@bayon/db/supervisor";
import { FORGES } from "../forge/github.js";
import { deliverySecrets, scrubSecrets } from "../forge/scrub.js";
import type { DeliveryCtx } from "./context.js";

// The pull-request sweep (spike §1.6), run right after the delivery sweep at the end of
// every reconciler pass. Each open pull request a delivery opened is read from its forge — one GET —
// and what it has become is recorded by `settlePullRequests`: merged (and, when that was the last,
// the ticket closed by `merge_close` in the same transaction), closed without merging (one human
// request), or unreadable (the scrubbed error, and one request when only the operator can fix it).
//
// Its shape is the delivery sweep's, for the same reasons: it calls out to a network, so it pages
// (a keyset cursor, in memory) and keeps to its own wall-clock budget, checked between tickets. An
// open request that is still open, with nothing new to say, costs its GET and nothing else — the
// writer is not called, so a re-poll writes no row, no event and no request.

/** The most tickets one pass looks at; the next pass carries on after the last of them. */
export const PR_SWEEP_MAX = 25;

/** The longest one pass spends polling, checked between tickets. */
export const PR_SWEEP_BUDGET_MS = 30_000;

/** Where each lifecycle's sweep left off. In memory: a restart starts from the top, harmlessly. */
const cursors = new WeakMap<DeliveryCtx, DeliveryCursor>();

export interface PullRequestsSwept {
  /** Tickets this pass actually looked at; fewer than the page when the budget ran out. */
  readonly looked: number;
  /** Requests recorded merged this pass. */
  readonly merged: number;
  /** Requests recorded closed without merging this pass. */
  readonly closed: number;
  /** Tickets `merge_close` took to done this pass. */
  readonly done: number;
  /**
   * Tickets whose poll had something new to record, and so opened a write: an end, a new or a
   * cleared error, or a merge that can now close it. A request still open with nothing new is not.
   */
  readonly recorded: number;
  /** Tickets whose poll or write failed this pass. */
  readonly failed: number;
  readonly budgetSpent: boolean;
}

export interface PullRequestSweepOptions {
  readonly signal?: AbortSignal;
  /** Replaces PR_SWEEP_BUDGET_MS for this pass (tests). */
  readonly budgetMs?: number;
}

/** A poll that could not ask: nothing the next pass will do differently without the operator. */
const refused = (repo_id: string, error: string): PullRequestSeen => ({
  repo_id,
  kind: "error",
  error,
  retryable: false,
});

/** What one open request is now, as the forge says; a failure is an observation too, scrubbed. */
async function poll(
  ctx: DeliveryCtx,
  pr: WatchedPullRequest,
  signal: AbortSignal,
): Promise<PullRequestSeen> {
  const target = pr.target_url;
  if (target === null || target.trim() === "") {
    return refused(pr.repo_id, `${pr.repo_id} has no remote recorded`);
  }
  const remote = (ctx.forgeRemoteOf ?? forgeRemote)(target);
  const forge = remote === null ? undefined : FORGES.get(remote.kind);
  if (remote === null || forge === undefined) {
    const host = remoteHost(target) ?? pr.repo_id;
    return refused(
      pr.repo_id,
      `${host} is not a forge Bayon can read a pull request on`,
    );
  }
  const secret = forgeTokenSecret(remote.kind);
  const token = await ctx.secrets.get(secret);
  if (!token.ok) {
    return refused(pr.repo_id, `no ${secret} in the host secret store`);
  }
  const got = await forge.getPullRequest(
    {
      fetch: ctx.forgeFetch ?? ((url, init) => fetch(url, init)),
      token: token.value,
      host: remote.host,
      clock: ctx.clock,
      signal,
    },
    remote,
    pr.pr_number,
  );
  if (!got.ok) {
    return {
      repo_id: pr.repo_id,
      kind: "error",
      // The forge layer scrubs its token already; this takes out the remote's own userinfo too.
      error: scrubSecrets(
        got.error.message,
        deliverySecrets(token.value, target),
      ),
      retryable: got.error.retryable,
    };
  }
  if (got.value.merged) {
    return {
      repo_id: pr.repo_id,
      kind: "merged",
      merged_at: got.value.merged_at,
      merged_by: got.value.merged_by,
    };
  }
  return got.value.state === "closed"
    ? { repo_id: pr.repo_id, kind: "closed" }
    : { repo_id: pr.repo_id, kind: "open" };
}

/**
 * Whether an observation says anything the row does not: an end, a new error, or a cleared one.
 * This is the idempotency check — without it every pass would open a write transaction per open
 * request just to find nothing to write.
 */
function news(seen: PullRequestSeen, pr: WatchedPullRequest): boolean {
  switch (seen.kind) {
    case "merged":
    case "closed":
      return true;
    case "error":
      return seen.error !== pr.error;
    case "open":
      return pr.error !== null;
  }
}

/** One ticket: poll each open request, and record what changed. Null: nothing to record. */
async function watchTicket(
  ctx: DeliveryCtx,
  ticketId: string,
  signal: AbortSignal,
): Promise<Result<PullRequestsSettled | null>> {
  const watch = await pullRequestWatch(ctx.db, ticketId);
  if (!watch.ok) return watch;
  const polled = await Promise.all(
    watch.value.open.map(async (pr) => ({
      pr,
      seen: await poll(ctx, pr, signal),
    })),
  );
  // No open request: a candidate only because every request already merged under a switch turned
  // on since — the settle then only asks whether the ticket can close.
  const changed = polled.filter(({ pr, seen }) => news(seen, pr));
  if (watch.value.open.length > 0 && changed.length === 0) {
    return { ok: true, value: null };
  }
  return settlePullRequests(ctx.db, {
    ticket_id: watch.value.ticket_id,
    ticket_key: watch.value.ticket_key,
    seen: changed.map(({ seen }) => seen),
  });
}

/** Where the next pass starts, given what this one got through (the delivery sweep's rule). */
function remember(
  ctx: DeliveryCtx,
  page: readonly PullRequestCandidate[],
  done: PullRequestCandidate | null,
  budgetSpent: boolean,
): void {
  if (budgetSpent) {
    if (done !== null) {
      cursors.set(ctx, { updated_at: done.updated_at, id: done.id });
    }
    return;
  }
  const last = page.at(-1);
  if (last === undefined || page.length < PR_SWEEP_MAX) {
    cursors.delete(ctx);
    return;
  }
  cursors.set(ctx, { updated_at: last.updated_at, id: last.id });
}

export async function sweepPullRequests(
  ctx: DeliveryCtx,
  o: PullRequestSweepOptions = {},
): Promise<PullRequestsSwept> {
  const none = {
    looked: 0,
    merged: 0,
    closed: 0,
    done: 0,
    recorded: 0,
    failed: 0,
    budgetSpent: false,
  };
  const page = await listPullRequestCandidates(ctx.db, {
    limit: PR_SWEEP_MAX,
    after: cursors.get(ctx) ?? null,
  });
  if (!page.ok) {
    ctx.log.error(
      { error: page.error },
      "pull-request sweep: cannot list the tickets to watch",
    );
    return none;
  }
  // Every forge call has its own timeout; nothing of this sweep's own aborts it.
  const stop = o.signal ?? new AbortController().signal;
  const budgetMs = o.budgetMs ?? PR_SWEEP_BUDGET_MS;
  const startedAt = ctx.clock.now();
  let totals = { ...none };
  let done: PullRequestCandidate | null = null;
  for (const ticket of page.value) {
    if (ctx.clock.now() - startedAt >= budgetMs) {
      totals = { ...totals, budgetSpent: true };
      ctx.log.info(
        { looked: totals.looked, of: page.value.length, budgetMs },
        "pull-request sweep: out of budget for this pass; the next one carries on",
      );
      break;
    }
    const out = await watchTicket(ctx, ticket.id, stop);
    done = ticket;
    totals = { ...totals, looked: totals.looked + 1 };
    if (!out.ok) {
      totals = { ...totals, failed: totals.failed + 1 };
      ctx.log.error(
        { ticketId: ticket.id, error: out.error },
        "pull-request sweep: a ticket's pull requests could not be recorded",
      );
      continue;
    }
    if (out.value === null) continue;
    const closedIt = out.value.advance?.advanced === true;
    totals = {
      ...totals,
      merged: totals.merged + out.value.merged.length,
      closed: totals.closed + out.value.closed.length,
      done: totals.done + (closedIt ? 1 : 0),
      recorded: totals.recorded + 1,
    };
    if (out.value.merged.length > 0 || out.value.closed.length > 0) {
      ctx.log.info(
        {
          ticketId: ticket.id,
          merged: out.value.merged,
          closed: out.value.closed,
          done: closedIt,
        },
        "pull-request sweep: a ticket's pull requests ended",
      );
    }
  }
  remember(ctx, page.value, done, totals.budgetSpent);
  return totals;
}
