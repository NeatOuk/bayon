import { expect, test } from "vitest";
import { CreateProjectAgentRequest, PatchAgentRequest } from "./agents.js";

test.each([
  [{ kind: "builder", runner_id: "runner-b" }, true],
  [{ kind: "reviewer", runner_id: "runner-b", max_concurrency: 0 }, true],
  [{ kind: "orchestrator", runner_id: "runner-b" }, true],
  [{ kind: "investigator", runner_id: "runner-b" }, false],
  [{ kind: "builder" }, false],
  [{ kind: "builder", runner_id: "" }, false],
  [{ kind: "builder", runner_id: "runner-b", max_concurrency: -1 }, false],
  [{ kind: "builder", runner_id: "runner-b", max_concurrency: 1.5 }, false],
  [{ kind: "builder", runner_id: "runner-b", mission_id: "m-1" }, false],
  [{ kind: "builder", runner_id: "runner-b", executor_id: "local" }, false],
])("CreateProjectAgentRequest %j parses: %s", (body, parses) => {
  expect(CreateProjectAgentRequest.safeParse(body).success).toBe(parses);
});

test.each([
  [{ enabled: false }, true],
  [{ max_concurrency: 0 }, true],
  [{ enabled: true, max_concurrency: 4 }, true],
  [{}, false],
  [{ max_concurrency: -1 }, false],
  [{ enabled: "no" }, false],
  [{ enabled: false, profile_id: "p1" }, false],
  [{ enabled: false, mission_id: "m-1" }, false],
  [{ enabled: false, kind: "reviewer" }, false],
  [{ enabled: false, runner_id: "r" }, false],
  [{ enabled: false, workspace_id: "w" }, false],
])("PatchAgentRequest %j parses: %s", (body, parses) => {
  expect(PatchAgentRequest.safeParse(body).success).toBe(parses);
});
