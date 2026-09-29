import type { ConfigRows } from "@bayon/db/operator";
import {
  SHIPPED_ALLOWLISTS,
  type CreateTicketRequest,
  type SpawnRequest,
} from "@bayon/proto";
import {
  FIXTURE_RUNNER_ID,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { SMOKE, profile } from "./config.js";
import type { ExpectedAudit, ExpectedCall } from "./m1-assertions.js";

// The M1 acceptance test's config (plan "Verification (M1 close)"): one builder agent whose
// fixture script works ticket A over MCP, and what its calls must leave behind.

export const M1 = {
  agent: "smoke-m1",
  role: "builder",
  runClass: "build",
  prompt:
    "Work ticket A over MCP: read it, update it, file a follow-up, ask the operator.",
  ticketA: {
    title: "M1 smoke: ticket A",
    type: "feature",
    body_md: "The ticket the M1 session holds.",
  } satisfies CreateTicketRequest,
  editedBody: "Updated by the M1 session over MCP.",
  followupTitle: "M1 smoke: follow-up B",
  question: "Start the follow-up now or later?",
} as const;

/** The script's calls, as their `mcp_call` events must record them. */
export const M1_CALLS: readonly ExpectedCall[] = [
  { tool: "ticket_get", outcome: "ok" },
  { tool: "ticket_update", outcome: "ok" },
  { tool: "ticket_create", outcome: "ok" },
  { tool: "ticket_update", outcome: "refused", reason: "cross_ticket_write" },
  { tool: "human_ask", outcome: "ok" },
];

/**
 * One run on ticket A: read it, update it at the version read, file follow-up B, try to update B
 * (a worker writes only its own ticket: refused), ask the operator. Then the run holds at its gate,
 * so the smoke can see the session still running with the question open.
 */
export function m1Script(ticketId: string): FixtureScriptInput {
  return {
    runs: [
      {
        events: [
          { kind: "turn_start", runner_type: "smoke.step", payload: {} },
        ],
        mcp: [
          {
            tool: "ticket_get",
            args: { ticket: ticketId },
            expect: {
              fields: { "ticket.id": ticketId, "ticket.status": "backlog" },
            },
            save: { a_version: "ticket.version" },
          },
          {
            tool: "ticket_update",
            args: {
              ticket: ticketId,
              version: { $saved: "a_version" },
              body_md: M1.editedBody,
            },
            expect: { fields: { id: ticketId } },
          },
          {
            tool: "ticket_create",
            args: {
              title: M1.followupTitle,
              type: "followup",
              body_md: "Filed by the M1 session over MCP.",
            },
            expect: { fields: { needs_human: true, status: "backlog" } },
            save: { b: "id", b_version: "version" },
          },
          {
            tool: "ticket_update",
            args: {
              ticket: { $saved: "b" },
              version: { $saved: "b_version" },
              title: `${M1.followupTitle}, retitled`,
            },
            expect: { refused: "cross_ticket_write" },
          },
          {
            tool: "human_ask",
            args: {
              questions: [
                {
                  question: M1.question,
                  options: ["now", "later"],
                  recommendation: "later",
                },
              ],
            },
            expect: { fields: { status: "open" } },
          },
        ],
        gate: "release",
      },
    ],
  };
}

/** The M1 agent's profile (the script, the builder's shipped tools) and the agent itself. */
export async function m1Rows(o: {
  readonly now: number;
  readonly ticketId: string;
}): Promise<ConfigRows> {
  const row = await profile(
    M1.agent,
    FIXTURE_RUNNER_ID,
    "standard",
    { script: m1Script(o.ticketId) },
    o.now,
    SHIPPED_ALLOWLISTS.builder,
  );
  return {
    profiles: [row],
    agents: [
      {
        id: M1.agent,
        name: M1.agent,
        kind: "builder",
        runner_id: FIXTURE_RUNNER_ID,
        executor_id: SMOKE.executor,
        profile_id: M1.agent,
        workspace_id: SMOKE.workspace,
        created_at: o.now,
      },
    ],
  };
}

/** `POST /sessions` for the M1 agent, holding ticket A. */
export const m1SpawnRequest = (ticketId: string): SpawnRequest => ({
  agent_id: M1.agent,
  role: M1.role,
  run_class: M1.runClass,
  workspace_id: SMOKE.workspace,
  runner_id: FIXTURE_RUNNER_ID,
  executor_id: SMOKE.executor,
  prompt: M1.prompt,
  ticket_id: ticketId,
});

/** The audit rows the session's writes must leave, in order (reads are not audited). */
export const m1Audit = (a: string, b: string): readonly ExpectedAudit[] => [
  { action: "mcp.ticket_update", outcome: "ok", target_id: a },
  { action: "mcp.ticket_create", outcome: "ok", target_id: b },
  { action: "mcp.ticket_update", outcome: "refused:cross_ticket_write" },
  { action: "mcp.human_ask", outcome: "ok", target_id: a },
];
