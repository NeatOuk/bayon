import type { ConfigRows } from "@bayon/db/operator";
import {
  SHIPPED_ALLOWLISTS,
  type CreateTicketRequest,
  type SpawnRequest,
} from "@bayon/proto";
import { FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import { SMOKE, profile } from "./config.js";
import { M3, PLANS, buildScript, fixScript, spikeScript } from "./m3-config.js";

// The M3 container run's config (plan "M3 — Container run"): one probe session of the reviewer's
// runner placed on the container, and a trivial ticket whose code review runs there. Trivial on
// purpose: with `reviewer` in executors.untrusted_roles every review must run on an untrusted
// executor, and a non-trivial ticket's ce_review runs on the builder's (local) executor.

export const M3C = {
  /** The one host the smoke adds to the gateway's allowlist (`--egress-allow`), and one it does not. */
  egressAllowed: "example.com",
  egressRefused: "example.org",
  /** An address a session container must not reach without the proxy. */
  directTarget: "1.1.1.1",
  untrustedRoles: "investigator,reviewer",
  /** The probe session's MCP call: any tool of its toolset; its arguments need not suit it. */
  mcpTool: "ticket_get",
  agents: {
    probe: "smoke-m3c-probe",
    reviewer: "smoke-m3c-review",
    spike: "smoke-m3c-spike",
    build: "smoke-m3c-build",
    fix: "smoke-m3c-fix",
  },
} as const;

/** The stand-in turns this into one MCP call with `nonce` (its conformance scenario's prompt). */
export const probePrompt = (nonce: string): string =>
  `Call the ${M3C.mcpTool} tool on the foreman MCP server once with the argument nonce set to "${nonce}", then reply DONE.`;

/** Tc: trivial (no complexity facts), so submit_plan opens no gate and a round is code_review alone. */
export const TRIVIAL_TICKET: CreateTicketRequest = {
  title: "M3 smoke: add() must add, reviewed on a container",
  type: "feature",
  body_md: `${M3.codePath}'s add(a, b) must return a + b; its code review runs on the container executor.`,
  workspace_id: SMOKE.workspace,
};

/** `POST /sessions` for the probe session: the reviewer's runner, placed on the container. */
export const probeSpawn = (
  runnerId: string,
  executorId: string,
  nonce: string,
): SpawnRequest => ({
  agent_id: M3C.agents.probe,
  role: "builder",
  run_class: M3.runClass,
  runner_id: runnerId,
  executor_id: executorId,
  prompt: probePrompt(nonce),
});

const agentRow = (o: {
  readonly id: string;
  readonly kind: "builder" | "reviewer";
  readonly runnerId: string;
  readonly executorId: string;
  readonly workspaceId: string | null;
  readonly now: number;
}) => ({
  id: o.id,
  name: o.id,
  kind: o.kind,
  runner_id: o.runnerId,
  executor_id: o.executorId,
  profile_id: o.id,
  workspace_id: o.workspaceId,
  created_at: o.now,
});

/** The probe agent and the container reviewer: the reviewer's runner, placed on the container. */
export async function probeRows(o: {
  readonly now: number;
  readonly schemaRunner: string;
  readonly executorId: string;
}): Promise<ConfigRows> {
  const a = M3C.agents;
  return {
    profiles: [
      await profile(
        a.probe,
        o.schemaRunner,
        "cheap",
        {},
        o.now,
        SHIPPED_ALLOWLISTS.builder,
      ),
      await profile(
        a.reviewer,
        o.schemaRunner,
        "cheap",
        {},
        o.now,
        SHIPPED_ALLOWLISTS.reviewer,
      ),
    ],
    agents: [
      agentRow({
        id: a.probe,
        kind: "builder",
        runnerId: o.schemaRunner,
        executorId: o.executorId,
        workspaceId: null,
        now: o.now,
      }),
      agentRow({
        id: a.reviewer,
        kind: "reviewer",
        runnerId: o.schemaRunner,
        executorId: o.executorId,
        workspaceId: null,
        now: o.now,
      }),
    ],
  };
}

/** Tc's fixture builders (local, as the gate engine's pin needs), scripted on its id. */
export async function ticketRows(o: {
  readonly now: number;
  readonly ticketId: string;
}): Promise<ConfigRows> {
  const a = M3C.agents;
  const builders = [
    [a.spike, spikeScript(o.ticketId, PLANS.hang)],
    [a.build, buildScript(o.ticketId)],
    [a.fix, fixScript(o.ticketId)],
  ] as const;
  return {
    profiles: await Promise.all(
      builders.map(([id, script]) =>
        profile(
          id,
          FIXTURE_RUNNER_ID,
          "standard",
          { script },
          o.now,
          SHIPPED_ALLOWLISTS.builder,
        ),
      ),
    ),
    agents: builders.map(([id]) =>
      agentRow({
        id,
        kind: "builder",
        runnerId: FIXTURE_RUNNER_ID,
        executorId: SMOKE.executor,
        workspaceId: SMOKE.workspace,
        now: o.now,
      }),
    ),
  };
}
