// The lint checker's fixed identity, the parity checker's shape (parity-agent.ts):
// main.ts's wiring, the gate engine's fixed pick and whoever seeds the fleet config (tools/frm
// today) all need to agree on these ids -- one place, so they never drift apart.
export const LINT_RUNNER_ID = "script-lint-check";
export const LINT_AGENT_ID = "lint-checker";
export const LINT_RUN_CLASS = "lint";
/**
 * §9.8's role for a script job. The agent row is `kind='util'`, not `'reviewer'`: a lint_check runs
 * a deterministic command and reports its exit, and `listUtilAgents` is what the gate engine looks
 * it up with.
 */
export const LINT_ROLE = "util";

/**
 * What the gate hands the job at spawn (the an earlier change env path, validated and hashed).
 *
 * `FRM_LINT_REPO_ID` is the repo the gate pinned, and the job reads **that repo's** `lint_cmd` and
 * `install_cmd`. It is required: a job that guessed the repo would lint one repo of a workspace and
 * report the answer as another's, and `GateEvidence.subject.repo_id` would name a repo nothing was
 * run in (Invariant 10).
 *
 * `FRM_LINT_LOG` is where the whole of the command's output goes. A lint run's output is routinely
 * thousands of lines; putting it in an event payload is the token and the disk bill both, so the
 * finding carries a capped tail and this path (Invariant 9). It is under the gate's own artifacts
 * directory, which is on the supervisor's host -- the other reason this job runs on `local`.
 */
export const LINT_REPO_ENV = "FRM_LINT_REPO_ID";
export const LINT_LOG_ENV = "FRM_LINT_LOG";
