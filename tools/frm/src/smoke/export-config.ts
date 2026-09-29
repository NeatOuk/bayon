import { join } from "node:path";
import { hashConfig } from "@bayon/core";
import type { ConfigRows } from "@bayon/db/operator";
import { SMOKE } from "./config.js";

// The markdown exporter's fleet config, which frm seeds. Its ids are the
// supervisor's (apps/supervisor/src/jobs/export-agent.ts); frm cannot import an app, so they are
// restated here and export-config.test.ts pins them to that file.

export const EXPORTER = {
  runnerId: "script-export-markdown",
  agentId: "exporter",
  runClass: "export",
  tier: "cheap",
} as const;

/**
 * The exporter's run class, profile and agent: no workspace (no worktree: it works in the exports
 * repo), a zero budget, and the DB path and FRM_HOME in its env, which the job opens read-only.
 */
export async function exporterRows(o: {
  readonly now: number;
  readonly home: string;
}): Promise<ConfigRows> {
  const env_json = JSON.stringify({
    FRM_HOME: o.home,
    FRM_DB: join(o.home, "foreman.db"),
  });
  const hash = await hashConfig({
    runner_id: EXPORTER.runnerId,
    model_tier: EXPORTER.tier,
    env_json,
  });
  return {
    run_classes: [
      {
        name: EXPORTER.runClass,
        context_tokens_cap: 0,
        max_turns: 0,
        max_tool_calls: 0,
        wall_clock_ms: 60_000,
        cost_cap_usd: 0,
        handoff_at_turns: 0,
        default_tier: EXPORTER.tier,
      },
    ],
    profiles: [
      {
        id: EXPORTER.agentId,
        name: EXPORTER.agentId,
        runner_id: EXPORTER.runnerId,
        model_tier: EXPORTER.tier,
        env_json,
        version: 1,
        hash,
        created_at: o.now,
      },
    ],
    agents: [
      {
        id: EXPORTER.agentId,
        name: EXPORTER.agentId,
        kind: "util",
        runner_id: EXPORTER.runnerId,
        executor_id: SMOKE.executor,
        profile_id: EXPORTER.agentId,
        workspace_id: null,
        created_at: o.now,
      },
    ],
  };
}
