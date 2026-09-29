// Who runs a `qa_harness` gate. Not a pick, like the lint job's: one fixed runner on one
// fixed executor, so the only questions are whether its rows exist and whether this host may run
// this project's harness at all.
//
// The runner is the daemon's own `script` adapter (main.ts registers it); the agent is an operator
// row (§4), `kind='util'`, because this gate runs a command and reports its exit rather than
// reviewing anything. Until one exists the gate fails `no_reviewer` with a line saying exactly what
// is missing — and, since a project opts into this gate by configuring a harness, that line has to
// say what to run rather than leaving a ticket stuck with no explanation.
//
// THE EXECUTOR IS `local`, AND THAT IS A LIMIT, NOT A PREFERENCE — the same limit lint-pick.ts
// states, for the same reason and with the same way out. The job's argv is
// `[node, <supervisor dist>/jobs/qa-check.js]`, which exists only on the supervisor's host, and the
// gate's artifacts directory (the log and the copied reports) is on that host too. But the command
// it runs is the *project's*: running a container-built branch's harness on the trusted host is
// precisely what §9.8's trust rule exists to prevent. A subject pinned on any other executor is
// refused here instead, with the reason named; the way out is shipping the job into the container
// image, which needs a docker host, and there is none (2026-09-18).
import { ok, type Result } from "@bayon/core";
import { listUtilAgents, type Db } from "@bayon/db";
import type { RunnerAdapter } from "@bayon/runners";
import { LOCAL_EXECUTOR_ID } from "../boot.js";
import { QA_RUNNER_ID } from "../jobs/qa-agent.js";
import type { ReviewerPickResult } from "./pick.js";

export interface QaPickInput {
  readonly db: Db;
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
  /** The executor that holds the pinned subject (`Pin.executorId`). */
  readonly subjectExecutorId: string;
}

export async function chooseQaJob(
  i: QaPickInput,
): Promise<Result<ReviewerPickResult>> {
  const adapter = i.adapters.get(QA_RUNNER_ID);
  if (adapter === undefined) {
    return ok({
      found: null,
      detail: `The QA check needs the ${QA_RUNNER_ID} job, which this supervisor does not have: waive this gate, or run a supervisor built with it`,
    });
  }
  if (i.subjectExecutorId !== LOCAL_EXECUTOR_ID) {
    return ok({
      found: null,
      detail: `The QA check runs this project's own QA command, and this change was built on executor ${i.subjectExecutorId}: running its harness on the supervisor's host would run untrusted code outside its sandbox. Set this project's QA mode to none and pass its QA by hand with an override note, or waive this gate.`,
    });
  }
  const agents = await listUtilAgents(i.db, QA_RUNNER_ID);
  if (!agents.ok) return agents;
  const agent = agents.value[0];
  if (agent === undefined) {
    return ok({
      found: null,
      detail: `The QA check needs the ${QA_RUNNER_ID} job's agent, and none is enabled: add the QA checker with \`frm config apply <file.json>\``,
    });
  }
  return ok({
    found: {
      runnerId: QA_RUNNER_ID,
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
