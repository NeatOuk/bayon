import { expect, test } from "vitest";
import type { MapInput, Mapper } from "../../adapter.js";
import { createScriptMapper } from "./mapper.js";

const encoder = new TextEncoder();
const TS = 1_800_000_000_000;
const LINES: readonly unknown[] = [
  {
    kind: "session_init",
    runner_type: "export.init",
    payload: { runner_session_id: "rs-1" },
  },
  { kind: "zz_unknown", runner_type: "export.unknown", payload: {} },
  {
    kind: "terminal",
    runner_type: "export.terminal",
    payload: {
      outcome: "ok",
      usage: {
        tokens_in: 0,
        tokens_out: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      },
      cost_usd: 0,
      manifest_path: "/runtime/sessions/s1/logs/export-manifest.json",
    },
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

test("stamps the record's ts, numbers ordinals, and keeps unknown kinds (Invariant 4)", () => {
  const events = mapAll(createScriptMapper());
  expect(events.map((e) => [e.kind, e.ts, e.ordinal])).toEqual([
    ["session_init", TS, 0],
    ["runner_native", TS, 0],
    ["terminal", TS, 0],
  ]);
  expect(events[1]?.runner_type).toBe("export.unknown");
  expect(events[2]?.payload).toMatchObject({
    outcome: "ok",
    cost_usd: 0,
    manifest_path: "/runtime/sessions/s1/logs/export-manifest.json",
  });
});

test("no spend bookkeeping: a fresh mapper never adds cumulative totals", () => {
  const events = mapAll(createScriptMapper());
  const terminal = events.at(-1);
  expect(terminal?.payload).not.toHaveProperty("spend");
});

test("is deterministic over the same records", () => {
  expect(mapAll(createScriptMapper())).toEqual(mapAll(createScriptMapper()));
});

test("blank, partial and non-object lines", () => {
  const mapper = createScriptMapper();
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
