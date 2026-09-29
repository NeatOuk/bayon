// createProjectAgent, `POST /projects/:id/agents`'s writer, against a real temp
// database: one agent, at most one profile and one audit row in one transaction; a refusal writes
// none of them.
import {
  FakeClock,
  projectAgentProfile,
  type AddableAgentKind,
} from "@bayon/core";
import type { Insertable } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { all, qb, read } from "../connection.js";
import type { ProfilesTable } from "../schema.js";
import {
  SPINE_SEED,
  listAudit,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { createProjectAgent, type NewProjectAgent } from "./agent-create.js";
import { setAgentFromApi } from "./agent-set.js";
import { getAgent } from "./config.js";

const T0 = 1_700_000_000_000;
const HASH = "0".repeat(64);
let t: TempDb;

beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(T0)));
  unwrap(await seedSpine(t.db, 1));
  // `demo` as POST /projects leaves it: a builder named demo-builder on the spine's runner and
  // executor. runner-b is a second registered runner; runner-off is registered and disabled.
  unwrap(
    await seedRows(t.db, {
      runners: [
        { id: "runner-b", kind: "script", adapter: "fixture", caps_json: "{}" },
        {
          id: "runner-off",
          kind: "script",
          adapter: "fixture",
          caps_json: "{}",
          enabled: 0,
        },
      ],
      workspaces: [{ id: "demo", name: "demo", kind: "single" }],
      agents: [
        {
          id: "demo-builder",
          name: "demo-builder",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          workspace_id: "demo",
          created_at: 1,
        },
      ],
    }),
  );
});
afterEach(() => t.cleanup());

/** The planned profile, filled as the door fills it (defaults stand in for withProfileDefaults). */
const profileFor = (
  kind: AddableAgentKind,
  runner: string,
  workspace = "demo",
): Insertable<ProfilesTable> => ({
  ...projectAgentProfile({ workspace, kind, runner }),
  version: 1,
  hash: HASH,
  created_at: T0,
});

const add = (o: Partial<NewProjectAgent> = {}) =>
  createProjectAgent(t.db, {
    workspace: "demo",
    kind: "builder",
    runner: "runner-b",
    profile: profileFor("builder", "runner-b"),
    ...o,
  });

const rows = async () =>
  unwrap(
    await read(t.db, (ix) => ({
      agents: all(ix, qb.selectFrom("agents").select("id").orderBy("id")).map(
        (a) => a.id,
      ),
      profiles: all(
        ix,
        qb.selectFrom("profiles").select(["id", "runner_id"]).orderBy("id"),
      ),
    })),
  );

describe("createProjectAgent", () => {
  test("adds demo-builder-1 on its own runner: one agent, its profile and one agent.create audit row", async () => {
    const created = unwrap(await add());
    expect(created.profileCreated).toBe(true);
    expect(created.agent).toMatchObject({
      id: "demo-builder-1",
      name: "demo-builder-1",
      kind: "builder",
      runner_id: "runner-b",
      // The project's oldest agent's executor: its new builder runs where its first one does.
      executor_id: SPINE_SEED.executorId,
      profile_id: "demo-builder-runner-b",
      workspace_id: "demo",
      mission_id: null,
      max_concurrency: 1,
      enabled: 1,
      created_at: T0,
    });
    expect(unwrap(await getAgent(t.db, "demo-builder-1"))).toEqual(
      created.agent,
    );
    expect(await rows()).toEqual({
      agents: [SPINE_SEED.agentId, "demo-builder", "demo-builder-1"],
      profiles: [{ id: "demo-builder-runner-b", runner_id: "runner-b" }],
    });
    expect(unwrap(await listAudit(t.db))).toMatchObject([
      {
        ts: T0,
        actor: "operator",
        action: "agent.create",
        target_kind: "agent",
        target_id: "demo-builder-1",
        payload_json: JSON.stringify({
          via: "rest",
          workspace: "demo",
          kind: "builder",
          runner: "runner-b",
          profile: "demo-builder-runner-b",
        }),
      },
    ]);
  });

  test("a second builder on the same runner is demo-builder-2 and reuses the profile; a reviewer is numbered on its own", async () => {
    unwrap(await add());
    const second = unwrap(await add({ maxConcurrency: 3 }));
    expect(second.profileCreated).toBe(false);
    expect(second.agent).toMatchObject({
      id: "demo-builder-2",
      profile_id: "demo-builder-runner-b",
      max_concurrency: 3,
    });
    const reviewer = unwrap(
      await add({
        kind: "reviewer",
        runner: SPINE_SEED.runnerId,
        profile: profileFor("reviewer", SPINE_SEED.runnerId),
      }),
    );
    expect(reviewer.agent).toMatchObject({
      id: "demo-reviewer-1",
      kind: "reviewer",
      profile_id: `demo-reviewer-${SPINE_SEED.runnerId}`,
    });
    expect((await rows()).profiles).toEqual(
      [
        {
          id: `demo-reviewer-${SPINE_SEED.runnerId}`,
          runner_id: SPINE_SEED.runnerId,
        },
        { id: "demo-builder-runner-b", runner_id: "runner-b" },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    expect(unwrap(await listAudit(t.db)).map((a) => a.target_id)).toEqual([
      "demo-builder-1",
      "demo-builder-2",
      "demo-reviewer-1",
    ]);
  });

  test("n skips an id or a name already taken anywhere in the fleet", async () => {
    unwrap(
      await seedRows(t.db, {
        agents: [
          {
            id: "01HAND",
            name: "demo-builder-1",
            kind: "builder",
            runner_id: "runner-b",
            created_at: 2,
          },
          {
            id: "demo-builder-2",
            name: "hand-named",
            kind: "reviewer",
            runner_id: "runner-b",
            created_at: 3,
          },
        ],
      }),
    );
    expect(unwrap(await add()).agent.id).toBe("demo-builder-3");
  });

  test("a project with no agent yet gets a builder with no executor: resolve falls back to the workspace's", async () => {
    unwrap(
      await seedRows(t.db, {
        workspaces: [{ id: "empty", name: "empty", kind: "single" }],
      }),
    );
    const created = unwrap(
      await add({
        workspace: "empty",
        profile: profileFor("builder", "runner-b", "empty"),
      }),
    );
    expect(created.agent).toMatchObject({
      id: "empty-builder-1",
      executor_id: null,
      workspace_id: "empty",
    });
  });

  test.each<[string, Partial<NewProjectAgent>, RegExp]>([
    [
      "an unregistered runner",
      { runner: "nobody", profile: profileFor("builder", "nobody") },
      /runner nobody is not registered/,
    ],
    [
      "a disabled runner",
      { runner: "runner-off", profile: profileFor("builder", "runner-off") },
      /runner runner-off is disabled/,
    ],
    ["a kind that is no kind", { kind: "boss" }, /kind/],
    ["a negative max_concurrency", { maxConcurrency: -1 }, /maxConcurrency/],
    ["a fractional max_concurrency", { maxConcurrency: 1.5 }, /maxConcurrency/],
    [
      "a profile that is not the plan's",
      { profile: profileFor("reviewer", "runner-b") },
      /not the plan's demo-builder-runner-b/,
    ],
    [
      "the plan's profile id on another runner",
      {
        profile: {
          ...profileFor("builder", "runner-b"),
          runner_id: SPINE_SEED.runnerId,
        },
      },
      /not the plan's/,
    ],
  ])("refuses %s as validation, writing nothing", async (_what, o, why) => {
    const before = await rows();
    const r = await add(o);
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(!r.ok && r.error.message).toMatch(why);
    expect(await rows()).toEqual(before);
    expect(unwrap(await listAudit(t.db))).toEqual([]);
  });

  test("the plan's profile id already taken on another runner is conflict, writing nothing", async () => {
    unwrap(
      await seedRows(t.db, {
        profiles: [
          {
            ...profileFor("builder", "runner-b"),
            runner_id: SPINE_SEED.runnerId,
          },
        ],
      }),
    );
    const before = await rows();
    const r = await add();
    expect(r).toMatchObject({ ok: false, error: { class: "conflict" } });
    expect(await rows()).toEqual(before);
    expect(unwrap(await listAudit(t.db))).toEqual([]);
  });
});

test("an unknown project is not_found — the path's resource — writing nothing", async () => {
  const before = await rows();
  const r = await add({
    workspace: "nowhere",
    profile: profileFor("builder", "runner-b", "nowhere"),
  });
  expect(r).toMatchObject({ ok: false, error: { class: "not_found" } });
  expect(!r.ok && r.error.message).toMatch(/project nowhere does not exist/);
  expect(await rows()).toEqual(before);
});

// An orchestrator: the door adds one to a project that has none, on an orchestrate
// profile, with no mission and the table's default pulse policy; at most one is enabled per project.
describe("createProjectAgent: an orchestrator", () => {
  const orchestrator = (runner = "runner-b", workspace = "demo") =>
    add({
      workspace,
      kind: "orchestrator",
      runner,
      profile: profileFor("orchestrator", runner, workspace),
    });

  /** An agent row as a hand-written config leaves it. */
  const seededOrchestrator = (
    id: string,
    workspace_id: string | null,
    enabled: number,
  ) => ({
    id,
    name: id,
    kind: "orchestrator" as const,
    runner_id: SPINE_SEED.runnerId,
    workspace_id,
    enabled,
    created_at: 2,
  });

  test("adds demo-orchestrator-1 on demo-orchestrate-runner-b, with no mission and the default pulse policy", async () => {
    const created = unwrap(await orchestrator());
    expect(created.profileCreated).toBe(true);
    expect(created.agent).toMatchObject({
      id: "demo-orchestrator-1",
      name: "demo-orchestrator-1",
      kind: "orchestrator",
      runner_id: "runner-b",
      executor_id: SPINE_SEED.executorId,
      profile_id: "demo-orchestrate-runner-b",
      workspace_id: "demo",
      mission_id: null,
      enabled: 1,
      // The columns' defaults (001_spine), as createProject's orchestrator starts on.
      pulse_mode: "hybrid",
      pulse_interval_ms: 5_400_000,
      pulse_debounce_ms: 60_000,
      pulse_min_gap_ms: 300_000,
      pulse_max_per_hour: 8,
      pulse_jitter_pct: 5,
    });
    expect((await rows()).profiles).toEqual([
      { id: "demo-orchestrate-runner-b", runner_id: "runner-b" },
    ]);
    expect(unwrap(await listAudit(t.db))).toMatchObject([
      {
        action: "agent.create",
        target_id: "demo-orchestrator-1",
        payload_json: JSON.stringify({
          via: "rest",
          workspace: "demo",
          kind: "orchestrator",
          runner: "runner-b",
          profile: "demo-orchestrate-runner-b",
        }),
      },
    ]);
  });

  test("a second while one is enabled is conflict naming it, writing nothing", async () => {
    unwrap(await orchestrator());
    const before = await rows();
    const r = await orchestrator(SPINE_SEED.runnerId);
    expect(r).toMatchObject({ ok: false, error: { class: "conflict" } });
    expect(!r.ok && r.error.message).toBe(
      "project demo already has an enabled orchestrator, demo-orchestrator-1: disable it before adding another",
    );
    expect(await rows()).toEqual(before);
    expect(unwrap(await listAudit(t.db))).toHaveLength(1);
  });

  test("a disabled one does not count: its replacement is demo-orchestrator-2, on the same profile", async () => {
    unwrap(await orchestrator());
    unwrap(
      await setAgentFromApi(t.db, "demo-orchestrator-1", { enabled: false }),
    );
    const created = unwrap(await orchestrator());
    expect(created).toMatchObject({
      profileCreated: false,
      agent: {
        id: "demo-orchestrator-2",
        profile_id: "demo-orchestrate-runner-b",
        enabled: 1,
      },
    });
    // The old one stays, disabled: nothing deletes an agent.
    expect(unwrap(await getAgent(t.db, "demo-orchestrator-1")).enabled).toBe(0);
  });

  test("another project's enabled orchestrator, and a fleet one, do not count", async () => {
    unwrap(
      await seedRows(t.db, {
        workspaces: [{ id: "other", name: "other", kind: "single" }],
        agents: [
          seededOrchestrator("other-orchestrator", "other", 1),
          seededOrchestrator("fleet-orchestrator", null, 1),
        ],
      }),
    );
    expect(unwrap(await orchestrator()).agent.id).toBe("demo-orchestrator-1");
  });
});
