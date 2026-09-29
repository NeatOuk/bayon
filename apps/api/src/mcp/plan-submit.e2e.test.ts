// an earlier change end to end: a spike submits its own plan over /mcp, with no operator write. The builder's
// ticket_update carries plan_path and status plan_review in one call, and submit_plan's laws (the
// plan artifact, no_source_changes) judge the row with that plan_path set. Real git worktrees under
// the API's work root, a temp-file DB, the MCP SDK client over HTTP.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeClock, hashToolset, sha256Hex, systemClock } from "@bayon/core";
import { getTicket, listTicketEvents, openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  listAudit,
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

const OPERATOR = "e2e-plan-operator-token-0123456789";
/** S-n is a builder holding spiking ticket n; S-O is the orchestrator, holding none. */
const TOKENS = {
  1: "tok-p1-0123456789abcdefghijklmnop",
  2: "tok-p2-0123456789abcdefghijklmnop",
  3: "tok-p3-0123456789abcdefghijklmnop",
  orch: "tok-po-0123456789abcdefghijklmnop",
} as const;
const SPIKES = [1, 2, 3] as const;
const PLAN = "docs/spikes/plan.md";
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
const clients: Client[] = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

const worktreeOf = (n: number) => join(runtime, "work", `t${n}`);

/** Ticket n's worktree under the work root: one source file, committed as the base. */
function worktree(n: number) {
  const path = worktreeOf(n);
  mkdirSync(join(path, "src"), { recursive: true });
  mkdirSync(join(path, "docs", "spikes"), { recursive: true });
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "src", "a.ts"), "export const a = 1;\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "base");
  return {
    id: `wt-${n}`,
    session_root: path,
    workspace_id: "ws-1",
    repo_id: "repo-1",
    path,
    branch: "main",
    base_sha: git(path, "rev-parse", "HEAD"),
    ticket_id: `ticket-${n}`,
    session_id: `S-${n}`,
    state: "active" as const,
    created_at: 0,
  };
}

/** The spike's own work: the plan written and committed in its worktree. */
function commitPlan(n: number): void {
  const path = worktreeOf(n);
  writeFileSync(join(path, PLAN), "# Plan\n\nApproach, files, tests, risks.\n");
  git(path, "add", PLAN);
  git(path, "commit", "-q", "-m", "plan");
}

const hashOf = async (role: string, allowlist: readonly string[]) => {
  const tools = toolsetFor(role, allowlist);
  if (!tools.ok) throw new Error(tools.error.message);
  return hashToolset(toolDefinitions(tools.value));
};

async function seed(): Promise<void> {
  const session = async (
    id: string,
    agent_id: string,
    role: string,
    token: string,
    ticket: number | null,
  ) => ({
    ...newSessionInput(),
    id,
    agent_id,
    role,
    state: "idle" as const,
    mcp_token_hash: await sha256Hex(token),
    toolset_hash: await hashOf(
      role,
      role === "orchestrator"
        ? SHIPPED_ALLOWLISTS.orchestrator
        : SHIPPED_ALLOWLISTS.builder,
    ),
    ticket_id: ticket === null ? null : `ticket-${ticket}`,
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
  const agent = (id: string, kind: "builder" | "orchestrator", p: string) => ({
    id,
    name: id,
    kind,
    runner_id: SPINE_SEED.runnerId,
    executor_id: SPINE_SEED.executorId,
    profile_id: p,
    mission_id: null,
    created_at: 0,
  });
  unwrap(
    await seedRows(spine.db, {
      repos: [{ id: "repo-1", name: "repo-1", mirror_path: "/m/repo-1" }],
      workspaces: [{ id: "ws-1", name: "ws-1", kind: "single" }],
      tickets: SPIKES.map((n) => ticketRow(n, { status: "spiking" })),
      profiles: [
        profile("P-B", SHIPPED_ALLOWLISTS.builder),
        profile("P-O", SHIPPED_ALLOWLISTS.orchestrator),
      ],
      agents: [
        agent("plan-builder", "builder", "P-B"),
        agent("plan-orchestrator", "orchestrator", "P-O"),
      ],
      sessions: [
        ...(await Promise.all(
          SPIKES.map((n) =>
            session(`S-${n}`, "plan-builder", "builder", TOKENS[n], n),
          ),
        )),
        await session(
          "S-O",
          "plan-orchestrator",
          "orchestrator",
          TOKENS.orch,
          null,
        ),
      ],
      worktrees: SPIKES.map(worktree),
    }),
  );
}

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 3));
  runtime = realpathSync(mkdtempSync(join(tmpdir(), "frm-plan-e2e-")));
  await seed();
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
const textOf = (r: CallResult) => r.content[0]?.text ?? "";
const dataOf = (r: CallResult) =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(textOf(r)));
const refusedAs = (reason: string, detail: string) => ({
  isError: true,
  structuredContent: {
    refused: true,
    reason,
    detail: expect.stringContaining(detail),
  },
});
const ticket = async (n: number) =>
  unwrap(await getTicket(spine.db, `ticket-${n}`));
const events = async (n: number) =>
  unwrap(
    await listTicketEvents(spine.db, {
      ticket_id: `ticket-${n}`,
      since: 0,
      limit: 100,
    }),
  ).rows;

describe("a spike submits its own plan over MCP", () => {
  test("plan_path and plan_review in one ticket_update move the ticket: no operator write", async () => {
    const client = await connect(TOKENS[1]);
    const before = dataOf(await call(client, "ticket_get", { ticket: "1" }));
    expect(before["ticket"]).toMatchObject({
      status: "spiking",
      plan_path: null,
      version: 1,
    });
    commitPlan(1);
    const submitted = dataOf(
      await call(client, "ticket_update", {
        ticket: "1",
        version: 1,
        plan_path: PLAN,
        status: "plan_review",
      }),
    );
    // Trivial, so submit_plan opens no plan_review round and the same move carries it on to
    // planned — this is the dogfood path where the ticket used to stall instead.
    expect(submitted).toMatchObject({ status: "planned", version: 2 });
    expect(await ticket(1)).toMatchObject({
      status: "planned",
      plan_path: PLAN,
      version: 2,
    });
    // One write, the session's: its transition carries submit_plan's evidence for the new path.
    const written = await events(1);
    expect(written.map((e) => [e.kind, e.actor_kind, e.actor_id])).toEqual([
      ["transition", "session", "S-1"],
    ]);
    expect(JSON.parse(written[0]?.payload_json ?? "null")).toMatchObject({
      rule: "submit_plan",
      evidence: {
        plan_path: PLAN,
        worktrees: [{ id: "wt-1", paths: [PLAN] }],
      },
    });
    expect(unwrap(await listAudit(spine.db))).toContainEqual(
      expect.objectContaining({
        action: "mcp.ticket_update",
        actor: "session:S-1",
        target_kind: "ticket",
        target_id: "ticket-1",
        payload_json: expect.stringContaining('"outcome":"ok"'),
      }),
    );
  });

  test("the laws judge the updated row: no plan file, then a source change; nothing is written", async () => {
    const client = await connect(TOKENS[2]);
    const submit = {
      ticket: "2",
      version: 1,
      plan_path: PLAN,
      status: "plan_review",
    };
    expect(await call(client, "ticket_update", submit)).toMatchObject(
      refusedAs("missing_evidence", "missing_artifact"),
    );
    commitPlan(2);
    writeFileSync(join(worktreeOf(2), "src", "b.ts"), "export const b = 2;\n");
    expect(await call(client, "ticket_update", submit)).toMatchObject(
      refusedAs("missing_evidence", "source_changes"),
    );
    expect(await ticket(2)).toMatchObject({
      status: "spiking",
      plan_path: null,
      version: 1,
    });
    expect(await events(2)).toEqual([]);
  });

  test("a plan_path is PlanPath-validated, and rides only with plan_review", async () => {
    const client = await connect(TOKENS[2]);
    for (const plan_path of ["/etc/plan.md", "../plan.md", "docs/./plan.md"]) {
      const bad = await call(client, "ticket_update", {
        ticket: "2",
        version: 1,
        plan_path,
        status: "plan_review",
      });
      expect(bad.isError, plan_path).toBe(true);
      expect(textOf(bad), plan_path).toMatch(/^invalid arguments/);
    }
    const blocked = await call(client, "ticket_update", {
      ticket: "2",
      version: 1,
      plan_path: PLAN,
      status: "blocked",
      blocked_reason: "stuck",
      unblock_condition: "unstuck",
    });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain(
      "plan_path moves only with status plan_review",
    );
    expect((await ticket(2)).version).toBe(1);
  });

  test("plan_path alone is an edit of the session's own ticket, recorded as one", async () => {
    const client = await connect(TOKENS[3]);
    const edited = dataOf(
      await call(client, "ticket_update", {
        ticket: "3",
        version: 1,
        plan_path: PLAN,
      }),
    );
    expect(edited).toMatchObject({ status: "spiking", version: 2 });
    expect((await ticket(3)).plan_path).toBe(PLAN);
    expect(
      (await events(3)).map((e) => [e.kind, e.actor_id, e.payload_json]),
    ).toEqual([["updated", "S-3", '{"fields":["plan_path"]}']]);
  });

  test("only the session holding the ticket sets its plan_path: not another builder, not the orchestrator", async () => {
    const set = { ticket: "3", version: 2, plan_path: "docs/spikes/other.md" };
    expect(
      await call(await connect(TOKENS[1]), "ticket_update", set),
    ).toMatchObject({
      isError: true,
      structuredContent: { refused: true, reason: "cross_ticket_write" },
    });
    expect(
      await call(await connect(TOKENS.orch), "ticket_update", set),
    ).toMatchObject(
      refusedAs("cross_ticket_write", "only the session holding a ticket"),
    );
    expect(await ticket(3)).toMatchObject({ plan_path: PLAN, version: 2 });
  });
});
