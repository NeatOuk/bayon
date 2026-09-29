// The API's side of FRM_MCP_URL for a real supervisor child, owned by the test that starts it.
// Without one the child falls back to DEFAULT_MCP_URL, the operator's live API, and gates every
// MCP-mounting spawn and adopt on that answering: the test passes only while a live install runs
// beside it. The stub answers the one probe the supervisor makes (httpReachable: GET /api/v1/health
// beside the /mcp URL, any 2xx) and nothing else. Test support only.
import { createServer } from "node:http";

const HEALTH_PATH = "/api/v1/health";

export interface McpStub {
  /** The child's FRM_MCP_URL: `http://127.0.0.1:<ephemeral port>/mcp`. */
  readonly url: string;
  /** Probes answered so far: proof the child asked here, not at the default URL. */
  probes(): number;
  close(): Promise<void>;
}

/** Listens on an ephemeral 127.0.0.1 port; close() it in afterAll. */
export async function startMcpStub(): Promise<McpStub> {
  let probes = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    if (req.method === "GET" && path === HEALTH_PATH) {
      probes += 1;
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"status":"ok"}');
      return;
    }
    // No script under these tests has an `mcp` step; a runner that called /mcp fails loudly here.
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("the MCP stub has no TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    probes: () => probes,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e === undefined ? resolve() : reject(e)));
      }),
  };
}
