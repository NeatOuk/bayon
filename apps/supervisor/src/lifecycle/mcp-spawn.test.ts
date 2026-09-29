// Design an earlier change §3 and §4 in the spawn pipeline: the token minted at resolve reaches the runner as
// spec.mcp (its plaintext in memory only), toolset_hash is computed at resolve from the role's
// matrix row ∩ the profile's allowlist, and ingest redacts the token and the injected secrets.
import { FakeClock, PULSE_ROLE, hashToolset, sha256Hex } from "@bayon/core";
import { getSession, listRuns, type Db } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { SHIPPED_ALLOWLISTS, toolDefinitions, toolsetFor } from "@bayon/proto";
import type { RunnerAdapter, SpawnSpec } from "@bayon/runners";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import { createIngest, type AttachOptions } from "../ingest/ingest.js";
import { builtinToolsFor } from "./mcp.js";
import { pino } from "pino";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const WAIT = { timeout: 10_000, interval: 5 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const MCP_URL = "http://127.0.0.1:9/mcp";
const SECRET = "s3cr3t-value-for-redaction-0123";
const BUILDER = [...SHIPPED_ALLOWLISTS.builder];

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function setup(o: {
  readonly allowlist: readonly string[];
  readonly mcpClient?: boolean;
  readonly reachable?: boolean;
}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const rows = lifecycleRows({
    healthArgv: ["ok"],
    script: { runs: [{ events: [TURN] }] },
    toolAllowlist: o.allowlist,
  });
  const profile = rows.profiles[0];
  if (profile === undefined) throw new Error("no profile row");
  unwrap(
    await seedRows(t.db, {
      ...rows,
      profiles: [{ ...profile, secret_refs_json: '["FRM_TEST_SECRET"]' }],
    }),
  );
  const home = tempHome();
  const slots = new SlotCounter(4);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
  });
  const base = createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock });
  const specs: SpawnSpec[] = [];
  const adapter: RunnerAdapter = {
    ...base,
    caps: () => ({ ...base.caps(), mcpClient: o.mcpClient ?? true }),
    spawn: (spec, ex) => {
      specs.push(spec);
      return base.spawn(spec, ex);
    },
  };
  const inner = createIngest({
    db: t.db,
    clock,
    log: pino({ level: "silent" }),
    maxRows: 1,
  });
  const attaches: AttachOptions[] = [];
  const ingest = {
    ...inner,
    attach: (a: AttachOptions) => {
      attaches.push(a);
      return inner.attach(a);
    },
  };
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter,
    ingest,
    secrets: { FRM_SECRET_FRM_TEST_SECRET: SECRET }, // envSecrets reads FRM_SECRET_<NAME>
    mcpUrl: MCP_URL,
    mcpReachable: async () => o.reachable ?? true,
  });
  // Quiet before the directories go: a spawn still in its pipeline when a test ends would re-create
  // its session root under the removed home, and leak it.
  cleanups.push(async () => {
    try {
      await started.lifecycle.shutdown();
      await started.lifecycle.settled();
      await inner.shutdown();
    } finally {
      t.cleanup();
      home.cleanup();
    }
  });
  return {
    ...started,
    db: t.db,
    slots,
    specs,
    attaches,
    spawn: (id: string) =>
      started.lifecycle.handlers.spawn.handle(
        spawnPayload(id, { prompt: "go" }),
        CMD,
      ),
  };
}

const session = async (db: Db, id: string) => unwrap(await getSession(db, id));
const toolsetHashOf = async (role: string, allowlist: readonly string[]) => {
  const tools = toolsetFor(role, allowlist);
  if (!tools.ok) throw new Error(tools.error.message);
  return hashToolset(toolDefinitions(tools.value));
};

test("an MCP-capable runner gets spec.mcp: a token hashing to the session's, the role's allowed tools", async () => {
  const allowlist = [...BUILDER, "ticket_staff"]; // not a builder tool: dropped, not an error
  const h = await setup({ allowlist });
  unwrap(await h.spawn("M1"));
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect(unwrap(await listRuns(h.db, "M1"))[0]?.state).toBe("ok");
  }, WAIT);
  const [spec] = h.specs;
  const s = await session(h.db, "M1");
  expect(spec?.mcp).toEqual({
    url: MCP_URL,
    token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    tools: [
      "ticket_get",
      "ticket_create",
      "ticket_update",
      "ticket_comment",
      "handoff_write",
      "handoff_accept",
      "handoff_request",
      "memory_append",
      "human_ask",
      "artifact_attach",
      // M3: a builder resolves its review findings.
      "finding_resolve",
      // M7.6: it reads the pages its ticket links to, read-only.
      "doc_search",
      "doc_get",
    ],
  });
  const token = spec?.mcp?.token ?? "";
  expect(s.mcp_token_hash).toBe(await sha256Hex(token));
  expect(s.toolset_hash).toBe(await toolsetHashOf("builder", allowlist));
  expect(unwrap(await listRuns(h.db, "M1"))[0]?.toolset_hash).toBe(
    s.toolset_hash,
  );
  // The supervisor never puts the plaintext in the env itself: the adapter mounts it its own way.
  expect(Object.values(spec?.env ?? {})).not.toContain(token);
  // A worker keeps the runner's own tools; only a pulse session is MCP-only (plan rule 4).
  expect(spec?.builtinTools).toBeUndefined();
  expect(h.attaches[0]?.redact).toEqual(
    expect.arrayContaining([token, SECRET]),
  );
});

test("a pulse session's spec withholds the runner's own tools; no other role's does (plan rule 4)", () => {
  expect(builtinToolsFor(PULSE_ROLE)).toEqual({ builtinTools: "none" });
  for (const role of ["builder", "reviewer", "investigator"]) {
    expect(builtinToolsFor(role), role).toEqual({});
  }
});

test("a runner without an MCP client gets no spec.mcp, and toolset_hash hashes no tools", async () => {
  const h = await setup({ allowlist: BUILDER, mcpClient: false });
  unwrap(await h.spawn("M2"));
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect((await session(h.db, "M2")).state).toBe("idle");
  }, WAIT);
  expect(h.specs[0]?.mcp).toBeUndefined();
  expect((await session(h.db, "M2")).toolset_hash).toBe(await hashToolset([]));
  expect(h.attaches[0]?.redact).toEqual([SECRET]);
});

test("no MCP client and an empty allowlist still spawns: admission's no_tools is for MCP runners", async () => {
  const h = await setup({ allowlist: [], mcpClient: false });
  unwrap(await h.spawn("M4"));
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect((await session(h.db, "M4")).state).toBe("idle");
  }, WAIT);
  expect(h.specs[0]?.mcp).toBeUndefined();
});

test("an MCP runner whose allowlist mounts none of a builder's tools is refused no_tools, leaving no row", async () => {
  const h = await setup({ allowlist: ["pulse_report"] }); // an orchestrator's tool only
  expect(await h.spawn("M5")).toMatchObject({
    ok: false,
    error: { class: "admission_refused", cause: { gate: "no_tools" } },
  });
  expect((await getSession(h.db, "M5")).ok).toBe(false);
  expect(h.specs).toEqual([]);
});

test("a role with no catalogue row on an MCP runner, allowing nothing, is still admitted: no_tools is for work roles", async () => {
  const h = await setup({ allowlist: [] });
  unwrap(
    await h.lifecycle.handlers.spawn.handle(
      spawnPayload("M6", { prompt: "go", role: "util" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect((await session(h.db, "M6")).state).toBe("idle");
  }, WAIT);
  expect(h.specs[0]?.mcp).toBeUndefined();
});

test("an allowlist entry that names no tool fails the spawn as validation, leaving no row", async () => {
  const h = await setup({ allowlist: ["tickets.read"] });
  expect(await h.spawn("M3")).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining("tickets.read"),
    },
  });
  expect(await getSession(h.db, "M3")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("an unreachable MCP server queues the spawn `unhealthy` before a slot is taken", async () => {
  const h = await setup({ allowlist: BUILDER, reachable: false });
  unwrap(await h.spawn("M4"));
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect(await session(h.db, "M4")).toMatchObject({
      state: "pending",
      queued_reason: "unhealthy",
    });
  }, WAIT);
  expect(h.specs).toEqual([]);
  expect(h.slots.capacity().used).toBe(0);
});
