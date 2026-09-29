import type { TimelineEntry, TimelineExportFormat } from "@bayon/proto";

// A timeline export's bytes: JSONL, one TimelineEntry per line; or CSV (RFC 4180) with
// fixed columns, every cell quoted, and a cell a spreadsheet would run as a formula defused.

export const TIMELINE_CSV_COLUMNS = [
  "ts",
  "time",
  "source",
  "key",
  "kind",
  "actor",
  "agent_id",
  "ticket_key",
  "ticket_id",
  "session_id",
  "summary",
  "payload",
] as const;

/** What a spreadsheet reads as a formula, or as the start of one (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell: a leading `'` on anything that would start a formula, then quoted with `"` doubled. */
export function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const inert = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${inert.replaceAll('"', '""')}"`;
}

const csvLine = (cells: readonly (string | number | null)[]): string =>
  `${cells.map(csvCell).join(",")}\r\n`;

export const csvHeader = (): string => csvLine(TIMELINE_CSV_COLUMNS);

export const csvRow = (e: TimelineEntry): string =>
  csvLine([
    e.ts,
    new Date(e.ts).toISOString(),
    e.source,
    e.key,
    e.kind,
    e.actor,
    e.agent_id,
    e.ticket_key,
    e.ticket_id,
    e.session_id,
    e.summary,
    e.payload === undefined ? null : JSON.stringify(e.payload),
  ]);

export const jsonlRow = (e: TimelineEntry): string => `${JSON.stringify(e)}\n`;

export const EXPORT_FORMATS: Readonly<
  Record<
    TimelineExportFormat,
    {
      readonly contentType: string;
      readonly header: string;
      readonly row: (e: TimelineEntry) => string;
    }
  >
> = {
  jsonl: {
    contentType: "application/x-ndjson; charset=utf-8",
    header: "",
    row: jsonlRow,
  },
  csv: {
    contentType: "text/csv; charset=utf-8",
    header: csvHeader(),
    row: csvRow,
  },
};
