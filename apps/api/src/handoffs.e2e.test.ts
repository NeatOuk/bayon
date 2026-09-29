// The hand-off tools over /mcp and the hand-off routes over REST, against a temp-file DB
//: handoff_write on the caller's own writing row only, handoff_accept (idempotent, and
// the claim-if-unowned case), handoff_request as one session.handoff per key, handoff_read; then
// POST /sessions/:id/handoff, GET /handoffs, GET /handoffs/:id and the chain in the ticket detail.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeClock, hashToolset, sha256Hex, systemClock } from "@bayon/core";
import {
  getHandoff,
  getTicket,
  listTicketEvents,
  openDb,
  type Db,
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
  type TempDb,
} from "@bayon/db/testing";
import {
  CommandAccepted,
  HandoffDetail,
  HandoffsPage,
  ROLE_MATRIX,
  SHIPPED_ALLOWLISTS,
  TicketDetail,
  toolDefinitions,
  toolsetFor,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { dbStore } from "./db-store.js";
import { mcpDbStore } from "./mcp/db-store.js";
import { startApi, type RunningApi } from "./server.js";
import { TicketService } from "./tickets/ticket-service.js";

const OPERATOR = "e2e-hand-operator-token-0123456789";
const TOKENS = {
  next: "tok-next-0123456789abcdefghijklmn",
  rev: "tok-revw-0123456789abcdefghijklmn",
  writing: "tok-writ-0123456789abcdefghijklmn",
  first: "tok-frst-0123456789abcdefghijklmn",
  other: "tok-othr-0123456789abcdefghijklmn",
  free: "tok-free-0123456789abcdefghijklmn",
} as const;
const HASH = "0".repeat(64);
const FACTS = JSON.stringify({
  v: 1,
  ticket: { id: "ticket-1", key: "T-1", status: "building" },
  session: { id: "S-OLD", role: "builder", run_class: "build" },
  repos: [],
  commands: [],
  gates: [],
  findings_open: 0,
  questions: [],
  spend: { session_usd: 0.5, ticket_usd: 1 },
  counters: {
    turns: 3,
    max_turns: 60,
    tool_calls: 4,
    context_peak_tokens: null,
    context_cap: 0,
  },
  events: { first_id: null, last_id: null },
  gathered_at: 0,
});

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

type Role = "builder" | "reviewer";
interface SessionSeed {
  readonly role: Role;
  readonly state: "running" | "handoff_writing" | "handed_off";
  readonly ticket: string | null;
  readonly token?: string;
  readonly handoff_in_id?: string;
  readonly handoff_out_id?: string;
  /** On a profile with the builder's whole row: handoff_read is in no shipped allowlist. */
  readonly full?: boolean;
}

const handoffRow = (
  id: string,
  ticket_id: string,
  from_session_id: string,
  quality: string,
  created_at: number,
  /** The ticket's hand-off number: the packet label `handoff-<n>`. */
  n = 1,
) => ({
  id,
  ticket_id,
  from_session_id,
  reason: "turn_ceiling",
  facts_json: FACTS,
  quality,
  packet_path: `.foreman/handoff-${n}.md`,
  packet_hash: HASH,
  created_at,
});

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 5));
  runtime = realpathSync(mkdtempSync(join(tmpdir(), "frm-handoff-e2e-")));
  const hashOf = async (role: Role, allowlist: readonly string[]) => {
    const tools = toolsetFor(role, allowlist);
    if (!tools.ok) throw new Error(tools.error.message);
    return hashToolset(toolDefinitions(tools.value));
  };
  const hashes = {
    builder: await hashOf("builder", SHIPPED_ALLOWLISTS.builder),
    reviewer: await hashOf("reviewer", SHIPPED_ALLOWLISTS.reviewer),
    full: await hashOf("builder", ROLE_MATRIX.builder),
  };
  const agentOf = (o: SessionSeed) =>
    o.full === true ? "A-ALL" : o.role === "builder" ? "A-B" : "A-R";
  const session = async (id: string, o: SessionSeed) => ({
    ...newSessionInput(),
    id,
    agent_id: agentOf(o),
    role: o.role,
    state: o.state,
    ticket_id: o.ticket,
    handoff_in_id: o.handoff_in_id ?? null,
    handoff_out_id: o.handoff_out_id ?? null,
    ...(o.token === undefined
      ? {}
      : { mcp_token_hash: await sha256Hex(o.token) }),
    toolset_hash: o.full === true ? hashes.full : hashes[o.role],
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
  const agent = (id: string, kind: Role, profile_id: string) => ({
    id,
    name: id,
    kind,
    runner_id: SPINE_SEED.runnerId,
    executor_id: SPINE_SEED.executorId,
    profile_id,
    created_at: 0,
  });
  unwrap(
    await seedRows(spine.db, {
      profiles: [
        profile("P-B", SHIPPED_ALLOWLISTS.builder),
        profile("P-R", SHIPPED_ALLOWLISTS.reviewer),
        profile("P-ALL", ROLE_MATRIX.builder),
      ],
      agents: [
        agent("A-B", "builder", "P-B"),
        agent("A-R", "reviewer", "P-R"),
        agent("A-ALL", "builder", "P-ALL"),
      ],
      tickets: [
        ticketRow(1, { status: "building" }),
        ticketRow(2, { status: "building" }),
        ticketRow(3, { status: "staffed" }),
        ticketRow(4, { status: "building" }),
        ticketRow(5, { status: "building" }),
      ],
      sessions: [
        // ticket-1: S-OLD handed off (H1) to S-NEXT; S-REV reviews it.
        await session("S-OLD", {
          role: "builder",
          state: "handed_off",
          ticket: "ticket-1",
        }),
        await session("S-NEXT", {
          role: "builder",
          full: true,
          state: "running",
          ticket: "ticket-1",
          token: TOKENS.next,
          handoff_in_id: "H1",
        }),
        await session("S-REV", {
          role: "reviewer",
          state: "running",
          ticket: "ticket-1",
          token: TOKENS.rev,
        }),
        // ticket-2: S-W is writing its hand-off, H-W.
        await session("S-W", {
          role: "builder",
          state: "handoff_writing",
          ticket: "ticket-2",
          token: TOKENS.writing,
          handoff_out_id: "H-W",
        }),
        // ticket-3: staffed, S-FIRST its first session, no hand-off anywhere.
        await session("S-FIRST", {
          role: "builder",
          state: "running",
          ticket: "ticket-3",
          token: TOKENS.first,
        }),
        await session("S-OTHER", {
          role: "builder",
          state: "running",
          ticket: "ticket-4",
          token: TOKENS.other,
        }),
        await session("S-FREE", {
          role: "builder",
          state: "running",
          ticket: null,
          token: TOKENS.free,
        }),
      ],
      handoffs: [
        handoffRow("H1", "ticket-1", "S-OLD", "full", 5),
        handoffRow("H-W", "ticket-2", "S-W", "writing", 6),
        {
          ...handoffRow("H5-1", "ticket-5", "S-OLD", "full", 7),
          to_session_id: "S-OTHER",
          accepted_at: 10,
          goal_line: "First slice.",
        },
        {
          ...handoffRow("H5-2", "ticket-5", "S-OTHER", "degraded", 8, 2),
          facts_json: "{}",
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
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> =>
  CallResult.parse(
    await (await connect(token)).callTool({ name, arguments: args }),
  );
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
const handoffEvents = async (ticket: string) =>
  unwrap(
    await listTicketEvents(spine.db, {
      ticket_id: ticket,
      since: 0,
      limit: 100,
    }),
  )
    .rows.filter((e) => e.kind === "handoff")
    .map((e) => ({
      actor: `${e.actor_kind}:${e.actor_id ?? ""}`,
      payload: JSON.parse(e.payload_json ?? "{}") as unknown,
    }));
const owner = async (ticket: string) =>
  unwrap(await getTicket(spine.db, ticket)).owner_session_id;
const handoffCommands = async (sessionId: string) =>
  unwrap(await listCommands(spine.db))
    .filter((c) => c.type === "session.handoff")
    .map((c) => ({
      id: c.id,
      payload: JSON.parse(c.payload_json) as { session_id?: string },
    }))
    .filter((c) => c.payload.session_id === sessionId);

const WRITE = {
  goal_line: "Make the writer path single.",
  decisions: ["guard in the service", "a unique index, not a lock"],
  traps: [],
  next_steps: ["catch the violation", "fix the fixture", "re-run the tests"],
  pointers: ["plan: docs/spikes/x.md"],
};

describe("the served tools (§8.6)", () => {
  test("a builder is served its 13 tools (M3: finding_resolve; M7.6: the doc tools) and a reviewer its 7, the hand-off tools among them", async () => {
    const listed = async (token: string) =>
      (await (await connect(token)).listTools()).tools.map((t) => t.name);
    const served = toolsetFor("builder", SHIPPED_ALLOWLISTS.builder);
    if (!served.ok) throw new Error(served.error.message);
    expect(await listed(TOKENS.first)).toEqual(served.value.map((t) => t.wire));
    expect(await listed(TOKENS.first)).toHaveLength(13);
    expect(await listed(TOKENS.first)).toEqual(
      expect.arrayContaining([
        "handoff_write",
        "handoff_accept",
        "handoff_request",
      ]),
    );
    expect(await listed(TOKENS.rev)).toHaveLength(7);
    expect(await listed(TOKENS.rev)).toEqual(
      expect.arrayContaining(["handoff_write", "handoff_accept"]),
    );
  });
});

describe("handoff_write: the caller's own writing row, only while it is in handoff_writing", () => {
  test("outside handoff_writing it is refused (not_writable), audited, and no row changes", async () => {
    expect(await call(TOKENS.other, "handoff_write", WRITE)).toMatchObject(
      refusedAs("not_writable", "handoff_write"),
    );
    expect(unwrap(await getHandoff(spine.db, "H-W")).goal_line).toBeNull();
    expect(
      unwrap(await listAudit(spine.db)).filter(
        (a) =>
          a.action === "mcp.handoff_write" &&
          a.payload_json?.includes("refused:not_writable") === true,
      ),
    ).toHaveLength(1);
  });

  test("in handoff_writing it lands on the caller's row as the packet's sections; the owner never moves", async () => {
    const r = await call(TOKENS.writing, "handoff_write", WRITE);
    expect(dataOf(r)).toEqual({ handoff_id: "H-W", ticket_id: "ticket-2" });
    expect(unwrap(await getHandoff(spine.db, "H-W"))).toMatchObject({
      quality: "writing",
      goal_line: "Make the writer path single.",
      decisions_md: "- guard in the service\n- a unique index, not a lock",
      traps_md: null,
      next_steps_md:
        "1. catch the violation\n2. fix the fixture\n3. re-run the tests",
      open_questions_md: null,
      pointers_json: '["plan: docs/spikes/x.md"]',
      accepted_at: null,
    });
    expect(await owner("ticket-2")).toBeNull();
  });

  test("anything but exactly 3 next steps is a bad call, not a refusal", async () => {
    const r = await call(TOKENS.writing, "handoff_write", {
      ...WRITE,
      next_steps: ["a", "b"],
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    // A count, not a length: zod's text alone, no hint.
    expect(r.content[0]?.text).toBe(
      "invalid arguments: ✖ Too small: expected array to have exactly 3 items\n  → at next_steps",
    );
  });

  test("an item over 300 characters is a bad call that keeps its path and says how to fit", async () => {
    const r = await call(TOKENS.writing, "handoff_write", {
      ...WRITE,
      traps: ["t".repeat(301)],
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0]?.text).toBe(
      "invalid arguments: ✖ Too big: expected string to have <=300 characters\n  → at traps[0]\n" +
        "Shorten each item to 300 characters or fewer (goal_line 200). Put longer detail in a file and list its path under pointers.",
    );
  });
});

describe("handoff_accept", () => {
  test("the successor takes its pending hand-off: the owner moves, the status does not, one event", async () => {
    const before = unwrap(await getTicket(spine.db, "ticket-1"));
    const r = await call(TOKENS.next, "handoff_accept", {});
    expect(r.isError).toBeFalsy();
    expect(dataOf(r)).toMatchObject({
      ticket_id: "ticket-1",
      owner_session_id: "S-NEXT",
      handoff_id: "H1",
      created: true,
    });
    expect(unwrap(await getTicket(spine.db, "ticket-1"))).toMatchObject({
      owner_session_id: "S-NEXT",
      status: before.status,
      version: before.version,
    });
    expect(unwrap(await getHandoff(spine.db, "H1")).to_session_id).toBe(
      "S-NEXT",
    );
    expect(await handoffEvents("ticket-1")).toEqual([
      {
        actor: "session:S-NEXT",
        payload: { handoff_id: "H1", step: "accept", from_session_id: "S-OLD" },
      },
    ]);
  });

  test("accepting again is idempotent: the same answer, no second event", async () => {
    const accepted_at = unwrap(await getHandoff(spine.db, "H1")).accepted_at;
    const again = dataOf(
      await call(TOKENS.next, "handoff_accept", { id: "H1" }),
    );
    expect(again).toEqual({
      ticket_id: "ticket-1",
      owner_session_id: "S-NEXT",
      handoff_id: "H1",
      accepted_at,
      created: false,
    });
    expect(await handoffEvents("ticket-1")).toHaveLength(1);
  });

  test("the packet label is the same hand-off: handoff-1 on the caller's ticket is H1", async () => {
    const byId = dataOf(
      await call(TOKENS.next, "handoff_accept", { id: "H1" }),
    );
    expect(
      dataOf(await call(TOKENS.next, "handoff_accept", { id: "handoff-1" })),
    ).toEqual(byId);
    expect(await handoffEvents("ticket-1")).toHaveLength(1);
  });

  test("a label is looked up on the caller's ticket only; a refusal names the call to make", async () => {
    // handoff-2 exists on ticket-5 only: S-OTHER works ticket-4, which has none.
    expect(
      await call(TOKENS.other, "handoff_accept", { id: "handoff-2" }),
    ).toMatchObject({
      ...refusedAs("not_found", "handoff_accept"),
      structuredContent: {
        detail: expect.stringContaining(
          "no hand-off handoff-2 on your ticket; call handoff_accept with no arguments",
        ),
      },
    });
    // S-NEXT was handed H1: naming ticket-5's row gets the exact no-argument call.
    expect(
      await call(TOKENS.next, "handoff_accept", { id: "H5-2" }),
    ).toMatchObject({
      ...refusedAs("actor_not_allowed", "handoff_accept"),
      structuredContent: {
        detail: expect.stringContaining(
          "you were handed H1: call handoff_accept with no arguments",
        ),
      },
    });
    expect(unwrap(await getHandoff(spine.db, "H5-2")).accepted_at).toBeNull();
  });

  test("structured refusals: another ticket's row, a row another session took, a row being written, an unknown id", async () => {
    expect(
      await call(TOKENS.other, "handoff_accept", { id: "H1" }),
    ).toMatchObject(refusedAs("cross_ticket_write", "handoff_accept"));
    expect(
      await call(TOKENS.rev, "handoff_accept", { id: "H1" }),
    ).toMatchObject(refusedAs("not_pending", "handoff_accept"));
    expect(
      await call(TOKENS.writing, "handoff_accept", { id: "H-W" }),
    ).toMatchObject(refusedAs("not_pending", "handoff_accept"));
    expect(
      await call(TOKENS.next, "handoff_accept", { id: "nope" }),
    ).toMatchObject(refusedAs("not_found", "handoff_accept"));
    expect(await owner("ticket-1")).toBe("S-NEXT");
    expect(await owner("ticket-2")).toBeNull();
    expect(unwrap(await getHandoff(spine.db, "H-W")).accepted_at).toBeNull();
  });

  test("with no id a first session claims its unowned staffed ticket; again is a repeat; a reviewer never claims", async () => {
    const first = dataOf(await call(TOKENS.first, "handoff_accept", {}));
    expect(first).toMatchObject({
      ticket_id: "ticket-3",
      owner_session_id: "S-FIRST",
      handoff_id: null,
      created: true,
    });
    expect(unwrap(await getTicket(spine.db, "ticket-3"))).toMatchObject({
      owner_session_id: "S-FIRST",
      status: "staffed",
    });
    expect(
      dataOf(await call(TOKENS.first, "handoff_accept", {})),
    ).toMatchObject({
      created: false,
    });
    expect(await handoffEvents("ticket-3")).toEqual([
      {
        actor: "session:S-FIRST",
        payload: { handoff_id: null, step: "claim" },
      },
    ]);
    expect(await call(TOKENS.rev, "handoff_accept", {})).toMatchObject(
      refusedAs("actor_not_allowed", "handoff_accept"),
    );
  });
});

describe("handoff_request and handoff_read", () => {
  test("handoff_request inserts one session.handoff per session and note; no ticket, nothing to hand off", async () => {
    const r = dataOf(
      await call(TOKENS.first, "handoff_request", { note: "out of depth" }),
    );
    expect(r).toMatchObject({ session_id: "S-FIRST", created: true });
    const again = dataOf(
      await call(TOKENS.first, "handoff_request", { note: "out of depth" }),
    );
    expect(again).toMatchObject({ command_id: r.command_id, created: false });
    expect(await handoffCommands("S-FIRST")).toEqual([
      {
        id: r.command_id,
        payload: {
          session_id: "S-FIRST",
          reason: "agent_request",
          note: "out of depth",
        },
      },
    ]);
    expect(await call(TOKENS.free, "handoff_request", {})).toMatchObject(
      refusedAs("not_found"),
    );
    expect(await handoffCommands("S-FREE")).toEqual([]);
    expect(await owner("ticket-3")).toBe("S-FIRST");
  });

  test("handoff_read: by id, by ticket (its latest) or the caller's own, with the facts rendered", async () => {
    const byId = dataOf(await call(TOKENS.next, "handoff_read", { id: "H1" }));
    expect(byId).toMatchObject({
      id: "H1",
      quality: "full",
      to_session_id: "S-NEXT",
    });
    expect(byId.facts).toEqual(
      expect.stringContaining("ticket: T-1 (building)"),
    );
    expect(dataOf(await call(TOKENS.next, "handoff_read", {}))).toMatchObject({
      id: "H1",
    });
    // A ticket by any form a prompt shows.
    for (const ticket of ["2", "#2", "FRM-2", "ticket-2"]) {
      expect(
        dataOf(await call(TOKENS.next, "handoff_read", { ticket })),
        ticket,
      ).toMatchObject({
        id: "H-W",
        goal_line: "Make the writer path single.",
        pointers: ["plan: docs/spikes/x.md"],
      });
    }
    expect(
      await call(TOKENS.next, "handoff_read", { id: "nope" }),
    ).toMatchObject(refusedAs("not_found"));
    expect(
      await call(TOKENS.next, "handoff_read", { ticket: "3" }),
    ).toMatchObject(refusedAs("not_found"));
    const both = await call(TOKENS.next, "handoff_read", {
      id: "H1",
      ticket: "1",
    });
    expect(both.isError).toBe(true);
    expect(both.structuredContent).toBeUndefined();
  });
});

const rest = (
  path: string,
  o: {
    readonly method?: string;
    readonly body?: unknown;
    readonly key?: string;
  } = {},
) =>
  fetch(`${api.url}${path}`, {
    method: o.method ?? "GET",
    headers: {
      authorization: `Bearer ${OPERATOR}`,
      "content-type": "application/json",
      ...(o.key === undefined ? {} : { "idempotency-key": o.key }),
    },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });

describe("REST (§12.1)", () => {
  test("POST /sessions/:id/handoff inserts session.handoff: operator by default, a reason and note when given", async () => {
    const plain = await rest("/sessions/S-OTHER/handoff", { method: "POST" });
    expect(plain.status).toBe(202);
    const first = CommandAccepted.parse(await plain.json());
    expect(first).toMatchObject({ session_id: "S-OTHER", created: true });
    const keyed = {
      method: "POST",
      body: { reason: "phase_change", note: "to review" },
      key: "k-1",
    };
    const second = CommandAccepted.parse(
      await (await rest("/sessions/S-OTHER/handoff", keyed)).json(),
    );
    const repeat = CommandAccepted.parse(
      await (await rest("/sessions/S-OTHER/handoff", keyed)).json(),
    );
    expect(repeat).toEqual({ ...second, created: false });
    expect((await handoffCommands("S-OTHER")).map((c) => c.payload)).toEqual([
      { session_id: "S-OTHER", reason: "operator" },
      { session_id: "S-OTHER", reason: "phase_change", note: "to review" },
    ]);
    expect(
      (await rest("/sessions/nope/handoff", { method: "POST" })).status,
    ).toBe(404);
    expect(
      (
        await rest("/sessions/S-OTHER/handoff", {
          method: "POST",
          body: { reason: "session_death" },
        })
      ).status,
    ).toBe(400);
  });

  test("GET /handoffs: a ticket's chain oldest first, pending=1 only the takeable ones, a limit", async () => {
    const ids = async (query: string) =>
      HandoffsPage.parse(
        await (await rest(`/handoffs${query}`)).json(),
      ).items.map((h) => h.id);
    expect(await ids("?ticket=5")).toEqual(["H5-1", "H5-2"]);
    expect(await ids("?ticket=5&pending=1")).toEqual(["H5-2"]);
    const pending = await ids("?pending=1");
    expect(pending).toContain("H5-2");
    expect(pending).not.toContain("H-W"); // still being written
    expect(pending).not.toContain("H1"); // accepted
    const one = HandoffsPage.parse(
      await (await rest("/handoffs?limit=1")).json(),
    );
    expect(one).toMatchObject({
      items: [{ id: "H1", ticket_id: "ticket-1" }],
      has_more: true,
    });
    expect((await rest("/handoffs?ticket=999")).status).toBe(404);
    expect((await rest("/handoffs?pending=yes")).status).toBe(400);
  });

  test("GET /handoffs/:id is the whole row: facts parsed, judgement, pointers", async () => {
    const detail = HandoffDetail.parse(
      await (await rest("/handoffs/H-W")).json(),
    );
    expect(detail).toMatchObject({
      id: "H-W",
      ticket_id: "ticket-2",
      quality: "writing",
      goal_line: "Make the writer path single.",
      pointers: ["plan: docs/spikes/x.md"],
      facts: { v: 1, ticket: { key: "T-1" } },
    });
    expect(
      HandoffDetail.parse(await (await rest("/handoffs/H5-2")).json()),
    ).toMatchObject({
      pointers: [],
      facts: {},
    });
    expect((await rest("/handoffs/nope")).status).toBe(404);
  });

  test("GET /tickets/:ref carries the chain in order, with quality, sessions and accepted_at", async () => {
    const five = TicketDetail.parse(await (await rest("/tickets/5")).json());
    expect(five.handoffs).toEqual([
      expect.objectContaining({
        id: "H5-1",
        quality: "full",
        from_session_id: "S-OLD",
        to_session_id: "S-OTHER",
        accepted_at: 10,
      }),
      expect.objectContaining({
        id: "H5-2",
        quality: "degraded",
        from_session_id: "S-OTHER",
        to_session_id: null,
        accepted_at: null,
      }),
    ]);
    const one = TicketDetail.parse(await (await rest("/tickets/1")).json());
    expect(one.ticket.owner_session_id).toBe("S-NEXT");
    expect(one.handoffs).toEqual([
      expect.objectContaining({
        id: "H1",
        to_session_id: "S-NEXT",
        accepted_at: expect.any(Number),
      }),
    ]);
  });
});
