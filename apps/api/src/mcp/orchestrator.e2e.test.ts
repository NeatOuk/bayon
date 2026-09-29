// The orchestrator's tools over /mcp against a temp-file DB: ticket_staff through the
// selection rule, pulse_report and probe_run as commands for the caller's own pulse.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeClock, hashToolset, sha256Hex, systemClock } from "@bayon/core";
import { getTicket, listTicketEvents, openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  listAudit,
  listCommands,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { SHIPPED_ALLOWLISTS, toolDefinitions, toolsetFor } from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { TicketService } from "../tickets/ticket-service.js";
import { mcpDbStore } from "./db-store.js";

const OPERATOR = "e2e-orch-operator-token-0123456789";
const TOKENS = {
  orch: "tok-orch-0123456789abcdefghijklmn",
  other: "tok-othr-0123456789abcdefghijklmn",
} as const;
const HASH = "0".repeat(64);
const ALLOWLIST = SHIPPED_ALLOWLISTS.orchestrator;

const CallResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
type CallResult = z.infer<typeof CallResult>;

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
let runtime = "";
const clients: Client[] = [];

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 4));
  runtime = realpathSync(mkdtempSync(join(tmpdir(), "frm-orch-e2e-")));
  const tools = toolsetFor("orchestrator", ALLOWLIST);
  if (!tools.ok) throw new Error(tools.error.message);
  const toolsetHash = await hashToolset(toolDefinitions(tools.value));
  const orchestrator = async (id: string, agent: string, token: string) => ({
    ...newSessionInput(),
    id,
    agent_id: agent,
    role: "orchestrator",
    state: "running" as const,
    mcp_token_hash: await sha256Hex(token),
    toolset_hash: toolsetHash,
    created_at: 0,
  });
  const agent = (
    id: string,
    kind: "builder" | "orchestrator",
    created_at: number,
  ) => ({
    id,
    name: id,
    kind,
    runner_id: SPINE_SEED.runnerId,
    executor_id: SPINE_SEED.executorId,
    profile_id: "P-O",
    created_at,
  });
  unwrap(
    await seedRows(spine.db, {
      profiles: [
        {
          id: "P-O",
          name: "P-O",
          runner_id: SPINE_SEED.runnerId,
          model_tier: "standard",
          tool_allowlist_json: JSON.stringify(ALLOWLIST),
          version: 1,
          hash: HASH,
          created_at: 0,
        },
      ],
      agents: [
        agent("A-O", "orchestrator", 0),
        agent("A-O2", "orchestrator", 0),
        agent("B-1", "builder", 1),
        agent("B-2", "builder", 2),
      ],
      tickets: [
        ticketRow(1, { status: "prioritized" }),
        ticketRow(2, { status: "building", complexity_tier: "complex" }),
        ticketRow(3),
        ticketRow(4, { status: "prioritized" }),
      ],
      sessions: [
        await orchestrator("S-O", "A-O", TOKENS.orch),
        await orchestrator("S-O2", "A-O2", TOKENS.other),
      ],
      handoffs: [
        {
          id: "H-1",
          ticket_id: "ticket-2",
          reason: "turn_ceiling",
          facts_json: "{}",
          packet_path: "/tmp/handoff-1.md",
          packet_hash: HASH,
          quality: "full",
          created_at: 5,
        },
        {
          id: "H-2",
          ticket_id: "ticket-2",
          reason: "turn_ceiling",
          facts_json: "{}",
          packet_path: "/tmp/handoff-2.md",
          packet_hash: HASH,
          quality: "writing", // still being written: not pending
          created_at: 6,
        },
      ],
      probes: [
        { name: "p_on", kind: "sql", spec_json: '{"query":"q"}', enabled: 1 },
        { name: "p_off", kind: "sql", spec_json: '{"query":"q"}', enabled: 0 },
      ],
      pulses: [
        {
          id: "P-1",
          agent_id: "A-O",
          trigger: "manual",
          scheduled_at: 0,
          state: "running",
          lease_token: "L-1",
          lease_expires_at: Number.MAX_SAFE_INTEGER,
          session_id: "S-O",
          started_at: 0,
        },
      ],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: OPERATOR, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    runtimeDir: runtime,
    logger: false,
    tickets: new TicketService({
      db: apiDb,
      clock: systemClock,
      workRoot: join(runtime, "work"),
    }),
    mcp: { store: mcpDbStore(apiDb), limits: { rateCalls: 10_000 } },
  });
});

afterAll(async () => {
  for (const client of clients) await client.close();
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
  if (runtime !== "") rmSync(runtime, { recursive: true, force: true });
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(api.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> =>
  CallResult.parse(await client.callTool({ name, arguments: args }));
const dataOf = (r: CallResult) =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(r.content[0]?.text ?? ""));
const refusedAs = (reason: string, rule?: string) => ({
  isError: true,
  structuredContent: {
    refused: true,
    reason,
    ...(rule === undefined ? {} : { rule }),
  },
});
const commandsOf = async (type: string) =>
  unwrap(await listCommands(spine.db))
    .filter((c) => c.type === type)
    .map((c) => ({ id: c.id, payload: JSON.parse(c.payload_json) as unknown }));

describe("ticket_staff (M2 amendment h)", () => {
  test("the orchestrator is served its shipped allowlist, ticket_staff, pulse_report and probe_run among it", async () => {
    const { tools } = await (await connect(TOKENS.orch)).listTools();
    const served = toolsetFor("orchestrator", ALLOWLIST);
    if (!served.ok) throw new Error(served.error.message);
    expect(tools.map((t) => t.name)).toEqual(served.value.map((t) => t.wire));
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["ticket_staff", "pulse_report", "probe_run"]),
    );
  });

  test("a prioritized ticket moves to staffed with one queued spawn; asking again changes nothing", async () => {
    const client = await connect(TOKENS.orch);
    const first = await call(client, "ticket_staff", {
      ticket: "1",
      role: "builder",
    });
    expect(first.isError).toBeFalsy();
    expect(dataOf(first)).toMatchObject({
      created: true,
      agent_id: "B-1", // the oldest free builder: agent-fixture is busy, B-1 older than B-2
      run_class: "spike",
      handoff_id: null,
      ticket_status: "staffed",
    });
    // Every form a prompt shows names the same ticket: #n, the key, the id.
    for (const ticket of ["1", "#1", "FRM-1", "ticket-1"]) {
      const again = dataOf(
        await call(client, "ticket_staff", { ticket, role: "builder" }),
      );
      expect(again, ticket).toMatchObject({
        created: false,
        command_id: dataOf(first).command_id,
        session_id: dataOf(first).session_id,
      });
    }
    const spawns = (await commandsOf("session.spawn")).filter(
      (c) => (c.payload as { ticket_id?: string }).ticket_id === "ticket-1",
    );
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.payload).toMatchObject({
      agent_id: "B-1",
      role: "builder",
      run_class: "spike",
      ticket_id: "ticket-1",
    });
    expect(unwrap(await getTicket(spine.db, "ticket-1"))).toMatchObject({
      status: "staffed",
      version: 2,
    });
    const moves = unwrap(
      await listTicketEvents(spine.db, {
        ticket_id: "ticket-1",
        since: 0,
        limit: 10,
      }),
    ).rows.filter((e) => e.kind === "transition");
    expect(moves).toEqual([
      expect.objectContaining({
        from_status: "prioritized",
        to_status: "staffed",
        actor_kind: "session",
        actor_id: "S-O",
      }),
    ]);
    const audit = unwrap(await listAudit(spine.db)).filter(
      (a) => a.action === "mcp.ticket_staff" && a.target_id === "ticket-1",
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.actor).toBe("session:S-O");
  });

  test("a pending hand-off rides along as handoff_id; a complex build takes build_complex", async () => {
    const r = await call(await connect(TOKENS.orch), "ticket_staff", {
      ticket: "2",
      role: "builder",
    });
    expect(dataOf(r)).toMatchObject({
      agent_id: "B-2",
      run_class: "build_complex",
      handoff_id: "H-1", // H-2 is still being written
      ticket_status: "building",
    });
    const spawn = (await commandsOf("session.spawn")).find(
      (c) => (c.payload as { ticket_id?: string }).ticket_id === "ticket-2",
    );
    expect(spawn?.payload).toMatchObject({ handoff_id: "H-1" });
  });

  test("refusals are structured, never thrown: not_staffable, no_agent, over_budget, not_found", async () => {
    const client = await connect(TOKENS.orch);
    expect(
      await call(client, "ticket_staff", { ticket: "3", role: "builder" }),
    ).toMatchObject(refusedAs("not_staffable", "staff"));
    // B-1 and B-2 each hold a queued spawn; agent-fixture has a live session.
    expect(
      await call(client, "ticket_staff", { ticket: "4", role: "builder" }),
    ).toMatchObject(refusedAs("no_agent", "staff"));
    const cap = (usd: number | null) =>
      fetch(`${api.url}/settings/budget`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${OPERATOR}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ daily_cap_usd: usd }),
      });
    expect((await cap(0)).status).toBe(200);
    expect(
      await call(client, "ticket_staff", { ticket: "4", role: "builder" }),
    ).toMatchObject(refusedAs("over_budget", "staff"));
    expect((await cap(null)).status).toBe(200);
    for (const ticket of ["99", "#99", "FRM-99", "BAY-1", "nope"]) {
      expect(
        await call(client, "ticket_staff", { ticket, role: "builder" }),
        ticket,
      ).toMatchObject({
        ...refusedAs("not_found"),
        structuredContent: {
          detail: expect.stringContaining(
            "its id (ULID), its key (e.g. FRM-1), #<number> or <number>",
          ),
        },
      });
    }
    expect(unwrap(await getTicket(spine.db, "ticket-4")).status).toBe(
      "prioritized",
    );
    expect(
      unwrap(await listAudit(spine.db)).filter(
        (a) =>
          a.action === "mcp.ticket_staff" &&
          a.payload_json?.includes("refused:not_staffable") === true,
      ),
    ).toHaveLength(1);
  });
});

// the orchestrator may name one of the ticket's project's agents; another is no_agent.
describe("ticket_staff with a named agent", () => {
  test("a named agent of the ticket's project takes it over an older one; one with no project is refused", async () => {
    const builder = (id: string, created_at: number) => ({
      id,
      name: id,
      kind: "builder" as const,
      runner_id: SPINE_SEED.runnerId,
      executor_id: SPINE_SEED.executorId,
      workspace_id: "P-O",
      created_at,
    });
    unwrap(
      await seedRows(spine.db, {
        workspaces: [{ id: "P-O", name: "P-O", kind: "single" }],
        agents: [builder("O-1", 10), builder("O-2", 11)],
        tickets: [
          ticketRow(6, { status: "prioritized", workspace_id: "P-O" }),
          ticketRow(7, { status: "prioritized", workspace_id: "P-O" }),
        ],
      }),
    );
    const client = await connect(TOKENS.orch);
    const args = { ticket: "6", role: "builder", agent: "O-2" };
    const first = await call(client, "ticket_staff", args);
    expect(first.isError).toBeFalsy();
    expect(dataOf(first)).toMatchObject({ created: true, agent_id: "O-2" });
    // The same ask again is the same command (the key carries the agent).
    expect(dataOf(await call(client, "ticket_staff", args))).toMatchObject({
      created: false,
      command_id: dataOf(first).command_id,
    });
    const spawn = (await commandsOf("session.spawn")).find(
      (c) => (c.payload as { ticket_id?: string }).ticket_id === "ticket-6",
    );
    expect(spawn?.payload).toMatchObject({
      agent_id: "O-2",
      workspace_id: "P-O",
    });
    const refused = await call(client, "ticket_staff", {
      ticket: "7",
      role: "builder",
      agent: "B-1",
    });
    expect(refused).toMatchObject({
      ...refusedAs("no_agent", "staff"),
      structuredContent: {
        detail:
          "agent B-1 has no project, and ticket #7's project P-O has builder agents of its own",
      },
    });
    expect(unwrap(await getTicket(spine.db, "ticket-7")).status).toBe(
      "prioritized",
    );
  });
});

describe("pulse_report and probe_run: commands for the caller's own pulse", () => {
  test("pulse_report inserts pulse.report for the caller's live pulse, before it replies", async () => {
    const r = await call(await connect(TOKENS.orch), "pulse_report", {
      summary_md: "Staffed #1 and #2.",
      actions: ["staffed #1 as builder", "staffed #2 as builder"],
    });
    expect(dataOf(r)).toMatchObject({ pulse_id: "P-1" });
    expect(await commandsOf("pulse.report")).toEqual([
      {
        id: dataOf(r).command_id,
        payload: {
          pulse_id: "P-1",
          session_id: "S-O",
          summary_md: "Staffed #1 and #2.",
          actions: ["staffed #1 as builder", "staffed #2 as builder"],
        },
      },
    ]);
  });

  test("a session that runs no pulse cannot report someone else's", async () => {
    const other = await connect(TOKENS.other);
    expect(
      await call(other, "pulse_report", { summary_md: "x", actions: [] }),
    ).toMatchObject(refusedAs("not_found"));
    expect(await call(other, "probe_run", { probe: "p_on" })).toMatchObject(
      refusedAs("not_found"),
    );
    expect(await commandsOf("pulse.report")).toHaveLength(1);
  });

  test("probe_run inserts probe.run for an enabled probe; an unknown or disabled one is refused", async () => {
    const client = await connect(TOKENS.orch);
    const r = await call(client, "probe_run", { probe: "p_on" });
    expect(dataOf(r)).toMatchObject({ pulse_id: "P-1", probe: "p_on" });
    for (const probe of ["p_off", "nope"]) {
      expect(await call(client, "probe_run", { probe })).toMatchObject(
        refusedAs("not_found"),
      );
    }
    expect(await commandsOf("probe.run")).toEqual([
      { id: dataOf(r).command_id, payload: { pulse_id: "P-1", probe: "p_on" } },
    ]);
  });
});
