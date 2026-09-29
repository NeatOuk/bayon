import { SpendGroup, type BurnMove, type SpendSummary } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DescriptionList } from "@/components/description-list";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatUsd } from "@/fleet/fleet-model";
import { FLEET_RECORD_LINKS, type RecordLinks } from "@/routing";
import { spendQuery } from "@/spend/spend-api";
import { SpendRows } from "@/spend/spend-tables";
import { useSpendFeed } from "@/spend/use-spend-feed";
import { Panel } from "@/tickets/panel";

const GROUPS: readonly {
  readonly group: SpendGroup;
  readonly label: string;
}[] = [
  { group: "day", label: "By day" },
  { group: "ticket", label: "By ticket" },
  { group: "tier", label: "By tier" },
  { group: "class", label: "By run class" },
];

/**
 * §2 Spend (§8.9): burn, projection, waste and the alarm, then one grouping's rows; live. With
 * `project` it is that project's Spend view in its IDE: every figure the project's, its
 * today and window totals the headline, each labelled "this project"; a ticket links by `links`.
 */
export function SpendScreen({
  project,
  links = FLEET_RECORD_LINKS,
}: {
  readonly project?: string;
  readonly links?: RecordLinks;
}) {
  useSpendFeed(project);
  const [group, setGroup] = useState<SpendGroup>("day");
  const report = useQuery(spendQuery(group, project));
  const scoped = project !== undefined;
  return (
    <PageContainer fill>
      <PageHeader title="Spend" />
      {report.isPending && <Loading label="Loading spend…" lines={3} />}
      {report.isError && (
        <QueryError
          title="Spend is unavailable"
          error={report.error}
          onRetry={() => void report.refetch()}
        />
      )}
      {report.data !== undefined && (
        <>
          {scoped && <Headline summary={report.data.summary} />}
          <AlarmBanner alarm={report.data.summary.alarm} scoped={scoped} />
          <DropNote alarm={report.data.summary.alarm} scoped={scoped} />
          <SummaryPanel summary={report.data.summary} scoped={scoped} />
        </>
      )}
      <Tabs
        className="min-h-0"
        value={group}
        onValueChange={(value) => {
          const next = SpendGroup.safeParse(value);
          if (next.success) setGroup(next.data);
        }}
      >
        <TabsList>
          {GROUPS.map(({ group: value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {GROUPS.map(({ group: value }) => (
          <TabsContent
            key={value}
            value={value}
            className="flex min-h-0 flex-col"
          >
            {report.data?.group === value && (
              <SpendRows report={report.data} links={links} />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </PageContainer>
  );
}

const signedPercent = (pct: number | null): string =>
  pct === null ? "—" : `${pct > 0 ? "+" : ""}${Math.round(pct)}%`;

/**
 * How far burn moved in dollars a day, beside the percentage, so a small ledger's big percentage
 * reads for what it is (+14043% can be +$8.19/day); nothing without a baseline to move from.
 */
function signedDelta(move: BurnMove): string {
  if (move.baseline_daily_usd === null) return "";
  const delta = move.daily_usd - move.baseline_daily_usd;
  return ` (${delta < 0 ? "-" : "+"}${formatUsd(Math.abs(delta))}/day)`;
}

function describeMove(label: string, move: BurnMove, days: number): string {
  const baseline =
    move.baseline_daily_usd === null
      ? "no baseline"
      : `${formatUsd(move.baseline_daily_usd)}/day`;
  return `${label}: ${formatUsd(move.daily_usd)}/day, ${signedPercent(move.change_pct)}${signedDelta(move)} against the ${days}-day baseline (${baseline})`;
}

/** A project's headline: what it spent today, and over the window. */
function Headline({ summary }: { readonly summary: SpendSummary }) {
  return (
    <p className="font-head text-lg">
      {`This project: ${formatUsd(summary.burn.today_usd)} today · ${formatUsd(summary.total_usd)} over the last ${summary.alarm.baseline_days} days`}
    </p>
  );
}

type Alarm = SpendSummary["alarm"];

/** The moves of both windows that `pick` keeps, each described on its own line. */
function MoveLines({
  alarm,
  pick,
}: {
  readonly alarm: Alarm;
  readonly pick: (move: BurnMove) => boolean;
}) {
  const moves = [
    ["last 24 h", alarm.last_day],
    ["last 7 days", alarm.last_7d],
  ] as const;
  return moves
    .filter(([, move]) => pick(move))
    .map(([label, move]) => (
      <p key={label}>{describeMove(label, move, alarm.baseline_days)}</p>
    ));
}

/**
 * Amendment j, rises only: burn rose past the threshold against the baseline. The
 * server decides (`active`, each move's `alarm`), so the fleet and project screens agree. `scoped`:
 * the project's burn against its own baseline, the fleet's threshold.
 */
function AlarmBanner({
  alarm,
  scoped,
}: {
  readonly alarm: Alarm;
  readonly scoped: boolean;
}) {
  if (!alarm.active) return null;
  return (
    <Alert status="error">
      <AlertTitle>{`Burn alarm: ${scoped ? "this project's " : ""}spend rose more than ${alarm.threshold_pct}%`}</AlertTitle>
      <AlertDescription>
        <MoveLines alarm={alarm} pick={(move) => move.alarm} />
      </AlertDescription>
    </Alert>
  );
}

/**
 * Burn fell past the threshold: news, not an alarm, so an info `status` that does not
 * interrupt. The server leaves `dropped` false while the fleet or the project is paused, when a
 * drop is what pausing is for.
 */
function DropNote({
  alarm,
  scoped,
}: {
  readonly alarm: Alarm;
  readonly scoped: boolean;
}) {
  if (!alarm.dropped) return null;
  return (
    <Alert status="info" role="status">
      <AlertTitle>{`${scoped ? "This project's spend" : "Spend"} fell more than ${alarm.threshold_pct}%`}</AlertTitle>
      <AlertDescription>
        <MoveLines alarm={alarm} pick={(move) => move.drop} />
      </AlertDescription>
    </Alert>
  );
}

function SummaryPanel({
  summary,
  scoped,
}: {
  readonly summary: SpendSummary;
  readonly scoped: boolean;
}) {
  const days = summary.alarm.baseline_days;
  const waste =
    summary.waste_pct === null ? "" : ` (${summary.waste_pct.toFixed(1)}%)`;
  const figures: readonly (readonly [string, string])[] = [
    ["today", formatUsd(summary.burn.today_usd)],
    ["month to date", formatUsd(summary.burn.month_to_date_usd)],
    ["projected month", formatUsd(summary.burn.projected_month_usd)],
    [`last ${days} days`, formatUsd(summary.total_usd)],
    ["wasted (target under 15%)", `${formatUsd(summary.wasted_usd)}${waste}`],
  ];
  return (
    <Panel
      label={scoped ? "this project's burn" : "burn"}
      title={scoped ? "Burn · this project" : "Burn"}
    >
      <DescriptionList items={figures} />
    </Panel>
  );
}
