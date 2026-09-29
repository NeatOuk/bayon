import type { PulseCheckView, PulseDetail } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DescriptionList } from "@/components/description-list";
import { Id } from "@/components/id";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { humanize, pulseStatus } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/fleet/fleet-model";
import { formatUtc, relativeTime } from "@/lib/format";
import { Markdown } from "@/markdown/markdown";
import { pulseQuery } from "@/pulses/pulse-api";
import { timeOrDash, untrustedOf } from "@/pulses/pulse-model";
import { usePulsesFeed } from "@/pulses/use-pulses-feed";
import { PULSES_HREF, sessionHref } from "@/routing";
import { Panel } from "@/tickets/panel";
import { Muted } from "@/tickets/ticket-sections";

/**
 * One pulse (§10.1): its context pack, probe checks, report and cost; live from the `pulses` topic.
 * An IDE tab passes a null `backHref`, its tab strip being the way back, and a
 * `sessionLink` that opens the pulse's session as a tab beside it.
 */
export function PulseScreen({
  pulseId,
  backHref = PULSES_HREF,
  sessionLink = sessionHref,
}: {
  readonly pulseId: string;
  readonly backHref?: string | null;
  readonly sessionLink?: (sessionId: string) => string;
}) {
  usePulsesFeed();
  const pulse = useQuery(pulseQuery(pulseId));
  return (
    <PageContainer size="wide">
      {backHref !== null && (
        <TextLink href={backHref} className="w-fit text-sm">
          ← Pulses
        </TextLink>
      )}
      {pulse.isPending && <Loading label="Loading the pulse…" lines={3} />}
      {pulse.isError && (
        <QueryError
          title="The pulse is unavailable"
          error={pulse.error}
          onRetry={() => void pulse.refetch()}
        />
      )}
      {pulse.data !== undefined && (
        <PulseReport
          pulse={pulse.data}
          now={pulse.dataUpdatedAt}
          sessionLink={sessionLink}
        />
      )}
    </PageContainer>
  );
}

/** Why a pulse has no summary. */
function noSummary(pulse: PulseDetail): string {
  if (pulse.state === "leased" || pulse.state === "running")
    return "Not reported yet.";
  if (pulse.state === "skipped") return "Skipped: no session ran.";
  return "No pulse_report: the pulse ended without one.";
}

const Mono = ({ children }: { readonly children: string }) => (
  <span className="font-mono break-all">{children}</span>
);

function PulseReport({
  pulse,
  now,
  sessionLink,
}: {
  readonly pulse: PulseDetail;
  /** When the read arrived: the relative time is measured from it, so rendering stays pure. */
  readonly now: number;
  readonly sessionLink: (sessionId: string) => string;
}) {
  const facts: readonly (readonly [string, ReactNode])[] = [
    ["agent", <Id key="agent" value={pulse.agent_id} />],
    ["trigger", pulse.trigger],
    ["scheduled", timeOrDash(pulse.scheduled_at)],
    ["started", timeOrDash(pulse.started_at)],
    ["ended", timeOrDash(pulse.ended_at)],
    [
      "session",
      pulse.session_id === null ? (
        "—"
      ) : (
        <TextLink href={sessionLink(pulse.session_id)}>
          <Id value={pulse.session_id} />
        </TextLink>
      ),
    ],
    [
      "context pack",
      pulse.context_pack_path === null ? (
        "—"
      ) : (
        <Mono>{pulse.context_pack_path}</Mono>
      ),
    ],
    ["context tokens", pulse.context_tokens?.toLocaleString("en") ?? "—"],
    ["cost", pulse.cost_usd === null ? "—" : formatUsd(pulse.cost_usd)],
  ];
  const actions = pulse.actions ?? [];
  return (
    <>
      <PageHeader
        title="Pulse"
        meta={
          <>
            <StatusBadge status={pulseStatus(pulse)} />
            <Id value={pulse.id} copy label="pulse id" />
            <span>{`${humanize(pulse.trigger)} trigger`}</span>
            <span title={formatUtc(pulse.scheduled_at)}>
              {`scheduled ${relativeTime(pulse.scheduled_at, now)}`}
            </span>
          </>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Panel label="facts" title="Facts">
            <DescriptionList items={facts} />
          </Panel>
          <Panel label="summary" title="Summary">
            {pulse.summary_md === null ? (
              <Muted>{noSummary(pulse)}</Muted>
            ) : (
              <Markdown markdown={pulse.summary_md} />
            )}
          </Panel>
          <Panel label="actions" title="Actions">
            {actions.length === 0 ? (
              <Muted>No actions.</Muted>
            ) : (
              <ol className="list-decimal pl-5 text-sm">
                {keyedActions(actions).map(({ key, text }) => (
                  <li key={key}>{text}</li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
        <ChecksPanel checks={pulse.checks} />
      </div>
    </>
  );
}

/** Each action keyed by its text and how often that text came before it: stable, and never the index. */
const keyedActions = (actions: readonly string[]) =>
  actions.map((text, i) => ({
    text,
    key: `${actions.slice(0, i).filter((a) => a === text).length}:${text}`,
  }));

function TrustBadge({ untrusted }: { readonly untrusted: boolean | null }) {
  if (untrusted === null) return <span>—</span>;
  return (
    <StatusBadge entity="content" state={untrusted ? "untrusted" : "trusted"} />
  );
}

/** The probes the context pack fenced (§10.2): untrusted output is data, never instructions. */
function ChecksPanel({
  checks,
}: {
  readonly checks: readonly PulseCheckView[];
}) {
  return (
    <Panel label="checks" title="Checks">
      {checks.length === 0 ? (
        <Muted>No probe ran for this pulse.</Muted>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>probe</TableHead>
              <TableHead>state</TableHead>
              <TableHead>ms</TableHead>
              <TableHead>trust</TableHead>
              <TableHead>where</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.map((check) => (
              <TableRow key={check.id}>
                <TableCell>{check.name}</TableCell>
                <TableCell>{humanize(check.state)}</TableCell>
                <TableCell>{check.duration_ms ?? "—"}</TableCell>
                <TableCell>
                  <TrustBadge untrusted={untrustedOf(check.result)} />
                </TableCell>
                <TableCell className="font-mono text-xs break-all">
                  {check.error ?? check.result_path ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
