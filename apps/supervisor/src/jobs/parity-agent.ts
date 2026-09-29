// The parity checker's fixed identity, the exporter's shape (export-agent.ts): main.ts's
// wiring, the gate engine's fixed pick and whoever seeds the fleet config (tools/frm today, an
// operator flow later) all need to agree on these ids -- one place, so they never drift apart.
export const PARITY_RUNNER_ID = "script-parity-check";
export const PARITY_AGENT_ID = "parity-checker";
export const PARITY_RUN_CLASS = "parity";
/**
 * §9.8's role for a script job. The agent row is `kind='util'`, not `'reviewer'`: a parity_check
 * runs a deterministic job, and `listUtilAgents` is what the gate engine looks it up with.
 */
export const PARITY_ROLE = "util";

/**
 * How the gate hands the job the commit it is to check (H1): the gate engine puts these
 * into the session's environment at spawn, and the child reads them there. The pin is the only
 * source of the ticket's head — `worktrees.head_sha` has no writer anywhere in this repo, so a job
 * reading the rows alone would walk `base_sha`, describe the tree the ticket *started* from, find
 * nothing wrong with it, and pass a gate whose evidence names a range it never looked at
 * (Invariant 10). The job requires both: an absent one fails the gate loudly rather than quietly
 * certifying the base.
 */
export const PARITY_REPO_ENV = "FRM_PARITY_REPO_ID";
export const PARITY_HEAD_ENV = "FRM_PARITY_HEAD";
