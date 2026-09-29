import type { AttentionItem, RunnerUpdateView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { fleetQuery } from "@/api/queries";
import { SectionTitle } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ackAttention } from "@/fleet/fleet-control-api";
import { formatIdle } from "@/fleet/fleet-model";
import { inboxCountLabel } from "@/inbox/inbox-count";
import { useInboxCount } from "@/inbox/use-inbox-count";
import { formatUtc } from "@/lib/format";
import { RUNNERS_KEY, dismissRunnerUpdate } from "@/runners/runners-api";
import { INBOX_HREF, RUNNERS_HREF, sessionHref } from "@/routing";

// The Fleet's first section: what is waiting on the operator, each with its way on.
// Amendment 8's items as the server computes them — a live session gone quiet (open it to stop or
// hand it off) and an error exit (dismissed for good once seen) — the Inbox's open
// questions, read from the very query the header's count rides (no second request) —
// and an open runner update check, which is not session-keyed and so is its own row.

/** How long ago, as the row reads it: "42m", "2h 5m". */
const age = (item: AttentionItem, now: number): string =>
  formatIdle(Math.max(0, now - item.since));

export function NeedsYou({
  items,
  runnerUpdates,
  now,
}: {
  readonly items: readonly AttentionItem[];
  readonly runnerUpdates: readonly RunnerUpdateView[];
  /** When the snapshot arrived: ages are measured from it, so rendering stays pure. */
  readonly now: number;
}) {
  const inbox = useInboxCount();
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (sessionId: string) => ackAttention(sessionId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: fleetQuery.queryKey }),
  });
  const dismissUpdate = useMutation({
    mutationFn: (u: RunnerUpdateView) =>
      dismissRunnerUpdate(u.runner_id, u.latest),
    onSuccess: () => {
      // The runner page reads the same open update from its own query (RUNNERS_KEY), not the
      // fleet one: both must drop the item, or one screen keeps showing what the other cleared.
      queryClient.invalidateQueries({ queryKey: fleetQuery.queryKey });
      queryClient.invalidateQueries({ queryKey: RUNNERS_KEY });
    },
  });
  const count = items.length + runnerUpdates.length + (inbox.open > 0 ? 1 : 0);
  return (
    <section aria-label="Needs you" className="flex flex-col gap-2">
      <SectionTitle className="flex items-center gap-2">
        Needs you
        {count > 0 && (
          <Badge variant="warning" aria-hidden="true">
            {count}
          </Badge>
        )}
      </SectionTitle>
      {count === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground shadow-xs">
          <CircleCheck aria-hidden="true" className="size-4 text-success" />
          Nothing needs you
        </p>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {inbox.open > 0 && (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <StatusBadge entity="waiting" state="you" label="Questions" />
              <p className="min-w-0 flex-1 font-medium">
                {`${inboxCountLabel(inbox)} ${inbox.open === 1 && !inbox.more ? "question waits" : "questions wait"} for your answer`}
              </p>
              <a
                href={INBOX_HREF}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Answer in the Inbox
              </a>
            </li>
          )}
          {items.map((item) => (
            <li
              key={`${item.why}:${item.session_id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
            >
              <StatusBadge entity="attention" state={item.why} />
              <div className="flex min-w-0 flex-1 flex-col">
                <p className="font-medium">
                  {item.agent}
                  <span
                    className="font-normal text-muted-foreground"
                    title={formatUtc(item.since)}
                  >
                    {item.why === "stale"
                      ? ` · silent for ${age(item, now)}`
                      : ` · exited with an error ${age(item, now)} ago`}
                  </span>
                </p>
                {item.detail !== null && (
                  <p className="text-xs break-words text-muted-foreground">
                    {item.detail}
                  </p>
                )}
              </div>
              {/* A stale session is live: its row names the remedy rather than only its age. */}
              <TextLink href={sessionHref(item.session_id)} className="text-sm">
                {item.why === "stale"
                  ? "Open to stop or hand off"
                  : "Open the session"}
              </TextLink>
              {item.why === "errored" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(item.session_id)}
                  aria-label={`Dismiss ${item.agent}'s error`}
                >
                  Dismiss
                </Button>
              )}
            </li>
          ))}
          {runnerUpdates.map((u) => (
            <li
              key={`${u.runner_id}:${u.latest}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
            >
              <Badge variant="warning">Update</Badge>
              <p className="min-w-0 flex-1 font-medium">
                {`${u.runner_id} ${u.current} → ${u.latest} available`}
              </p>
              <TextLink href={RUNNERS_HREF} className="text-sm">
                Open runners
              </TextLink>
              <Button
                size="sm"
                variant="ghost"
                disabled={dismissUpdate.isPending}
                onClick={() => dismissUpdate.mutate(u)}
                aria-label={`Dismiss the ${u.runner_id} ${u.latest} update`}
              >
                Dismiss
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dismiss.error !== null && (
        <p role="alert" className="text-sm text-danger">
          {`Not dismissed: ${dismiss.error.message}`}
        </p>
      )}
      {dismissUpdate.error !== null && (
        <p role="alert" className="text-sm text-danger">
          {`Not dismissed: ${dismissUpdate.error.message}`}
        </p>
      )}
    </section>
  );
}
