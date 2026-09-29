import { FakeClock } from "@bayon/core";
import { afterAll, beforeEach, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import { tempDb, unwrap } from "../testing.js";
import {
  deactivateOperatorModel,
  putOperatorModel,
  type OperatorModel,
} from "./operator-models.js";
import { seedConfig } from "./operator.js";
import { upsertRegistration, type NewModel } from "./registration.js";

// The operator's models: the tier rule, the source rule across a boot, the fixed model
// string, idempotence and the audit rows.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));

const RUNNER = "r1";
const registered = (id: string, tier: NewModel["tier"]): NewModel => ({
  id,
  tier,
  model: `model-${id}`,
  price_in_per_mtok: 1,
  price_out_per_mtok: 2,
});
const boot = async () =>
  unwrap(
    await upsertRegistration(t.db, {
      runner: {
        id: RUNNER,
        kind: "script",
        adapter: RUNNER,
        caps_json: "{}",
      },
      models: [
        registered("r1.complex", "complex"),
        registered("r1.cheap", "cheap"),
      ],
    }),
  );

const op = (id: string, o: Partial<OperatorModel> = {}): OperatorModel => ({
  id,
  runner_id: RUNNER,
  tier: "complex",
  model: `own-${id}`,
  effort: null,
  price_in_per_mtok: 0,
  price_out_per_mtok: 0,
  price_cache_read_per_mtok: null,
  price_cache_write_per_mtok: null,
  context_tokens: 32_768,
  settings_json: "{}",
  active: true,
  ...o,
});
const upsert = { via: "rest", mode: "upsert" } as const;

const state = () =>
  raw
    .prepare(
      "SELECT id, tier, active, source FROM models WHERE runner_id = ? ORDER BY id",
    )
    .all(RUNNER);
const audits = () =>
  raw
    .prepare(
      "SELECT action, target_id, payload_json FROM audit_log WHERE target_kind = 'model' ORDER BY id",
    )
    .all() as { action: string; target_id: string; payload_json: string }[];

beforeEach(() => {
  raw.prepare("DELETE FROM audit_log").run();
  raw.prepare("DELETE FROM models").run();
});

test("an operator row replaces the adapter's in its tier, and survives the next boot", async () => {
  await boot();
  const put = unwrap(await putOperatorModel(t.db, op("mine"), upsert));
  expect(put).toEqual({ changed: true, replaced: ["r1.complex"] });
  await boot();
  expect(state()).toEqual([
    { id: "mine", tier: "complex", active: 1, source: "operator" },
    { id: "r1.cheap", tier: "cheap", active: 1, source: "adapter" },
    { id: "r1.complex", tier: "complex", active: 0, source: "adapter" },
  ]);
  const [audit] = audits();
  expect(audit?.action).toBe("model.put");
  expect(JSON.parse(audit?.payload_json ?? "null")).toMatchObject({
    via: "rest",
    runner_id: RUNNER,
    from: null,
    to: { tier: "complex", model: "own-mine", active: true, settings: {} },
    replaced: ["r1.complex"],
  });
});

test("a second active operator row in a tier is refused, and nothing is written", async () => {
  await boot();
  unwrap(await putOperatorModel(t.db, op("mine"), upsert));
  const before = state();
  const refused = await putOperatorModel(t.db, op("other"), upsert);
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.error.class).toBe("conflict");
  expect(refused.error.message).toContain(
    "already runs operator model mine in tier complex",
  );
  expect(state()).toEqual(before);
  // Inactive, it fits beside it.
  unwrap(await putOperatorModel(t.db, op("other", { active: false }), upsert));
  expect(audits()).toHaveLength(2);
});

test("the same row twice writes nothing the second time; a changed price writes and audits", async () => {
  await boot();
  unwrap(await putOperatorModel(t.db, op("mine"), upsert));
  expect(unwrap(await putOperatorModel(t.db, op("mine"), upsert))).toEqual({
    changed: false,
    replaced: [],
  });
  expect(audits()).toHaveLength(1);
  unwrap(
    await putOperatorModel(t.db, op("mine", { price_in_per_mtok: 3 }), upsert),
  );
  const last = audits().at(-1);
  expect(JSON.parse(last?.payload_json ?? "null")).toMatchObject({
    from: { price_in_per_mtok: 0 },
    to: { price_in_per_mtok: 3 },
  });
});

test("a stored model string is fixed; create refuses an existing id; another runner's id is refused", async () => {
  await boot();
  unwrap(await putOperatorModel(t.db, op("mine"), upsert));
  const renamed = await putOperatorModel(
    t.db,
    op("mine", { model: "else" }),
    upsert,
  );
  expect(!renamed.ok && renamed.error.class).toBe("validation");
  const again = await putOperatorModel(t.db, op("mine"), {
    via: "rest",
    mode: "create",
  });
  expect(!again.ok && again.error.class).toBe("conflict");
  raw
    .prepare(
      "INSERT INTO runners (id, kind, adapter, caps_json) VALUES ('r2', 'script', 'r2', '{}')",
    )
    .run();
  const foreign = await putOperatorModel(
    t.db,
    op("mine", { runner_id: "r2" }),
    upsert,
  );
  expect(!foreign.ok && foreign.error.message).toContain("is runner r1's");
});

test("an unknown runner is refused by its foreign key", async () => {
  const refused = await putOperatorModel(
    t.db,
    op("x", { runner_id: "nope" }),
    upsert,
  );
  expect(!refused.ok && refused.error.class).toBe("validation");
});

test("deactivating the operator's row gives the tier back to the adapter's; moving tiers does too", async () => {
  await boot();
  unwrap(await putOperatorModel(t.db, op("mine"), upsert));
  unwrap(await deactivateOperatorModel(t.db, RUNNER, "mine", "rest"));
  expect(state()).toContainEqual({
    id: "r1.complex",
    tier: "complex",
    active: 1,
    source: "adapter",
  });
  // Active again (replacing the adapter's), then moved to standard: complex is refilled.
  unwrap(await putOperatorModel(t.db, op("mine"), upsert));
  unwrap(
    await putOperatorModel(t.db, op("mine", { tier: "standard" }), upsert),
  );
  expect(state()).toEqual([
    { id: "mine", tier: "standard", active: 1, source: "operator" },
    { id: "r1.cheap", tier: "cheap", active: 1, source: "adapter" },
    { id: "r1.complex", tier: "complex", active: 1, source: "adapter" },
  ]);
  expect(audits().map((a) => a.action)).toEqual([
    "model.put",
    "model.deactivate",
    "model.put",
    "model.put",
  ]);
});

test("deactivating an adapter row makes it the operator's, so the next boot keeps it off", async () => {
  await boot();
  expect(
    unwrap(await deactivateOperatorModel(t.db, RUNNER, "r1.cheap", "frm")),
  ).toEqual({ changed: true });
  await boot();
  expect(state()).toContainEqual({
    id: "r1.cheap",
    tier: "cheap",
    active: 0,
    source: "operator",
  });
  expect(
    unwrap(await deactivateOperatorModel(t.db, RUNNER, "r1.cheap", "frm")),
  ).toEqual({ changed: false });
  const missing = await deactivateOperatorModel(t.db, "r2", "r1.cheap", "frm");
  expect(!missing.ok && missing.error.class).toBe("not_found");
});

test("seedConfig writes models in its one transaction: a refused model writes none of the file", async () => {
  await boot();
  unwrap(await putOperatorModel(t.db, op("mine"), upsert));
  const refused = await seedConfig(t.db, {
    run_classes: [
      {
        name: "operator-models-test",
        context_tokens_cap: 1,
        max_turns: 1,
        max_tool_calls: 1,
        wall_clock_ms: 1,
        cost_cap_usd: 1,
        handoff_at_turns: 1,
        default_tier: "cheap",
      },
    ],
    models: [op("other")],
  });
  expect(!refused.ok && refused.error.class).toBe("conflict");
  expect(
    raw
      .prepare(
        "SELECT COUNT(*) FROM run_classes WHERE name = 'operator-models-test'",
      )
      .pluck()
      .get(),
  ).toBe(0);
  unwrap(await seedConfig(t.db, { models: [op("mine", { effort: "high" })] }));
  const last = audits().at(-1);
  expect(JSON.parse(last?.payload_json ?? "null")).toMatchObject({
    via: "frm",
    to: { effort: "high" },
  });
});
