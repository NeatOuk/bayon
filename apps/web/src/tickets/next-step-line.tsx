import { STAFF_APPROVAL_KIND } from "@bayon/core";
import type {
  NextStep,
  TicketDetail,
  TicketView,
  TransitionOption,
} from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Button } from "@/components/ui/button";
import { RerunGateButton } from "@/gates/gate-actions";
import { cn } from "@/lib/utils";
import { AnswerDialog } from "@/inbox/answer-dialog";
import { ticketQuestionsQuery } from "@/inbox/inbox-api";
import {
  FLEET_HREF,
  GENERAL_HREF,
  RUNNERS_HREF,
  inboxHref,
  projectHref,
} from "@/routing";
import { useTicketMove } from "@/tickets/use-ticket-move";

// A ticket's next step in its header: who it waits on, the server's one sentence why, and
// the way on — the Inbox's own Answer dialog, the Actions panel's own move, the gate strip's own
// Rerun, or a link to where a pause lifts or a reviewer is set up. The server says what; this only
// renders it, so the line never disagrees with GET /tickets/:ref/next.

type Action = NonNullable<NextStep["action"]>;

export function NextStepLine({ detail }: { readonly detail: TicketDetail }) {
  const step = detail.next_step;
  return (
    <div
      aria-label="next step"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm shadow-xs",
        step.waiting_on === "you"
          ? "border-warning/40 bg-warning-subtle"
          : "bg-card",
      )}
    >
      <StatusBadge entity="waiting" state={step.waiting_on} />
      <span className="min-w-0 flex-1 font-medium">{step.reason}</span>
      {step.action !== undefined && (
        <StepAction detail={detail} action={step.action} />
      )}
    </div>
  );
}

function StepAction({
  detail,
  action,
}: {
  readonly detail: TicketDetail;
  readonly action: Action;
}) {
  const { ticket } = detail;
  switch (action.kind) {
    case "answer":
      return action.target === "questions" ? (
        <AnswerFirst ticket={ticket} label={action.label} />
      ) : (
        <Link href={inboxHref(ticket.workspace_id, ticket.num)}>
          {action.label}
        </Link>
      );
    case "transition": {
      const option = detail.transitions.find(
        (t) => t.to === action.target && t.allowed,
      );
      return option === undefined ? null : (
        <MoveButton ticket={ticket} option={option} label={action.label} />
      );
    }
    case "rerun_gate": {
      const gate = detail.gates.find((g) => g.id === action.target);
      return gate === undefined ? null : (
        <Rerun gate={gate} label={action.label} />
      );
    }
    case "unpause":
      return (
        <Link
          href={
            action.target === "project" && ticket.workspace_id !== null
              ? projectHref(ticket.workspace_id, "orchestrator")
              : FLEET_HREF
          }
        >
          {action.label}
        </Link>
      );
    case "configure":
      return (
        <Link href={action.target === "runners" ? RUNNERS_HREF : GENERAL_HREF}>
          {action.label}
        </Link>
      );
    case "none":
      return <span className="text-muted-foreground">{action.label}</span>;
  }
}

const Link = ({
  href,
  children,
}: {
  readonly href: string;
  readonly children: string;
}) => <TextLink href={href}>{children}</TextLink>;

/** The first open question, answered with the Inbox's own dialog; the Inbox while none is loaded. */
function AnswerFirst({
  ticket,
  label,
}: {
  readonly ticket: TicketView;
  readonly label: string;
}) {
  const questions = useQuery(ticketQuestionsQuery(ticket.num));
  const [notice, setNotice] = useState<string | null>(null);
  const first = questions.data?.items.find(
    (i) => i.kind !== STAFF_APPROVAL_KIND,
  );
  if (first === undefined)
    return (
      <Link href={inboxHref(ticket.workspace_id, ticket.num)}>{label}</Link>
    );
  return (
    <>
      <AnswerDialog item={first} onConflict={setNotice} />
      {notice !== null && (
        <span className="text-muted-foreground">{notice}</span>
      )}
    </>
  );
}

function MoveButton({
  ticket,
  option,
  label,
}: {
  readonly ticket: TicketView;
  readonly option: TransitionOption;
  readonly label: string;
}) {
  const move = useTicketMove(ticket);
  return (
    <>
      <Button
        size="sm"
        disabled={move.pending}
        onClick={() => move.choose(option)}
      >
        {label}
      </Button>
      {move.ui}
    </>
  );
}

function Rerun({
  gate,
  label,
}: {
  readonly gate: TicketDetail["gates"][number];
  readonly label: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <RerunGateButton gate={gate} label={label} onConflict={setNotice} />
      {notice !== null && (
        <span className="text-muted-foreground">{notice}</span>
      )}
    </>
  );
}
