import { STAFF_APPROVAL_KIND } from "@bayon/core";
import type { TicketView } from "@bayon/proto";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ticketQuery } from "@/api/queries";
import { TextLink } from "@/components/text-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useFeed } from "@/feed/feed";
import { AnswerDialog } from "@/inbox/answer-dialog";
import { DismissButton } from "@/inbox/dismiss-button";
import { ticketQuestionsQuery } from "@/inbox/inbox-api";
import { recommendationOf } from "@/inbox/inbox-groups";
import { Recommendation } from "@/inbox/recommendation";
import { formatTime } from "@/lib/format";
import { Markdown } from "@/markdown/markdown";
import { inboxHref } from "@/routing";
import { Panel } from "@/tickets/panel";

/**
 * The ticket's open questions to the operator, each answered right here with the
 * Inbox's own dialog, or dismissed as no longer relevant. While any is open the ticket waits: nothing
 * is staffed on it until the last is answered or dismissed, which wakes the orchestrator. A staffing
 * proposal is not a question (it has its own panel), so it is not listed. Live from the `inbox` topic.
 */
export function TicketQuestions({ ticket }: { readonly ticket: TicketView }) {
  const questions = useQuery(ticketQuestionsQuery(ticket.num));
  const [notice, setNotice] = useState<string | null>(null);
  const items =
    questions.data?.items.filter((i) => i.kind !== STAFF_APPROVAL_KIND) ?? [];
  useQuestionsFeed(
    ticket.num,
    questions.data === undefined ? undefined : items.length,
  );
  if (questions.isPending) return null;
  // A quiet line, not an alert: the questions are a side panel of the ticket, and the ticket itself
  // (with its needs-human badge, which links to the Inbox) is still whole without them.
  if (questions.isError)
    return (
      <p className="text-sm text-muted-foreground">{`Open questions are unavailable: ${questions.error.message}`}</p>
    );
  const { has_more } = questions.data;
  if (items.length === 0) return null;
  const inbox = inboxHref(ticket.workspace_id, ticket.num);
  return (
    <Panel
      label="open questions"
      title={`Open questions (${items.length}${has_more ? "+" : ""})`}
    >
      <p className="text-sm text-muted-foreground">
        {
          "This ticket waits for your answers: nothing is staffed on it until the last one is answered or dismissed. "
        }
        <TextLink href={inbox} inline>
          Open in the Inbox
        </TextLink>
      </p>
      {notice !== null && (
        <Alert status="warning">
          <AlertTitle>Already answered</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      <ul aria-label="questions to answer" className="flex flex-col gap-3">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-1 border-t border-border pt-2 text-sm first:border-t-0 first:pt-0"
          >
            <p className="font-medium">{item.question}</p>
            <p className="text-muted-foreground">
              {`${item.kind} · asked ${formatTime(item.asked_at)} UTC${item.session === null ? "" : ` by ${item.session.agent}`}`}
            </p>
            <QuestionContext contextMd={item.context_md} />
            <div className="flex flex-wrap items-center gap-2">
              <AnswerDialog item={item} onConflict={setNotice} />
              <DismissButton item={item} />
            </div>
          </li>
        ))}
      </ul>
      {has_more && (
        <TextLink href={inbox} className="w-fit text-sm">
          More are open: see them all in the Inbox
        </TextLink>
      )}
    </Panel>
  );
}

/** A question's context: its recommendation called out as the Inbox shows it, else its markdown. */
function QuestionContext({ contextMd }: { readonly contextMd: string | null }) {
  if (contextMd === null) return null;
  const recommendation = recommendationOf(contextMd);
  return recommendation === null ? (
    <Markdown markdown={contextMd} />
  ) : (
    <Recommendation text={recommendation} />
  );
}

/**
 * Refetches the questions on every `inbox` frame; and the ticket when one is answered, since the last
 * answer clears its needs_human (the `tickets` topic says so too, a frame later).
 */
function useQuestionsFeed(num: number, open: number | undefined): void {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      feed.subscribeInbox(() => {
        void queryClient.invalidateQueries({
          queryKey: ticketQuestionsQuery(num).queryKey,
        });
      }),
    [feed, queryClient, num],
  );
  const last = useRef(open);
  useEffect(() => {
    const before = last.current;
    last.current = open;
    if (before !== undefined && open !== undefined && open < before) {
      void queryClient.invalidateQueries({
        queryKey: ticketQuery(num).queryKey,
      });
    }
  }, [open, num, queryClient]);
}
