import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { tempDb, unwrap } from "../testing.js";
import { seedConfig } from "./operator.js";
import { upsertExecutor, upsertRegistration } from "./registration.js";
import {
  listExecutors,
  listModels,
  listRunners,
  listWorkspaces,
} from "./registry-reads.js";

const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());

test("the registry reads return what registration wrote, by id", async () => {
  expect(unwrap(await listRunners(t.db))).toEqual([]);
  unwrap(
    await upsertRegistration(t.db, {
      runner: { id: "r1", kind: "script", adapter: "r1", caps_json: "{}" },
      models: [
        { id: "r1.b", tier: "standard", model: "m-b" },
        { id: "r1.a", tier: "complex", model: "m-a" },
      ],
    }),
  );
  unwrap(
    await upsertExecutor(t.db, {
      id: "local",
      kind: "local",
      config_json: "{}",
    }),
  );
  expect(unwrap(await listRunners(t.db))).toMatchObject([
    { id: "r1", kind: "script", enabled: 1 },
  ]);
  expect(unwrap(await listModels(t.db)).map((m) => [m.id, m.active])).toEqual([
    ["r1.a", 1],
    ["r1.b", 1],
  ]);
  expect(unwrap(await listExecutors(t.db))).toMatchObject([
    { id: "local", kind: "local", enabled: 1 },
  ]);
});

test("listWorkspaces returns every row ordered by name", async () => {
  expect(unwrap(await listWorkspaces(t.db))).toEqual([]);
  unwrap(
    await seedConfig(t.db, {
      workspaces: [
        { id: "w-b", name: "b-workspace", kind: "single" },
        { id: "w-a", name: "a-workspace", kind: "multi" },
      ],
    }),
  );
  expect(unwrap(await listWorkspaces(t.db))).toMatchObject([
    { id: "w-a", name: "a-workspace", kind: "multi" },
    { id: "w-b", name: "b-workspace", kind: "single" },
  ]);
});
