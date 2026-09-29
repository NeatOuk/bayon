// The FRM-82 loop, replayed over /mcp and REST against a temp-file DB. A builder asks the
// operator two questions and hands off. A pulse then has nothing to do, and its ticket_staff is
// refused `awaiting_human`: no session.spawn. The first answer changes nothing the pulse can see;
// the second clears needs_human, is the one completion that wakes the orchestrator, and the next
// pulse staffs the successor once. What that successor is told comes back oldest first, with both
// answers. The operator's own staffing over an open question goes ahead, audited.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeClock, hashToolset, sha256Hex, systemClock } from "@bayon/core";
import {
  completionsSince,
  getTicket,
  hasPulseWork,
  listTicketQuestions,
  openDb,
  type Db,
  type PulseScope,
} from "@bayon/db";
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
  updateRowForTest,
  type TempDb,
} from "@bayon/db/testing";
import {
  InboxItem,
  InboxPage,
  ROLE_MATRIX,
  StaffAccepted,
  TicketDetail,
  TicketsPage,
  toolDefinitions,
  toolsetFor,
  type McpRole,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { dbStore } from "../db-store.js";
import { mcpDbStore } from "../mcp/db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { TicketService } from "./ticket-service.js";

const TOKEN = "e2e-awaiting-human-operator-0123456789";
const TOKENS = {
  builder: "tok-awaiting-builder-0123456789abcdef",
  pulse1: "tok-awaiting-pulse1-0123456789abcdefg",
  pulse2: "tok-awaiting-pulse2-0123456789abcdefg",
} as const;
const HASH = "0".repeat(64);
const SHOP: PulseScope = { workspaceId: "shop", agentName: "shop-orch" };

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
/** Before anything was asked: where a completions poll that has seen nothing resumes. */
let start = 0;

const profile = (id: string, role: McpRole) => ({
  id,
  name: id,
  runner_id: SPINE_SEED.runnerId,
  model_tier: "standard",
  tool_allowlist_json: JSON.stringify([...ROLE_MATRIX[role]]),
  version: 1,
  hash: HASH,
  created_at: 0,
});
const agent = (
  id: string,
  kind: "builder" | "orchestrator",
  profile_id: string,
) => ({
  id,
  name: id,
  kind,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  profile_id,
  workspace_id: "shop",
  // Room for both tickets' builders: the second test's staffing is the override, not a slot fight.
  max_concurrency: 3,
  created_at: 1,
});

async function session(
  id: string,
  role: McpRole,
  agent_id: string,
  token: string,
  ticket_id?: string,
) {
  const tools = toolsetFor(role, [...ROLE_MATRIX[role]]);
  if (!tools.ok) throw new Error(tools.error.message);
  return {
    ...newSessionInput(),
    id,
    agent_id,
    role,
    state: "running" as const,
    workspace_id: "shop",
    ...(ticket_id === undefined ? {} : { ticket_id }),
    mcp_token_hash: await sha256Hex(token),
    toolset_hash: await hashToolset(toolDefinitions(tools.value)),
    last_event_at: Date.now(),
    created_at: 0,
  };
}

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 4));
  runtime = realpathSync(mkdtempSync(join(tmpdir(), "frm-awaiting-e2e-")));
  unwrap(
    await seedRows(spine.db, {
      workspaces: [{ id: "shop", name: "shop", kind: "single" }],
      profiles: [profile("P-O", "orchestrator"), profile("P-B", "builder")],
      agents: [
        agent("shop-orch", "orchestrator", "P-O"),
        agent("shop-builder", "builder", "P-B"),
      ],
      tickets: [
        ticketRow(1, { status: "building", workspace_id: "shop" }),
        // Backlog, so it is nobody's pulse work until the second test prioritizes it.
        ticketRow(2, { status: "backlog", workspace_id: "shop" }),
      ],
      sessions: [
        await session(
          "S-B",
          "builder",
          "shop-builder",
          TOKENS.builder,
          "ticket-1",
        ),
        await session("S-O1", "orchestrator", "shop-orch", TOKENS.pulse1),
        await session("S-O2", "orchestrator", "shop-orch", TOKENS.pulse2),
      ],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
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
  start = Date.now() - 1;
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
  if (runtime !== "") rmSync(runtime, { recursive: true, force: true });
});

const http = (method: string, path: string, body?: unknown) =>
  fetch(`${api.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function call(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const c = new Client({ name: "e2e", version: "1.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(api.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(c);
  return CallResult.parse(await c.callTool({ name, arguments: args }));
}
const dataOf = (r: CallResult) =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(r.content[0]?.text ?? ""));

const ticket1 = async () => unwrap(await getTicket(spine.db, "ticket-1"));
const spawnsFor = async (ticketId: string) =>
  unwrap(await listCommands(spine.db)).filter(
    (c) => c.type === "session.spawn" && c.payload_json.includes(ticketId),
  );
const wakes = async () =>
  unwrap(
    await completionsSince(spine.db, { at: start, ref: "" }, [
      "human_answered",
    ]),
  ).filter((c) => c.workspace_id === "shop");
const pulseWork = async () =>
  unwrap(await hasPulseWork(spine.db, Date.now() + 1, SHOP));
const answer = (id: string, text: string) =>
  http("POST", `/inbox/${id}/answer`, { answer: text });
const staffBy = (token: string, num: number) =>
  call(token, "ticket_staff", { ticket: String(num), role: "builder" });

test("the loop shape: asked and handed off, the pulse staffs nobody; the last answer wakes it once and it staffs once", async () => {
  // 1. The builder asks two decisions only the operator can make. It is not blocked; the ticket is.
  const asked = dataOf(
    await call(TOKENS.builder, "human_ask", {
      questions: [
        {
          question: "Keep the ticket blocked until the log check is confirmed?",
          options: ["keep it blocked", "proceed"],
        },
        {
          question: "Is the version gate raised with 7 clean days?",
          options: ["yes", "no"],
        },
      ],
    }),
  );
  const [q1, q2] = z.array(z.string()).length(2).parse(asked["request_ids"]);
  expect(await ticket1()).toMatchObject({ needs_human: 1 });

  // 2. It hands off: its session ends, and its packet waits for a successor.
  unwrap(
    await updateRowForTest(spine.db, "sessions", "S-B", {
      state: "handed_off",
      exit_reason: "ok",
      ended_at: Date.now(),
    }),
  );
  unwrap(
    await seedRows(spine.db, {
      handoffs: [
        {
          id: "H-1",
          ticket_id: "ticket-1",
          from_session_id: "S-B",
          reason: "agent_request",
          facts_json: "{}",
          packet_path: ".foreman/handoff-1.md",
          packet_hash: HASH,
          quality: "full",
          created_at: Date.now(),
        },
      ],
    }),
  );

  // 3. A pulse: nothing to do ($0, skipped), and staffing is refused anyway. No command row.
  expect(await pulseWork()).toBe(false);
  const refused = await staffBy(TOKENS.pulse1, 1);
  expect(refused).toMatchObject({
    isError: true,
    structuredContent: {
      refused: true,
      reason: "awaiting_human",
      rule: "staff",
    },
  });
  expect(await spawnsFor("ticket-1")).toEqual([]);
  expect(unwrap(await listAudit(spine.db))).toContainEqual(
    expect.objectContaining({
      actor: "session:S-O1",
      action: "mcp.ticket_staff",
      payload_json: expect.stringContaining("refused:awaiting_human"),
    }),
  );
  // Re-asking the same question returns the open request instead of a third one.
  const reasked = dataOf(
    await call(TOKENS.pulse1, "human_ask", {
      ticket: "1",
      questions: [
        {
          question: "keep the ticket blocked until the log check is confirmed",
          options: ["keep it blocked", "proceed"],
        },
      ],
    }),
  );
  expect(reasked).toMatchObject({ request_ids: [q1], already_open: [q1] });

  // 4. The first answer: still waiting, nobody woken.
  expect(
    (
      await answer(
        q1 ?? "",
        "Keep ticket blocked until the log check is confirmed",
      )
    ).status,
  ).toBe(200);
  expect(await ticket1()).toMatchObject({ needs_human: 1 });
  expect(await wakes()).toEqual([]);
  expect(await pulseWork()).toBe(false);

  // 5. The last answer: needs_human clears, and exactly one completion wakes the orchestrator.
  expect(
    (await answer(q2 ?? "", "Already confirmed: proceed now")).status,
  ).toBe(200);
  expect(await ticket1()).toMatchObject({ needs_human: 0 });
  expect((await wakes()).map((c) => c.ref)).toEqual([q2]);
  expect(await pulseWork()).toBe(true);

  // 6. The woken pulse staffs the successor, once.
  const staffed = await staffBy(TOKENS.pulse2, 1);
  expect(staffed.isError).not.toBe(true);
  expect(StaffAccepted.partial().parse(dataOf(staffed))).toMatchObject({
    handoff_id: "H-1",
    created: true,
  });
  // Asked again, the same pulse gets the same spawn back: one successor, however often it asks.
  expect(dataOf(await staffBy(TOKENS.pulse2, 1))).toMatchObject({
    created: false,
  });
  expect(await spawnsFor("ticket-1")).toHaveLength(1);

  // 7. What the successor is told: every question, oldest first, each with its answer and time.
  const told = unwrap(await listTicketQuestions(spine.db, "ticket-1"));
  expect(told.map((q) => [q.id, q.status, q.answer])).toEqual([
    [q1, "answered", "Keep ticket blocked until the log check is confirmed"],
    [q2, "answered", "Already confirmed: proceed now"],
  ]);
  const [first, second] = told;
  expect(first?.answered_at).toBeLessThan(second?.answered_at ?? 0);
});

test("the operator staffs over an open question, audited; GET /inbox?ticket= lists that ticket's alone", async () => {
  unwrap(
    await seedRows(spine.db, {
      sessions: [
        await session(
          "S-B2",
          "builder",
          "shop-builder",
          "tok-awaiting-b2-0123456789abcdefgh",
          "ticket-2",
        ),
      ],
    }),
  );
  const asked = dataOf(
    await call("tok-awaiting-b2-0123456789abcdefgh", "human_ask", {
      questions: [{ question: "Which store?", options: ["sqlite", "pg"] }],
    }),
  );
  const [q] = z.array(z.string()).length(1).parse(asked["request_ids"]);
  unwrap(
    await updateRowForTest(spine.db, "sessions", "S-B2", {
      state: "exited",
      exit_reason: "ok",
      ended_at: Date.now(),
    }),
  );

  const listed = InboxPage.parse(
    await (await http("GET", "/inbox?status=open&ticket=2")).json(),
  );
  expect(listed.items.map((i) => i.id)).toEqual([q]);
  expect(
    InboxPage.parse(
      await (await http("GET", "/inbox?ticket=1")).json(),
    ).items.every((i) => i.ticket?.num === 1),
  ).toBe(true);
  expect((await http("GET", "/inbox?ticket=zero")).status).toBe(400);

  const etag = (r: Response) =>
    Number(r.headers.get("etag")?.replaceAll('"', "") ?? "0");
  const prioritized = await fetch(`${api.url}/tickets/2/transition`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "if-match": `"${etag(await http("GET", "/tickets/2"))}"`,
    },
    body: JSON.stringify({ to: "prioritized" }),
  });
  expect(prioritized.status).toBe(200);
  const res = await http("POST", "/tickets/2/staff", { role: "builder" });
  expect(res.status).toBe(202);
  const accepted = StaffAccepted.parse(await res.json());
  const override = unwrap(await listAudit(spine.db)).filter(
    (a) => a.action === "ticket.staff_override",
  );
  expect(override).toEqual([
    expect.objectContaining({
      actor: "operator",
      target_id: "ticket-2",
      payload_json: JSON.stringify({
        reason: "awaiting_human",
        request_ids: [q],
        role: "builder",
        command_id: accepted.command_id,
      }),
    }),
  ]);
  // The operator cannot clear the flag while the question is open: the refusal says where to answer.
  const version = etag(await http("GET", "/tickets/2"));
  const cleared = await fetch(`${api.url}/tickets/2`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "if-match": `"${version}"`,
    },
    body: JSON.stringify({ needs_human: false }),
  });
  expect(cleared.status).toBe(422);
  expect(await cleared.json()).toMatchObject({
    error: { reason: "questions_open", rule: "patch" },
  });
});

test("a supervisor's question shows on the ticket (open_questions) without the flag; the operator dismisses it", async () => {
  unwrap(
    await seedRows(spine.db, {
      tickets: [ticketRow(3, { status: "backlog", workspace_id: "shop" })],
      human_requests: [
        {
          id: "R-SPLIT",
          ticket_id: "ticket-3",
          kind: "split",
          question: "Ticket #3 has 5 hand-offs: split it?",
          asked_at: Date.now(),
          dedupe_key: "split:ticket-3:4",
        },
        {
          id: "R-PROPOSAL",
          ticket_id: "ticket-3",
          kind: "staff_approval",
          question: "Staff it?",
          asked_at: Date.now(),
        },
      ],
    }),
  );
  const ticket3 = async () =>
    TicketDetail.parse(await (await http("GET", "/tickets/3")).json()).ticket;
  expect(await ticket3()).toMatchObject({
    needs_human: false,
    open_questions: 1,
  });
  const board = TicketsPage.parse(
    await (await http("GET", "/tickets?needs_human=1")).json(),
  );
  expect(board.items.find((t) => t.num === 3)).toMatchObject({
    open_questions: 1,
  });

  // REST is the operator's: without its token nobody reaches the door.
  const anonymous = await fetch(`${api.url}/inbox/R-SPLIT/dismiss`, {
    method: "POST",
  });
  expect(anonymous.status).toBe(401);
  expect((await http("POST", "/inbox/R-PROPOSAL/dismiss")).status).toBe(400);
  const dismissed = await http("POST", "/inbox/R-SPLIT/dismiss");
  expect(dismissed.status).toBe(200);
  expect(InboxItem.parse(await dismissed.json())).toMatchObject({
    status: "dismissed",
    answer: null,
    answered_by: "operator",
  });
  expect((await http("POST", "/inbox/R-SPLIT/dismiss")).status).toBe(409);
  expect((await http("POST", "/inbox/nope/dismiss")).status).toBe(404);
  expect(unwrap(await listAudit(spine.db))).toContainEqual(
    expect.objectContaining({
      actor: "operator",
      action: "rest.inbox_dismiss",
      target_id: "R-SPLIT",
    }),
  );
  expect(await ticket3()).toMatchObject({ open_questions: 0 });
  const listed = InboxPage.parse(
    await (await http("GET", "/inbox?status=dismissed&ticket=3")).json(),
  );
  expect(listed.items.map((i) => i.id)).toEqual(["R-SPLIT"]);
});
