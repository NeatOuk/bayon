// The terminal of a run in a process started with a JSON schema (SDK outputFormat): the
// answer, or a typed failure when it never came. Pure over records: the mode comes from the
// segment's own init, which lists the tool that returns the answer.
import { describe, expect, test } from "vitest";
import type { MappedEvent } from "../../adapter.js";
import { createMapper } from "./mapper.js";
import { MODELS } from "./registration.js";
import { STRUCTURED_OUTPUT_TOOL } from "./tool-names.js";

const encoder = new TextEncoder();
const TS = 1_800_000_000_000;

const init = (tools: readonly string[]) => ({
  type: "system",
  subtype: "init",
  session_id: "s-1",
  model: "m",
  cwd: "/work/repo",
  tools,
  mcp_servers: [],
});
const STRUCTURED = init(["Read", STRUCTURED_OUTPUT_TOOL]);
const PLAIN = init(["Read"]);
const ANSWER = { summary: "fine", findings: [] };

const result = (extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  duration_ms: 10,
  total_cost_usd: 0,
  modelUsage: {},
  ...extra,
});

/** Maps frames with one mapper, as one process segment; returns every event. */
const run = (...frames: unknown[]): MappedEvent[] => {
  const mapper = createMapper({ prices: MODELS });
  return frames.flatMap((f, i) =>
    mapper.map({
      offset: i * 1000,
      bytes: encoder.encode(JSON.stringify(f)),
      ts: TS,
    }),
  );
};
const terminals = (list: readonly MappedEvent[]) =>
  list.filter((e) => e.kind === "terminal").map((e) => e.payload);

describe("a process started with a schema", () => {
  test("a success that carries structured_output ends ok", () => {
    const [t, ...more] = terminals(
      run(STRUCTURED, result({ structured_output: ANSWER })),
    );
    expect(more).toEqual([]);
    expect(t).toMatchObject({ outcome: "ok" });
    expect(t).not.toHaveProperty("error");
  });

  test("a success without structured_output is a typed failure, not a success", () => {
    const [t] = terminals(run(STRUCTURED, result()));
    expect(t).toMatchObject({
      outcome: "failed",
      error: {
        class: "runner_error",
        message: "the run ended without its structured output",
        retryable: false,
      },
    });
  });

  test("retry exhaustion is a failed terminal whose error says the retries ran out", () => {
    const list = run(
      STRUCTURED,
      result({
        subtype: "error_max_structured_output_retries",
        is_error: true,
        errors: ["Failed to provide valid structured output after 5 attempts"],
        terminal_reason: "structured_output_retry_exhausted",
      }),
    );
    expect(list.at(-1)?.kind).toBe("terminal"); // Invariant 3: the run still ends on one
    expect(terminals(list)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        terminal_reason: "structured_output_retry_exhausted",
        error: {
          class: "runner_error",
          message:
            "no valid structured output: the runner's retries ran out (Failed to provide valid structured output after 5 attempts)",
          retryable: false,
        },
      }),
    ]);
    expect(list.find((e) => e.kind === "error")?.payload).toMatchObject({
      class: "runner_error",
      runner_error: "error_max_structured_output_retries",
    });
  });

  test("the exhausted terminal reason alone fails a run, whatever its subtype says", () => {
    const [t] = terminals(
      run(
        PLAIN,
        result({
          structured_output: ANSWER,
          terminal_reason: "structured_output_retry_exhausted",
        }),
      ),
    );
    expect(t).toMatchObject({
      outcome: "failed",
      error: { class: "runner_error", retryable: false },
    });
  });

  test("the mode holds for every run of the segment, and an interrupt still wins", () => {
    const list = run(
      STRUCTURED,
      result({ structured_output: ANSWER }),
      // Run 2's init is the runner's again (runner_native); the segment is still structured.
      STRUCTURED,
      result(),
      result({
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
      }),
    );
    expect(terminals(list).map((t) => t["outcome"])).toEqual([
      "ok",
      "failed",
      "interrupted",
    ]);
  });
});

test("a process started without one owes no structured output: a plain success is ok", () => {
  expect(terminals(run(PLAIN, result()))).toEqual([
    expect.objectContaining({ outcome: "ok" }),
  ]);
});
