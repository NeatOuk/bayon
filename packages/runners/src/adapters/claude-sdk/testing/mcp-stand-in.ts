// A local stand-in for Bayon's /mcp: a minimal streamable-HTTP MCP server that answers
// initialize and tools/list with JSON, to one bearer alone; any other Authorization gets a 401
// without WWW-Authenticate, so a client starts no OAuth flow. It records every Authorization it
// is sent. Since a mount that cannot connect fails the start, every test that mounts needs one.
import { createServer, type Server } from "node:http";

export type McpStandIn = {
  readonly url: string;
  /** Every Authorization header received, in order (undefined where none was sent). */
  readonly authorizations: readonly (string | undefined)[];
  readonly close: () => Promise<void>;
};

type Rpc = {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: { readonly protocolVersion?: string };
};

const resultOf = (rpc: Rpc, tools: readonly string[]): object =>
  rpc.method === "initialize"
    ? {
        protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-stand-in", version: "0.0.0" },
      }
    : rpc.method === "tools/list"
      ? {
          tools: tools.map((name) => ({
            name,
            description: `The stand-in's ${name}.`,
            inputSchema: { type: "object", properties: {} },
          })),
        }
      : {};

/** Listens on 127.0.0.1; answers `Bearer <bearer>` alone, listing `tools`. */
export async function mcpStandIn(
  bearer: string,
  tools: readonly string[],
): Promise<McpStandIn> {
  const authorizations: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      authorizations.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${bearer}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"error":"stand-in"}');
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let rpc: Rpc;
      try {
        rpc = JSON.parse(body) as Rpc;
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (rpc.id === undefined) {
        res.writeHead(202).end(); // a notification
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: resultOf(rpc, tools),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the MCP stand-in has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
