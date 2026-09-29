import { describe, expect, test } from "vitest";
import {
  flattenPages,
  freshRows,
  historyExportPath,
  historyPagePath,
  newerThan,
  prependRows,
  rowId,
} from "@/ide/history-api";
import { timelineEntry, timelinePage } from "@/test/project-fixtures";

// Rows newest first, as the timeline orders them: ts, then source, then key, all descending.
const row = (n: number) =>
  timelineEntry({ key: String(n).padStart(20, "0"), ts: n, summary: `r${n}` });
const rows = (...ns: number[]) => ns.map(row);

describe("paths", () => {
  test("a page: limit, the filters, then the cursor", () => {
    expect(historyPagePath("ws a", { sources: ["gate"] }, 50, "abc==")).toBe(
      "/projects/ws%20a/timeline?limit=50&kind=gate.*&cursor=abc%3D%3D",
    );
    expect(historyPagePath("ws", { sources: [] }, 1, null)).toBe(
      "/projects/ws/timeline?limit=1",
    );
  });

  test("the export: its format, then the same filters", () => {
    expect(
      historyExportPath("ws", { sources: ["audit"], q: "x y" }, "csv"),
    ).toBe("/projects/ws/timeline/export?format=csv&kind=audit.*&q=x%20y");
  });
});

test("the timeline's order: ts, then source, then key", () => {
  const at = (ts: number, source: "audit" | "ticket", key: string) =>
    timelineEntry({ ts, source, key, summary: "" });
  expect(newerThan(at(2, "audit", "a"), at(1, "ticket", "z"))).toBe(true);
  expect(newerThan(at(1, "ticket", "a"), at(1, "audit", "z"))).toBe(true);
  expect(newerThan(at(1, "audit", "b"), at(1, "audit", "a"))).toBe(true);
  expect(newerThan(at(1, "audit", "a"), at(1, "audit", "a"))).toBe(false);
});

test("pages flatten to each row once, the first page's copy winning", () => {
  const moved = { ...row(5), summary: "moved" };
  const flat = flattenPages([
    timelinePage(rows(9, 5), "c1"),
    timelinePage([moved, row(3)]),
  ]);
  expect(flat.map((entry) => entry.summary)).toEqual(["r9", "r5", "r3"]);
  expect(new Set(flat.map(rowId)).size).toBe(flat.length);
});

describe("freshRows: what the head holds that the list lacks", () => {
  test("nothing new", () => {
    expect(freshRows(timelinePage(rows(9, 8)), rows(9, 8), true)).toEqual({
      rows: [],
      more: false,
      prepend: true,
    });
  });

  test("rows above the loaded top, the head reaching it: prepend them", () => {
    const fresh = freshRows(
      timelinePage(rows(11, 10, 9), "c"),
      rows(9, 8),
      false,
    );
    expect(fresh.rows.map((entry) => entry.ts)).toEqual([11, 10]);
    expect(fresh).toMatchObject({ more: false, prepend: true });
  });

  test("a whole head page above the top, more after it: a gap, so the list starts over", () => {
    const fresh = freshRows(timelinePage(rows(12, 11), "c"), rows(9, 8), false);
    expect(fresh.rows).toHaveLength(2);
    expect(fresh).toMatchObject({ more: true, prepend: false });
  });

  test("a late row inside the loaded range counts, and the list starts over", () => {
    const fresh = freshRows(
      timelinePage(rows(10, 9, 7, 6)),
      rows(10, 9, 6),
      true,
    );
    expect(fresh.rows.map((entry) => entry.ts)).toEqual([7]);
    expect(fresh).toMatchObject({ more: false, prepend: false });
  });

  test("a head row below the loaded bottom is not new while older pages remain", () => {
    expect(
      freshRows(timelinePage(rows(10, 9, 4), "c"), rows(10, 9), false).rows,
    ).toEqual([]);
  });

  test("an empty list takes the whole head, unless more follow it", () => {
    expect(freshRows(timelinePage(rows(2, 1)), [], true)).toMatchObject({
      prepend: true,
      more: false,
    });
    expect(freshRows(timelinePage(rows(2, 1), "c"), [], true)).toMatchObject({
      prepend: false,
      more: true,
    });
  });
});

test("prepending keeps older pages and every cursor", () => {
  const data = {
    pages: [timelinePage(rows(9), "c1"), timelinePage(rows(8))],
    pageParams: [null, "c1"],
  };
  const next = prependRows(data, rows(11, 10));
  expect(next.pages[0]?.items.map((entry) => entry.ts)).toEqual([11, 10, 9]);
  expect(next.pages[0]?.next_cursor).toBe("c1");
  expect(next.pages[1]).toBe(data.pages[1]);
  expect(data.pages[0]?.items).toHaveLength(1);
});
