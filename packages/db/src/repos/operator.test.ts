import { DEFAULT_RUN_CLASSES, FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import {
  SPINE_SEED,
  listAudit,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { seedConfig, type ConfigRows } from "./operator.js";

const T0 = 1_700_000_000_000;
const HASH = "0".repeat(64);
const t = unwrap(await tempDb(new FakeClock(T0)));
// The spine gives a registered runner, as the supervisor's boot would.
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));
const count = (table: string) =>
  raw.prepare(`SELECT count(*) AS n FROM ${table}`).get();

/** One of each config row, the agent referencing the others. */
const config = (s: string): ConfigRows => ({
  executors: [{ id: `ex-${s}`, kind: "local", config_json: "{}" }],
  repos: [{ id: `repo-${s}`, name: `repo-${s}`, mirror_path: "/tmp/mirror" }],
  workspaces: [
    {
      id: `ws-${s}`,
      name: `ws-${s}`,
      kind: "single",
      default_executor_id: `ex-${s}`,
    },
  ],
  workspace_repos: [
    {
      workspace_id: `ws-${s}`,
      repo_id: `repo-${s}`,
      rel_path: "repo",
      role: "primary",
    },
  ],
  profiles: [
    {
      id: `p-${s}`,
      name: `p-${s}`,
      runner_id: SPINE_SEED.runnerId,
      model_tier: "standard",
      sandbox_json: '{"script":{}}',
      version: 1,
      hash: HASH,
      created_at: T0,
    },
  ],
  agents: [
    {
      id: `agent-${s}`,
      name: `agent-${s}`,
      kind: "builder",
      runner_id: SPINE_SEED.runnerId,
      executor_id: `ex-${s}`,
      profile_id: `p-${s}`,
      workspace_id: `ws-${s}`,
      created_at: T0,
    },
  ],
  run_classes: [
    {
      name: `rc_${s}`,
      context_tokens_cap: 1_000,
      max_turns: 5,
      max_tool_calls: 10,
      wall_clock_ms: 3_000,
      cost_cap_usd: 0.1,
      handoff_at_turns: 0,
      default_tier: "cheap",
    },
  ],
});

test("seeds every config table in one call, parents before children", async () => {
  unwrap(await seedConfig(t.db, config("a")));
  expect(
    raw
      .prepare(
        "SELECT executor_id, profile_id, mission_id, workspace_id FROM agents WHERE id = ?",
      )
      .get("agent-a"),
  ).toEqual({
    executor_id: "ex-a",
    profile_id: "p-a",
    mission_id: null, // the API's to set (POST /missions), never the operator seed's
    workspace_id: "ws-a",
  });
  expect(
    raw
      .prepare("SELECT rel_path, role FROM workspace_repos WHERE repo_id = ?")
      .get("repo-a"),
  ).toEqual({ rel_path: "repo", role: "primary" });
  expect(
    raw
      .prepare("SELECT wall_clock_ms FROM run_classes WHERE name = ?")
      .get("rc_a"),
  ).toEqual({ wall_clock_ms: 3_000 });
});

test("a repo id with the executor-mirror prefix is refused, and nothing is written (H1)", async () => {
  const executors = count("executors");
  const repos = count("repos");
  expect(
    await seedConfig(t.db, {
      executors: [{ id: "ex-frm", kind: "local", config_json: "{}" }],
      repos: [
        {
          id: "frm-conformance",
          name: "frm-conformance",
          mirror_path: "/tmp/m",
        },
      ],
    }),
  ).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining("frm-conformance"),
    },
  });
  expect(count("executors")).toEqual(executors);
  expect(count("repos")).toEqual(repos);
});

test("fleet.paused is never seeded: its only writer is the audited pause and resume", async () => {
  const before = raw
    .prepare("SELECT value_json, updated_at FROM settings WHERE key = ?")
    .get("fleet.paused");
  const executors = count("executors");
  expect(
    await seedConfig(t.db, {
      executors: [{ id: "ex-paused", kind: "local", config_json: "{}" }],
      settings: { "fleet.paused": 1, "backup.keep": 7 },
    }),
  ).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining("frm pause"),
    },
  });
  expect(
    raw
      .prepare("SELECT value_json, updated_at FROM settings WHERE key = ?")
      .get("fleet.paused"),
  ).toEqual(before);
  expect(count("executors")).toEqual(executors);
});

const stored = (key: string) =>
  raw
    .prepare("SELECT value_json, updated_at FROM settings WHERE key = ?")
    .get(key) as { value_json: string; updated_at: number } | undefined;
const auditOf = async (key: string) =>
  unwrap(await listAudit(t.db))
    .filter((r) => r.target_id === key)
    .map((r) => [r.actor, r.action, r.payload_json]);

test("a governed setting out of its bounds is refused as PUT /settings refuses it: nothing written or audited", async () => {
  const before = stored("backup.keep");
  const executors = count("executors");
  expect(
    await seedConfig(t.db, {
      executors: [{ id: "ex-bounds", kind: "local", config_json: "{}" }],
      settings: { "backup.keep": 0, "lifecycle.kill_grace_ms": 2_000 },
    }),
  ).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining("backup.keep"),
    },
  });
  expect(stored("backup.keep")).toEqual(before);
  expect(count("executors")).toEqual(executors);
  expect(await auditOf("backup.keep")).toEqual([]);
});

test("a seeded governed setting leaves a settings.put audit row, the operator's via frm; the same value again, and a plain key, leave none", async () => {
  const from = JSON.parse(stored("backup.keep")?.value_json ?? "null") as
    number | null;
  unwrap(
    await seedConfig(t.db, {
      settings: { "backup.keep": 9, "lifecycle.interrupt_grace_ms": 9_000 },
    }),
  );
  unwrap(await seedConfig(t.db, { settings: { "backup.keep": 9 } }));
  expect(stored("backup.keep")?.value_json).toBe("9");
  expect(await auditOf("backup.keep")).toEqual([
    ["operator", "settings.put", JSON.stringify({ via: "frm", from, to: 9 })],
  ]);
  expect(await auditOf("lifecycle.interrupt_grace_ms")).toEqual([]);
});

test("the shell-only security controls are checked and audited when seeded", async () => {
  expect(
    await seedConfig(t.db, {
      settings: { "admission.require_certified": true },
    }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  unwrap(
    await seedConfig(t.db, {
      settings: {
        "admission.require_certified": 0,
        "executors.untrusted_roles": ["investigator", "reviewer"],
      },
    }),
  );
  expect(await auditOf("admission.require_certified")).toEqual([
    [
      "operator",
      "settings.put",
      JSON.stringify({ via: "frm", from: 1, to: 0 }),
    ],
  ]);
  expect(
    (await auditOf("executors.untrusted_roles")).map(([, action]) => action),
  ).toEqual(["settings.put"]);
});

test("settings are upserted as canonical JSON, a seeded key included", async () => {
  unwrap(
    await seedConfig(t.db, {
      settings: {
        "retention.events_days": 7,
        "lifecycle.kill_grace_ms": 1_000,
        "x.object": { b: 1, a: [true, null] },
      },
    }),
  );
  const setting = (key: string) =>
    raw
      .prepare("SELECT value_json, updated_at FROM settings WHERE key = ?")
      .get(key);
  expect(setting("retention.events_days")).toEqual({
    value_json: "7",
    updated_at: T0,
  });
  expect(setting("lifecycle.kill_grace_ms")).toEqual({
    value_json: "1000",
    updated_at: T0,
  });
  expect(setting("x.object")).toEqual({
    value_json: '{"a":[true,null],"b":1}',
    updated_at: T0,
  });
});

test("a missing parent is validation, and the whole seed rolls back", async () => {
  const repos = count("repos");
  const rows = config("b");
  const seeded = await seedConfig(t.db, {
    ...rows,
    agents: (rows.agents ?? []).map((a) => ({ ...a, runner_id: "no-runner" })),
  });
  expect(seeded.ok ? null : seeded.error.class).toBe("validation");
  expect(count("repos")).toEqual(repos);
});

test("a repeated id is conflict", async () => {
  const seeded = await seedConfig(t.db, config("a"));
  expect(seeded.ok ? null : seeded.error.class).toBe("conflict");
});

test("a seeded run class is upserted: tuned in place, the others untouched", async () => {
  const spike = DEFAULT_RUN_CLASSES.find((c) => c.name === "spike");
  if (spike === undefined) throw new Error("no seeded spike class");
  const classes = count("run_classes");
  unwrap(
    await seedConfig(t.db, {
      run_classes: [{ ...spike, handoff_at_turns: 3 }],
    }),
  );
  expect(count("run_classes")).toEqual(classes);
  expect(
    raw
      .prepare(
        "SELECT handoff_at_turns, max_turns FROM run_classes WHERE name = 'spike'",
      )
      .get(),
  ).toEqual({ handoff_at_turns: 3, max_turns: spike.max_turns });
});
