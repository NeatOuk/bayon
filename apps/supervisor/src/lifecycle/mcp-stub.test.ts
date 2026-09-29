// The stub the real-process tests hand their supervisor child as FRM_MCP_URL satisfies the
// supervisor's own reachability probe, so admission and adopt proceed against it and never need
// the operator's live API on the default URL.
import { expect, test } from "vitest";
import { DEFAULT_MCP_URL, httpReachable } from "./mcp.js";
import { startMcpStub } from "./testing/mcp-stub.js";

test("the MCP stub answers the supervisor's reachability probe on a port of its own, and nothing else", async () => {
  const stub = await startMcpStub();
  try {
    expect(stub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(stub.url).not.toBe(DEFAULT_MCP_URL);
    expect(await httpReachable(stub.url)).toBe(true);
    expect(stub.probes()).toBe(1);
    expect((await fetch(stub.url, { method: "POST" })).status).toBe(404);
    expect(stub.probes()).toBe(1);
  } finally {
    await stub.close();
  }
  // Closed: the gate would hold the spawn, as it does when the API is down.
  expect(await httpReachable(stub.url)).toBe(false);
});
