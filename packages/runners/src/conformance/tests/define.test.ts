// A check detail names the terminal's error: its class, the adapter's kind, and a
// short, flattened message — the error only, never the rest of the payload.
import { MAX_DETAIL_CHARS } from "@bayon/core";
import { expect, test } from "vitest";
import type { StoredEvent } from "../types.js";
import { check, outcomeOf } from "./define.js";

const terminal = (
  payload: Record<string, unknown>,
  source: StoredEvent["source"] = "runner",
): StoredEvent =>
  ({
    ts: 1,
    runner_type: "t",
    kind: "terminal",
    payload,
    source,
    seq: 1,
  }) as unknown as StoredEvent;

test("an ok terminal reads as before", () => {
  expect(outcomeOf([terminal({ outcome: "ok" })])).toBe("runner:ok");
  expect(outcomeOf([])).toBe("no terminal");
});

test("a failed terminal names the runner's error class and its message", () => {
  expect(
    outcomeOf([
      terminal({
        outcome: "failed",
        error: {
          class: "runner_error",
          message: "model 'm-1:27b' not found",
          retryable: false,
        },
      }),
    ]),
  ).toBe("runner:failed (runner_error: model 'm-1:27b' not found)");
});

test("the adapter's kind rides with the class", () => {
  expect(
    outcomeOf([
      terminal({
        outcome: "failed",
        error: {
          class: "runner_error",
          message: "fetch failed",
          retryable: true,
          cause: { kind: "connection", error_name: "APIError" },
        },
      }),
    ]),
  ).toBe("runner:failed (runner_error/connection: fetch failed)");
});

test("a supervisor's terminal names its class too", () => {
  expect(
    outcomeOf([
      terminal(
        {
          outcome: "failed",
          error: {
            class: "runner_exited_without_terminal",
            message: "the runner exited without a terminal event",
            retryable: false,
          },
        },
        "supervisor",
      ),
    ]),
  ).toBe(
    "supervisor:failed (runner_exited_without_terminal: the runner exited without a terminal event)",
  );
});

test("the message is flattened and cut; nothing else from the payload appears", () => {
  const long = `line one\n\tline two ${"x".repeat(400)}`;
  const got = outcomeOf([
    terminal({
      outcome: "failed",
      usage: { tokens_in: 1, tokens_out: 2 },
      text: "PAYLOAD-TEXT",
      error: { class: "runner_error", message: long, retryable: false },
    }),
  ]);
  expect(got).not.toContain("\n");
  expect(got).not.toContain("\t");
  expect(got).not.toContain("PAYLOAD-TEXT");
  expect(got).toMatch(
    /^runner:failed \(runner_error: line one line two x+…\)$/,
  );
  expect(got.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
  // And a check's detail is capped as before.
  expect(check("c", false, `${got}, ${got}`).detail?.length).toBe(
    MAX_DETAIL_CHARS,
  );
});

test("an error that does not parse is left out rather than guessed at", () => {
  expect(
    outcomeOf([terminal({ outcome: "failed", error: "just a string" })]),
  ).toBe("runner:failed");
  expect(
    outcomeOf([
      terminal({ outcome: "failed", error: { class: "x", message: 7 } }),
    ]),
  ).toBe("runner:failed");
});
