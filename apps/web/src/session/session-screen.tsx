import type { SessionView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { sessionQuery } from "@/api/queries";
import { BackLink } from "@/app-shell/back-link";
import { Id } from "@/components/id";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { sessionStatus } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { useHashTab } from "@/components/use-hash-tab";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatUsd } from "@/fleet/fleet-model";
import { FLEET_HREF } from "@/routing";
import { AttachButton, takeoverPending } from "@/session/attach-button";
import { contextSavedLine, failedOpen } from "@/session/context-saved";
import { DiffTab } from "@/session/diff-tab";
import { HandoffButton } from "@/session/handoff-button";
import { clearLeaseToken, isLeaseHolderFor } from "@/session/pty-lease-storage";
import { StopButton } from "@/session/stop-button";
import { TerminalTab } from "@/terminal/terminal-tab";
import { Timeline } from "@/timeline/timeline";
import { WatchPane } from "@/watch/watch-pane";

/** The header's counters change as the session runs; the Timeline itself is live over WS. */
const SESSION_REFRESH_MS = 5_000;

const TABS = ["timeline", "watch", "terminal", "diff"] as const;

/**
 * §12.3 SESSION: the Timeline is the default view; Watch is the same stream as a
 * read-only terminal, the Terminal the attached one, and the Diff per repo. The way back returns to
 * where the operator came from, else to `backHref`; an IDE tab passes a
 * null `backHref`: its tab strip is the way back.
 */
export function SessionScreen({
  sessionId,
  backHref = FLEET_HREF,
}: {
  readonly sessionId: string;
  readonly backHref?: string | null;
}) {
  const session = useQuery({
    ...sessionQuery(sessionId),
    refetchInterval: SESSION_REFRESH_MS,
  });
  const state = session.data?.state;
  const leaseOwner = session.data?.attach_lease_owner ?? null;
  // This tab's own token, minted and persisted by AttachButton before its request ever went out
  // (own code review: adopting "whatever lease owner shows up next" raced a different
  // actor's attach and permanently stranded a legitimate holder across a reload — comparing a
  // token this tab already knows against the poll has neither failure mode). No React state: a
  // fresh read every render is as cheap as the comparison itself, and never goes stale.
  const isLeaseHolder = isLeaseHolderFor(sessionId, leaseOwner);
  // A takeover asked "after this step" will mint this tab's token as the lease owner
  // later: the token stays while it is pending, including the brief `idle` between the run's end and
  // the attach itself.
  const pending = session.data !== undefined && takeoverPending(session.data);
  // The open tab is the URL's `?tab=` where the router keeps one, so a reload keeps it.
  const [tab, setTab] = useHashTab(TABS, "timeline");
  useEffect(() => {
    // Once nobody holds the lease, no persisted token is valid — for this tab or a stale one left
    // by a detach/TTL expiry/boot sweep this tab never saw complete.
    if (state !== undefined && state !== "human_attached" && !pending) {
      clearLeaseToken(sessionId);
    }
  }, [sessionId, state, pending]);

  return (
    <PageContainer fill>
      {backHref !== null && <BackLink parent={backHref} />}
      <PageHeader
        title={
          session.data === undefined
            ? "Session"
            : `Session · ${session.data.agent_name}`
        }
        meta={
          <>
            <Id value={sessionId} copy label="session id" />
            {session.data !== undefined && (
              <SessionFacts session={session.data} />
            )}
          </>
        }
        actions={
          session.data === undefined ? undefined : (
            <>
              <HandoffButton session={session.data} />
              <StopButton session={session.data} />
              <AttachButton session={session.data} />
            </>
          )
        }
      />
      {session.isError && (
        <QueryError
          title="The session is unavailable"
          error={session.error}
          onRetry={() => void session.refetch()}
        />
      )}
      {session.data !== undefined && <FailedOpen session={session.data} />}
      <Tabs
        value={tab}
        onValueChange={(value: unknown) => {
          const next = TABS.find((t) => t === value);
          if (next !== undefined) setTab(next);
        }}
        className="min-h-0 flex-1 gap-3"
      >
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="watch">Watch</TabsTrigger>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="diff">Diff</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="flex min-h-0 flex-col">
          <Timeline
            sessionId={sessionId}
            agentName={session.data?.agent_name}
          />
        </TabsContent>
        <TabsContent value="watch" className="flex min-h-0 flex-col">
          <WatchPane sessionId={sessionId} className="min-h-96" />
        </TabsContent>
        <TabsContent value="terminal" className="flex min-h-0 flex-col">
          {session.data !== undefined && (
            <TerminalTab session={session.data} isLeaseHolder={isLeaseHolder} />
          )}
        </TabsContent>
        <TabsContent value="diff">
          <DiffTab sessionId={sessionId} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

/** The meta row: how the session stands (an exited one by how it ended), where it runs, what it cost. */
function SessionFacts({ session }: { readonly session: SessionView }) {
  return (
    <>
      <StatusBadge status={sessionStatus(session.state, session.exit_reason)} />
      <span className="inline-flex items-center gap-1">
        <Id value={session.runner_id} />
        {" · "}
        <Id value={session.executor_id} />
      </span>
      {session.model !== null && <span>{session.model}</span>}
      <span>{session.run_class}</span>
      <span>{`${session.turns} ${session.turns === 1 ? "turn" : "turns"}`}</span>
      <span>{formatUsd(session.cost_usd)}</span>
      <ContextSaved session={session} />
    </>
  );
}

/** Context compression's saving, where the session was compressed. */
function ContextSaved({ session }: { readonly session: SessionView }) {
  const line = contextSavedLine(session);
  return line === null ? null : <span>{line}</span>;
}

/** Blocks sent whole because compressing them failed: the model saw more than it would have. */
function FailedOpen({ session }: { readonly session: SessionView }) {
  const failed = failedOpen(session);
  if (failed === 0) return null;
  return (
    <Alert status="warning" role="note">
      <AlertTitle>Context compression failed open</AlertTitle>
      <AlertDescription>
        {`${failed} large tool ${failed === 1 ? "result was" : "results were"} sent to the model whole because compressing ${failed === 1 ? "it" : "them"} failed. Nothing was lost; the supervisor log says why.`}
      </AlertDescription>
    </Alert>
  );
}
