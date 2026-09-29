import type { GateSummary } from "@bayon/proto";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { TextLink } from "@/components/text-link";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GateActions } from "@/gates/gate-actions";
import { gateLine } from "@/gates/gate-announce";
import { GateAnnouncer } from "@/gates/gate-announcer";
import { queueQuery } from "@/gates/gate-api";
import { GateStateBadge, ReviewerFacts } from "@/gates/gate-badges";
import { failureNote, gateName } from "@/gates/gate-model";
import { useGatesFeed } from "@/gates/use-gates-feed";
import { ConflictNotice, type OnConflict } from "@/gates/write-dialog";
import { formatTime } from "@/lib/format";
import { FLEET_RECORD_LINKS, TICKETS_HREF, type RecordLinks } from "@/routing";
import { Panel } from "@/tickets/panel";
import { Muted } from "@/tickets/ticket-sections";

/**
 * The Review queue (§12.1 GET /gates): failed gates that need the operator, then running ones; live.
 * With `project` it is that project's Reviews view in its IDE: the gates of its tickets,
 * each ticket and reviewer session linked by `links`.
 */
export function ReviewQueueScreen({
  project,
  links = FLEET_RECORD_LINKS,
}: {
  readonly project?: string;
  readonly links?: RecordLinks;
}) {
  useGatesFeed(project);
  const [notice, setNotice] = useState<string | null>(null);
  const queue = useInfiniteQuery(queueQuery(project));
  return (
    <PageContainer fill>
      <PageHeader
        title="Reviews"
        meta={
          project === undefined ? undefined : "Gates on this project's tickets."
        }
      />
      <ConflictNotice notice={notice} />
      {queue.isPending && <Loading label="Loading the review queue…" />}
      {queue.isError && (
        <QueryError
          title="The review queue is unavailable"
          error={queue.error}
          onRetry={() => void queue.refetch()}
        />
      )}
      {queue.data !== undefined && (
        <LiveQueue
          gates={uniqueGates(queue.data.pages.flatMap((page) => page.items))}
          links={links}
          onConflict={setNotice}
        />
      )}
      {queue.hasNextPage && (
        <Button
          variant="outline"
          className="w-fit"
          disabled={queue.isFetchingNextPage}
          onClick={() => void queue.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </PageContainer>
  );
}

/**
 * The loaded pages, each gate once. A snapshot replaces the first page before the later ones are
 * refetched (use-gates-feed.ts), so for a moment a gate can sit in two pages: the first copy wins.
 */
function uniqueGates(gates: readonly GateSummary[]): readonly GateSummary[] {
  const seen = new Set<string>();
  return gates.filter((gate) => {
    if (seen.has(gate.id)) return false;
    seen.add(gate.id);
    return true;
  });
}

/** The queue, and a live region that says which gate a push moved. */
function LiveQueue({
  gates,
  links,
  onConflict,
}: {
  readonly gates: readonly GateSummary[];
  readonly links: RecordLinks;
  readonly onConflict: OnConflict;
}) {
  return (
    <>
      <GateAnnouncer lines={gates.map((gate) => gateLine(gate, gate.ticket))} />
      <Queue gates={gates} links={links} onConflict={onConflict} />
    </>
  );
}

function Queue({
  gates,
  links,
  onConflict,
}: {
  readonly gates: readonly GateSummary[];
  readonly links: RecordLinks;
  readonly onConflict: OnConflict;
}) {
  if (gates.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing to review</EmptyTitle>
          <EmptyDescription>
            Running gates, and failed ones waiting for a rerun or a waiver, land
            here.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <TextLink href={TICKETS_HREF}>Open the Tickets board</TextLink>
        </EmptyContent>
      </Empty>
    );
  const failed = gates.filter((gate) => gate.state === "failed");
  const running = gates.filter((gate) => gate.state !== "failed");
  return (
    <>
      <QueueSection
        label="failed"
        title={`Failed · ${failed.length}`}
        empty="No failed gate needs you."
        gates={failed}
        links={links}
        onConflict={onConflict}
      />
      <QueueSection
        label="running"
        title={`Running · ${running.length}`}
        empty="No gate is running."
        gates={running}
        links={links}
        onConflict={onConflict}
      />
    </>
  );
}

function QueueSection({
  label,
  title,
  empty,
  gates,
  links,
  onConflict,
}: {
  readonly label: string;
  readonly title: string;
  readonly empty: string;
  readonly gates: readonly GateSummary[];
  readonly links: RecordLinks;
  readonly onConflict: OnConflict;
}) {
  return (
    <Panel label={label} title={title} fill>
      {gates.length === 0 ? (
        <Muted>{empty}</Muted>
      ) : (
        <Table scroll="fill">
          <TableHeader>
            <TableRow>
              <TableHead>ticket</TableHead>
              <TableHead>gate</TableHead>
              <TableHead>state</TableHead>
              <TableHead>reviewer</TableHead>
              <TableHead>started</TableHead>
              <TableHead>findings</TableHead>
              <TableHead>actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {gates.map((gate) => (
              <QueueRow
                key={gate.id}
                gate={gate}
                links={links}
                onConflict={onConflict}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function QueueRow({
  gate,
  links,
  onConflict,
}: {
  readonly gate: GateSummary;
  readonly links: RecordLinks;
  readonly onConflict: OnConflict;
}) {
  const note = failureNote(gate);
  return (
    <TableRow>
      <TableCell>
        <TextLink href={links.ticket(gate.ticket.num)}>
          {`${gate.ticket.key} ${gate.ticket.title}`}
        </TextLink>
      </TableCell>
      <TableCell>{`${gateName(gate)} #${gate.attempt}`}</TableCell>
      <TableCell className="whitespace-normal">
        <div className="flex flex-col items-start gap-1">
          <GateStateBadge gate={gate} />
          {note !== null && (
            <span className="text-xs text-muted-foreground">{note}</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <ReviewerFacts gate={gate} links={links} />
      </TableCell>
      <TableCell>
        {gate.started_at === null ? "—" : `${formatTime(gate.started_at)} UTC`}
      </TableCell>
      <TableCell>{`${gate.findings_unresolved} open / ${gate.findings_total}`}</TableCell>
      <TableCell>
        <GateActions gate={gate} onConflict={onConflict} />
      </TableCell>
    </TableRow>
  );
}
