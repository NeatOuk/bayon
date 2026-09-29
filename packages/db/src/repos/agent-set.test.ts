// setAgentFromCli, `frm agent set`'s writer, and setAgentFromApi,
// `PATCH /agents/:id`'s, against a real temp database: a change and its audit row in one
// transaction; a refusal or a no-op writes neither.
import { FakeClock } from "@bayon/core";
import { afterEach, describe, expect, test } from "vitest";
import { getAgent } from "../index.js";
import {
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import {
  setAgentFromApi,
  setAgentFromCli,
  type AgentApiPatch,
  type AgentPatch,
} from "./agent-set.js";

const T0 = 1_700_000_000_000;
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function db(): Promise<TempDb> {
  const t = unwrap(await tempDb(new FakeClock(T0)));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      runners: [
        { id: "r1", kind: "script", adapter: "fixture", caps_json: "{}" },
      ],
      profiles: [
        {
          id: "p1",
          name: "p1",
          runner_id: "r1",
          model_tier: "standard",
          version: 1,
          hash: "0".repeat(64),
          created_at: T0,
        },
      ],
      agents: [
        {
          id: "b1",
          name: "b1",
          kind: "builder",
          runner_id: "r1",
          profile_id: null,
          created_at: T0,
        },
      ],
    }),
  );
  return t;
}

test("sets what changed, and audits it as the operator's via frm, stamped now", async () => {
  const t = await db();
  expect(
    unwrap(
      await setAgentFromCli(t.db, "b1", {
        profile_id: "p1",
        max_concurrency: 1,
      }),
    ),
  ).toEqual({
    id: "b1",
    changed: true,
    from: { profile_id: null },
    to: { profile_id: "p1" },
  });
  expect(unwrap(await getAgent(t.db, "b1"))).toMatchObject({
    profile_id: "p1",
    max_concurrency: 1,
  });
  expect(unwrap(await listAudit(t.db))).toMatchObject([
    {
      ts: T0,
      actor: "operator",
      action: "agent.set",
      target_kind: "agent",
      target_id: "b1",
      payload_json: JSON.stringify({
        via: "frm",
        from: { profile_id: null },
        to: { profile_id: "p1" },
      }),
    },
  ]);
});

test.each([
  ["mission_id", { mission_id: "m-1" }, /mission_id is set by the API/],
  ["an unknown field", { kind: "reviewer" }, /kind/],
  [
    "an empty patch",
    {},
    /at least one of profile_id, enabled, max_concurrency/,
  ],
  ["a negative max_concurrency", { max_concurrency: -1 }, /max_concurrency/],
  ["a fractional max_concurrency", { max_concurrency: 1.5 }, /max_concurrency/],
  ["an empty profile id", { profile_id: "" }, /profile_id/],
])("refuses %s as validation, writing nothing", async (_what, patch, why) => {
  const t = await db();
  // The patch comes from outside TypeScript here, as a JS caller's would.
  const r = await setAgentFromCli(t.db, "b1", patch as unknown as AgentPatch);
  expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(!r.ok && r.error.message).toMatch(why);
  expect(unwrap(await getAgent(t.db, "b1"))).toMatchObject({
    profile_id: null,
    enabled: 1,
    max_concurrency: 1,
  });
  expect(unwrap(await listAudit(t.db))).toEqual([]);
});

test("an unknown agent is not_found; an unnamed one validation", async () => {
  const t = await db();
  expect(
    await setAgentFromCli(t.db, "nobody", { enabled: false }),
  ).toMatchObject({
    ok: false,
    error: { class: "not_found", message: "agent nobody does not exist" },
  });
  expect(await setAgentFromCli(t.db, " ", { enabled: false })).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(unwrap(await listAudit(t.db))).toEqual([]);
});

describe("setAgentFromApi", () => {
  test.each<[string, AgentApiPatch, object, object]>([
    ["disables", { enabled: false }, { enabled: 1 }, { enabled: 0 }],
    [
      "resizes",
      { max_concurrency: 3 },
      { max_concurrency: 1 },
      { max_concurrency: 3 },
    ],
    [
      "disables and sizes to 0 at once",
      { enabled: false, max_concurrency: 0 },
      { enabled: 1, max_concurrency: 1 },
      { enabled: 0, max_concurrency: 0 },
    ],
  ])("%s, audited as the operator's via rest", async (_, patch, from, to) => {
    const t = await db();
    expect(unwrap(await setAgentFromApi(t.db, "b1", patch))).toEqual({
      id: "b1",
      changed: true,
      from,
      to,
    });
    expect(unwrap(await getAgent(t.db, "b1"))).toMatchObject(to);
    expect(unwrap(await listAudit(t.db))).toMatchObject([
      {
        actor: "operator",
        action: "agent.set",
        target_kind: "agent",
        target_id: "b1",
        payload_json: JSON.stringify({ via: "rest", from, to }),
      },
    ]);
  });

  test("re-enables a disabled agent", async () => {
    const t = await db();
    unwrap(await setAgentFromApi(t.db, "b1", { enabled: false }));
    expect(
      unwrap(await setAgentFromApi(t.db, "b1", { enabled: true })),
    ).toMatchObject({ changed: true, to: { enabled: 1 } });
    expect(unwrap(await getAgent(t.db, "b1")).enabled).toBe(1);
  });

  test("values it already has write nothing and audit nothing", async () => {
    const t = await db();
    expect(
      unwrap(
        await setAgentFromApi(t.db, "b1", {
          enabled: true,
          max_concurrency: 1,
        }),
      ),
    ).toEqual({ id: "b1", changed: false, from: {}, to: {} });
    expect(unwrap(await listAudit(t.db))).toEqual([]);
  });

  test.each([
    ["profile_id (frm's alone)", { profile_id: "p1" }, /profile_id/],
    ["mission_id", { mission_id: "m-1" }, /set by POST \/missions/],
    ["kind", { kind: "reviewer" }, /kind/],
    ["runner_id", { runner_id: "r1" }, /runner_id/],
    ["workspace_id", { workspace_id: "w1" }, /workspace_id/],
    ["an empty patch", {}, /at least one of enabled, max_concurrency/],
    ["a negative max_concurrency", { max_concurrency: -1 }, /max_concurrency/],
  ])("refuses %s as validation, writing nothing", async (_what, patch, why) => {
    const t = await db();
    const r = await setAgentFromApi(
      t.db,
      "b1",
      patch as unknown as AgentApiPatch,
    );
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(!r.ok && r.error.message).toMatch(why);
    expect(unwrap(await getAgent(t.db, "b1"))).toMatchObject({
      profile_id: null,
      enabled: 1,
      max_concurrency: 1,
    });
    expect(unwrap(await listAudit(t.db))).toEqual([]);
  });

  test("an unknown agent is not_found, writing nothing", async () => {
    const t = await db();
    expect(
      await setAgentFromApi(t.db, "nobody", { enabled: false }),
    ).toMatchObject({
      ok: false,
      error: { class: "not_found", message: "agent nobody does not exist" },
    });
    expect(unwrap(await listAudit(t.db))).toEqual([]);
  });
});

// At most one enabled orchestrator per project: enabling a second is refused at both
// doors, as adding one is; a fleet orchestrator (no project) is outside the rule.
describe("enabling an orchestrator", () => {
  const orch = (id: string, workspace_id: string | null, enabled: number) => ({
    id,
    name: id,
    kind: "orchestrator" as const,
    runner_id: "r1",
    workspace_id,
    enabled,
    created_at: T0,
  });

  async function withOrchestrators() {
    const t = await db();
    unwrap(
      await seedRows(t.db, {
        workspaces: [{ id: "w1", name: "w1", kind: "single" }],
        agents: [
          orch("w1-orchestrator", "w1", 0),
          orch("w1-orchestrator-1", "w1", 1),
          orch("fleet-a", null, 1),
          orch("fleet-b", null, 0),
        ],
      }),
    );
    return t;
  }

  test.each([
    ["PATCH /agents/:id", setAgentFromApi],
    ["frm agent set", setAgentFromCli],
  ])(
    "%s: a project's second is conflict naming the first, writing nothing",
    async (_door, set) => {
      const t = await withOrchestrators();
      const r = await set(t.db, "w1-orchestrator", { enabled: true });
      expect(r).toMatchObject({ ok: false, error: { class: "conflict" } });
      expect(!r.ok && r.error.message).toBe(
        "project w1 already has an enabled orchestrator, w1-orchestrator-1: disable it before enabling w1-orchestrator",
      );
      expect(unwrap(await getAgent(t.db, "w1-orchestrator")).enabled).toBe(0);
      expect(unwrap(await listAudit(t.db))).toEqual([]);
    },
  );

  test("with the first disabled, the other is enabled; a fleet orchestrator is never held", async () => {
    const t = await withOrchestrators();
    unwrap(
      await setAgentFromApi(t.db, "w1-orchestrator-1", { enabled: false }),
    );
    expect(
      unwrap(await setAgentFromApi(t.db, "w1-orchestrator", { enabled: true })),
    ).toMatchObject({ changed: true, to: { enabled: 1 } });
    // Enabling what is already enabled, or resizing an enabled one, is no second orchestrator.
    expect(
      unwrap(
        await setAgentFromApi(t.db, "w1-orchestrator", {
          enabled: true,
          max_concurrency: 2,
        }),
      ),
    ).toMatchObject({ changed: true, to: { max_concurrency: 2 } });
    expect(
      unwrap(await setAgentFromApi(t.db, "fleet-b", { enabled: true })),
    ).toMatchObject({ changed: true });
  });
});
