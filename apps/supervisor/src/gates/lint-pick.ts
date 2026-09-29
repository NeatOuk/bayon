// Who runs a `lint_check`. Not a pick, like the parity job's: one fixed runner on one
// fixed executor, so the only questions are whether its rows exist and whether this host may run
// this branch's commands at all.
//
// The runner is the daemon's own `script` adapter (main.ts registers it); the agent is an operator
// row (§4), `kind='util'` rather than `'reviewer'`, because this gate runs a command and reports
// its exit rather than reviewing anything. Until one exists the gate fails `no_reviewer` with a line
// saying exactly what is missing -- which is why the laws that make the gate required are behind a
// default-off setting.
//
// THE EXECUTOR IS `local`, AND THAT IS A LIMIT, NOT A PREFERENCE. The job's argv is
// `[node, <supervisor dist>/jobs/lint-check.js]`, which exists only on the supervisor's host, and
// the gate's artifacts directory (where the whole output goes) is on that host too. But the command
// it runs is the *repo's* -- `pnpm -w lint` resolves through a `package.json` script the builder
// could have edited. Running a container-built branch's script on the trusted host is precisely
// what §9.8's trust rule exists to prevent, so a subject pinned on any other executor is refused
// here instead, with the reason named. With the gate on, such a fleet stalls in `code_review` and
// must waive; that is one more reason the default is off, and shipping the job into the container
// image (or running it through the executor's `exec`, as `collect()` reads a review file with
// `cat`) is the way out -- a later ticket, not this one.
//
// The refusal above is only half the trade, and the half this comment used to be the *only* record
// of. The other half is what the job may reach once it does run here: jobs/job-env.ts confines a
// repo's declared commands to the session's own home and lays git's environment floor under them
//. Neither half is isolation -- the commands still run as the supervisor's uid. The
// decision, and what it leaves open, is written down in the design and on the issue,
// so it is no longer a thing you learn by reading a pick function.
import { ok, type Result } from "@bayon/core";
import { listUtilAgents, type Db } from "@bayon/db";
import type { RunnerAdapter } from "@bayon/runners";
import { LOCAL_EXECUTOR_ID } from "../boot.js";
import { LINT_RUNNER_ID } from "../jobs/lint-agent.js";
import type { ReviewerPickResult } from "./pick.js";

export interface LintPickInput {
  readonly db: Db;
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
  /** The executor that holds the pinned subject (`Pin.executorId`). */
  readonly subjectExecutorId: string;
}

export async function chooseLintJob(
  i: LintPickInput,
): Promise<Result<ReviewerPickResult>> {
  const adapter = i.adapters.get(LINT_RUNNER_ID);
  if (adapter === undefined) {
    return ok({
      found: null,
      detail: `lint_check runs the ${LINT_RUNNER_ID} job, and this supervisor has no adapter for it`,
    });
  }
  if (i.subjectExecutorId !== LOCAL_EXECUTOR_ID) {
    return ok({
      found: null,
      detail: `lint_check runs the repository's own lint command, and this subject was built on executor ${i.subjectExecutorId}: running its scripts on the supervisor's host would put untrusted code on the trusted side of §9.8. Turn gates.lint_check off for this fleet, or waive this gate.`,
    });
  }
  const agents = await listUtilAgents(i.db, LINT_RUNNER_ID);
  if (!agents.ok) return agents;
  const agent = agents.value[0];
  if (agent === undefined) {
    return ok({
      found: null,
      detail: `lint_check runs the ${LINT_RUNNER_ID} job, and no enabled kind='util' agent of it exists: seed the lint checker's rows with \`frm config apply\``,
    });
  }
  return ok({
    found: {
      runnerId: LINT_RUNNER_ID,
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
