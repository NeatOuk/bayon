// One MCP request: a new low-level Server and a stateless transport, bound to
// the session behind the token. tools/list serves the catalogue's JSON Schema verbatim, and only
// while it still hashes to the session's toolset_hash (fail closed); tools/call validates,
// dispatches, caps (§8.5) and audits refused writes.
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { hashToolset, newId, sha256Hex, type Clock } from "@bayon/core";
import type { AuditEntry } from "@bayon/db/api";
import {
  listedTools,
  mcpTool,
  toolDefinitions,
  toolsetFor,
  type McpTool,
} from "@bayon/proto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { DocsReader } from "../docs/reader.js";
import type { TicketService } from "../tickets/ticket-service.js";
import { capResult } from "./cap.js";
import { invalidArguments } from "./invalid-args.js";
import type { McpLimits } from "./limits.js";
import { failed, refusal, type Refusal } from "./refusals.js";
import type { McpActor } from "./scope.js";
import type { McpSession, McpStore } from "./store.js";
import { HANDLERS, type ToolCtx } from "./tools.js";

export interface McpDeps {
  readonly store: McpStore;
  readonly limits: McpLimits;
  /** Session files (§11.3): the backstop keeps full results under it; null keeps none. */
  readonly runtimeDir: string | null;
  /** tickets module: every ticket tool goes through it (§7). */
  readonly tickets?: TicketService;
  /** documentation reader: doc_search and doc_get go through it. */
  readonly docs?: DocsReader;
}

interface Served {
  readonly tools: readonly McpTool[];
  /** The tool set no longer hashes to toolset_hash: nothing is served. */
  readonly drifted: boolean;
}

/** The role's §11.1 row ∩ the profile's allowlist, only while it hashes to toolset_hash. */
export async function servedTools(session: McpSession): Promise<Served> {
  const tools =
    session.allowlist === null
      ? undefined
      : toolsetFor(session.role, session.allowlist);
  if (tools === undefined || !tools.ok) return { tools: [], drifted: true };
  const hash = await hashToolset(toolDefinitions(tools.value));
  return hash === session.toolsetHash
    ? { tools: tools.value, drifted: false }
    : { tools: [], drifted: true };
}

const actorOf = (s: McpSession): McpActor => ({
  kind: "session",
  id: s.id,
  role: s.role,
  agentId: s.agentId,
  agentName: s.agentName,
  ticketId: s.ticketId,
  workspaceId: s.workspaceId,
});

/** What tools/list sends: the catalogue's schema as it is, typed for the SDK. */
const listed = (tools: readonly McpTool[]): Tool[] =>
  listedTools(tools).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { ...t.inputSchema, type: "object" },
  }));

async function callTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  session: McpSession,
  served: Served,
  deps: McpDeps,
  clock: Clock,
): Promise<CallToolResult> {
  const argsJson = JSON.stringify(args);
  const digest = {
    args_sha256: await sha256Hex(argsJson),
    bytes: Buffer.byteLength(argsJson, "utf8"),
  };
  const auditOf = (
    outcome: string,
    targetKind: string,
    targetId: string | null,
  ): AuditEntry => ({
    actor: `session:${session.id}`,
    action: `mcp.${name}`,
    target_kind: targetKind,
    target_id: targetId,
    payload: { ...digest, outcome },
  });
  // A refused write is still an attempt: it gets its own audit row (§6).
  const refuse = async (r: Refusal): Promise<CallToolResult> => {
    if (mcpTool(name)?.write === true) {
      const logged = await deps.store.audit(
        auditOf(`refused:${r.reason}`, "session", session.id),
      );
      if (!logged.ok) return failed(`internal: ${logged.error.class}`);
    }
    return refusal(r);
  };
  const tool = served.tools.find((t) => t.wire === name);
  if (tool === undefined) {
    return refuse(
      served.drifted
        ? {
            reason: "actor_not_allowed",
            rule: "toolset_hash",
            detail: "this session's tool set changed since it was spawned",
          }
        : {
            reason: "actor_not_allowed",
            detail:
              mcpTool(name)?.pending === true
                ? `${name} is not available yet`
                : `${name} is not one of this session's tools`,
          },
    );
  }
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) return failed(invalidArguments(tool, parsed.error));
  const handler = HANDLERS[tool.wire];
  if (handler === undefined) return failed(`${tool.wire} is not available yet`);
  const ctx: ToolCtx = {
    session,
    actor: actorOf(session),
    store: deps.store,
    tickets: deps.tickets,
    docs: deps.docs,
    audit: (kind, id) => auditOf("ok", kind, id),
  };
  const outcome = await handler(ctx, parsed.data);
  if (outcome.kind === "refused") return refuse(outcome.refusal);
  if (outcome.kind === "failed") {
    const { class: cls, message, retryable } = outcome.error;
    // Internal errors name their class only: the details belong in the server's log.
    const text =
      cls === "internal" || cls === "db_busy" ? cls : `${cls}: ${message}`;
    return failed(retryable ? `${text} (retryable)` : text);
  }
  const capped = capResult(JSON.stringify(outcome.data), {
    limits: { bytes: deps.limits.capBytes, lines: deps.limits.capLines },
    toolDir:
      deps.runtimeDir === null
        ? null
        : join(deps.runtimeDir, "sessions", session.id, "logs", "tool"),
    fileId: newId(clock.now()),
  });
  if (!capped.ok) return failed("internal: the result could not be capped");
  return { content: [{ type: "text", text: capped.value.text }] };
}

/** Serves one POST /mcp for `session`. */
export async function serveMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  session: McpSession,
  deps: McpDeps,
  clock: Clock,
): Promise<void> {
  const served = await servedTools(session);
  const server = new Server(
    { name: "foreman", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listed(served.tools),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callTool(
      request.params.name,
      request.params.arguments ?? {},
      session,
      served,
      deps,
      clock,
    ),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no MCP session, nothing kept between requests
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
