import { join } from "node:path";
import { hashConfig } from "@bayon/core";
import type { ConfigRows } from "@bayon/db/operator";

// The parity checker's fleet config -- the same shape as the exporter's
// (export-config.ts). Seeded by `frm config apply` alongside the operator's own file
// and by the M3 smoke's m3Rows: rows nothing seeds are rows that do not exist, and chooseParityJob
// then answers `no_reviewer` every time an operator turns `gates.parity_check` on. This file sits
// beside config-apply.ts rather than under smoke/ for that reason. Its ids are the supervisor's
// (apps/supervisor/src/jobs/parity-agent.ts); frm cannot import an app, so they are restated here
// and parity-config.test.ts pins them to that file.
//
// Its runner row is NOT here: the supervisor registers it at boot from its own adapter, exactly as
// it does the exporter's. What an operator owns is the run class, the profile and the agent.
//
// There is deliberately no `role_bindings` row for `util`. A binding answers "which runner fills
// this role", and `parity_check` has no such question: it runs one specific job of this daemon's,
// found by id. A binding pointing anywhere else would not be an operator choice, it would be a
// broken gate.

export const PARITY = {
  runnerId: "script-parity-check",
  agentId: "parity-checker",
  runClass: "parity",
  tier: "cheap",
  /**
   * The executor the supervisor upserts at boot (amendment 4), which every install has. The job
   * reads this host's mirrors and its database, and a container can see neither.
   */
  executor: "local",
} as const;

/**
 * The parity job's run class, profile and agent: no workspace (it reads the mirrors and the
 * database, and works in no worktree of its own), a zero budget (it sends no model a prompt), and
 * the DB path and FRM_HOME in its env, which the job opens read-only.
 */
export async function parityRows(o: {
  readonly now: number;
  readonly home: string;
}): Promise<ConfigRows> {
  const env_json = JSON.stringify({
    FRM_HOME: o.home,
    FRM_DB: join(o.home, "foreman.db"),
  });
  const hash = await hashConfig({
    runner_id: PARITY.runnerId,
    model_tier: PARITY.tier,
    env_json,
  });
  return {
    run_classes: [
      {
        name: PARITY.runClass,
        context_tokens_cap: 0,
        max_turns: 0,
        max_tool_calls: 0,
        wall_clock_ms: 120_000,
        cost_cap_usd: 0,
        handoff_at_turns: 0,
        default_tier: PARITY.tier,
      },
    ],
    profiles: [
      {
        id: PARITY.agentId,
        name: PARITY.agentId,
        runner_id: PARITY.runnerId,
        model_tier: PARITY.tier,
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
        id: PARITY.agentId,
        name: PARITY.agentId,
        // A job, not a review: the gate engine looks it up with listUtilAgents.
        kind: "util",
        runner_id: PARITY.runnerId,
        // local: the mirrors and the database are on the supervisor's host, and a container can
        // see neither.
        executor_id: PARITY.executor,
        profile_id: PARITY.agentId,
        workspace_id: null,
        created_at: o.now,
      },
    ],
  };
}
