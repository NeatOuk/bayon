// A project that requires approval for its orchestrator's staffing, over HTTP and /mcp
// against a temp-file DB: `PATCH /projects/:id` sets the switch (audited `project.set`, 404 for an
// unknown project); the orchestrator's ticket_staff then files a proposal, returned as data; the
// operator's inbox answer approves it (409 while the proposed agent is busy, the request left open;
// 200 and the spawn once it is free) or rejects it. The operator's own staffing never asks.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  FakeClock,
  hashToolset,
  sha256Hex,
  systemClock,
  NO_STEP_TIERS,
} from "@bayon/core";
import { getTicket, openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
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
  DEFAULT_JIRA_PUSH_VIEW,
  NO_DELIVERY,
  NO_DOCS,
  NO_QA,
  ApiErrorBody,
  AuditPage,
  InboxItem,
  InboxPage,
  ProjectSettingsState,
  ProjectsView,
  ROLE_MATRIX,
  StaffAccepted,
  StaffProposed,
  toolDefinitions,
  toolsetFor,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { dbStore } from "../db-store.js";
import { mcpDbStore } from "../mcp/db-store.js";
import { ProjectsService } from "../projects/projects-service.js";
import { startApi, type RunningApi } from "../server.js";
import { TicketService } from "./ticket-service.js";

const TOKEN = "e2e-staff-approval-operator-0123456789";
const ORCH_TOKEN = "tok-approval-orch-0123456789abcdefg";
const HASH = "0".repeat(64);
const ALLOWLIST = [...ROLE_MATRIX.orchestrator];

const CallResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
let runtime = "";
let client: Client | undefined;

const agent = (
  id: string,
  kind: "builder" | "orchestrator",
  workspace_id: string,
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
  runtime = realpathSync(mkdtempSync(join(tmpdir(), "frm-approval-e2e-")));
  const tools = toolsetFor("orchestrator", ALLOWLIST);
  if (!tools.ok) throw new Error(tools.error.message);
  unwrap(
    await seedRows(spine.db, {
      workspaces: [
        { id: "shop", name: "shop", kind: "single" },
        { id: "blog", name: "blog", kind: "single" },
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
        agent("shop-orch", "orchestrator", "shop"),
        agent("shop-builder", "builder", "shop"),
      ],
      tickets: [1, 2, 3].map((n) =>
        ticketRow(n, { status: "prioritized", workspace_id: "shop" }),
      ),
      sessions: [
        {
          ...newSessionInput(),
          id: "S-O",
          agent_id: "shop-orch",
          role: "orchestrator",
          state: "running",
          mcp_token_hash: await sha256Hex(ORCH_TOKEN),
          toolset_hash: await hashToolset(toolDefinitions(tools.value)),
          created_at: 0,
        },
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
    projects: new ProjectsService({
      db: apiDb,
      clock: systemClock,
      mirrorsRoot: join(runtime, "mirrors"),
    }),
    mcp: { store: mcpDbStore(apiDb), limits: { rateCalls: 10_000 } },
  });
});

afterAll(async () => {
  await client?.close();
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

async function orchestrator(): Promise<Client> {
  if (client !== undefined) return client;
  const c = new Client({ name: "e2e", version: "1.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(api.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${ORCH_TOKEN}` } },
    }),
  );
  client = c;
  return c;
}

/** The orchestrator's ticket_staff on ticket `num`, as the tool returns it. */
async function staffCall(num: number) {
  const r = CallResult.parse(
    await (
      await orchestrator()
    ).callTool({
      name: "ticket_staff",
      arguments: { ticket: String(num), role: "builder" },
    }),
  );
  return r;
}
const proposedOf = (r: z.infer<typeof CallResult>) =>
  StaffProposed.parse(JSON.parse(r.content[0]?.text ?? ""));

const spawns = async () =>
  unwrap(await listCommands(spine.db)).filter(
    (c) => c.type === "session.spawn",
  );
const openInbox = async () => {
  const res = await http("GET", "/inbox?status=open");
  expect(res.status).toBe(200);
  return InboxPage.parse(await res.json()).items;
};
const answer = (id: string, text: string) =>
  http("POST", `/inbox/${id}/answer`, { answer: text });

test("PATCH /projects/:id sets the switch: 200, a no-op again, audited project.set; 404 and 400 write nothing", async () => {
  const unauthorized = await fetch(`${api.url}/projects/shop`, {
    method: "PATCH",
  });
  expect(unauthorized.status).toBe(401);

  const on = await http("PATCH", "/projects/shop", { staff_approval: true });
  expect(on.status).toBe(200);
  expect(ProjectSettingsState.parse(await on.json())).toEqual({
    project: "shop",
    staff_approval: true,
    jira: null,
    qa: NO_QA,
    docs: NO_DOCS,
    delivery: NO_DELIVERY,
    jira_push: DEFAULT_JIRA_PUSH_VIEW,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
    push_targets: [],
    qa_ticket: null,
    changed: true,
  });
  const again = await http("PATCH", "/projects/shop", {
    staff_approval: true,
  });
  expect(ProjectSettingsState.parse(await again.json())).toMatchObject({
    changed: false,
  });

  const listed = ProjectsView.parse(
    await (await http("GET", "/projects")).json(),
  );
  expect(
    Object.fromEntries(listed.projects.map((p) => [p.id, p.staff_approval])),
  ).toEqual({ shop: true, blog: false });

  const unknown = await http("PATCH", "/projects/nobody", {
    staff_approval: true,
  });
  expect(unknown.status).toBe(404);
  expect(ApiErrorBody.parse(await unknown.json()).error.class).toBe(
    "not_found",
  );
  for (const bad of [
    {},
    { staff_approval: "yes" },
    { staff_approval: true, paused: true },
  ]) {
    const res = await http("PATCH", "/projects/blog", bad);
    expect(res.status, JSON.stringify(bad)).toBe(400);
  }

  const audit = AuditPage.parse(
    await (await http("GET", "/audit?action=project.*")).json(),
  ).items;
  expect(
    audit.map((a) => [
      a.actor,
      a.action,
      a.target_kind,
      a.target_id,
      a.payload,
    ]),
  ).toEqual([
    ["operator", "project.set", "project", "shop", { staff_approval: true }],
  ]);
});

test("ticket_staff files one proposal, as data; approve is 409 while the agent is busy, then staffs it", async () => {
  const first = await staffCall(1);
  expect(first.isError).not.toBe(true);
  const proposed = proposedOf(first);
  expect(proposed).toMatchObject({
    status: "approval_pending",
    created: true,
    agent_id: "shop-builder",
    role: "builder",
    run_class: "spike",
    handoff_id: null,
  });
  expect(proposedOf(await staffCall(1))).toMatchObject({
    request_id: proposed.request_id,
    created: false,
  });
  expect(await spawns()).toEqual([]);

  const [item] = (await openInbox()).filter(
    (i) => i.id === proposed.request_id,
  );
  expect(item).toMatchObject({
    kind: "staff_approval",
    question: "Staff FRM-1 with shop-builder (builder, spike)?",
    options: ["approve", "reject"],
    ticket: { num: 1, status: "prioritized" },
    session: { id: "S-O", role: "orchestrator" },
    // The proposal's own fields, for a reader that must not parse the question.
    proposal: {
      agent_id: "shop-builder",
      runner_id: SPINE_SEED.runnerId,
      role: "builder",
      run_class: "spike",
      handoff_id: null,
    },
  });

  // The operator's own staffing never asks; it takes the builder's only slot.
  const operator = await http("POST", "/tickets/2/staff", { role: "builder" });
  expect(operator.status).toBe(202);
  expect(StaffAccepted.parse(await operator.json()).agent_id).toBe(
    "shop-builder",
  );

  const busy = await answer(proposed.request_id, "approve");
  expect(busy.status).toBe(409);
  const error = ApiErrorBody.parse(await busy.json()).error;
  expect(error.class).toBe("conflict");
  expect(error.message).toContain("no_agent");
  expect((await openInbox()).map((i) => i.id)).toContain(proposed.request_id);
  expect(await spawns()).toHaveLength(1);

  const unclear = await answer(proposed.request_id, "maybe");
  expect(unclear.status).toBe(400);

  // Room for the approval (and the next proposal): the builder takes three at once.
  const resized = await http("PATCH", "/agents/shop-builder", {
    max_concurrency: 3,
  });
  expect(resized.status).toBe(200);
  const approved = await answer(proposed.request_id, "Approve");
  expect(approved.status).toBe(200);
  expect(InboxItem.parse(await approved.json())).toMatchObject({
    id: proposed.request_id,
    status: "answered",
    answer: "approve",
    answered_by: "operator",
  });
  const spawn = (await spawns()).find(
    (c) => c.idempotency_key === `approval:${proposed.request_id}`,
  );
  expect(JSON.parse(spawn?.payload_json ?? "{}")).toMatchObject({
    agent_id: "shop-builder",
    ticket_id: "ticket-1",
    run_class: "spike",
  });
  expect(unwrap(await getTicket(spine.db, "ticket-1")).status).toBe("staffed");
  const answered = await answer(proposed.request_id, "reject");
  expect(answered.status).toBe(409);
});

test("reject records the answer; the orchestrator's same staffing is then refused as rejected", async () => {
  const proposed = proposedOf(await staffCall(3));
  const rejected = await answer(proposed.request_id, "reject");
  expect(rejected.status).toBe(200);
  expect(InboxItem.parse(await rejected.json())).toMatchObject({
    status: "answered",
    answer: "reject",
  });
  const again = await staffCall(3);
  expect(again).toMatchObject({
    isError: true,
    structuredContent: { refused: true, reason: "not_staffable" },
  });
  expect(String(again.structuredContent?.detail)).toContain(
    "rejected by the operator",
  );
  expect(
    (await spawns()).filter(
      (c) => JSON.parse(c.payload_json).ticket_id === "ticket-3",
    ),
  ).toEqual([]);
  expect(unwrap(await getTicket(spine.db, "ticket-3")).status).toBe(
    "prioritized",
  );
});
