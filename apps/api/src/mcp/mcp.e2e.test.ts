// /mcp over HTTP against a temp-file DB: the MCP SDK client
// for tool calls, raw fetch for the auth boundaries. The ticket tools wait for an earlier change.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  FakeClock,
  hashToolset,
  parseTruncationMarker,
  sha256Hex,
  systemClock,
} from "@bayon/core";
import {
  getHumanRequest,
  getSession,
  getTicket,
  listInbox,
  listTicketEvents,
  openDb,
  type Db,
} from "@bayon/db";
import {
  SPINE_SEED,
  listAudit,
  newSessionInput,
  seedRows,
  seedSpine,
  setSessionTokenHash,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ROLE_MATRIX,
  SHIPPED_ALLOWLISTS,
  mcpTool,
  toolDefinitions,
  toolsetFor,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { TicketService } from "../tickets/ticket-service.js";
import { mcpDbStore } from "./db-store.js";
import type { McpLimits } from "./limits.js";

const OPERATOR = "e2e-mcp-operator-token-0123456789";
const TOKENS = {
  a: "tok-a-0123456789abcdefghijklmnopq",
  reviewer: "tok-r-0123456789abcdefghijklmnopq",
  ended: "tok-e-0123456789abcdefghijklmnopq",
  drift: "tok-d-0123456789abcdefghijklmnopq",
  nomcp: "tok-n-0123456789abcdefghijklmnopq",
  fresh: "tok-f-0123456789abcdefghijklmnopq",
  orch: "tok-o-0123456789abcdefghijklmnopq",
} as const;
/** The builder's wired tools: a pending one (M2's hand-off tools, until) is never served. */
const BUILDER_ALL = ROLE_MATRIX.builder.filter(
  (wire) => mcpTool(wire)?.pending !== true,
);
const MISSION = "m".repeat(300_000);
const HASH = "0".repeat(64);

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
const apis: RunningApi[] = [];
const clients: Client[] = [];

const hashOf = async (role: string, allowlist: readonly string[]) => {
  const tools = toolsetFor(role, allowlist);
  if (!tools.ok) throw new Error(tools.error.message);
  return hashToolset(toolDefinitions(tools.value));
};

async function start(limits?: Partial<McpLimits>): Promise<RunningApi> {
  const started = await startApi({
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
    mcp: {
      store: mcpDbStore(apiDb),
      ...(limits === undefined ? {} : { limits }),
    },
  });
  apis.push(started);
  return started;
}

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 3));
  runtime = realpathSync(mkdtempSync(join(tmpdir(), "frm-mcp-e2e-")));
  const session = async (
    id: string,
    agent_id: string,
    role: string,
    token: string,
    toolset_hash: string,
    state: "idle" | "exited" = "idle",
  ) => ({
    ...newSessionInput(),
    id,
    agent_id,
    role,
    state,
    mcp_token_hash: await sha256Hex(token),
    toolset_hash,
    // S-A works ticket 1; ticket 2 is someone else's (design test 5).
    ticket_id: id === "S-A" ? "ticket-1" : null,
    created_at: 0,
  });
  const profile = (id: string, allowlist: readonly string[]) => ({
    id,
    name: id,
    runner_id: SPINE_SEED.runnerId,
    model_tier: "standard",
    tool_allowlist_json: JSON.stringify(allowlist),
    version: 1,
    hash: HASH,
    created_at: 0,
  });
  const agent = (
    id: string,
    name: string,
    kind: "builder" | "reviewer" | "orchestrator",
    profile_id: string,
    mission_id: string | null,
  ) => ({
    id,
    name,
    kind,
    runner_id: SPINE_SEED.runnerId,
    executor_id: SPINE_SEED.executorId,
    profile_id,
    mission_id,
    created_at: 0,
  });
  unwrap(
    await seedRows(spine.db, {
      missions: [
        {
          id: "M1",
          agent_name: "mcp-builder",
          version: 1,
          who_md: "who",
          what_md: "what",
          how_md: "how",
          laws_md: "laws",
          rendered_md: MISSION,
          hash: HASH,
          note: "v1",
          created_at: 0,
          created_by: "operator",
        },
      ],
      tickets: [ticketRow(1, { status: "building" }), ticketRow(2)],
      profiles: [
        profile("P-B", BUILDER_ALL),
        profile("P-R", SHIPPED_ALLOWLISTS.reviewer),
        profile("P-O", ROLE_MATRIX.orchestrator),
      ],
      agents: [
        agent("A-B", "mcp-builder", "builder", "P-B", "M1"),
        agent("A-R", "mcp-reviewer", "reviewer", "P-R", null),
        agent("A-O", "mcp-orchestrator", "orchestrator", "P-O", null),
      ],
      sessions: [
        await session(
          "S-A",
          "A-B",
          "builder",
          TOKENS.a,
          await hashOf("builder", BUILDER_ALL),
        ),
        await session(
          "S-R",
          "A-R",
          "reviewer",
          TOKENS.reviewer,
          await hashOf("reviewer", SHIPPED_ALLOWLISTS.reviewer),
        ),
        await session(
          "S-END",
          "A-B",
          "builder",
          TOKENS.ended,
          await hashOf("builder", BUILDER_ALL),
          "exited",
        ),
        await session(
          "S-DRIFT",
          "A-B",
          "builder",
          TOKENS.drift,
          await hashOf("builder", ["ticket_get"]),
        ),
        await session(
          "S-NOMCP",
          "A-B",
          "builder",
          TOKENS.nomcp,
          await hashToolset([]),
        ),
        await session(
          "S-O",
          "A-O",
          "orchestrator",
          TOKENS.orch,
          await hashOf("orchestrator", ROLE_MATRIX.orchestrator),
        ),
      ],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  // Many calls from one session in seconds: the rate has its own instance and test below.
  api = await start({ rateCalls: 10_000 });
});

afterAll(async () => {
  for (const client of clients) await client.close();
  for (const running of apis) await running.close();
  await apiDb?.close();
  spine?.cleanup();
  if (runtime !== "") rmSync(runtime, { recursive: true, force: true });
});

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  },
};

const post = (url: string, authorization?: string): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(INITIALIZE),
  });

async function connect(token: string, url = api.mcpUrl): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallResult> =>
  CallResult.parse(await client.callTool({ name, arguments: args }));
const textOf = (r: CallResult) => r.content[0]?.text ?? "";
const dataOf = (r: CallResult) =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(textOf(r)));
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const lines = (s: string) => s.split("\n").length;
const refusedAs = (reason: string, rule?: string) => ({
  isError: true,
  structuredContent: {
    refused: true,
    reason,
    ...(rule === undefined ? {} : { rule }),
  },
});

describe("the auth boundaries (design §2, §3; test 6)", () => {
  test("a live session's token initializes; every other bearer gets 401 without WWW-Authenticate", async () => {
    expect((await post(api.mcpUrl, `Bearer ${TOKENS.a}`)).status).toBe(200);
    for (const authorization of [
      undefined,
      "Bearer nope",
      `Bearer ${OPERATOR}`,
      "Bearer ${FRM_MCP_TOKEN}",
      `Bearer ${TOKENS.ended}`,
    ]) {
      const res = await post(api.mcpUrl, authorization);
      expect(res.status, String(authorization)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.text()).not.toContain(TOKENS.ended);
    }
  });

  test("a session token is refused at /api/v1", async () => {
    const res = await fetch(`${api.url}/fleet`, {
      headers: { authorization: `Bearer ${TOKENS.a}` },
    });
    expect(res.status).toBe(401);
  });

  test("adopt's re-mint: the old token dies at once, the new one works", async () => {
    unwrap(
      await setSessionTokenHash(
        spine.db,
        "S-NOMCP",
        await sha256Hex(TOKENS.fresh),
      ),
    );
    expect((await post(api.mcpUrl, `Bearer ${TOKENS.nomcp}`)).status).toBe(401);
    expect((await post(api.mcpUrl, `Bearer ${TOKENS.fresh}`)).status).toBe(200);
  });

  test("GET and DELETE /mcp are 405: stateless, no stream and no MCP session", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(api.mcpUrl, {
        method,
        headers: { authorization: `Bearer ${TOKENS.a}` },
      });
      expect(res.status, method).toBe(405);
    }
  });
});

describe("the tool set (design §4; test 8)", () => {
  test("tools/list serves the session's tools, and hashes to its toolset_hash", async () => {
    const { tools } = await (await connect(TOKENS.a)).listTools();
    expect(tools.map((t) => t.name)).toEqual(BUILDER_ALL);
    const served = await hashToolset(
      tools.map((t) => ({
        name: t.name,
        schema: z
          .json()
          .parse({ description: t.description, input: t.inputSchema }),
      })),
    );
    expect(served).toBe(unwrap(await getSession(spine.db, "S-A")).toolset_hash);
    const reviewer = await (await connect(TOKENS.reviewer)).listTools();
    expect(reviewer.tools.map((t) => t.name)).toEqual([
      "ticket_get",
      "ticket_comment",
      "handoff_write",
      "handoff_accept",
      "human_ask",
      "doc_search",
      "doc_get",
    ]);
  });

  test("drift fails closed: nothing is listed and every call is refused by rule toolset_hash", async () => {
    const client = await connect(TOKENS.drift);
    expect((await client.listTools()).tools).toEqual([]);
    expect(
      await call(client, "human_ask", {
        questions: [{ question: "Ship?", options: ["yes", "no"] }],
      }),
    ).toMatchObject(refusedAs("actor_not_allowed", "toolset_hash"));
  });

  test("a tool outside the session's set is refused as actor_not_allowed", async () => {
    const client = await connect(TOKENS.reviewer);
    expect(
      await call(client, "memory_append", {
        kind: "trap",
        title: "t",
        body_md: "b",
      }),
    ).toMatchObject(refusedAs("actor_not_allowed"));
  });

  test("a call that fails its schema is an error, not a refusal", async () => {
    const result = await call(await connect(TOKENS.a), "human_ask", {
      questions: [],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("the non-ticket tools (design §5, §6, §8; tests 7, 10)", () => {
  test("human_ask returns at once with open requests, never touches the session, and is audited; the ticket waits", async () => {
    const before = unwrap(await getSession(spine.db, "S-A"));
    const ticketBefore = unwrap(await getTicket(spine.db, "ticket-1"));
    const result = await call(await connect(TOKENS.a), "human_ask", {
      questions: [
        { question: "Ship it?", options: ["yes", "no"], recommendation: "yes" },
        { question: "Which store?", options: ["sqlite", "pg"] },
      ],
    });
    const data = dataOf(result);
    expect(data).toMatchObject({ status: "open" });
    const ids = z.array(z.string()).length(2).parse(data["request_ids"]);
    expect(data["request_id"]).toBe(ids[0]);
    for (const id of ids) {
      expect(unwrap(await getHumanRequest(spine.db, id))).toMatchObject({
        session_id: "S-A",
        status: "open",
      });
    }
    expect(unwrap(await getSession(spine.db, "S-A"))).toEqual(before);
    expect(unwrap(await listAudit(spine.db))).toContainEqual(
      expect.objectContaining({
        actor: "session:S-A",
        action: "mcp.human_ask",
      }),
    );
    // The session goes on; its ticket waits for the answer: needs_human is raised.
    expect(unwrap(await getTicket(spine.db, "ticket-1"))).toMatchObject({
      needs_human: 1,
      version: ticketBefore.version + 1,
    });
    // The same question, still open, is not asked twice: its request comes back.
    const again = dataOf(
      await call(await connect(TOKENS.a), "human_ask", {
        questions: [{ question: "which store", options: ["sqlite", "pg"] }],
      }),
    );
    expect(again).toMatchObject({
      request_ids: [ids[1]],
      already_open: [ids[1]],
      status: "open",
    });
  });

  test("mailbox: each send is audited; the inbox pages 20 at a time with windowed bodies", async () => {
    const client = await connect(TOKENS.a);
    for (let i = 0; i < 25; i += 1) {
      const sent = await call(client, "mailbox_send", {
        to: "mcp-builder",
        subject: `note ${i}`,
        body_md: `${"b".repeat(3_000)} ${i}`,
      });
      expect(sent.isError).not.toBe(true);
    }
    const page1 = await call(client, "mailbox_inbox");
    const first = dataOf(page1);
    const rows = z
      .array(z.record(z.string(), z.unknown()))
      .parse(first["rows"]);
    expect(rows).toHaveLength(20);
    expect(first["next_cursor"]).toBe("20");
    expect(bytes(textOf(page1))).toBeLessThanOrEqual(8 * 1024);
    expect(lines(textOf(page1))).toBeLessThanOrEqual(200);
    const page2 = dataOf(await call(client, "mailbox_inbox", { cursor: "20" }));
    expect(z.array(z.unknown()).parse(page2["rows"])).toHaveLength(5);
    expect(page2["next_cursor"]).toBeNull();
    const audits = unwrap(await listAudit(spine.db)).filter(
      (a) => a.action === "mcp.mailbox_send",
    );
    expect(audits).toHaveLength(25);
  });

  test("mailbox_inbox marks what it returns read: once, only the caller's; unread pages stay whole", async () => {
    const sender = await connect(TOKENS.a);
    const send = async (to: string, subject: string) =>
      expect(
        (await call(sender, "mailbox_send", { to, subject, body_md: "b" }))
          .isError,
      ).not.toBe(true);
    for (let i = 0; i < 23; i += 1) await send("mcp-orchestrator", `n ${i}`);
    await send("mcp-reviewer", "not the orchestrator's");
    const orch = await connect(TOKENS.orch);
    const Rows = z.array(z.object({ id: z.string(), read: z.boolean() }));
    const inbox = async (args: Record<string, unknown>) => {
      const data = dataOf(await call(orch, "mailbox_inbox", args));
      return { rows: Rows.parse(data["rows"]), next: data["next_cursor"] };
    };
    const stored = async (to_id: string) =>
      unwrap(
        await listInbox(spine.db, { to_kind: "agent", to_id, limit: 100 }),
      );

    const page1 = await inbox({ unread_only: true });
    expect(page1.rows).toHaveLength(20);
    expect(page1.rows.every((r) => !r.read)).toBe(true);
    expect(page1.next).toBe("0"); // the 20 just read left the unread list
    const page2 = await inbox({ unread_only: true, cursor: "0" });
    expect(page2).toMatchObject({ next: null });
    expect(page2.rows).toHaveLength(3);
    expect((await inbox({ unread_only: true })).rows).toEqual([]);

    const orchRows = await stored("mcp-orchestrator");
    expect(orchRows).toHaveLength(23);
    expect(orchRows.every((m) => m.read_at !== null)).toBe(true);
    expect((await stored("mcp-reviewer")).map((m) => m.read_at)).toEqual([
      null,
    ]);

    const again = await inbox({});
    expect(again.rows.every((r) => r.read)).toBe(true);
    expect(await stored("mcp-orchestrator")).toEqual(orchRows);
  });

  test("an operator's answer reaches the asking session through ticket_get", async () => {
    const client = await connect(TOKENS.a);
    const asked = dataOf(
      await call(client, "human_ask", {
        questions: [{ question: "Which queue?", options: ["sqs", "redis"] }],
      }),
    );
    const id = z.string().parse(asked["request_id"]);
    const res = await fetch(`${api.url}/inbox/${id}/answer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPERATOR}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ answer: "redis" }),
    });
    expect(res.status).toBe(200);
    const ticket = dataOf(await call(client, "ticket_get", { ticket: "1" }));
    expect(ticket["human_requests"]).toContainEqual(
      expect.objectContaining({
        id,
        status: "answered",
        answer: '"redis"',
        answered_at: expect.any(Number),
      }),
    );
  });

  test("memory: an appended entry is proposed and found by search", async () => {
    const client = await connect(TOKENS.a);
    const appended = await call(client, "memory_append", {
      kind: "trap",
      title: "WAL needs a local disk",
      body_md: "Never put foreman.db on NFS.",
    });
    expect(dataOf(appended)).toMatchObject({ status: "proposed" });
    const found = dataOf(await call(client, "memory_search", { q: "WAL" }));
    expect(found["rows"]).toEqual([
      expect.objectContaining({ title: "WAL needs a local disk" }),
    ]);
  });

  test("mission_read windows a 300 KB mission: 4096 characters and next_offset", async () => {
    const client = await connect(TOKENS.a);
    const head = await call(client, "mission_read");
    const first = dataOf(head);
    expect(first).toMatchObject({
      version: 1,
      total_chars: 300_000,
      offset: 0,
      next_offset: 4096,
    });
    expect(z.string().parse(first["text"])).toHaveLength(4096);
    expect(bytes(textOf(head))).toBeLessThanOrEqual(8 * 1024);
    const tail = dataOf(
      await call(client, "mission_read", { offset: 299_000 }),
    );
    expect(z.string().parse(tail["text"])).toHaveLength(1_000);
    expect(tail["next_offset"]).toBeNull();
  });
});

describe("the backstop and the rate (design §2, §5; test 7)", () => {
  test("over its cap a result goes to logs/tool/ (0600); the agent gets head, marker and tail", async () => {
    const small = await start({ capBytes: 1024, capLines: 40 });
    const result = await call(
      await connect(TOKENS.a, small.mcpUrl),
      "mission_read",
    );
    const text = textOf(result);
    expect(bytes(text)).toBeLessThanOrEqual(1024);
    const marker = parseTruncationMarker(text);
    expect(
      marker?.path.startsWith(join(runtime, "sessions", "S-A", "logs", "tool")),
    ).toBe(true);
    const file = marker?.path ?? "";
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(bytes(readFileSync(file, "utf8"))).toBe(marker?.bytes);
  });

  test("past its window's budget a session gets 429; another session does not", async () => {
    const limited = await start({ rateCalls: 3, rateWindowMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      expect((await post(limited.mcpUrl, `Bearer ${TOKENS.a}`)).status).toBe(
        200,
      );
    }
    expect((await post(limited.mcpUrl, `Bearer ${TOKENS.a}`)).status).toBe(429);
    expect(
      (await post(limited.mcpUrl, `Bearer ${TOKENS.reviewer}`)).status,
    ).toBe(200);
  });
});

describe("the ticket tools, through TicketService (design §7; tests 5, 9)", () => {
  test("ticket_get: the session's ticket, windowed, with its human_ask requests", async () => {
    const data = dataOf(
      await call(await connect(TOKENS.a), "ticket_get", { ticket: "1" }),
    );
    // human_ask above raised needs_human: one write, one version.
    expect(data["ticket"]).toMatchObject({
      id: "ticket-1",
      num: 1,
      status: "building",
      version: 2,
      needs_human: true,
    });
    const asked = z
      .array(z.object({ kind: z.string(), asked_at: z.number() }))
      .parse(data["human_requests"]);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]?.kind).toBe("decision");
  });

  test("a token scoped to session A cannot touch ticket B; the refusals are audited", async () => {
    const client = await connect(TOKENS.a);
    const writes: readonly (readonly [string, Record<string, unknown>])[] = [
      ["ticket_update", { ticket: "2", version: 1, title: "mine now" }],
      ["ticket_comment", { ticket: "2", body_md: "hi" }],
      ["ticket_link", { ticket: "2", to: "1", kind: "relates" }],
    ];
    for (const [name, args] of writes) {
      expect(await call(client, name, args), name).toMatchObject(
        refusedAs("cross_ticket_write"),
      );
    }
    expect(unwrap(await getTicket(spine.db, "ticket-2")).version).toBe(1);
    expect(unwrap(await listAudit(spine.db))).toContainEqual(
      expect.objectContaining({
        action: "mcp.ticket_update",
        payload_json: expect.stringContaining("refused:cross_ticket_write"),
      }),
    );
    // A session without a ticket writes to none.
    expect(
      await call(await connect(TOKENS.reviewer), "ticket_comment", {
        ticket: "1",
        body_md: "hi",
      }),
    ).toMatchObject(refusedAs("cross_ticket_write"));
  });

  test("the laws refuse through the service: no edge, a stale version, an unknown ticket", async () => {
    const client = await connect(TOKENS.a);
    expect(
      await call(client, "ticket_update", {
        ticket: "1",
        version: 2,
        status: "done",
      }),
    ).toMatchObject(refusedAs("illegal_transition", "no_edge"));
    expect(
      await call(client, "ticket_update", {
        ticket: "1",
        version: 7,
        status: "blocked",
        blocked_reason: "CI is down",
        unblock_condition: "CI is up",
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: {
        refused: true,
        reason: "version_conflict",
        current_version: 2,
      },
    });
    expect(await call(client, "ticket_get", { ticket: "999" })).toMatchObject(
      refusedAs("not_found"),
    );
  });

  test("a worker's own writes land, attributed to its session and audited", async () => {
    const client = await connect(TOKENS.a);
    const commented = await call(client, "ticket_comment", {
      ticket: "1",
      body_md: "progress",
    });
    expect(commented.isError).not.toBe(true);
    const blocked = dataOf(
      await call(client, "ticket_update", {
        ticket: "1",
        version: 2,
        status: "blocked",
        blocked_reason: "CI is down",
        unblock_condition: "CI is up",
      }),
    );
    expect(blocked).toMatchObject({ status: "blocked", version: 3 });
    const attached = await call(client, "artifact_attach", {
      kind: "pr",
      ref: "https://example.com/pr/1",
    });
    expect(attached.isError).not.toBe(true);
    const events = unwrap(
      await listTicketEvents(spine.db, {
        ticket_id: "ticket-1",
        since: 0,
        limit: 100,
      }),
    ).rows;
    expect(events).toContainEqual(
      expect.objectContaining({
        actor_kind: "session",
        actor_id: "S-A",
        kind: "comment",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        actor_kind: "session",
        actor_id: "S-A",
        to_status: "blocked",
      }),
    );
    expect(unwrap(await listAudit(spine.db)).map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "mcp.ticket_comment",
        "mcp.ticket_update",
        "mcp.artifact_attach",
      ]),
    );
  });

  test("ticket_create files a backlog ticket that waits for a human; ticket_search finds it", async () => {
    const client = await connect(TOKENS.a);
    const created = dataOf(
      await call(client, "ticket_create", {
        title: "follow-up: flaky CI",
        type: "followup",
      }),
    );
    expect(created).toMatchObject({
      status: "backlog",
      needs_human: true,
      version: 1,
    });
    const found = dataOf(await call(client, "ticket_search", { q: "flaky" }));
    expect(found["rows"]).toEqual([
      expect.objectContaining({ title: "follow-up: flaky CI" }),
    ]);
    // Filed, not owned: the session may not update it.
    expect(
      await call(client, "ticket_update", {
        ticket: String(created["num"]),
        version: 1,
        title: "x",
      }),
    ).toMatchObject(refusedAs("cross_ticket_write"));
  });

  test("ticket_create with a probe fingerprint files once: a repeat returns the same ticket", async () => {
    const finding = {
      title: "log_scan: supervisor relaunch loop",
      type: "bug",
      fingerprint: "0123456789abcdef",
    };
    // Only the orchestrator files findings: a worker may not squat the fingerprint first.
    const builder = await connect(TOKENS.a);
    expect(await call(builder, "ticket_create", finding)).toMatchObject(
      refusedAs("actor_not_allowed"),
    );
    const client = await connect(TOKENS.orch);
    const first = dataOf(await call(client, "ticket_create", finding));
    expect(first).toMatchObject({ status: "backlog", needs_human: true });
    expect(first["duplicate"]).toBeUndefined();
    const again = dataOf(
      await call(client, "ticket_create", { ...finding, title: "reworded" }),
    );
    expect(again).toMatchObject({ id: first["id"], duplicate: true });
    const row = unwrap(await getTicket(apiDb, String(first["id"])));
    expect(row).toMatchObject({
      origin: "probe",
      origin_ref: "S-O",
      origin_fingerprint: "0123456789abcdef",
      needs_human: 1,
      title: "log_scan: supervisor relaunch loop",
    });
  });

  test("every ticket tool takes the forms prompts show: the id, the key, #n and n", async () => {
    const client = await connect(TOKENS.a);
    for (const ticket of ["ticket-1", "FRM-1", "frm-1", "#1", "1"]) {
      const got = dataOf(await call(client, "ticket_get", { ticket }));
      expect(got["ticket"], ticket).toMatchObject({ id: "ticket-1", num: 1 });
    }
    for (const ticket of ["#1", "FRM-1"]) {
      const commented = await call(client, "ticket_comment", {
        ticket,
        body_md: `by ${ticket}`,
      });
      expect(commented.isError, ticket).not.toBe(true);
    }
    expect(
      dataOf(
        await call(client, "ticket_link", {
          ticket: "FRM-1",
          to: "#2",
          kind: "relates",
        }),
      ),
    ).toEqual({ kind: "relates", target_ticket_id: "ticket-2" });
    // Another session's ticket by key is still another session's ticket.
    expect(
      await call(client, "ticket_comment", { ticket: "FRM-2", body_md: "hi" }),
    ).toMatchObject(refusedAs("cross_ticket_write"));
    for (const ticket of ["#999", "FRM-999", "BAY-1", "nope"]) {
      expect(
        await call(client, "ticket_get", { ticket }),
        ticket,
      ).toMatchObject({
        ...refusedAs("not_found"),
        structuredContent: {
          detail: `no ticket ${ticket}; name a ticket by its id (ULID), its key (e.g. FRM-1), #<number> or <number>`,
        },
      });
    }
  });
});

describe("the review fixes: body limit, no pending tools", () => {
  test("a body over 64 KB is refused with 413 before it reaches the MCP server", async () => {
    const res = await fetch(api.mcpUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${TOKENS.a}`,
      },
      body: JSON.stringify({ ...INITIALIZE, padding: "x".repeat(70 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  test("no tool is pending since an earlier change: the orchestrator's whole row is listed, the hand-off tools among it", async () => {
    const client = await connect(TOKENS.orch);
    const { tools } = await client.listTools();
    expect(
      ROLE_MATRIX.orchestrator.filter(
        (wire) => mcpTool(wire)?.pending === true,
      ),
    ).toEqual([]);
    expect(tools.map((t) => t.name)).toEqual(ROLE_MATRIX.orchestrator);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "ticket_staff",
        "handoff_write",
        "handoff_read",
        "handoff_accept",
        "handoff_request",
      ]),
    );
  });
});
