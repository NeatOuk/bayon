// The reference MCP probe (test 11): an /mcp endpoint on 127.0.0.1 serving one
// tool, `conformance_echo`, which answers its arguments back. Stateless streamable HTTP with JSON
// responses, as the API's /mcp serves it; a wrong bearer gets 401. Every tools/call is recorded,
// refused ones too. Production serves the tool from the API under a conformance role.
import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpProbe, McpProbeCall, McpProbePort } from "./types.js";

export const ECHO_TOOL = "conformance_echo";

const TOOL = {
  name: ECHO_TOOL,
  description: "Conformance probe: returns its arguments as JSON.",
  inputSchema: {
    type: "object" as const,
    properties: { nonce: { type: "string" } },
    required: ["nonce"],
  },
};

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The tools/call a JSON-RPC body carries, if it is one. */
function callOf(body: unknown): Omit<McpProbeCall, "bearerOk"> | undefined {
  if (!isRecord(body) || body["method"] !== "tools/call") return undefined;
  const params = body["params"];
  if (!isRecord(params) || typeof params["name"] !== "string") return undefined;
  const args = params["arguments"];
  return { tool: params["name"], args: isRecord(args) ? args : {} };
}

function echo(
  name: string,
  args: Readonly<Record<string, unknown>>,
): CallToolResult {
  return name === ECHO_TOOL
    ? { content: [{ type: "text", text: JSON.stringify(args) }] }
    : { content: [{ type: "text", text: `no tool ${name}` }], isError: true };
}

export async function startMcpProbe(): Promise<McpProbe> {
  const token = randomBytes(32).toString("base64url");
  let calls: readonly McpProbeCall[] = [];

  async function serve(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const body = await bodyOf(req);
    const bearerOk = req.headers.authorization === `Bearer ${token}`;
    const call = callOf(body);
    if (call !== undefined) calls = [...calls, { ...call, bearerOk }];
    if (!bearerOk) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const server = new Server(
      { name: "foreman-conformance", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [TOOL] }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      echo(request.params.name, request.params.arguments ?? {}),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const http = createServer((req, res) => {
    serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    tools: [ECHO_TOOL],
    calls: async () => calls,
    stop: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

export const referenceMcpProbe: McpProbePort = {
  source: "reference",
  start: startMcpProbe,
};
