import type { RunRow, SpendRow } from "@bayon/db";
import { expect, test } from "vitest";
import {
  cursorProblems,
  missingFromSequence,
  runProblems,
  spendProblems,
} from "./assertions.js";

test("missingFromSequence finds an ordered subsequence, gaps allowed", () => {
  const kinds = [
    "session_init",
    "turn_start",
    "assistant_text",
    "turn_end",
    "terminal",
  ];
  expect(
    missingFromSequence(kinds, ["session_init", "turn_end", "terminal"]),
  ).toBeUndefined();
  expect(missingFromSequence(kinds, [])).toBeUndefined();
  expect(missingFromSequence(kinds, ["terminal", "turn_end"])).toBe("turn_end");
  expect(missingFromSequence(kinds, ["session_init", "file_change"])).toBe(
    "file_change",
  );
});

test("cursorProblems passes exactly the stored ids, in order, once each", () => {
  expect(cursorProblems([1, 2, 5], [1, 2, 5])).toEqual([]);
  expect(cursorProblems([], [])).toEqual([]);
  expect(cursorProblems([1, 2, 2, 5], [1, 2, 5])).toEqual([
    "duplicated ids 2",
    "ids out of order at 2",
  ]);
  expect(cursorProblems([1, 5], [1, 2, 5])).toEqual([
    "gap: ids 2 never received",
  ]);
  expect(cursorProblems([2, 1, 9], [1, 2])).toEqual([
    "ids out of order at 1",
    "ids 9 received but not stored",
  ]);
});

const HASH = (n: number) => String(n).repeat(64);
const run = (patch: Partial<RunRow> = {}): RunRow => ({
  id: "run-1",
  session_id: "s-1",
  seq: 1,
  trigger: "operator",
  template_id: null,
  wall_clock_ms: null,
  prompt_path: "/p/run-1.md",
  prompt_tokens_est: null,
  prompt_tokens_actual: null,
  prompt_hash: HASH(1),
  context_hash: HASH(2),
  mission_hash: HASH(3),
  doctrine_hash: HASH(4),
  toolset_hash: HASH(5),
  config_hash: HASH(6),
  model: "fixture-model",
  effort: null,
  base_sha: "abc",
  truncated_sections_json: null,
  state: "ok",
  attempt: 1,
  wasted: 0,
  started_at: 1,
  ended_at: 2,
  tool_calls: 1,
  error_class: null,
  error_message: null,
  idempotency_key: "s-1:1",
  ...patch,
});

test("runProblems wants every §8.1 hash and the model, matching expectations", () => {
  expect(runProblems(run(), { prompt_hash: HASH(1), base_sha: "abc" })).toEqual(
    [],
  );
  expect(runProblems(run({ mission_hash: null, model: null }), {})).toEqual([
    "run run-1 recorded no mission_hash",
    "run run-1 recorded no model",
  ]);
  expect(runProblems(run(), { config_hash: HASH(9), base_sha: "def" })).toEqual(
    [
      `run run-1: config_hash is ${HASH(6)}, expected ${HASH(9)}`,
      "run run-1: base_sha is abc, expected def",
    ],
  );
  // A missing hash is reported once, not also as a mismatch.
  expect(
    runProblems(run({ toolset_hash: null }), { toolset_hash: HASH(5) }),
  ).toEqual(["run run-1 recorded no toolset_hash"]);
});

const spend = (tokens_in: number, tokens_out: number): SpendRow => ({
  id: "sp-1",
  run_id: "run-1",
  session_id: "s-1",
  ticket_id: null,
  gate_id: null,
  pulse_id: null,
  phase: "build",
  runner_id: "fixture",
  model: "fixture-model",
  tokens_in,
  tokens_out,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  tokens_tool_result: null,
  tokens_saved: null,
  cost_usd: 0.01,
  cost_source: "reported",
  cache_hit_ratio: null,
  wasted: 0,
  ts: 1,
});

test("spendProblems wants a row with tokens", () => {
  expect(spendProblems([spend(0, 0), spend(10, 2)])).toEqual([]);
  expect(spendProblems([])).toEqual(["no spend row"]);
  expect(spendProblems([spend(0, 0)])).toEqual([
    "1 spend row(s), all with zero tokens",
  ]);
});
