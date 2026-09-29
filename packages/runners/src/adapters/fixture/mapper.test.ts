import { expect, test } from "vitest";
import type { MapInput, Mapper } from "../../adapter.js";
import { createFixtureMapper } from "./mapper.js";

const encoder = new TextEncoder();
const TS = 1_800_000_000_000;
const totals = (tokens_in: number, cost_usd: number) => ({
  tokens_in,
  tokens_out: tokens_in / 5,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  cost_usd,
});
const LINES: readonly unknown[] = [
  {
    kind: "session_init",
    runner_type: "fixture.init",
    payload: { runner_session_id: "rs-1" },
  },
  { kind: "zz_unknown", runner_type: "fixture.unknown", payload: {} },
  {
    kind: "terminal",
    runner_type: "fixture.terminal",
    ts: 5,
    payload: { outcome: "ok", cumulative: { m: totals(100, 0.001) } },
  },
  {
    kind: "terminal",
    runner_type: "fixture.terminal",
    payload: { outcome: "ok", cumulative: { m: totals(300, 0.003) } },
  },
  {
    kind: "terminal",
    runner_type: "fixture.terminal",
    payload: { outcome: "interrupted" },
  },
];

const input = (value: unknown, partial = false): MapInput => ({
  offset: 0,
  bytes: encoder.encode(
    typeof value === "string" ? value : JSON.stringify(value),
  ),
  ts: TS,
  ...(partial ? { partial } : {}),
});
const mapAll = (mapper: Mapper) => LINES.flatMap((l) => mapper.map(input(l)));

test("stamps the record's ts, keeps unknown kinds, and bills each run's delta", () => {
  const events = mapAll(createFixtureMapper());
  expect(events.map((e) => [e.kind, e.ts, e.ordinal])).toEqual([
    ["session_init", TS, 0],
    ["runner_native", TS, 0],
    ["terminal", TS, 0],
    ["terminal", TS, 0],
    ["terminal", TS, 0],
  ]);
  expect(events[1]?.runner_type).toBe("fixture.unknown");
  expect(events[2]?.payload).toMatchObject({
    outcome: "ok",
    spend: {
      tokens_in: 100,
      cost_usd: 0.001,
      cost_source: "reported",
      model: "m",
    },
    usage: { tokens_in: 100, tokens_out: 20 },
    cost_usd: 0.001,
  });
  expect(events[3]?.payload).toMatchObject({
    spend: { tokens_in: 200, tokens_out: 40, cost_usd: 0.002 },
  });
  expect(events[4]?.payload).toEqual({ outcome: "interrupted" });
});

test("is deterministic over the same records", () => {
  expect(mapAll(createFixtureMapper())).toEqual(mapAll(createFixtureMapper()));
});

test("blank, partial and non-object lines", () => {
  const mapper = createFixtureMapper();
  expect(mapper.map(input(""))).toEqual([]);
  expect(mapper.map(input('{"kind":"terminal"}', true))).toEqual([
    expect.objectContaining({
      runner_type: "unparsed",
      payload: { raw: '{"kind":"terminal"}', parse_error: "partial line" },
    }),
  ]);
  expect(mapper.map(input("[1,2]"))).toEqual([
    expect.objectContaining({
      runner_type: "unparsed",
      payload: { raw: "[1,2]", parse_error: "not a JSON object" },
    }),
  ]);
});
