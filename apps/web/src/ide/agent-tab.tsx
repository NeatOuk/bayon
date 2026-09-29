import type { AgentSessionItem, FleetRow, ProjectView } from "@bayon/proto";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Id } from "@/components/id";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { humanize, sessionStatus } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatUsd } from "@/fleet/fleet-model";
import { agentSessionsQuery } from "@/ide/agents-api";
import type { HistoryFilters } from "@/ide/history-filters";
import { LiveState, type TabHref } from "@/ide/live-state";
import { ticketNumOf } from "@/ide/open-tabs";
import { useProjectFleet } from "@/ide/project-fleet";
import { formatTime } from "@/lib/format";
import { missionHref, projectHref, type IdeView } from "@/routing";
import { Panel } from "@/tickets/panel";
import { WatchPane } from "@/watch/watch-pane";

const NO_ROWS: readonly FleetRow[] = [];

/**
 * An agent tab: who the agent is and what it is doing now — watched live
 * while it has a session — then every session it ran, newest first. A session opens as its own tab — the session screen, whose Timeline
 * replays it event by event — and a ticket as its tab.
 */
export function AgentTab({
  project,
  view,
  id,
  filters,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
  readonly id: string;
  /** The history view's filters: a tab opened from here beside it keeps them. */
  readonly filters?: HistoryFilters | undefined;
}) {
  const { byAgent } = useProjectFleet(project.id);
  const agent = project.agents.find((known) => known.id === id);
  if (agent === undefined)
    return (
      <PageContainer>
        <p role="alert">{`This project has no agent ${id}.`}</p>
      </PageContainer>
    );
  const tabHref: TabHref = (tab) => projectHref(project.id, view, tab, filters);
  const live = byAgent.get(agent.name) ?? NO_ROWS;
  return (
    <PageContainer>
      <header className="flex flex-col gap-2">
        <PageHeader
          title={agent.name}
          meta={
            <>
              <Badge variant="outline">{humanize(agent.kind)}</Badge>
              <Id value={agent.runner_id} />
              <StatusBadge
                entity="enabled"
                state={agent.enabled ? "enabled" : "disabled"}
              />
              <Badge variant="outline">{`max concurrency ${agent.max_concurrency}`}</Badge>
              <Id value={agent.id} copy label="agent id" />
            </>
          }
        />
        <LiveState agent={agent} rows={live} tabHref={tabHref} />
        <TextLink className="w-fit" href={missionHref(agent.name)}>
          Mission
        </TextLink>
      </header>
      {live.length > 0 && <AgentWatch rows={live} />}
      <AgentSessions agentId={agent.id} tabHref={tabHref} />
    </PageContainer>
  );
}

/**
 * Watch: what the agent is doing right now, as a read-only terminal of its live
 * session's events — it never touches the agent. With several live sessions, one at a time.
 */
function AgentWatch({ rows }: { readonly rows: readonly FleetRow[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const watched = rows.find((row) => row.id === picked) ?? rows[0];
  if (watched === undefined) return null;
  return (
    <Panel label="watch" title="Watch">
      {rows.length > 1 && (
        <ToggleGroup
          aria-label="watched session"
          variant="outline"
          size="sm"
          value={[watched.id]}
          onValueChange={(values: readonly unknown[]) => {
            const next = values.find(
              (value): value is string => typeof value === "string",
            );
            if (next !== undefined) setPicked(next);
          }}
        >
          {rows.map((row) => (
            <ToggleGroupItem key={row.id} value={row.id}>
              {"session "}
              <Id value={row.id} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      <WatchPane key={watched.id} sessionId={watched.id} className="h-80" />
    </Panel>
  );
}

/** `GET /agents/:id/sessions`, newest first, a page at a time: "Load older" reads the next. */
function AgentSessions({
  agentId,
  tabHref,
}: {
  readonly agentId: string;
  readonly tabHref: TabHref;
}) {
  const sessions = useInfiniteQuery(agentSessionsQuery(agentId));
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Panel label="sessions" title="Sessions">
      {sessions.isPending && <Loading label="Loading the sessions…" />}
      {sessions.isError && sessions.data === undefined && (
        <QueryError
          title="The sessions are unavailable"
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      )}
      {sessions.isSuccess && items.length === 0 && (
        <p className="text-sm text-muted-foreground">No sessions yet.</p>
      )}
      {items.length > 0 && (
        <Table aria-label="agent sessions">
          <TableHeader>
            <TableRow>
              <TableHead>session</TableHead>
              <TableHead>ticket</TableHead>
              <TableHead>role · run class</TableHead>
              <TableHead>state</TableHead>
              <TableHead>started</TableHead>
              <TableHead>ended</TableHead>
              <TableHead className="text-right">turns</TableHead>
              <TableHead className="text-right">cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <SessionRow key={item.id} item={item} tabHref={tabHref} />
            ))}
          </TableBody>
        </Table>
      )}
      {sessions.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={sessions.isFetchingNextPage}
          onClick={() => void sessions.fetchNextPage()}
        >
          {sessions.isFetchingNextPage ? "Loading…" : "Load older"}
        </Button>
      )}
      {sessions.isFetchNextPageError && (
        <p role="alert" className="text-sm">
          {`The older sessions are unavailable: ${sessions.error?.message ?? ""}`}
        </p>
      )}
    </Panel>
  );
}

const at = (ms: number | null): string =>
  ms === null ? "—" : `${formatTime(ms)} UTC`;

function SessionRow({
  item,
  tabHref,
}: {
  readonly item: AgentSessionItem;
  readonly tabHref: TabHref;
}) {
  const num = item.ticket_key === null ? null : ticketNumOf(item.ticket_key);
  return (
    <TableRow>
      <TableCell>
        <TextLink href={tabHref({ kind: "session", id: item.id })}>
          <Id value={item.id} />
        </TextLink>
      </TableCell>
      <TableCell className="font-mono">
        {num === null ? (
          (item.ticket_key ?? "—")
        ) : (
          <TextLink href={tabHref({ kind: "ticket", num })}>
            {item.ticket_key}
          </TextLink>
        )}
      </TableCell>
      <TableCell>{`${item.role} · ${item.run_class}`}</TableCell>
      <TableCell>
        <StatusBadge status={sessionStatus(item.state, item.exit_reason)} />
      </TableCell>
      <TableCell className="font-mono text-xs">{at(item.started_at)}</TableCell>
      <TableCell className="font-mono text-xs">{at(item.ended_at)}</TableCell>
      <TableCell className="text-right font-mono">{item.turns}</TableCell>
      <TableCell className="text-right font-mono">
        {formatUsd(item.cost_usd)}
      </TableCell>
    </TableRow>
  );
}
