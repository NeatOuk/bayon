import type {
  ClassSpend,
  DailySpend,
  SpendReport,
  TicketSpend,
  TierSpend,
} from "@bayon/proto";
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
import { formatPercent, formatTime } from "@/lib/format";
import { FLEET_RECORD_LINKS, type RecordLinks } from "@/routing";
import { Muted } from "@/tickets/ticket-sections";

// One table per `GET /spend?group=` grouping (§8.9). The server computes every figure. The day and
// run-class tables carry what context compression kept out of the model's input, an
// estimate (chars/4), hence "saved (est.)".

const tokens = (n: number): string => n.toLocaleString("en");

/** The saved column's heading: an estimate, never a bill. */
export const SAVED_COLUMN = "saved (est.)";

function Head({ columns }: { readonly columns: readonly string[] }) {
  return (
    <TableHeader>
      <TableRow>
        {columns.map((column) => (
          <TableHead key={column}>{column}</TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

/** The window's UTC days, newest first. */
function DayTable({ rows }: { readonly rows: readonly DailySpend[] }) {
  return (
    <Table scroll="fill">
      <Head columns={["day (UTC)", "runs", "cost", "wasted", SAVED_COLUMN]} />
      <TableBody>
        {rows.toReversed().map((row) => (
          <TableRow key={row.day}>
            <TableCell>{formatTime(row.day).slice(0, 10)}</TableCell>
            <TableCell>{row.runs}</TableCell>
            <TableCell>{formatUsd(row.cost_usd)}</TableCell>
            <TableCell>{formatUsd(row.wasted_usd)}</TableCell>
            <TableCell>{tokens(row.tokens_saved)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TicketTable({
  rows,
  links,
}: {
  readonly rows: readonly TicketSpend[];
  readonly links: RecordLinks;
}) {
  return (
    <Table scroll="fill">
      <Head
        columns={[
          "ticket",
          "status",
          "tier",
          "cost",
          "wasted",
          "sessions",
          "hand-offs",
          "review rounds",
          "cache",
        ]}
      />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <TextLink href={links.ticket(row.num)}>
                {`#${row.num} ${row.title}`}
              </TextLink>
            </TableCell>
            <TableCell>
              <StatusBadge entity="ticket" state={row.status} />
            </TableCell>
            <TableCell>{row.complexity_tier}</TableCell>
            <TableCell>{formatUsd(row.cost_usd)}</TableCell>
            <TableCell>{formatUsd(row.cost_wasted_usd)}</TableCell>
            <TableCell>{row.sessions}</TableCell>
            <TableCell>{row.handoff_count}</TableCell>
            <TableCell>{row.review_rounds}</TableCell>
            <TableCell>{formatPercent(row.cache_ratio)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TierTable({ rows }: { readonly rows: readonly TierSpend[] }) {
  return (
    <Table scroll="fill">
      <Head
        columns={[
          "tier",
          "closed tickets",
          "p50",
          "p95",
          "total",
          "review rounds (avg)",
          "hand-offs (avg)",
        ]}
      />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.tier}>
            <TableCell>{row.tier}</TableCell>
            <TableCell>{row.closed_tickets}</TableCell>
            <TableCell>{formatUsd(row.cost_p50_usd)}</TableCell>
            <TableCell>{formatUsd(row.cost_p95_usd)}</TableCell>
            <TableCell>{formatUsd(row.cost_total_usd)}</TableCell>
            <TableCell>{row.review_rounds_avg.toFixed(1)}</TableCell>
            <TableCell>{row.handoffs_avg.toFixed(1)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ClassTable({ rows }: { readonly rows: readonly ClassSpend[] }) {
  return (
    <Table scroll="fill">
      <Head
        columns={[
          "run class",
          "runs",
          "tokens in",
          "tokens out",
          "cache read",
          "cache write",
          SAVED_COLUMN,
          "cost",
          "wasted",
        ]}
      />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.run_class}>
            <TableCell>{row.run_class}</TableCell>
            <TableCell>{row.runs}</TableCell>
            <TableCell>{tokens(row.tokens_in)}</TableCell>
            <TableCell>{tokens(row.tokens_out)}</TableCell>
            <TableCell>{tokens(row.tokens_cache_read)}</TableCell>
            <TableCell>{tokens(row.tokens_cache_write)}</TableCell>
            <TableCell>{tokens(row.tokens_saved)}</TableCell>
            <TableCell>{formatUsd(row.cost_usd)}</TableCell>
            <TableCell>{formatUsd(row.wasted_usd)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The report's rows, in its grouping's table; a ticket links by `links` (a tab in the IDE). */
export function SpendRows({
  report,
  links = FLEET_RECORD_LINKS,
}: {
  readonly report: SpendReport;
  readonly links?: RecordLinks;
}) {
  if (report.rows.length === 0) return <Muted>No spend in the window.</Muted>;
  switch (report.group) {
    case "day":
      return <DayTable rows={report.rows} />;
    case "ticket":
      return <TicketTable rows={report.rows} links={links} />;
    case "tier":
      return <TierTable rows={report.rows} />;
    case "class":
      return <ClassTable rows={report.rows} />;
  }
}
