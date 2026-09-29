import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { SPINE_SEED, seedRows, seedSpine, tempDb, unwrap } from "../testing.js";
import {
  getActiveModel,
  getAgent,
  getExecutor,
  getMission,
  getProfile,
  getRepo,
  getRunner,
  getSettings,
  getWorkspace,
  getWorkspaceRepos,
  setExecutorHealth,
} from "./config.js";
import { listExecutors } from "./registry-reads.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
const HASH = "0".repeat(64);
const runner_id = SPINE_SEED.runnerId;

unwrap(await seedSpine(t.db, 2));
unwrap(
  await seedRows(t.db, {
    models: [
      { id: "m-std", runner_id, tier: "standard", model: "m1" },
      { id: "m-old", runner_id, tier: "cheap", model: "m0", active: 0 },
    ],
    repos: [
      { id: "repo-b", name: "b", mirror_path: "/m/b" },
      {
        id: "repo-a",
        name: "a",
        mirror_path: "/m/a",
        doctrine_paths_json: '["DOCTRINE.md"]',
      },
    ],
    workspaces: [{ id: "ws", name: "ws", kind: "single" }],
    workspace_repos: [
      { workspace_id: "ws", repo_id: "repo-b", rel_path: "b" },
      { workspace_id: "ws", repo_id: "repo-a", rel_path: "a", role: "primary" },
    ],
    missions: [
      {
        id: "mis",
        agent_name: SPINE_SEED.agentName,
        version: 1,
        who_md: "who",
        what_md: "what",
        how_md: "how",
        laws_md: "laws",
        rendered_md: "# mission",
        hash: HASH,
        created_at: T0,
        created_by: "operator",
      },
    ],
    profiles: [
      {
        id: "prof",
        name: "prof",
        runner_id,
        model_tier: "standard",
        version: 1,
        hash: HASH,
        created_at: T0,
      },
    ],
    settings: [
      { key: "lifecycle.adopt_max", value_json: "3", updated_at: T0 },
      { key: "broken", value_json: "{", updated_at: T0 },
    ],
  }),
);

const notFound = { ok: false, error: { class: "not_found" } };

test("config reads return the row, and not_found for an unknown id", async () => {
  expect(unwrap(await getAgent(t.db, SPINE_SEED.agentId))).toMatchObject({
    runner_id,
  });
  expect(unwrap(await getProfile(t.db, "prof"))).toMatchObject({
    model_tier: "standard",
    permission_json: "{}",
  });
  expect(unwrap(await getRunner(t.db, runner_id))).toMatchObject({
    enabled: 1,
  });
  expect(unwrap(await getExecutor(t.db, SPINE_SEED.executorId))).toMatchObject({
    health: "unknown",
    slots: 4,
  });
  expect(unwrap(await getMission(t.db, "mis")).rendered_md).toBe("# mission");
  expect(unwrap(await getWorkspace(t.db, "ws")).kind).toBe("single");
  expect(unwrap(await getRepo(t.db, "repo-a"))).toMatchObject({
    name: "a",
    mirror_path: "/m/a",
    doctrine_paths_json: '["DOCTRINE.md"]',
  });
  for (const get of [
    getAgent,
    getProfile,
    getRunner,
    getExecutor,
    getMission,
    getWorkspace,
    getRepo,
  ]) {
    expect(await get(t.db, "nope")).toMatchObject(notFound);
  }
});

test("getWorkspaceRepos joins each repo with its path, by rel_path", async () => {
  const repos = unwrap(await getWorkspaceRepos(t.db, "ws"));
  expect(repos.map((r) => [r.id, r.rel_path, r.role])).toEqual([
    ["repo-a", "a", "primary"],
    ["repo-b", "b", "dep"],
  ]);
  expect(repos[0]).toMatchObject({
    mirror_path: "/m/a",
    doctrine_paths_json: '["DOCTRINE.md"]',
    default_base_branch: "main",
    has_submodules: 0,
    submodule_path: null,
  });
  expect(unwrap(await getWorkspaceRepos(t.db, "nope"))).toEqual([]);
});

test("getActiveModel finds only the active model of a tier", async () => {
  expect(unwrap(await getActiveModel(t.db, runner_id, "standard")).model).toBe(
    "m1",
  );
  expect(await getActiveModel(t.db, runner_id, "cheap")).toMatchObject(
    notFound,
  );
});

test("getSettings parses the rows it finds and leaves missing keys out", async () => {
  const found = unwrap(
    await getSettings(t.db, ["lifecycle.adopt_max", "missing"]),
  );
  expect([...found]).toEqual([["lifecycle.adopt_max", 3]]);
  expect(unwrap(await getSettings(t.db, [])).size).toBe(0);
  expect(await getSettings(t.db, ["broken"])).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("setExecutorHealth records the check time; listExecutors lists by id", async () => {
  await clock.advance(1_000);
  expect(
    unwrap(await setExecutorHealth(t.db, SPINE_SEED.executorId, "healthy")),
  ).toMatchObject({ health: "healthy", health_checked_at: T0 + 1_000 });
  expect(unwrap(await listExecutors(t.db)).map((e) => e.id)).toEqual([
    SPINE_SEED.executorId,
  ]);
  expect(await setExecutorHealth(t.db, "nope", "unhealthy")).toMatchObject(
    notFound,
  );
});

test("setExecutorHealth stores the detail as canonical JSON; a check without one clears it", async () => {
  const id = SPINE_SEED.executorId;
  expect(
    unwrap(
      await setExecutorHealth(t.db, id, "unhealthy", {
        rtt_ms: 312,
        failures: ["tunnel: down"],
      }),
    ),
  ).toMatchObject({
    health: "unhealthy",
    health_detail: '{"failures":["tunnel: down"],"rtt_ms":312}',
  });
  expect(unwrap(await setExecutorHealth(t.db, id, "healthy"))).toMatchObject({
    health: "healthy",
    health_detail: null,
  });
});
