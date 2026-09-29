// An orchestrator with a project over /mcp, against a temp-file DB: every tool that
// names a ticket refuses one in another project, or in none, with `cross_project` — a write's
// refusal audited, nothing else written — ticket_search lists only its project and ticket_create
// files into it. An orchestrator with no project reaches everything, as before.
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
import { ROLE_MATRIX, toolDefinitions, toolsetFor } from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { TicketService } from "../tickets/ticket-service.js";
import { mcpDbStore } from "./db-store.js";

const OPERATOR = "e2e-orch-project-operator-token-012345";
const TOKENS = {
  a: "tok-proj-a-0123456789abcdefghijklm",
  fleet: "tok-fleet-0123456789abcdefghijklm",
} as const;
const HASH = "0".repeat(64);
/** The orchestrator's whole row, so every ticket-naming tool it has is served. */
const ALLOWLIST = [...ROLE_MATRIX.orchestrator];

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

const agent = (
  id: string,
  kind: "builder" | "orchestrator",
  workspace_id: string | null,
) => ({
  id,
  name: id,
  kind,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  profile_id: "P-X",
  workspace_id,
  created_at: 1,
});

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 4));
  runtime = realpathSync(mkdtempSync(join(tmpdir(), "frm-orch-project-e2e-")));
  const tools = toolsetFor("orchestrator", ALLOWLIST);
  if (!tools.ok) throw new Error(tools.error.message);
  const toolsetHash = await hashToolset(toolDefinitions(tools.value));
  const orchestrator = async (id: string, agentId: string, token: string) => ({
    ...newSessionInput(),
    id,
    agent_id: agentId,
    role: "orchestrator",
    state: "running" as const,
    mcp_token_hash: await sha256Hex(token),
    toolset_hash: toolsetHash,
    created_at: 0,
  });
  unwrap(
    await seedRows(spine.db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
      profiles: [
        {
          id: "P-X",
          name: "P-X",
          runner_id: SPINE_SEED.runnerId,
          model_tier: "standard",
          tool_allowlist_json: JSON.stringify(ALLOWLIST),
          version: 1,
          hash: HASH,
          created_at: 0,
        },
      ],
      agents: [
        agent("O-A", "orchestrator", "P-A"),
        agent("O-F", "orchestrator", null),
        agent("BA", "builder", "P-A"),
        agent("BB", "builder", "P-B"),
      ],
      tickets: [
        ticketRow(1, { status: "prioritized", workspace_id: "P-A" }),
        ticketRow(2, { status: "prioritized", workspace_id: "P-B" }),
        ticketRow(3, { status: "prioritized" }),
        ticketRow(4, { workspace_id: "P-A" }),
      ],
      handoffs: [
        {
          id: "H-B",
          ticket_id: "ticket-2",
          reason: "turn_ceiling",
          facts_json: "{}",
          packet_path: "/tmp/handoff-b.md",
          packet_hash: HASH,
          quality: "full",
          created_at: 5,
        },
      ],
      sessions: [
        await orchestrator("S-OA", "O-A", TOKENS.a),
        await orchestrator("S-OF", "O-F", TOKENS.fleet),
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
const crossProject = {
  isError: true,
  structuredContent: { refused: true, reason: "cross_project" },
};
const commands = async () => unwrap(await listCommands(spine.db));
const eventsOf = async (id: string) =>
  unwrap(
    await listTicketEvents(spine.db, { ticket_id: id, since: 0, limit: 50 }),
  ).rows;
/** The `mcp.<tool>` audit rows of S-OA's calls refused cross_project. */
const refusedAudit = async () =>
  unwrap(await listAudit(spine.db))
    .filter(
      (a) =>
        a.actor === "session:S-OA" &&
        a.payload_json?.includes('"outcome":"refused:cross_project"') === true,
    )
    .map((a) => a.action);

const QUESTION = { question: "which way?", options: ["left", "right"] };

describe("an orchestrator with a project", () => {
  test("every tool that names a ticket refuses B's ticket and one with no project: cross_project, a write audited, nothing written", async () => {
    const client = await connect(TOKENS.a);
    const before = await commands();
    // Every form of the ref, B's ticket and the one with no project.
    const refs = ["2", "#2", "FRM-2", "ticket-2", "3", "ticket-3"];
    const writes: [string, (ref: string) => Record<string, unknown>][] = [
      ["ticket_update", (ticket) => ({ ticket, version: 1, title: "moved" })],
      ["ticket_comment", (ticket) => ({ ticket, body_md: "hello" })],
      ["ticket_link", (to) => ({ ticket: "1", to, kind: "relates" })],
      ["ticket_link", (ticket) => ({ ticket, to: "1", kind: "relates" })],
      ["ticket_staff", (ticket) => ({ ticket, role: "builder" })],
      ["human_ask", (ticket) => ({ questions: [QUESTION], ticket })],
      [
        "ticket_create",
        (parent) => ({ title: "child", type: "chore", parent }),
      ],
    ];
    const reads: [string, (ref: string) => Record<string, unknown>][] = [
      ["ticket_get", (ticket) => ({ ticket })],
      ["handoff_read", (ticket) => ({ ticket })],
    ];
    for (const ref of refs) {
      for (const [tool, args] of [...writes, ...reads]) {
        expect(
          await call(client, tool, args(ref)),
          `${tool} ${ref}`,
        ).toMatchObject(crossProject);
      }
    }
    // A hand-off by id is its ticket's: B's packet is refused too.
    expect(await call(client, "handoff_read", { id: "H-B" })).toMatchObject(
      crossProject,
    );
    // The detail names the caller's project, never the other one.
    const detail = (await call(client, "ticket_get", { ticket: "2" }))
      .structuredContent?.detail;
    expect(detail).toBe(
      "that ticket is not in project P-A, the only one this orchestrator works",
    );

    // Nothing was written: no command, no ticket event or move, no human request, no child.
    expect(await commands()).toEqual(before);
    for (const id of ["ticket-2", "ticket-3"]) {
      expect(unwrap(await getTicket(spine.db, id))).toMatchObject({
        status: "prioritized",
        version: 1,
        title: `ticket ${id.slice(-1)}`,
      });
      expect(await eventsOf(id)).toEqual([]);
    }
    expect(await eventsOf("ticket-1")).toEqual([]);
    const tickets = await call(await connect(TOKENS.fleet), "ticket_search", {
      q: "child",
    });
    expect(dataOf(tickets).rows).toEqual([]);

    // Each refused write has its own audit row (§6); a refused read, as always, none.
    const audited = await refusedAudit();
    for (const [tool] of writes) {
      const expected = refs.length * (tool === "ticket_link" ? 2 : 1);
      expect(
        audited.filter((a) => a === `mcp.${tool}`),
        tool,
      ).toHaveLength(expected);
    }
    expect(audited.filter((a) => a === "mcp.ticket_get")).toEqual([]);
    expect(audited.filter((a) => a === "mcp.handoff_read")).toEqual([]);
  });

  test("ticket_search lists only its project's tickets", async () => {
    const r = await call(await connect(TOKENS.a), "ticket_search", {
      q: "ticket",
    });
    expect(
      z.array(z.object({ num: z.number() })).parse(dataOf(r).rows),
    ).toEqual([{ num: 1 }, { num: 4 }]);
  });

  test("ticket_create files into its project, under its own tickets; it staffs its own", async () => {
    const client = await connect(TOKENS.a);
    const filed = dataOf(
      await call(client, "ticket_create", {
        title: "follow-up in A",
        type: "chore",
        parent: "1",
      }),
    );
    expect(unwrap(await getTicket(spine.db, String(filed.id)))).toMatchObject({
      workspace_id: "P-A",
      parent_ticket_id: "ticket-1",
    });
    const staffed = await call(client, "ticket_staff", {
      ticket: "1",
      role: "builder",
    });
    expect(staffed.isError).toBeFalsy();
    expect(dataOf(staffed)).toMatchObject({ created: true, agent_id: "BA" });
  });

  test("a probe fingerprint another project (or none) already filed is refused, not shown", async () => {
    const fleet = await connect(TOKENS.fleet);
    const first = dataOf(
      await call(fleet, "ticket_create", {
        title: "disk nearly full",
        type: "chore",
        fingerprint: "fp-disk",
      }),
    );
    expect(
      unwrap(await getTicket(spine.db, String(first.id))).workspace_id,
    ).toBeNull();
    const again = await call(await connect(TOKENS.a), "ticket_create", {
      title: "disk nearly full",
      type: "chore",
      fingerprint: "fp-disk",
    });
    expect(again).toMatchObject(crossProject);
    expect(JSON.stringify(again)).not.toContain(String(first.id));
  });
});

describe("an orchestrator with no project: the fleet, as before", () => {
  test("it reads, searches, files and staffs across every project and tickets with none", async () => {
    const client = await connect(TOKENS.fleet);
    for (const ticket of ["1", "2", "3"]) {
      expect(
        (await call(client, "ticket_get", { ticket })).isError,
      ).toBeFalsy();
    }
    expect(
      (await call(client, "handoff_read", { id: "H-B" })).isError,
    ).toBeFalsy();
    const found = z
      .array(z.object({ num: z.number() }))
      .parse(dataOf(await call(client, "ticket_search", { q: "ticket" })).rows)
      .map((r) => r.num);
    expect(found).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    const filed = dataOf(
      await call(client, "ticket_create", {
        title: "fleet chore",
        type: "chore",
      }),
    );
    expect(
      unwrap(await getTicket(spine.db, String(filed.id))).workspace_id,
    ).toBeNull();
    const staffed = await call(client, "ticket_staff", {
      ticket: "2",
      role: "builder",
    });
    expect(dataOf(staffed)).toMatchObject({ created: true, agent_id: "BB" });
    const comment = await call(client, "ticket_comment", {
      ticket: "3",
      body_md: "seen",
    });
    expect(comment.isError).toBeFalsy();
  });
});
