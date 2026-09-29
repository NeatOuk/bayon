// The production job-runner set, not a test's own copy: the lint job once sat in the adapter map but
// not in the exemption, so every lint_check gate would have been refused at admission as uncertified.
import { expect, test } from "vitest";
import { EXPORTER_RUNNER_ID } from "./export-agent.js";
import { JOB_ADAPTERS, JOB_RUNNERS } from "./job-adapters.js";
import { LINT_RUNNER_ID } from "./lint-agent.js";
import { PARITY_RUNNER_ID } from "./parity-agent.js";
import { QA_RUNNER_ID } from "./qa-agent.js";

test("every job the daemon wires is exempt from certification, the lint and QA jobs included", () => {
  expect([...JOB_RUNNERS].toSorted()).toEqual(
    [
      EXPORTER_RUNNER_ID,
      LINT_RUNNER_ID,
      PARITY_RUNNER_ID,
      QA_RUNNER_ID,
    ].toSorted(),
  );
  for (const job of JOB_ADAPTERS) expect(JOB_RUNNERS.has(job.id)).toBe(true);
});

test("each job adapter is wired once, under its own id", () => {
  const ids = JOB_ADAPTERS.map((a) => a.id);
  expect(new Set(ids).size).toBe(ids.length);
});
