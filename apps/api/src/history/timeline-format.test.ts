import type { TimelineEntry } from "@bayon/proto";
import { expect, test } from "vitest";
import {
  TIMELINE_CSV_COLUMNS,
  csvCell,
  csvHeader,
  csvRow,
  jsonlRow,
} from "./timeline-format.js";

// An export's bytes: CSV cells are always quoted with `"` doubled, a cell a spreadsheet
// would run as a formula gets a leading `'`, and JSONL is one entry per line.

test.each([
  ['=HYPERLINK("http://x")', '"\'=HYPERLINK(""http://x"")"'],
  ["+1+1", '"\'+1+1"'],
  ["-2+3", '"\'-2+3"'],
  ["@SUM(A1)", '"\'@SUM(A1)"'],
  ["\tcmd", '"\'\tcmd"'],
  ["\rcmd", '"\'\rcmd"'],
])("a cell starting a formula, %j, is defused", (value, cell) => {
  expect(csvCell(value)).toBe(cell);
});

test.each([
  ["plain", '"plain"'],
  ['say "hi", then go', '"say ""hi"", then go"'],
  ["two\nlines", '"two\nlines"'],
  ["a=b", '"a=b"'],
  ["", '""'],
])("a cell %j is quoted and escaped", (value, cell) => {
  expect(csvCell(value)).toBe(cell);
});

test("null is an empty cell and a number its digits", () => {
  expect(csvCell(null)).toBe('""');
  expect(csvCell(1_700_000_000_000)).toBe('"1700000000000"');
});

const entry: TimelineEntry = {
  source: "audit",
  key: "00000000000000000007",
  ts: Date.UTC(2026, 8, 22, 12),
  kind: "audit.mcp.ticket_update",
  actor: "session:S-1",
  agent_id: "builder",
  ticket_id: "ticket-1",
  ticket_key: "FRM-1",
  session_id: "S-1",
  summary: '=cmd|" /C calc"!A0',
  payload: { bytes: 12 },
};

/** RFC 4180, enough to read our own rows back: quoted cells, `""` escapes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  while (i < text.length) {
    expect(text[i]).toBe('"');
    let cell = "";
    i += 1;
    for (;;) {
      if (text[i] === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
      } else if (text[i] === '"') {
        i += 1;
        break;
      } else {
        cell += text[i];
        i += 1;
      }
    }
    row.push(cell);
    if (text[i] === ",") {
      i += 1;
    } else {
      expect(text.slice(i, i + 2)).toBe("\r\n");
      rows.push(row);
      row = [];
      i += 2;
    }
  }
  return rows;
}

test("a CSV row has the fixed columns and reads back, its formula defused", () => {
  const [header, row] = parseCsv(csvHeader() + csvRow(entry));
  expect(header).toEqual([...TIMELINE_CSV_COLUMNS]);
  expect(row).toEqual([
    String(entry.ts),
    "2026-09-22T12:00:00.000Z",
    "audit",
    "00000000000000000007",
    "audit.mcp.ticket_update",
    "session:S-1",
    "builder",
    "FRM-1",
    "ticket-1",
    "S-1",
    `'=cmd|" /C calc"!A0`,
    '{"bytes":12}',
  ]);
  const bare: TimelineEntry = { ...entry, payload: undefined };
  expect(parseCsv(csvRow(bare)).at(0)?.at(-1)).toBe("");
});

test("a JSONL row is the entry on one line", () => {
  const line = jsonlRow({ ...entry, summary: "two\nlines" });
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1)).not.toContain("\n");
  expect(JSON.parse(line)).toEqual({ ...entry, summary: "two\nlines" });
});
