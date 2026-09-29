// A spawn that could not read its repo blocks the ticket, in plain words. Not found, no
// access, an unknown ssh host key or a missing base branch is something only the operator can fix,
// so re-staffing would fail the same way each time. blockTicket (the supervisor's ticket write,
// §9.5) files a `repo` human request — Needs you — and blocks the ticket with the reason, in one
// transaction. The degraded hand-off end.ts wrote stays: it is what staffs a successor once the
// operator has fixed the repo and unblocked. A retryable failure (a host unreachable) blocks
// nothing; the next staffing tries again.
import { excerpt, type FrmError } from "@bayon/core";
import { blockTicket } from "@bayon/db/supervisor";
import type { Ctx } from "./context.js";
import { RepoReadCause } from "./repo-failure.js";

export const REPO_UNBLOCK = "fix the repo URL or its access, then unblock";
/**
 * What the request offers (review L6). Answering records the choice and changes nothing else, so
 * each option says what to press after it: the ticket's own Unblock or Park, through the laws.
 */
export const REPO_OPTIONS = [
  "I fixed it (then press Unblock on the ticket)",
  "Leave it (park the ticket)",
] as const;

const BLOCKED_REASON_MAX = 200;
const QUESTION_MAX = 500;

const shortWhy = (c: RepoReadCause): string => {
  switch (c.outcome) {
    case "missing":
      return "not found, or no access";
    case "host_key":
      return "its ssh host key is not known on this machine";
    case "no_branch":
      return `no branch ${c.branch ?? "?"} on its remote`;
    case "unreachable":
      return "its host cannot be reached";
    case "refused":
      return "its URL or host is not allowed";
  }
};

/**
 * Blocks `ticketId` for a spawn that failed with `error`, when it is a repo that cannot be read and
 * retrying would not help. Logs, never throws: the session has ended either way.
 */
export async function blockForUnreadableRepo(
  ctx: Pick<Ctx, "db" | "log">,
  o: {
    readonly ticketId: string | null;
    readonly sessionId: string;
    readonly error: FrmError;
  },
): Promise<void> {
  if (o.ticketId === null || o.error.class !== "repo_unreachable") return;
  if (o.error.retryable) return;
  const cause = RepoReadCause.safeParse(o.error.cause);
  if (!cause.success) return;
  const blocked = await blockTicket(ctx.db, {
    ticketId: o.ticketId,
    blockedReason: excerpt(
      `repo ${cause.data.repo_id} cannot be read: ${shortWhy(cause.data)}`,
      BLOCKED_REASON_MAX,
    ),
    unblockCondition: REPO_UNBLOCK,
    request: {
      rule: "repo",
      subject: o.ticketId,
      window: o.sessionId,
      question: excerpt(o.error.message, QUESTION_MAX),
      context_md: `Session ${o.sessionId} could not start: its workspace needs repo ${cause.data.repo_id}, and git could not read it. Once it is fixed, unblock the ticket: its hand-off is waiting for a successor.`,
      options: [...REPO_OPTIONS],
      ticket_id: o.ticketId,
      session_id: o.sessionId,
    },
  });
  if (!blocked.ok) {
    ctx.log.error(
      { ticketId: o.ticketId, sessionId: o.sessionId, error: blocked.error },
      "cannot block the ticket for its unreadable repo",
    );
    return;
  }
  if (blocked.value.blocked) {
    ctx.log.warn(
      { ticketId: o.ticketId, request: blocked.value.request.id },
      "blocked the ticket: its repo cannot be read",
    );
  }
}
