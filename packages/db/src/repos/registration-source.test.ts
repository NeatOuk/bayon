import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import { tempDb, unwrap } from "../testing.js";
import {
  upsertRegistration,
  type NewModel,
  type NewRunner,
} from "./registration.js";

// The source rule (046): boot writes adapter rows only. An operator row is never
// overwritten, retired or deactivated, and an adapter row stays inactive while an operator row is
// active in its (runner, tier), so one row per (runner, tier) is active after every boot.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));

const runner: NewRunner = {
  id: "fixture",
  kind: "script",
  adapter: "fixture",
  version_detected: "1.0.0",
  caps_json: "{}",
};
const model = (id: string, tier: NewModel["tier"], price = 1): NewModel => ({
  id,
  tier,
  model: `model-${id}`,
  price_in_per_mtok: price,
  price_out_per_mtok: price,
});
const boot = async (models: readonly NewModel[]) =>
  unwrap(await upsertRegistration(t.db, { runner, models }));

const rows = () =>
  raw
    .prepare(
      `SELECT id, tier, model, active, retired_at, source, settings_json, price_in_per_mtok
       FROM models WHERE runner_id = ? ORDER BY id`,
    )
    .all(runner.id);
const activePerTier = () =>
  raw
    .prepare(
      "SELECT tier, COUNT(*) AS n FROM models WHERE runner_id = ? AND active = 1 GROUP BY tier ORDER BY tier",
    )
    .all(runner.id);

test("boot never overwrites, retires or deactivates an operator row, and keeps one active per tier", async () => {
  await boot([model("a", "complex"), model("b", "standard")]);
  // The operator replaces a's tier with their own row, and takes b over at their own price.
  raw.prepare("UPDATE models SET active = 0 WHERE id = 'a'").run();
  raw
    .prepare(
      `INSERT INTO models (id, runner_id, tier, model, price_in_per_mtok, price_out_per_mtok,
         active, source, settings_json)
       VALUES ('op', ?, 'complex', 'own-model', 0, 0, 1, 'operator', '{"k":1}')`,
    )
    .run(runner.id);
  raw
    .prepare(
      "UPDATE models SET source = 'operator', price_in_per_mtok = 9 WHERE id = 'b'",
    )
    .run();

  // The adapter re-registers b at another price and adds c; a is still listed.
  await boot([
    model("a", "complex"),
    model("b", "standard", 2),
    model("c", "cheap"),
  ]);
  expect(rows()).toEqual([
    // Inactive: the operator's row holds its tier. Not retired: still registered.
    {
      id: "a",
      tier: "complex",
      model: "model-a",
      active: 0,
      retired_at: null,
      source: "adapter",
      settings_json: "{}",
      price_in_per_mtok: 1,
    },
    // The operator's price stands.
    {
      id: "b",
      tier: "standard",
      model: "model-b",
      active: 1,
      retired_at: null,
      source: "operator",
      settings_json: "{}",
      price_in_per_mtok: 9,
    },
    {
      id: "c",
      tier: "cheap",
      model: "model-c",
      active: 1,
      retired_at: null,
      source: "adapter",
      settings_json: "{}",
      price_in_per_mtok: 1,
    },
    {
      id: "op",
      tier: "complex",
      model: "own-model",
      active: 1,
      retired_at: null,
      source: "operator",
      settings_json: '{"k":1}',
      price_in_per_mtok: 0,
    },
  ]);
  expect(activePerTier()).toEqual([
    { tier: "cheap", n: 1 },
    { tier: "complex", n: 1 },
    { tier: "standard", n: 1 },
  ]);
});

test("a registration that lists nothing retires its own rows and none of the operator's", async () => {
  await boot([]);
  const byId = new Map(
    (rows() as { id: string; active: number; retired_at: number | null }[]).map(
      (r) => [r.id, r],
    ),
  );
  expect(byId.get("c")).toMatchObject({ active: 0, retired_at: clock.now() });
  expect(byId.get("op")).toMatchObject({ active: 1, retired_at: null });
  expect(byId.get("b")).toMatchObject({ active: 1, retired_at: null });
});

test("once the operator's row is inactive, the next boot activates the adapter's row of that tier", async () => {
  raw.prepare("UPDATE models SET active = 0 WHERE id = 'op'").run();
  await boot([
    model("a", "complex"),
    model("b", "standard"),
    model("c", "cheap"),
  ]);
  const active = (rows() as { id: string; active: number }[]).filter(
    (r) => r.active === 1,
  );
  expect(active.map((r) => r.id)).toEqual(["a", "b", "c"]);
});
