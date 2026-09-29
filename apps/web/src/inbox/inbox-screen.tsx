import { STAFF_APPROVAL_KIND } from "@bayon/core";
import type { InboxItem, InboxStatus } from "@bayon/proto";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Id } from "@/components/id";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { useHashTab } from "@/components/use-hash-tab";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AnswerDialog } from "@/inbox/answer-dialog";
import { choicesOf } from "@/inbox/choices";
import { DismissButton } from "@/inbox/dismiss-button";
import { inboxQuery } from "@/inbox/inbox-api";
import {
  groupByTicket,
  kindLabel,
  recommendationOf,
  type InboxGroup,
} from "@/inbox/inbox-groups";
import { Recommendation } from "@/inbox/recommendation";
import { useInboxFeed } from "@/inbox/use-inbox-feed";
import { formatUtc, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Markdown } from "@/markdown/markdown";
import {
  FLEET_HREF,
  FLEET_RECORD_LINKS,
  INBOX_HREF,
  projectHref,
  type RecordLinks,
} from "@/routing";

type OnConflict = (message: string) => void;

/** Where the lists read from, and where their links go. */
interface Scope {
  readonly project: string | undefined;
  /** One ticket's requests only. */
  readonly ticket: number | undefined;
  readonly links: RecordLinks;
}

const TABS: readonly InboxStatus[] = ["open", "answered", "dismissed"];

/**
 * §2 Inbox: what agents asked with human_ask (§11.1), open first; live from the `inbox` topic. With
 * `project` it is that project's Inbox view in its IDE: its requests only, staffing
 * proposals among them, each ticket and session linked by `links`. With `ticket` it shows that one
 * ticket's requests: where the ticket's "needs human" badge sends the operator. The
 * requests are grouped by ticket, newest first.
 */
export function InboxScreen({
  project,
  ticket,
  links = FLEET_RECORD_LINKS,
}: {
  readonly project?: string;
  readonly ticket?: number | undefined;
  readonly links?: RecordLinks;
}) {
  useInboxFeed(project);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useHashTab(TABS, "open");
  const scope: Scope = { project, ticket, links };
  return (
    <PageContainer size="wide">
      <PageHeader
        title="Inbox"
        meta={
          project === undefined && ticket === undefined ? undefined : (
            <>
              {project !== undefined && (
                <span>
                  What this project&apos;s agents asked, and its staffing
                  proposals.
                </span>
              )}
              {ticket !== undefined && (
                <span>
                  {`Only ticket #${ticket}'s requests. `}
                  <TextLink
                    inline
                    href={
                      project === undefined
                        ? INBOX_HREF
                        : projectHref(project, "inbox")
                    }
                  >
                    Show all
                  </TextLink>
                </span>
              )}
            </>
          )
        }
      />
      {notice !== null && (
        <Alert status="warning">
          <AlertTitle>Already answered</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      <Tabs
        value={tab}
        onValueChange={(value: unknown) => {
          const next = TABS.find((t) => t === value);
          if (next !== undefined) setTab(next);
        }}
        className="gap-4"
      >
        <TabsList>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="answered">Answered</TabsTrigger>
          <TabsTrigger value="dismissed">Dismissed</TabsTrigger>
        </TabsList>
        {TABS.map((status) => (
          <TabsContent key={status} value={status}>
            <InboxList status={status} scope={scope} onConflict={setNotice} />
          </TabsContent>
        ))}
      </Tabs>
    </PageContainer>
  );
}

const EMPTY: Readonly<Record<InboxStatus, readonly [string, string]>> = {
  open: [
    "Nothing needs you",
    "When an agent asks with human_ask, its question lands here, grouped by ticket.",
  ],
  answered: ["No answers yet", "Answered requests move here."],
  dismissed: [
    "Nothing dismissed",
    "Questions you dismiss as no longer relevant move here.",
  ],
};

function InboxList({
  status,
  scope,
  onConflict,
}: {
  readonly status: InboxStatus;
  readonly scope: Scope;
  readonly onConflict: OnConflict;
}) {
  const inbox = useInfiniteQuery(
    inboxQuery(status, scope.project, scope.ticket),
  );
  if (inbox.isPending) return <Loading label="Loading the inbox…" lines={3} />;
  if (inbox.isError)
    return (
      <QueryError
        title="The inbox is unavailable"
        error={inbox.error}
        onRetry={() => void inbox.refetch()}
      />
    );
  const items = inbox.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    const [title, description] = EMPTY[status];
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <TextLink href={FLEET_HREF}>Back to the Fleet</TextLink>
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <div
        role="region"
        aria-label={`${status} requests`}
        className="flex flex-col gap-6"
      >
        {groupByTicket(items).map((group) => (
          <TicketGroup
            key={group.key}
            group={group}
            links={scope.links}
            now={inbox.dataUpdatedAt}
            onConflict={onConflict}
          />
        ))}
      </div>
      {inbox.hasNextPage && (
        <Button
          variant="outline"
          className="w-fit"
          disabled={inbox.isFetchingNextPage}
          onClick={() => void inbox.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

/** One ticket's requests under its key and title, with how many there are. */
function TicketGroup({
  group,
  links,
  now,
  onConflict,
}: {
  readonly group: InboxGroup;
  readonly links: RecordLinks;
  readonly now: number;
  readonly onConflict: OnConflict;
}) {
  const headingId = useId();
  const { ticket, items } = group;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <h2
          id={headingId}
          className="flex min-w-0 items-baseline gap-2 font-head text-sm font-semibold"
        >
          {ticket === null ? (
            "Not about a ticket"
          ) : (
            <>
              <TextLink href={links.ticket(ticket.num)} className="shrink-0">
                {`#${ticket.num}`}
              </TextLink>{" "}
              <span className="truncate" title={ticket.title}>
                {ticket.title}
              </span>
            </>
          )}
        </h2>
        <Badge variant="outline" tone="neutral">
          {items.length}
          <span className="sr-only">
            {items.length === 1 ? " request" : " requests"}
          </span>
        </Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <InboxCard
              item={item}
              links={links}
              now={now}
              onConflict={onConflict}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A question longer than this is clamped to three lines, with Show more. */
const LONG_QUESTION = 300;

function Question({ text }: { readonly text: string }) {
  const [whole, setWhole] = useState(false);
  const long = text.length > LONG_QUESTION;
  return (
    <div className="flex flex-col items-start gap-1">
      <h3
        className={cn(
          "font-head text-base leading-snug font-medium break-words",
          long && !whole && "line-clamp-3",
        )}
      >
        {text}
      </h3>
      {long && (
        <Button
          variant="link"
          size="xs"
          className="h-auto px-0 text-primary"
          aria-expanded={whole}
          onClick={() => setWhole((shown) => !shown)}
        >
          {whole ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

function InboxCard({
  item,
  links,
  now,
  onConflict,
}: {
  readonly item: InboxItem;
  readonly links: RecordLinks;
  readonly now: number;
  readonly onConflict: OnConflict;
}) {
  const recommendation = recommendationOf(item.context_md);
  return (
    <article className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs">
      <Question text={item.question} />
      <p
        data-slot="inbox-meta"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      >
        <Badge variant="outline" tone="neutral">
          {kindLabel(item.kind)}
        </Badge>
        <span title={formatUtc(item.asked_at)}>
          {`asked ${relativeTime(item.asked_at, now)}`}
        </span>
        {item.expires_at !== null && (
          <span>{`expires ${formatUtc(item.expires_at)}`}</span>
        )}
        {item.session !== null && (
          <span className="inline-flex items-center gap-1.5">
            {"by "}
            <TextLink href={links.session(item.session.id)}>
              {item.session.agent}
            </TextLink>
            <StatusBadge entity="session" state={item.session.state} />
            <Id value={item.session.id} />
          </span>
        )}
      </p>
      {recommendation !== null ? (
        <Recommendation text={recommendation} />
      ) : (
        item.context_md !== null && (
          <div className="text-sm">
            <Markdown markdown={item.context_md} />
          </div>
        )
      )}
      <Outcome item={item} onConflict={onConflict} />
    </article>
  );
}

/**
 * An open request's options as chips and its Answer (and, for a question, Dismiss); a
 * closed one's answer, or that the operator dismissed it. A staffing proposal is approved or
 * rejected, never dismissed. Picking a chip starts the answer from it: an answer is final, so the
 * dialog still asks for Send.
 */
function Outcome({
  item,
  onConflict,
}: {
  readonly item: InboxItem;
  readonly onConflict: OnConflict;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const who = ` · ${item.answered_by ?? "unknown"}${item.answered_at === null ? "" : `, ${formatUtc(item.answered_at)}`}`;
  if (item.status === "open") {
    const choices = choicesOf(item.options);
    return (
      <div className="flex flex-col gap-3">
        {choices.length > 0 && (
          <ToggleGroup
            aria-label="options"
            variant="outline"
            size="sm"
            className="flex-wrap"
            value={picked === null ? [] : [picked]}
            onValueChange={(values: readonly unknown[]) => {
              const [value] = values;
              setPicked(typeof value === "string" ? value : null);
            }}
          >
            {choices.map((choice) => (
              <ToggleGroupItem
                key={choice}
                value={choice}
                className="h-auto min-h-8 max-w-full py-1 text-left whitespace-normal"
              >
                {choice}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <AnswerDialog item={item} onConflict={onConflict} preset={picked} />
          {item.kind !== STAFF_APPROVAL_KIND && <DismissButton item={item} />}
        </div>
      </div>
    );
  }
  if (item.status === "dismissed") {
    return (
      <p className="text-sm">
        <strong>Dismissed as no longer relevant</strong>
        <span className="text-muted-foreground">{who}</span>
      </p>
    );
  }
  return (
    <p className="text-sm">
      <strong>{`Answer: ${item.answer ?? ""}`}</strong>
      <span className="text-muted-foreground">{who}</span>
    </p>
  );
}
