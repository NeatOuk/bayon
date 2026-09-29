import type { TicketDetail } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { Ban } from "lucide-react";
import { ticketQuery } from "@/api/queries";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { humanize } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FindingsPanel } from "@/gates/findings-panel";
import { GateStrip } from "@/gates/gate-strip";
import { useGatesFeed } from "@/gates/use-gates-feed";
import { HandoffChain } from "@/handoffs/handoff-chain";
import { JiraKeyChip, jiraKeyOf, useJiraSites } from "@/jira/jira-key-chip";
import { siteFromBody } from "@/jira/jira-links";
import { Markdown } from "@/markdown/markdown";
import { TICKETS_HREF } from "@/routing";
import { AddALaw } from "@/tickets/add-a-law";
import { NeedsHumanLink, needsHuman } from "@/tickets/needs-human-link";
import { NextStepLine } from "@/tickets/next-step-line";
import { Panel } from "@/tickets/panel";
import { TicketActions } from "@/tickets/ticket-actions";
import { TicketQuestions } from "@/tickets/ticket-questions";
import { reviewRoundsLabel } from "@/tickets/ticket-model";
import { EconomicsPanel, EventsPanel } from "@/tickets/ticket-sections";
import { useTicketsFeed } from "@/tickets/use-tickets-feed";

/**
 * §12.3 TICKET: `#/tickets/:num`, live from the `tickets` and `gates` topics. An IDE tab
 * passes a null `backHref`: its tab strip is the way back.
 */
export function TicketScreen({
  num,
  backHref = TICKETS_HREF,
}: {
  readonly num: number;
  readonly backHref?: string | null;
}) {
  useTicketsFeed();
  useGatesFeed();
  const detail = useQuery(ticketQuery(num));
  return (
    <PageContainer className="@container">
      {backHref !== null && (
        <TextLink href={backHref} className="w-fit text-sm">
          ← Tickets
        </TextLink>
      )}
      {detail.isPending && (
        // A failed try waiting on its retry (paused while the tab is hidden) says why it still loads.
        <Loading
          label={
            detail.failureReason === null
              ? "Loading the ticket…"
              : `Loading the ticket… retrying after ${detail.failureReason.message}`
          }
        />
      )}
      {detail.isError && (
        <QueryError
          title="The ticket is unavailable"
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      )}
      {detail.data !== undefined && <TicketView detail={detail.data} />}
    </PageContainer>
  );
}

/** Only http(s) becomes a link: `pr_url` is any URL zod accepts, `javascript:` included. */
const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

function TicketView({ detail }: { readonly detail: TicketDetail }) {
  const { ticket } = detail;
  const jiraKey = jiraKeyOf(ticket);
  // The project's source first; its body's own header link if the project no longer mirrors.
  const jiraSite =
    useJiraSites()(ticket.workspace_id) ??
    (jiraKey === null ? null : siteFromBody(ticket.body_md, jiraKey));
  return (
    <>
      <div className="flex flex-col gap-3">
        <PageHeader
          title={
            <>
              <span className="font-mono text-muted-foreground">
                {ticket.key}
              </span>
              {` · ${ticket.title}`}
            </>
          }
          meta={
            <>
              <StatusBadge entity="ticket" state={ticket.status} />
              <span className="font-medium text-foreground">{`P${ticket.priority}`}</span>
              <span>{humanize(ticket.type)}</span>
              <JiraKeyChip ticket={ticket} site={jiraSite} />
              {ticket.pr_url !== null &&
                (isWebUrl(ticket.pr_url) ? (
                  <TextLink href={ticket.pr_url}>pull request</TextLink>
                ) : (
                  <span className="font-mono">{ticket.pr_url}</span>
                ))}
              <span>{`${ticket.complexity_tier} (score ${ticket.complexity_score})`}</span>
              <span>{reviewRoundsLabel(detail.economics.review_rounds)}</span>
              {needsHuman(ticket) && <NeedsHumanLink ticket={ticket} />}
              <span className="font-mono">
                {`v${ticket.version}`}
                {ticket.branch !== null && ` · ${ticket.branch}`}
              </span>
            </>
          }
        />
        <NextStepLine detail={detail} />
        {ticket.blocked_reason !== null && (
          <Alert status="error" role="note">
            <Ban aria-hidden="true" />
            <AlertTitle>{`Blocked: ${ticket.blocked_reason}`}</AlertTitle>
            <AlertDescription>
              {`Unblocks when ${ticket.unblock_condition ?? "?"}`}
            </AlertDescription>
          </Alert>
        )}
      </div>
      {/* Two columns once the screen (or the IDE's tab) is wide enough: the ticket on the left, what
          to do with it on the right. The rail comes first in the page's order, so a narrow screen
          shows the actions before the long reading. */}
      <div className="grid items-start gap-5 @5xl:grid-cols-[minmax(0,1fr)_20rem]">
        <aside
          aria-label="ticket rail"
          className="flex min-w-0 flex-col gap-5 @5xl:col-start-2 @5xl:row-start-1"
        >
          <TicketActions
            ticket={ticket}
            transitions={detail.transitions}
            suggested={
              detail.next_step.action?.kind === "transition"
                ? (detail.transitions.find(
                    (t) => t.to === detail.next_step.action?.target,
                  )?.to ?? null)
                : null
            }
          />
          <EconomicsPanel economics={detail.economics} />
          <AddALaw detail={detail} />
        </aside>
        <div className="flex min-w-0 flex-col gap-5 @5xl:col-start-1 @5xl:row-start-1">
          <TicketQuestions ticket={ticket} />
          {(ticket.body_md !== "" || ticket.acceptance_md !== "") && (
            <Panel label="description" title="Description">
              <Markdown markdown={ticket.body_md} />
              {ticket.acceptance_md !== "" && (
                <>
                  <SectionTitle as="h3" className="mt-2">
                    Acceptance
                  </SectionTitle>
                  <Markdown markdown={ticket.acceptance_md} />
                </>
              )}
            </Panel>
          )}
          <GateStrip gates={detail.gates} />
          <FindingsPanel gates={detail.gates} />
          <HandoffChain handoffs={detail.handoffs} />
          <EventsPanel
            events={detail.events.items}
            hasMore={detail.events.has_more}
          />
        </div>
      </div>
    </>
  );
}
