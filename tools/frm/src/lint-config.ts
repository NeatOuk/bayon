import { join } from "node:path";
import { hashConfig } from "@bayon/core";
import type { ConfigRows } from "@bayon/db/operator";

// The lint checker's fleet config -- the parity checker's shape (parity-config.ts),
// seeded by `frm config apply` alongside the operator's own file. Rows nothing seeds are rows that
// do not exist, and `chooseLintJob` then answers `no_reviewer` every time an operator turns
// `gates.lint_check` on. Its ids are the supervisor's (apps/supervisor/src/jobs/lint-agent.ts); frm
// cannot import an app, so they are restated here and lint-config.test.ts pins them to that file.
//
// Its runner row is NOT here: the supervisor registers it at boot from its own adapter. What an
// operator owns is the run class, the profile and the agent. There is deliberately no
// `role_bindings` row for `util`, for the reason parity-config.ts gives: a binding answers "which
// runner fills this role", and this gate runs one specific job of this daemon's, found by id.
//
// What an operator owns *besides* these rows is the command itself: `repos.lint_cmd` (and
// `repos.install_cmd`) on each repo, which the same `frm config apply` file writes. Those are not
// seeded here — a default lint command would be this repo's own, hardcoded into a control plane for
// arbitrary repositories, and a repo that declares none simply opens no gate.

export const LINT = {
  runnerId: "script-lint-check",
  agentId: "lint-checker",
  runClass: "lint",
  tier: "cheap",
  /**
   * The executor the supervisor upserts at boot, which every install has. The job's argv is the
   * supervisor's own dist path and its log goes under the gate's artifacts directory, both on this
   * host — and `chooseLintJob` refuses a subject built anywhere else rather than running a
   * container's scripts here (§9.8).
   */
  executor: "local",
} as const;

/**
 * The lint job's run class, profile and agent: no workspace of its own (the gate hands it a
 * detached worktree at the pinned head), a zero budget (it sends no model a prompt), and the DB
 * path and FRM_HOME in its env, which the job opens read-only.
 *
 * The wall clock is the gate's own 15 minutes (`gates.wall_clock_ms`, 007) rather than parity's two
 * minutes: this job runs the repo's install and then its lint, on a worktree with no `node_modules`
 * and possibly a cold package-manager cache. A run class shorter than the gate's would make a slow
 * install look like a timeout.
 */
export async function lintRows(o: {
  readonly now: number;
  readonly home: string;
}): Promise<ConfigRows> {
  const env_json = JSON.stringify({
    FRM_HOME: o.home,
    FRM_DB: join(o.home, "foreman.db"),
  });
  const hash = await hashConfig({
    runner_id: LINT.runnerId,
    model_tier: LINT.tier,
    env_json,
  });
  return {
    run_classes: [
      {
        name: LINT.runClass,
        context_tokens_cap: 0,
        max_turns: 0,
        max_tool_calls: 0,
        wall_clock_ms: 900_000,
        cost_cap_usd: 0,
        handoff_at_turns: 0,
        default_tier: LINT.tier,
      },
    ],
    profiles: [
      {
        id: LINT.agentId,
        name: LINT.agentId,
        runner_id: LINT.runnerId,
        model_tier: LINT.tier,
        env_json,
        // It answers in its own event stream, so it mounts no MCP tools at all (§11.1).
        tool_allowlist_json: "[]",
        version: 1,
        hash,
        created_at: o.now,
      },
    ],
    agents: [
      {
        id: LINT.agentId,
        name: LINT.agentId,
        // A job, not a review: the gate engine looks it up with listUtilAgents.
        kind: "util",
        runner_id: LINT.runnerId,
        executor_id: LINT.executor,
        profile_id: LINT.agentId,
        workspace_id: null,
        created_at: o.now,
      },
    ],
  };
}
