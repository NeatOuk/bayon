import { describe, expect, test } from "vitest";
import {
  NO_FILTERS,
  dayBoundMs,
  filterParams,
  isFiltered,
  parseFilterParams,
  timelineParams,
  type HistoryFilters,
} from "@/ide/history-filters";

/** Local midnight of a calendar day, as the date input's day means it. */
const midnight = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day).getTime();

describe("timelineParams: the filters as the timeline's query", () => {
  test("no filter asks for everything", () => {
    expect(timelineParams(NO_FILTERS)).toEqual([]);
  });

  test("each chip asks for its whole source, in the API's order, once", () => {
    expect(
      timelineParams({ sources: ["gate", "ticket", "human_request", "gate"] }),
    ).toEqual(["kind=ticket.*,gate.*,human_request.*"]);
  });

  test.each<[string, HistoryFilters, string]>([
    ["agent", { sources: [], agent: "bayon builder" }, "agent=bayon%20builder"],
    ["ticket", { sources: [], ticket: "FRM-12" }, "ticket=FRM-12"],
    ["q", { sources: [], q: "50% & more" }, "q=50%25%20%26%20more"],
  ])("%s is sent as given, encoded", (_name, filters, param) => {
    expect(timelineParams(filters)).toEqual([param]);
  });

  test("from is its day's local midnight; to the next day's, so to includes its day", () => {
    expect(
      timelineParams({ sources: [], from: "2026-09-01", to: "2026-09-22" }),
    ).toEqual([`from=${midnight(2026, 9, 1)}`, `to=${midnight(2026, 9, 23)}`]);
    expect(dayBoundMs("2026-12-31", true)).toBe(midnight(2027, 1, 1));
  });

  test("every filter at once, in a fixed order", () => {
    expect(
      timelineParams({
        sources: ["session"],
        agent: "a1",
        ticket: "FRM-1",
        from: "2026-09-01",
        to: "2026-09-01",
        q: "x",
      }),
    ).toEqual([
      "kind=session.*",
      "agent=a1",
      "ticket=FRM-1",
      `from=${midnight(2026, 9, 1)}`,
      `to=${midnight(2026, 9, 2)}`,
      "q=x",
    ]);
  });
});

describe("the URL's filters", () => {
  const all: HistoryFilters = {
    sources: ["audit", "finding"],
    agent: "ws a/b",
    ticket: "FRM-12",
    from: "2026-09-01",
    to: "2026-09-22",
    q: "a&b=c",
  };

  test("round-trip through their pairs, encoded; sources read as written", () => {
    const params = filterParams(all);
    expect(params).toEqual([
      "kind=audit,finding",
      "agent=ws%20a%2Fb",
      "ticket=FRM-12",
      "from=2026-09-01",
      "to=2026-09-22",
      "q=a%26b%3Dc",
    ]);
    const pairs = new Map(
      params.map((param) => {
        const [name = "", value = ""] = param.split("=");
        return [name, decodeURIComponent(value)] as const;
      }),
    );
    expect(parseFilterParams(pairs)).toEqual(all);
  });

  test("unset filters write nothing", () => {
    expect(filterParams(NO_FILTERS)).toEqual([]);
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ sources: [], q: "x" })).toBe(true);
    expect(isFiltered({ sources: ["pulse"] })).toBe(true);
  });

  test.each([
    ["an unknown name", [["open", "ticket:1"]]],
    ["an empty value", [["q", ""]]],
    ["an unknown source", [["kind", "ticket,nope"]]],
    ["an empty source", [["kind", "ticket,"]]],
    ["a date that is not a day", [["from", "2026-02-30"]]],
    ["a date in another shape", [["to", "22/09/2026"]]],
    ["a five-digit year", [["from", "20261-01-01"]]],
  ] as const)("%s is malformed", (_name, pairs) => {
    expect(parseFilterParams(new Map(pairs))).toBe(null);
  });
});
