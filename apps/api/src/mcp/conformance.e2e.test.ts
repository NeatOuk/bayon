// conformance_echo over /mcp (§15 test 11): a live probe token is served that tool alone
// and each call leaves an audit row naming its nonce; an ended probe's token is refused; no work
// session reaches the tool, even one whose profile or role names it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeClock, hashToolset, sha256Hex, systemClock } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  listAudit,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  CONFORMANCE_ECHO_TOOL,
  ROLE_MATRIX,
  toolDefinitions,
  toolsetFor,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { mcpDbStore } from "./db-store.js";

const OPERATOR = "e2e-conformance-operator-0123456789";
const TOKENS = {
  probe: "tok-probe-0123456789abcdefghijklmnop",
  ended: "tok-ended-0123456789abcdefghijklmnop",
  builder: "tok-build-0123456789abcdefghijklmnop",
  posing: "tok-posin-0123456789abcdefghijklmnop",
} as const;
const HASH = "0".repeat(64);

const CallResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
});

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
const clients: Client[] = [];

const hashOf = async (role: string, allowlist: readonly string[]) => {
  const tools = toolsetFor(role, allowlist);
  if (!tools.ok) throw new Error(tools.error.message);
  return hashToolset(toolDefinitions(tools.value));
};

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 8));
  const builderAllowlist = [...ROLE_MATRIX.builder, CONFORMANCE_ECHO_TOOL];
  const probe = async (id: string, token: string, expires_at: number) => ({
    id,
    token_hash: await sha256Hex(token),
    toolset_hash: await hashOf("conformance", [CONFORMANCE_ECHO_TOOL]),
    runner_id: SPINE_SEED.runnerId,
    executor_id: SPINE_SEED.executorId,
    created_at: 0,
    expires_at,
  });
  unwrap(
    await seedRows(spine.db, {
      profiles: [
        {
          id: "P-ECHO",
          name: "P-ECHO",
          runner_id: SPINE_SEED.runnerId,
          model_tier: "standard",
          tool_allowlist_json: JSON.stringify(builderAllowlist),
          version: 1,
          hash: HASH,
          created_at: 0,
        },
      ],
      agents: [
        {
          id: "A-ECHO",
          name: "echo-builder",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          profile_id: "P-ECHO",
          created_at: 0,
        },
      ],
      sessions: [
        {
          ...newSessionInput(),
          id: "S-BUILD",
          agent_id: "A-ECHO",
          role: "builder",
          state: "idle",
          mcp_token_hash: await sha256Hex(TOKENS.builder),
          toolset_hash: await hashOf("builder", builderAllowlist),
          created_at: 0,
        },
        {
          ...newSessionInput(),
          id: "S-POSING",
          agent_id: "A-ECHO",
          role: "conformance",
          state: "idle",
          mcp_token_hash: await sha256Hex(TOKENS.posing),
          toolset_hash: await hashOf("conformance", [CONFORMANCE_ECHO_TOOL]),
          created_at: 0,
        },
      ],
      conformance_probes: [
        await probe("PROBE-LIVE", TOKENS.probe, Date.now() + 600_000),
        await probe("PROBE-ENDED", TOKENS.ended, 1),
      ],
    }),
  );
  // The API's own connection on real time: probe expiry is read against its clock.
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: OPERATOR, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false,
    mcp: { store: mcpDbStore(apiDb) },
  });
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await api.close();
  unwrap(await apiDb.close());
  spine.cleanup();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "conformance-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(api.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

const echo = async (client: Client, nonce: string) =>
  CallResult.parse(
    await client.callTool({
      name: CONFORMANCE_ECHO_TOOL,
      arguments: { nonce },
    }),
  );

test("a live probe token lists conformance_echo alone, and each call is an audit row naming its nonce", async () => {
  const client = await connect(TOKENS.probe);
  const listed = await client.listTools();
  expect(listed.tools.map((t) => t.name)).toEqual([CONFORMANCE_ECHO_TOOL]);
  const result = await echo(client, "frm-abc123");
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
    nonce: "frm-abc123",
  });
  const rows = unwrap(await listAudit(apiDb)).filter(
    (r) => r.actor === "session:PROBE-LIVE",
  );
  expect(rows).toEqual([
    expect.objectContaining({
      action: `mcp.${CONFORMANCE_ECHO_TOOL}`,
      target_kind: "conformance_nonce",
      target_id: "frm-abc123",
    }),
  ]);
});

test("an ended probe's token is 401", async () => {
  const res = await fetch(api.mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKENS.ended}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(401);
});

test("a builder whose profile names conformance_echo is not served it", async () => {
  const client = await connect(TOKENS.builder);
  const listed = await client.listTools();
  expect(listed.tools.map((t) => t.name)).not.toContain(CONFORMANCE_ECHO_TOOL);
  const result = await echo(client, "frm-builder");
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("actor_not_allowed");
});

test("a session posing as the conformance role is served nothing at all", async () => {
  const client = await connect(TOKENS.posing);
  expect((await client.listTools()).tools).toEqual([]);
  const result = await echo(client, "frm-posing");
  expect(result.isError).toBe(true);
  const nonces = unwrap(await listAudit(apiDb)).map((r) => r.target_id);
  expect(nonces).not.toContain("frm-posing");
  expect(nonces).not.toContain("frm-builder");
});
