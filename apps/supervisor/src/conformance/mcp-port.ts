// The conformance MCP probe on the API's own /mcp (§15 test 11): the
// supervisor mints a per-suite token, as it does per session, and stores only its hash in a
// conformance_probes row; the API serves that token conformance_echo alone, and each echo is an
// audit row naming its nonce, which is how calls() sees the call arrive with the right bearer.
import { hashToolset, type Clock } from "@bayon/core";
import { listAuditByActor, type Db } from "@bayon/db";
import {
  closeConformanceProbe,
  openConformanceProbe,
} from "@bayon/db/supervisor";
import {
  CONFORMANCE_ECHO_TOOL,
  CONFORMANCE_NONCE_TARGET,
  CONFORMANCE_ROLE,
  toolDefinitions,
  toolsetFor,
} from "@bayon/proto";
import type { McpProbe, McpProbePort } from "@bayon/runners/conformance";
import { mintToken } from "../lifecycle/mcp.js";

export interface SupervisorMcpOptions {
  readonly db: Db;
  readonly clock: Clock;
  /** FRM_MCP_URL: the API's /mcp, as sessions reach it. */
  readonly url: string;
  /** Whether it answers: a probe that cannot be reached is a harness error, never a failure. */
  readonly reachable: (url: string) => Promise<boolean>;
  readonly runnerId: string;
  readonly executorId: string;
  /** The run's models row, recorded on the probe. */
  readonly modelId?: string;
  /** A probe token outlives no suite: it expires after this even if stop() never runs. */
  readonly ttlMs: number;
}

async function echoToolsetHash(): Promise<string> {
  const tools = toolsetFor(CONFORMANCE_ROLE, [CONFORMANCE_ECHO_TOOL]);
  if (!tools.ok) throw new Error(tools.error.message);
  return hashToolset(toolDefinitions(tools.value));
}

export function supervisorMcpProbe(o: SupervisorMcpOptions): McpProbePort {
  return {
    source: "supervisor",
    async start(): Promise<McpProbe> {
      if (!(await o.reachable(o.url))) {
        throw new Error(`the API's /mcp at ${o.url} does not answer`);
      }
      const token = await mintToken();
      const opened = await openConformanceProbe(o.db, {
        token_hash: token.hash,
        toolset_hash: await echoToolsetHash(),
        runner_id: o.runnerId,
        executor_id: o.executorId,
        model_id: o.modelId ?? null,
        expires_at: o.clock.now() + o.ttlMs,
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const probe = opened.value;
      return {
        url: o.url,
        token: token.token,
        tools: [CONFORMANCE_ECHO_TOOL],
        async calls() {
          const rows = await listAuditByActor(o.db, `session:${probe.id}`);
          if (!rows.ok) throw new Error(rows.error.message);
          return rows.value
            .filter((r) => r.action === `mcp.${CONFORMANCE_ECHO_TOOL}`)
            .map((r) => ({
              tool: CONFORMANCE_ECHO_TOOL,
              args:
                r.target_kind === CONFORMANCE_NONCE_TARGET &&
                r.target_id !== null
                  ? { nonce: r.target_id }
                  : {},
              // Only an authenticated call reaches the tool and leaves a row.
              bearerOk: true,
            }));
        },
        async stop() {
          const closed = await closeConformanceProbe(o.db, probe.id);
          if (!closed.ok) throw new Error(closed.error.message);
        },
      };
    },
  };
}
