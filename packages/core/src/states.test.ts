import { expect, test } from "vitest";
import {
  ExitReason,
  RunOutcome,
  RunState,
  RunTrigger,
  SessionState,
} from "./states.js";

test("run triggers are the runs.trigger values", () => {
  expect(RunTrigger.options).toEqual([
    "pulse",
    "operator",
    "orchestrator",
    "retry",
    "gate",
    "handoff",
  ]);
});

test("session states are the §3.3 state machine", () => {
  expect(SessionState.options).toEqual([
    "pending",
    "preparing",
    "spawning",
    "running",
    "idle",
    "awaiting_approval",
    "human_attached",
    "handoff_writing",
    "handed_off",
    "stopping",
    "exited",
    "resumable",
  ]);
});

test("exit reasons are §3.3's exited{…}", () => {
  expect(ExitReason.options).toEqual([
    "ok",
    "error",
    "killed",
    "timeout",
    "abandoned",
  ]);
});

test("run states are the runs.state values; an outcome is any but running", () => {
  expect(RunState.options).toEqual([
    "running",
    "ok",
    "failed",
    "timeout",
    "interrupted",
    "budget_stop",
  ]);
  expect(RunOutcome.options).toEqual(
    RunState.options.filter((state) => state !== "running"),
  );
});
