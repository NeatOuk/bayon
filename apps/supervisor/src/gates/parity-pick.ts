// Who runs a `parity_check`. Not a pick at all: the job is one fixed runner on one fixed
// executor, so the only question is whether its rows exist.
//
// The runner is the daemon's own `script` adapter (main.ts registers it, as it does the exporter's);
// the agent is an operator row (§4: config over code), `kind='util'` rather than `'reviewer'`,
// because this gate runs a deterministic job and not a review. Until one exists the gate fails
// `no_reviewer` with a line saying exactly what is missing -- which is why the laws that make the
// gate required are behind a default-off setting: a required gate nobody can decide would stall
// every multi-repo ticket in code_review.
//
// The executor is `local`: the job reads the supervisor's own mirrors and its database, neither of
// which a container can see. §9.8's `util -> container` row is about QA harnesses,
// which run a repo's own commands inside the workspace.
import { ok, type Result } from "@bayon/core";
import { listUtilAgents, type Db } from "@bayon/db";
import type { RunnerAdapter } from "@bayon/runners";
import { LOCAL_EXECUTOR_ID } from "../boot.js";
import { PARITY_RUNNER_ID } from "../jobs/parity-agent.js";
import type { ReviewerPickResult } from "./pick.js";

export interface ParityPickInput {
  readonly db: Db;
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
}

export async function chooseParityJob(
  i: ParityPickInput,
): Promise<Result<ReviewerPickResult>> {
  const adapter = i.adapters.get(PARITY_RUNNER_ID);
  if (adapter === undefined) {
    return ok({
      found: null,
      detail: `The parity check needs the ${PARITY_RUNNER_ID} job, which this supervisor does not have: waive this gate, or run a supervisor built with it`,
    });
  }
  const agents = await listUtilAgents(i.db, PARITY_RUNNER_ID);
  if (!agents.ok) return agents;
  const agent = agents.value[0];
  if (agent === undefined) {
    return ok({
      found: null,
      detail: `The parity check needs the ${PARITY_RUNNER_ID} job's agent, and none is enabled: add the parity checker with \`frm config apply <file.json>\``,
    });
  }
  return ok({
    found: {
      runnerId: PARITY_RUNNER_ID,
      fallbackFrom: null,
      // Not a review, so neither flag is ever true: the evidence says the plain truth.
      singleRunnerReview: false,
      // SCRIPT_CAPS.outputSchema is false, so collect() takes the heuristic path and holds the
      // job's answer to its FINDINGS sentinel () -- read from the adapter, never assumed.
      outputSchema: adapter.caps().outputSchema === true,
      agentId: agent.id,
      // The agent's own profile, which carries FRM_DB and FRM_HOME into the child's env.
      profileId: null,
      executorId: LOCAL_EXECUTOR_ID,
    },
  });
}
