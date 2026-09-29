import {
  listDeliveryCandidates,
  type DeliveryCandidate,
  type DeliveryCursor,
} from "@bayon/db";
import { deliverTicket } from "./deliver.js";
import type { DeliveryCtx } from "./context.js";

// The delivery sweep (spike §1.2), the **last** step of every reconciler pass. It is a
// sweep rather than a hook on `advanceTicket`'s outcome for two reasons:
//
//   * a ticket the **operator** moved by hand reaches its moment with no outcome for anyone to
//     watch, and delivering that ticket is half the point;
//   * a network write has no business inside a gate decision's transaction.
//
// Paging is the machine sweep's, keyset on (updated_at, id), so a fleet with more due tickets than
// one pass's cap has every one of them looked at in turn. A finished delivery is a no-op —
// `deliverTicket` reads its rows and does nothing — so running it every pass costs one indexed
// query plus, per due ticket, one local `rev-parse` and one `ls-remote`.
//
// TWO THINGS KEEP IT OFF THE REST OF THE PASS (code review, MEDIUM 5). It is the only
// reconciler step that makes outbound network calls, so a slow remote must not delay health checks,
// lease expiry or the watchdog:
//
//   * it runs **after** all of them, at the end of `reconcilePass`;
//   * it has a **wall-clock budget**. Past it the pass stops where it is and the cursor keeps the
//     place, so the next pass carries on from the ticket after the last one finished rather than
//     from the top. A budget was chosen over a loop of its own (the worktree sweep's shape) because
//     the work is already idempotent and already paged: the cursor is the whole mechanism, and a
//     second timer would add a second thing that can drift from a reconciler pass without adding
//     anything a carried-over remainder does not already give.
//
// No ticket is ever cut off mid-delivery: the budget is checked between tickets, and a ticket that
// has started finishes. Its own git calls are bounded by `workspace.git_timeout_ms` and its forge
// calls by their own timeout.

/** The most tickets one pass looks at; the next pass carries on after the last of them. */
export const DELIVERY_SWEEP_MAX = 25;

/** The longest one pass spends delivering, checked between tickets. */
export const DELIVERY_SWEEP_BUDGET_MS = 30_000;

/** Where each lifecycle's sweep left off. In memory: a restart starts from the top, harmlessly. */
const cursors = new WeakMap<DeliveryCtx, DeliveryCursor>();

export interface DeliverySwept {
  /** Tickets this pass actually attempted; fewer than the page when the budget ran out. */
  readonly looked: number;
  /** Tickets this pass pushed something for, or opened a pull request for. */
  readonly delivered: number;
  readonly failed: number;
  /** The budget stopped this pass short: the next one carries on from the cursor. */
  readonly budgetSpent: boolean;
}

export interface SweepOptions {
  readonly signal?: AbortSignal;
  /** Replaces DELIVERY_SWEEP_BUDGET_MS for this pass (tests). */
  readonly budgetMs?: number;
}

/** Where the next pass starts, given what this one got through. */
function remember(
  ctx: DeliveryCtx,
  page: readonly DeliveryCandidate[],
  done: DeliveryCandidate | null,
  budgetSpent: boolean,
): void {
  // Stopped short: carry on after the last ticket that finished. Nothing finished at all — a budget
  // of zero, or the first ticket already over it — leaves the cursor where it was, so the next pass
  // makes the same attempt rather than skipping the page.
  if (budgetSpent) {
    if (done !== null) {
      cursors.set(ctx, { updated_at: done.updated_at, id: done.id });
    }
    return;
  }
  const last = page.at(-1);
  // A short page reached the end: the next pass starts from the top again.
  if (last === undefined || page.length < DELIVERY_SWEEP_MAX) {
    cursors.delete(ctx);
    return;
  }
  cursors.set(ctx, { updated_at: last.updated_at, id: last.id });
}

export async function sweepDeliveries(
  ctx: DeliveryCtx,
  o: SweepOptions = {},
): Promise<DeliverySwept> {
  const after = cursors.get(ctx) ?? null;
  const page = await listDeliveryCandidates(ctx.db, {
    limit: DELIVERY_SWEEP_MAX,
    after,
  });
  if (!page.ok) {
    ctx.log.error(
      { error: page.error },
      "delivery sweep: cannot list the tickets to deliver",
    );
    return { looked: 0, delivered: 0, failed: 0, budgetSpent: false };
  }
  // Nothing of this sweep's own aborts; every git call still has workspace.git_timeout_ms and
  // every forge call its own timeout, so no step of it can hang a reconciler pass for ever.
  const stop = o.signal ?? new AbortController().signal;
  const budgetMs = o.budgetMs ?? DELIVERY_SWEEP_BUDGET_MS;
  const startedAt = ctx.clock.now();
  let looked = 0;
  let delivered = 0;
  let failed = 0;
  let done: DeliveryCandidate | null = null;
  let budgetSpent = false;
  for (const ticket of page.value) {
    if (ctx.clock.now() - startedAt >= budgetMs) {
      budgetSpent = true;
      ctx.log.info(
        { looked, of: page.value.length, budgetMs },
        "delivery sweep: out of budget for this pass; the next one carries on",
      );
      break;
    }
    looked += 1;
    const out = await deliverTicket(ctx, ticket.id, stop);
    done = ticket;
    if (!out.ok) {
      failed += 1;
      ctx.log.error(
        { ticketId: ticket.id, error: out.error },
        "delivery sweep: a ticket could not be delivered",
      );
      continue;
    }
    if (out.value.failed !== null) {
      failed += 1;
      ctx.log.error(
        { ticketId: ticket.id, error: out.value.failed },
        "delivery sweep: a ticket's delivery stopped",
      );
    }
    if (out.value.pushed === 0 && out.value.prs === 0) continue;
    delivered += 1;
    ctx.log.info(
      { ticketId: ticket.id, pushed: out.value.pushed, prs: out.value.prs },
      "delivery sweep: a ticket's work reached its project's remote",
    );
  }
  remember(ctx, page.value, done, budgetSpent);
  return { looked, delivered, failed, budgetSpent };
}
