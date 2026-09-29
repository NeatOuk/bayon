import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import { tempDb, unwrap } from "../testing.js";
import {
  upsertExecutor,
  upsertRegistration,
  type NewModel,
  type NewRunner,
} from "./registration.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));

const runner: NewRunner = {
  id: "fixture",
  kind: "script",
  adapter: "fixture",
  version_detected: "1.0.0",
  caps_json: '{"structuredEvents":true}',
};
const model = (id: string, tier: NewModel["tier"]): NewModel => ({
  id,
  tier,
  model: `model-${id}`,
  price_in_per_mtok: 1,
});

const runnerRow = () =>
  raw.prepare("SELECT * FROM runners WHERE id = ?").get(runner.id);
const models = () =>
  raw
    .prepare(
      "SELECT id, tier, active, retired_at FROM models WHERE runner_id = ? ORDER BY id",
    )
    .all(runner.id);

test("registration inserts the runner and its models", async () => {
  unwrap(
    await upsertRegistration(t.db, {
      runner,
      models: [model("a", "complex"), model("b", "standard")],
    }),
  );
  expect(runnerRow()).toMatchObject({
    ...runner,
    enabled: 1,
    defaults_json: "{}",
  });
  expect(models()).toEqual([
    { id: "a", tier: "complex", active: 1, retired_at: null },
    { id: "b", tier: "standard", active: 1, retired_at: null },
  ]);
});

test("re-registration refreshes the runner but keeps conformance_* and enabled", async () => {
  raw
    .prepare(
      `UPDATE runners SET conformance_version = '1.0.0', conformance_passed_at = 7,
         conformance_report_path = '/r.json', enabled = 0 WHERE id = ?`,
    )
    .run(runner.id);
  unwrap(
    await upsertRegistration(t.db, {
      runner: { ...runner, version_detected: "2.0.0" },
      models: [model("a", "complex"), model("b", "standard")],
    }),
  );
  expect(runnerRow()).toMatchObject({
    version_detected: "2.0.0",
    conformance_version: "1.0.0",
    conformance_passed_at: 7,
    conformance_report_path: "/r.json",
    enabled: 0,
  });
});

test("absent models are retired, never deleted, and tiers can swap", async () => {
  await clock.advance(1_000);
  unwrap(
    await upsertRegistration(t.db, {
      runner,
      models: [model("a", "standard"), model("c", "complex")],
    }),
  );
  expect(models()).toEqual([
    { id: "a", tier: "standard", active: 1, retired_at: null },
    { id: "b", tier: "standard", active: 0, retired_at: T0 + 1_000 },
    { id: "c", tier: "complex", active: 1, retired_at: null },
  ]);
  await clock.advance(1_000);
  unwrap(
    await upsertRegistration(t.db, {
      runner,
      models: [
        model("a", "complex"),
        model("b", "standard"),
        model("c", "cheap"),
      ],
    }),
  );
  expect(models()).toEqual([
    { id: "a", tier: "complex", active: 1, retired_at: null },
    { id: "b", tier: "standard", active: 1, retired_at: null },
    { id: "c", tier: "cheap", active: 1, retired_at: null },
  ]);
});

test("two models in one tier is a conflict, and nothing changes", async () => {
  const before = models();
  expect(
    await upsertRegistration(t.db, {
      runner,
      models: [model("a", "cheap"), model("d", "cheap")],
    }),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
  expect(models()).toEqual(before);
});

test("upsertExecutor inserts, then updates without touching health, enabled or slots", async () => {
  unwrap(
    await upsertExecutor(t.db, {
      id: "local",
      kind: "local",
      config_json: "{}",
      slots: 3,
    }),
  );
  raw
    .prepare(
      "UPDATE executors SET health = 'ok', enabled = 0 WHERE id = 'local'",
    )
    .run();
  unwrap(
    await upsertExecutor(t.db, {
      id: "local",
      kind: "local",
      config_json: '{"root":"/w"}',
      slots: 8,
    }),
  );
  expect(
    raw.prepare("SELECT * FROM executors WHERE id = 'local'").get(),
  ).toMatchObject({
    config_json: '{"root":"/w"}',
    // Boot re-upserts the local row every start: the operator's capacity survives it.
    slots: 3,
    health: "ok",
    enabled: 0,
  });
});

test("an executor kind outside the CHECK is a validation error", async () => {
  expect(
    await upsertExecutor(t.db, {
      id: "odd",
      kind: "vm" as unknown as "local",
      config_json: "{}",
    }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
});
