import { afterEach, expect, test } from "vitest";
import { ECHO_TOOL, startMcpProbe } from "./mcp-probe.js";
import type { McpProbe } from "./types.js";

let probe: McpProbe | undefined;
afterEach(async () => {
  await probe?.stop();
  probe = undefined;
});

async function rpc(
  p: McpProbe,
  method: string,
  params: object,
  bearer = p.token,
): Promise<Response> {
  return fetch(p.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

test("the right bearer: initialize, list conformance_echo, and echo the arguments back", async () => {
  probe = await startMcpProbe();
  expect(probe.tools).toEqual([ECHO_TOOL]);
  const init = await rpc(probe, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(init.status).toBe(200);
  const listed = (await (await rpc(probe, "tools/list", {})).json()) as {
    result: { tools: { name: string }[] };
  };
  expect(listed.result.tools.map((t) => t.name)).toEqual([ECHO_TOOL]);
  const called = (await (
    await rpc(probe, "tools/call", {
      name: ECHO_TOOL,
      arguments: { nonce: "n-1" },
    })
  ).json()) as { result: { content: { text: string }[] } };
  expect(JSON.parse(called.result.content[0]?.text ?? "")).toEqual({
    nonce: "n-1",
  });
  expect(await probe.calls()).toEqual([
    { tool: ECHO_TOOL, args: { nonce: "n-1" }, bearerOk: true },
  ]);
});

test("a wrong bearer gets 401, and the attempt is recorded as refused", async () => {
  probe = await startMcpProbe();
  const res = await rpc(
    probe,
    "tools/call",
    { name: ECHO_TOOL, arguments: { nonce: "n-2" } },
    "not-the-token",
  );
  expect(res.status).toBe(401);
  expect(await probe.calls()).toEqual([
    { tool: ECHO_TOOL, args: { nonce: "n-2" }, bearerOk: false },
  ]);
});

test("an unknown tool is an error result; anything but POST is 405", async () => {
  probe = await startMcpProbe();
  const called = (await (
    await rpc(probe, "tools/call", { name: "nope", arguments: {} })
  ).json()) as { result: { isError: boolean } };
  expect(called.result.isError).toBe(true);
  expect((await fetch(probe.url)).status).toBe(405);
});
