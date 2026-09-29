// A Codex shell result carries the command's output as its text, as claude-sdk's does: the mapper
// never caps it, ingest does (§8.5, Invariant 9; apps/supervisor's cap-runners test runs the cap on
// this runner's over-cap sample).
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { MappedEvent } from "../../adapter.js";
import { createCodexMapper } from "./mapper.js";
import { MODELS } from "./registration.js";
import { CODEX_TOOL_OUTPUT, LONG_OUTPUT } from "./testing/samples.js";

const FIXTURE = new URL(
  "../../../fixtures/codex-exec/shell-commands.jsonl",
  import.meta.url,
);
const encoder = new TextEncoder();

function mapAll(records: readonly Uint8Array[]): MappedEvent[] {
  const mapper = createCodexMapper({ prices: MODELS });
  let offset = 0;
  return records.flatMap((bytes) => {
    const mapped = mapper.map({ offset, bytes, ts: 1 });
    offset += bytes.length + 1;
    return mapped;
  });
}

const results = (events: readonly MappedEvent[]) =>
  events.filter((e) => e.kind === "tool_result");

test("a shell tool_result carries the command's stdout; an empty output carries no text", () => {
  const lines = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.includes('"fixture_meta"'))
    .map((l) => encoder.encode(l));
  expect(results(mapAll(lines)).map((e) => [e.status, e.text])).toEqual([
    ["ok", "README.md\nadd.js\n"],
    ["error", undefined],
    ["error", undefined],
  ]);
});

test("an over-cap output is carried whole: the cap and the spill file are ingest's", () => {
  const [result] = results(mapAll(CODEX_TOOL_OUTPUT.records));
  expect(result?.text).toBe(LONG_OUTPUT);
  expect(LONG_OUTPUT.split("\n").length).toBeGreaterThan(200);
});
