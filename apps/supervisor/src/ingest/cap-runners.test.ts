// Every runner that provides an over-cap shell result (`@bayon/runners/testing`): mapped by its own
// adapter, the tool_result carries the command's whole output, and ingest's cap keeps head and tail
// around a marker naming the spilled file (§8.5, Invariant 9). Runner-neutral: no runner is named
// here (Invariant 1).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseTruncationMarker } from "@bayon/core";
import { loadAdapter } from "@bayon/runners";
import { TOOL_OUTPUT_SAMPLES } from "@bayon/runners/testing";
import { afterAll, describe, expect, test } from "vitest";
import {
  TOOL_RESULT_MAX_BYTES,
  TOOL_RESULT_MAX_LINES,
  capEvent,
} from "./cap.js";

const dir = mkdtempSync("/tmp/frm-cap-runners-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("at least one runner provides an over-cap sample", () => {
  expect(TOOL_OUTPUT_SAMPLES.length).toBeGreaterThan(0);
});

describe.each(TOOL_OUTPUT_SAMPLES)("$runnerId", (sample) => {
  test("its tool_result carries the whole output; ingest caps it with a spill pointer", () => {
    const adapter = loadAdapter(sample.runnerId);
    if (!adapter.ok) throw new Error(adapter.error.message);
    const mapper = adapter.value.createMapper({
      prices: adapter.value.registration().models,
    });
    let offset = 0;
    const events = sample.records.flatMap((bytes) => {
      const mapped = mapper.map({ offset, bytes, ts: 1 });
      offset += bytes.length + 1;
      return mapped;
    });
    const result = events.find((e) => e.kind === "tool_result");
    if (result === undefined) throw new Error("no tool_result mapped");
    expect(result.text).toBe(sample.output);
    expect(
      sample.output.split("\n").length > TOOL_RESULT_MAX_LINES ||
        Buffer.byteLength(sample.output) > TOOL_RESULT_MAX_BYTES,
    ).toBe(true);

    const toolDir = join(dir, sample.runnerId, "tool");
    const stored = capEvent(result, { toolDir, rawOffset: 0 });
    expect(stored.truncated).toBe(1);
    expect(stored.payload_path?.startsWith(toolDir)).toBe(true);
    expect(readFileSync(stored.payload_path ?? "", "utf8")).toBe(sample.output);
    expect(parseTruncationMarker(stored.text ?? "")?.path).toBe(
      stored.payload_path,
    );
    expect(stored.text?.startsWith(sample.output.split("\n")[0] ?? "")).toBe(
      true,
    );
    expect(Buffer.byteLength(stored.text ?? "")).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_BYTES,
    );
  });
});
