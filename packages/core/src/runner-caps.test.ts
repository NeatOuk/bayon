import { expect, test } from "vitest";
import { isAgentRunner, JOB_RUNNER_KIND, RunnerCaps } from "./runner-caps.js";

const ALL: RunnerCaps = {
  structuredEvents: true,
  multiTurnInProcess: true,
  resumable: true,
  concurrentSessions: true,
  costReporting: true,
  tokenCounting: false,
  toolApprovalCallback: true,
  sandboxModes: false,
  mcpClient: true,
  hooks: true,
  pty: false,
  outputSchema: true,
  imageInput: true,
  subagents: false,
};

test("caps are the §5.1 booleans", () => {
  expect(Object.keys(RunnerCaps.shape)).toEqual(Object.keys(ALL));
  expect(RunnerCaps.parse(ALL)).toEqual(ALL);
});

test("every cap must be declared", () => {
  expect(RunnerCaps.safeParse({ ...ALL, pty: undefined }).success).toBe(false);
  expect(RunnerCaps.safeParse({ ...ALL, pty: "yes" }).success).toBe(false);
});

test("a job runner is not an agent runner; every other kind is", () => {
  expect(isAgentRunner({ kind: JOB_RUNNER_KIND })).toBe(false);
  expect(isAgentRunner({ kind: "job" })).toBe(false);
  for (const kind of ["llm_sdk", "llm_cli", "llm_http", "script"]) {
    expect(isAgentRunner({ kind })).toBe(true);
  }
});
