import { FakeClock } from "@bayon/core";
import { afterAll, beforeEach, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import { tempDb, unwrap } from "../testing.js";
import {
  deactivateOperatorModel,
  putOperatorModel,
  type OperatorModel,
} from "./operator-models.js";
import { upsertRegistration, type NewModel } from "./registration.js";

// Standby rows (050): a registration moves its tier to a new model and keeps the old one
// registered, inactive, with its certificates, so the operator can switch back. The shape of the
// live upgrade: `r1.complex` (certified, active) is kept on standby and `r1.complex-next` takes the
// tier. The old id sorts first, so a refill by id alone would bring the old model back.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));

const RUNNER = "r1";
const row = (
  id: string,
  tier: NewModel["tier"],
  o: Partial<NewModel> = {},
): NewModel => ({
  id,
  tier,
  model: `model-${id}`,
  price_in_per_mtok: 1,
  price_out_per_mtok: 2,
  context_tokens: 200_000,
  ...o,
});
const boot = async (models: readonly NewModel[]) =>
  unwrap(
    await upsertRegistration(t.db, {
      runner: { id: RUNNER, kind: "script", adapter: RUNNER, caps_json: "{}" },
      models,
    }),
  );

/** Before: one model per tier. After: the new complex row, the old one on standby. */
const BEFORE = [row("r1.complex", "complex"), row("r1.cheap", "cheap")];
const AFTER = [
  row("r1.complex-next", "complex", { context_tokens: 1_000_000 }),
  row("r1.complex", "complex", { standby: 1 }),
  row("r1.cheap", "cheap"),
];

const state = () =>
  raw
    .prepare(
      `SELECT id, tier, model, active, standby, source, retired_at
       FROM models WHERE runner_id = ? ORDER BY id`,
    )
    .all(RUNNER);
const activeOf = (tier: string) =>
  raw
    .prepare(
      "SELECT id FROM models WHERE runner_id = ? AND tier = ? AND active = 1",
    )
    .pluck()
    .all(RUNNER, tier);

const op = (id: string, o: Partial<OperatorModel> = {}): OperatorModel => ({
  id,
  runner_id: RUNNER,
  tier: "complex",
  model: `model-${id}`,
  effort: null,
  price_in_per_mtok: 1,
  price_out_per_mtok: 2,
  price_cache_read_per_mtok: null,
  price_cache_write_per_mtok: null,
  context_tokens: 200_000,
  settings_json: "{}",
  active: true,
  ...o,
});
const upsert = { via: "rest", mode: "upsert" } as const;

beforeEach(() => {
  raw.prepare("DELETE FROM audit_log").run();
  raw.prepare("DELETE FROM models").run();
});

test("the new row takes the tier; the old one stays registered on standby, its string unchanged", async () => {
  await boot(BEFORE);
  await boot(AFTER);
  expect(state()).toEqual([
    {
      id: "r1.cheap",
      tier: "cheap",
      model: "model-r1.cheap",
      active: 1,
      standby: 0,
      source: "adapter",
      retired_at: null,
    },
    {
      id: "r1.complex",
      tier: "complex",
      model: "model-r1.complex",
      active: 0,
      standby: 1,
      source: "adapter",
      retired_at: null,
    },
    {
      id: "r1.complex-next",
      tier: "complex",
      model: "model-r1.complex-next",
      active: 1,
      standby: 0,
      source: "adapter",
      retired_at: null,
    },
  ]);
  // Every boot after is the same.
  const once = state();
  await boot(AFTER);
  expect(state()).toEqual(once);
});

test("a row that leaves standby is active again and its stored flag is rewritten", async () => {
  await boot(AFTER);
  await boot([
    row("r1.complex-next", "complex", { standby: 1 }),
    row("r1.complex", "complex"),
    row("r1.cheap", "cheap"),
  ]);
  expect(activeOf("complex")).toEqual(["r1.complex"]);
  expect(
    raw
      .prepare(
        "SELECT id, standby FROM models WHERE tier = 'complex' ORDER BY id",
      )
      .all(),
  ).toEqual([
    { id: "r1.complex", standby: 0 },
    { id: "r1.complex-next", standby: 1 },
  ]);
});

test("the operator switches back to the standby row, and the next boot keeps it", async () => {
  await boot(AFTER);
  // PATCH /runners/r1/models/r1.complex {"active": true}: the row becomes the operator's.
  const put = unwrap(await putOperatorModel(t.db, op("r1.complex"), upsert));
  expect(put.replaced).toEqual(["r1.complex-next"]);
  await boot(AFTER);
  expect(activeOf("complex")).toEqual(["r1.complex"]);
  expect(
    raw
      .prepare("SELECT source FROM models WHERE id = 'r1.complex'")
      .pluck()
      .get(),
  ).toBe("operator");
});

test("an operator row leaving the tier gives it back to the row not on standby, not the lowest id", async () => {
  await boot(AFTER);
  unwrap(await putOperatorModel(t.db, op("mine"), upsert));
  expect(activeOf("complex")).toEqual(["mine"]);
  unwrap(await deactivateOperatorModel(t.db, RUNNER, "mine", "rest"));
  // As the next boot would: r1.complex sorts first, but it is on standby.
  expect(activeOf("complex")).toEqual(["r1.complex-next"]);
  await boot(AFTER);
  expect(activeOf("complex")).toEqual(["r1.complex-next"]);
});
