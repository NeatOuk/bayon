// The supervisor's own job runners — the exporter and the two script gates — built once, in one
// place. The adapter map and the `uncertified` exemption are both derived from JOB_ADAPTERS, so a
// job cannot be wired up without also being exempt.
//
// They used to be two hand-kept lists in main.ts, and they drifted: the lint job was registered as
// an adapter but left out of the exemption, so under admission.require_certified=1 every lint_check
// gate would have been refused at admission as uncertified — and a gate that cannot run stalls every
// ticket in code_review. It stayed latent only because gates.lint_check defaults off, and the tests
// never noticed because they pass their own job-runner set rather than this one.
import { fileURLToPath } from "node:url";
import type { RunnerAdapter } from "@bayon/runners";
import { createScriptAdapter } from "@bayon/runners/script";
import { EXPORTER_RUNNER_ID } from "./export-agent.js";
import { LINT_RUNNER_ID } from "./lint-agent.js";
import { PARITY_RUNNER_ID } from "./parity-agent.js";
import { QA_RUNNER_ID } from "./qa-agent.js";

/** A job script beside this module, as the daemon runs it from dist/jobs/. */
const jobPath = (file: string): string =>
  fileURLToPath(new URL(`./${file}`, import.meta.url));

/** Each argv is fixed at construction: a job-specific detail belongs to the adapter, not a profile. */
export const exportAdapter: RunnerAdapter = createScriptAdapter({
  id: EXPORTER_RUNNER_ID,
  argv: [process.execPath, jobPath("export-markdown.js")],
});

/** The lint_check gate's job. Its runner row goes in at boot with the others'. */
export const lintAdapter: RunnerAdapter = createScriptAdapter({
  id: LINT_RUNNER_ID,
  argv: [process.execPath, jobPath("lint-check.js")],
});

/** The qa_harness gate's job. Its runner row goes in at boot with the others'. */
export const qaAdapter: RunnerAdapter = createScriptAdapter({
  id: QA_RUNNER_ID,
  argv: [process.execPath, jobPath("qa-check.js")],
});

/** The parity_check gate's job. Its runner row goes in at boot with the exporter's. */
export const parityAdapter: RunnerAdapter = createScriptAdapter({
  id: PARITY_RUNNER_ID,
  argv: [process.execPath, jobPath("parity-check.js")],
});

/** Every job adapter this daemon runs. Add a job here and it is both wired and exempt. */
export const JOB_ADAPTERS: readonly RunnerAdapter[] = [
  exportAdapter,
  parityAdapter,
  lintAdapter,
  qaAdapter,
];

/**
 * Runners this daemon registers for its own jobs: exempt from `uncertified` only. A job is not an
 * agent — §15's suite exercises a model's behaviour and has nothing to say about a fixed script —
 * so certifying one would be meaningless, not merely unnecessary.
 */
export const JOB_RUNNERS: ReadonlySet<string> = new Set(
  JOB_ADAPTERS.map((a) => a.id),
);
