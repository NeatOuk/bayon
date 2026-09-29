// The QA checker's fixed identity, the lint checker's shape (lint-agent.ts): main.ts's
// wiring, the gate engine's fixed pick and whoever seeds the fleet config (tools/frm today) all need
// to agree on these ids -- one place, so they never drift apart.
export const QA_RUNNER_ID = "script-qa-check";
export const QA_AGENT_ID = "qa-checker";
export const QA_RUN_CLASS = "qa";
/**
 * §9.8's role for a script job. The agent row is `kind='util'`, not `'qa'`: the `qa` agent kind is
 * for a model that looks at a running application (§10.4's later half), while this runs a
 * deterministic command and reports its exit — which is what `listUtilAgents` finds.
 */
export const QA_ROLE = "util";

/**
 * What the gate hands the job at spawn (the an earlier change env path, validated and hashed).
 *
 * `FRM_QA_WORKSPACE_ID` is the project whose harness runs. Required, and never guessed: a job that
 * read the wrong workspace would run one project's command and report the answer as another's, and
 * the evidence would name a project nothing ran in (Invariant 10).
 *
 * `FRM_QA_ARTIFACTS` is the gate's artifacts directory on this host. The whole of the harness's
 * output goes into `qa.log` there, the run's facts into `qa-run.json`, and every report its globs
 * matched is copied under `qa-reports/` — so a finding carries a capped tail and a path, never
 * thousands of lines in an event payload (Invariant 9), and the reports survive the worktree's
 * sweep.
 */
export const QA_WORKSPACE_ENV = "FRM_QA_WORKSPACE_ID";
/**
 * The ticket the gate is for: the job reads its row for the three placeholders (`{ticket}`,
 * `{external_key}`, `{branch}`). Named here rather than read from the session, so the two runs of
 * this profile on two tickets hash differently (§8.1) and the job needs no writer's view of itself.
 */
export const QA_TICKET_ENV = "FRM_QA_TICKET_ID";
export const QA_ARTIFACTS_ENV = "FRM_QA_ARTIFACTS";

/** The files the job writes under the gate's artifacts directory. */
export const QA_LOG = "qa.log";
export const QA_RUN_FILE = "qa-run.json";
export const QA_REPORTS_DIR = "qa-reports";
