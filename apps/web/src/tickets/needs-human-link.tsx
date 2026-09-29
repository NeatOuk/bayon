import type { TicketSummary } from "@bayon/proto";
import { StatusBadge } from "@/components/status-badge";
import { FOCUS_RING } from "@/components/text-link";
import { cn } from "@/lib/utils";
import { inboxHref } from "@/routing";

/**
 * Whether a ticket needs a human: its flag, or a live open question. The supervisor's own
 * requests (split, circuit breaker, retry storm) wait on the operator without writing the flag.
 */
export const needsHuman = (
  ticket: Pick<TicketSummary, "needs_human" | "open_questions">,
): boolean => ticket.needs_human || ticket.open_questions > 0;

/**
 * A ticket's "needs human" badge, as a link to where the operator answers: its
 * project's Inbox, or the fleet's for a ticket with no project, showing that ticket's requests.
 * Before, the badge said a human was needed and nothing said where. It waits on you, so it reads
 * as the status map's "waiting on you": asked, not alarmed.
 */
export function NeedsHumanLink({
  ticket,
  className,
}: {
  readonly ticket: Pick<TicketSummary, "num" | "workspace_id">;
  readonly className?: string;
}) {
  return (
    <a
      href={inboxHref(ticket.workspace_id, ticket.num)}
      title={`Answer ticket #${ticket.num}'s questions in the Inbox`}
      className={cn(
        "inline-flex w-fit rounded-md hover:underline",
        FOCUS_RING,
        className,
      )}
    >
      <StatusBadge entity="waiting" state="you" label="Needs human" />
    </a>
  );
}
