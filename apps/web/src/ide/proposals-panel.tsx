import type { StaffDecision, StaffProposal } from "@bayon/core";
import type { InboxItem, ProjectView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { TICKET_KEY, TICKETS_KEY } from "@/api/queries";
import {
  DescriptionItem,
  DescriptionList,
} from "@/components/description-list";
import { Id } from "@/components/id";
import { Loading } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { TextLink } from "@/components/text-link";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { projectProposalsQuery, useProposalsFeed } from "@/ide/agents-api";
import type { TabHref } from "@/ide/live-state";
import { withoutRequest } from "@/ide/orchestrator-api";
import {
  INBOX_KEY,
  answerInboxItem,
  conflictMessage,
  isFinalConflict,
} from "@/inbox/inbox-api";
import { formatTime } from "@/lib/format";
import { INBOX_HREF } from "@/routing";
import { Panel } from "@/tickets/panel";

// The orchestrator's staffing proposals waiting on the operator: one row per
// open `staff_approval` request of this project, answered approve or reject in place, the answer told
// in a toast. Live: every `inbox` frame refetches the list.

/** What a row answers about: its ticket, else the question itself. */
const subjectOf = (item: InboxItem): string =>
  item.ticket === null ? item.question : `#${item.ticket.num}`;

const PAST: Readonly<Record<StaffDecision, string>> = {
  approve: "Approved",
  reject: "Rejected",
};

export function ProposalsPanel({
  project,
  tabHref,
}: {
  readonly project: ProjectView;
  readonly tabHref: TabHref;
}) {
  useProposalsFeed(project.id);
  const queryClient = useQueryClient();
  const query = projectProposalsQuery(project.id);
  const proposals = useQuery(query);
  const names = new Map(project.agents.map((agent) => [agent.id, agent.name]));

  // Answered: the request leaves the open list now, and what the answer moved is refetched.
  const onAnswered = (item: InboxItem, decision: StaffDecision) => {
    notify.success(`${PAST[decision]}: ${subjectOf(item)}`);
    queryClient.setQueryData(query.queryKey, (page) =>
      page === undefined ? undefined : withoutRequest(page, item.id),
    );
    void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
    void queryClient.invalidateQueries({ queryKey: TICKETS_KEY });
    void queryClient.invalidateQueries({ queryKey: TICKET_KEY });
  };
  // A final conflict: the server's reason, and the list as it now is — the row goes if answered.
  const onFinal = (item: InboxItem, message: string) => {
    // The row may already be gone, so the reason is told where it cannot be lost with it.
    notify.error(
      `Not answered: ${subjectOf(item)}`,
      `${message}. The proposals are refreshed.`,
    );
    void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
  };

  const items = proposals.data?.items ?? [];
  return (
    <Panel label="proposals" title="Pending proposals">
      <p className="text-sm text-muted-foreground">
        Approve starts the proposed session now, if its agent is free. Reject
        records your decision, and this phase is not proposed again.
      </p>
      {proposals.isPending && <Loading label="Loading the proposals…" />}
      {proposals.isError && (
        <QueryError
          title="The proposals are unavailable"
          error={proposals.error}
          onRetry={() => void proposals.refetch()}
        />
      )}
      {proposals.data !== undefined && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {project.staff_approval
            ? "None open."
            : "None open. Approval is off: the orchestrator staffs without asking."}
        </p>
      )}
      {items.length > 0 && (
        <ul aria-label="open proposals" className="flex flex-col gap-2">
          {items.map((item) => (
            <ProposalRow
              key={item.id}
              item={item}
              names={names}
              tabHref={tabHref}
              onAnswered={onAnswered}
              onFinal={onFinal}
            />
          ))}
        </ul>
      )}
      {proposals.data?.has_more === true && (
        <p className="text-sm">
          More are open than shown here:{" "}
          <TextLink inline href={INBOX_HREF}>
            the Inbox
          </TextLink>{" "}
          lists them all.
        </p>
      )}
    </Panel>
  );
}

function ProposalRow({
  item,
  names,
  tabHref,
  onAnswered,
  onFinal,
}: {
  readonly item: InboxItem;
  readonly names: ReadonlyMap<string, string>;
  readonly tabHref: TabHref;
  readonly onAnswered: (item: InboxItem, decision: StaffDecision) => void;
  readonly onFinal: (item: InboxItem, message: string) => void;
}) {
  const answer = useMutation({
    mutationFn: (decision: StaffDecision) => answerInboxItem(item.id, decision),
    onSuccess: (_answered, decision) => onAnswered(item, decision),
    onError: (error) => {
      if (isFinalConflict(error)) onFinal(item, conflictMessage(error));
    },
  });
  // Not final (a retryable 409, the agent busy; or any other failure): the request is still open,
  // so the row stays and says why, in the server's words.
  const refusal =
    answer.isError && !isFinalConflict(answer.error)
      ? conflictMessage(answer.error)
      : null;
  // A rejection is for good (this phase is never proposed again), so it asks first; approval does not.
  const [confirming, setConfirming] = useState(false);
  const subject = subjectOf(item);
  return (
    <li
      aria-label={`proposal ${subject}`}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {item.ticket !== null && (
          <>
            <TextLink
              className="font-head"
              href={tabHref({ kind: "ticket", num: item.ticket.num })}
            >
              {subject}
            </TextLink>
            <span className="min-w-0 truncate">{item.ticket.title}</span>
          </>
        )}
        <span className="text-xs text-muted-foreground">
          {`asked ${formatTime(item.asked_at)} UTC`}
        </span>
      </div>
      {item.proposal === null ? (
        <AsAsked item={item} />
      ) : (
        <ProposalFacts proposal={item.proposal} names={names} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          aria-label={`Approve ${subject}`}
          disabled={answer.isPending}
          onClick={() => answer.mutate("approve")}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-label={`Reject ${subject}`}
          disabled={answer.isPending}
          onClick={() => {
            answer.reset();
            setConfirming(true);
          }}
        >
          Reject
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Reject ${subject}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {`Nothing starts, and the orchestrator will not propose this phase of ${subject} again.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={answer.isPending}
              onClick={() => {
                setConfirming(false);
                answer.mutate("reject");
              }}
            >
              {`Reject ${subject}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {refusal !== null && (
        <p role="alert" className="text-sm text-destructive">
          {`Not ${answer.variables === "reject" ? "rejected" : "approved"}: ${refusal}`}
        </p>
      )}
    </li>
  );
}

/** Who the proposal would staff, on which runner, as what (`proposal_json`). */
function ProposalFacts({
  proposal,
  names,
}: {
  readonly proposal: StaffProposal;
  readonly names: ReadonlyMap<string, string>;
}) {
  return (
    <DescriptionList>
      <DescriptionItem term="Agent">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-head">
            {names.get(proposal.agent_id) ?? proposal.agent_id}
          </span>
          <Id value={proposal.runner_id} className="text-xs" />
        </span>
      </DescriptionItem>
      <DescriptionItem term="As">{`${proposal.role} · ${proposal.run_class}`}</DescriptionItem>
      <DescriptionItem term="Hand-off">
        {proposal.handoff_id === null ? (
          "none"
        ) : (
          <Id value={proposal.handoff_id} />
        )}
      </DescriptionItem>
    </DescriptionList>
  );
}

/** A request without the proposal's fields: its question and context, as they were asked. */
function AsAsked({ item }: { readonly item: InboxItem }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>{item.question}</p>
      {item.context_md !== null && (
        <p className="whitespace-pre-wrap text-muted-foreground">
          {item.context_md}
        </p>
      )}
    </div>
  );
}
