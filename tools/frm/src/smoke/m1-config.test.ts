import { FakeClock } from "@bayon/core";
import { seedConfig } from "@bayon/db/operator";
import { seedSpine, tempDb, unwrap } from "@bayon/db/testing";
import {
  CreateTicketRequest,
  ROLE_MATRIX,
  SHIPPED_ALLOWLISTS,
  SpawnRequest,
} from "@bayon/proto";
import { FIXTURE_RUNNER_ID, FixtureScript } from "@bayon/runners/fixture";
import { afterAll, expect, test } from "vitest";
import { SMOKE, smokeConfig } from "./config.js";
import {
  M1,
  M1_CALLS,
  m1Audit,
  m1Rows,
  m1Script,
  m1SpawnRequest,
} from "./m1-config.js";

const T0 = 1_700_000_000_000;
const A = "01TICKETA";
const t = unwrap(await tempDb(new FakeClock(T0)));
afterAll(() => t.cleanup());

test("the M1 script: ticket_get, update, create, a refused cross-ticket update, human_ask, then the gate", () => {
  const run = FixtureScript.parse(m1Script(A)).runs[0];
  expect(run?.gate).toBe("release");
  expect(run?.mcp.map((s) => s.tool)).toEqual(M1_CALLS.map((c) => c.tool));
  expect(run?.mcp[0]).toMatchObject({
    args: { ticket: A },
    save: { a_version: "ticket.version" },
  });
  // A's update carries the version ticket_get read; B's update names the ticket ticket_create made.
  expect(run?.mcp[1]?.args).toMatchObject({
    ticket: A,
    version: { $saved: "a_version" },
  });
  expect(run?.mcp[2]).toMatchObject({
    args: { type: "followup", title: M1.followupTitle },
    save: { b: "id", b_version: "version" },
  });
  expect(run?.mcp[3]).toMatchObject({
    args: { ticket: { $saved: "b" }, version: { $saved: "b_version" } },
    expect: { refused: "cross_ticket_write" },
  });
  expect(run?.mcp[4]?.expect.fields).toEqual({ status: "open" });
});

test("every tool the script calls is a builder's and in the profile's allowlist", async () => {
  const rows = await m1Rows({ now: T0, ticketId: A });
  const allowlist: unknown = JSON.parse(
    rows.profiles?.[0]?.tool_allowlist_json ?? "[]",
  );
  expect(allowlist).toEqual(SHIPPED_ALLOWLISTS.builder);
  for (const { tool } of M1_CALLS) {
    expect(SHIPPED_ALLOWLISTS.builder).toContain(tool);
    expect(ROLE_MATRIX.builder).toContain(tool);
  }
});

test("the M1 rows seed once the boot's runner and the smoke's workspace exist; the script rides in the sandbox", async () => {
  const config = await smokeConfig({
    now: T0,
    repo: { origin: "/tmp/o", mirror: "/tmp/m.git", baseSha: "a".repeat(40) },
    runnerId: FIXTURE_RUNNER_ID,
  });
  unwrap(await seedSpine(t.db, 2));
  unwrap(await seedConfig(t.db, config.beforeBoot));
  unwrap(await seedConfig(t.db, config.afterBoot));
  const rows = await m1Rows({ now: T0, ticketId: A });
  unwrap(await seedConfig(t.db, rows));
  expect(rows.agents).toMatchObject([
    {
      id: M1.agent,
      profile_id: M1.agent,
      runner_id: FIXTURE_RUNNER_ID,
      workspace_id: SMOKE.workspace,
    },
  ]);
  const sandbox = JSON.parse(rows.profiles?.[0]?.sandbox_json ?? "{}") as {
    script?: unknown;
  };
  expect(sandbox.script).toEqual(m1Script(A));
});

test("the spawn request holds ticket A; ticket A is a valid POST /tickets body", () => {
  expect(SpawnRequest.parse(m1SpawnRequest(A))).toMatchObject({
    agent_id: M1.agent,
    role: "builder",
    ticket_id: A,
    runner_id: FIXTURE_RUNNER_ID,
    workspace_id: SMOKE.workspace,
    executor_id: SMOKE.executor,
  });
  expect(CreateTicketRequest.parse(M1.ticketA)).toEqual(M1.ticketA);
});

test("the audit the session must leave: each landed write, and the refused one", () => {
  expect(m1Audit(A, "01TICKETB")).toEqual([
    { action: "mcp.ticket_update", outcome: "ok", target_id: A },
    { action: "mcp.ticket_create", outcome: "ok", target_id: "01TICKETB" },
    { action: "mcp.ticket_update", outcome: "refused:cross_ticket_write" },
    { action: "mcp.human_ask", outcome: "ok", target_id: A },
  ]);
});
