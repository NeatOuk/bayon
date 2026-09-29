import { join } from "node:path";
import { hashConfig } from "@bayon/core";
import type { ConfigRows } from "@bayon/db/operator";

// The QA checker's fleet config -- the lint checker's shape (lint-config.ts), seeded by
// `frm config apply` alongside the operator's own file. Rows nothing seeds are rows that do not
// exist, and `chooseQaJob` then answers `no_reviewer` every time a project sets its QA mode to
// `command`. Its ids are the supervisor's (apps/supervisor/src/jobs/qa-agent.ts); frm cannot import
// an app, so they are restated here and qa-config.test.ts pins them to that file.
//
// Its runner row is NOT here: the supervisor registers it at boot from its own adapter. What an
// operator owns is the run class, the profile and the agent. There is deliberately no
// `role_bindings` row for `util`, for the reason parity-config.ts gives: a binding answers "which
// runner fills this role", and this gate runs one specific job of this daemon's, found by id.
//
// What an operator owns *besides* these rows is the harness itself: `workspaces.qa_mode` and
// `workspaces.qa_cmd`, set per project in its Settings view. Those are not seeded here, and could
// not be: a default QA command would be one project's, hardcoded into a control plane for arbitrary
// projects. A project that declares none opens no gate.

export const QA = {
  runnerId: "script-qa-check",
  agentId: "qa-checker",
  runClass: "qa",
  tier: "cheap",
  /**
   * The executor the supervisor upserts at boot, which every install has. The job's argv is the
   * supervisor's own dist path and its artifacts go under the gate's directory, both on this host --
   * and `chooseQaJob` refuses a subject built anywhere else rather than running a container's
   * harness here (§9.8).
   */
  executor: "local",
} as const;

/**
 * The QA job's profile and agent: no workspace of its own (the gate hands it a detached worktree at
 * the pinned head), a zero budget (it sends no model a prompt), and the DB path and FRM_HOME in its
 * env, which the job opens read-only.
 *
 * **No run class.** 002_seed already ships `qa` (§4's own list, 20 minutes, cheap, no turns), which
 * is exactly this job's shape and exactly the default a project's `qa_timeout_ms` falls back to.
 * Seeding a second row of that name is a UNIQUE conflict that would lose the operator's whole
 * apply. A fleet whose harnesses need longer raises that run class's `wall_clock_ms` — config over
 * code (§4), and the one place both clocks can be kept in step.
 */
export async function qaRows(o: {
  readonly now: number;
  readonly home: string;
}): Promise<ConfigRows> {
  const env_json = JSON.stringify({
    FRM_HOME: o.home,
    FRM_DB: join(o.home, "foreman.db"),
  });
  const hash = await hashConfig({
    runner_id: QA.runnerId,
    model_tier: QA.tier,
    env_json,
  });
  return {
    profiles: [
      {
        id: QA.agentId,
        name: QA.agentId,
        runner_id: QA.runnerId,
        model_tier: QA.tier,
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
        id: QA.agentId,
        name: QA.agentId,
        // A job, not a review: the gate engine looks it up with listUtilAgents.
        kind: "util",
        runner_id: QA.runnerId,
        executor_id: QA.executor,
        profile_id: QA.agentId,
        workspace_id: null,
        created_at: o.now,
      },
    ],
  };
}
