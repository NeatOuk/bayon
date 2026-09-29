// The kill switch and the whitelisted settings against a real temp database: every
// change audited in its own transaction, an unchanged value writes nothing, a refused one neither.
import {
  FakeClock,
  FLEET_PAUSED_KEY,
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
} from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { getSettingRows } from "./config.js";
import {
  putOperatorSettings,
  setFleetPaused,
  setFleetPausedFromCli,
} from "./fleet-control.js";
import { getFleetOverview } from "./fleet-overview.js";

const T0 = 1_700_000_000_000;
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function fresh() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  opened.push(t);
  return { db: t.db, clock };
}

const stored = async (db: TempDb["db"], key: string) =>
  unwrap(await getSettingRows(db, [key])).get(key);

const pause = (paused: boolean) =>
  ({ paused, actor: "operator", via: "rest" }) as const;

test("pause writes fleet.paused=1 and one fleet.pause audit row; the Fleet shows it", async () => {
  const { db, clock } = await fresh();
  expect(unwrap(await getFleetOverview(db)).paused).toBe(false);
  await clock.advance(5_000);
  expect(unwrap(await setFleetPaused(db, pause(true)))).toEqual({
    paused: true,
    changed: true,
    updated_at: T0 + 5_000,
  });
  expect(await stored(db, FLEET_PAUSED_KEY)).toEqual({
    value: 1,
    updated_at: T0 + 5_000,
  });
  expect(unwrap(await getFleetOverview(db)).paused).toBe(true);
  expect(unwrap(await listAudit(db))).toMatchObject([
    {
      ts: T0 + 5_000,
      actor: "operator",
      action: "fleet.pause",
      target_kind: "setting",
      target_id: FLEET_PAUSED_KEY,
      payload_json: JSON.stringify({ via: "rest" }),
    },
  ]);
});

test("the same state again changes nothing: no write, no audit row, updated_at kept", async () => {
  const { db, clock } = await fresh();
  unwrap(await setFleetPaused(db, pause(true)));
  await clock.advance(1_000);
  expect(unwrap(await setFleetPaused(db, pause(true)))).toEqual({
    paused: true,
    changed: false,
    updated_at: T0,
  });
  expect(unwrap(await listAudit(db))).toHaveLength(1);
});

test("resume writes 0 and fleet.resume; the CLI's fallback is audited as the operator's via frm", async () => {
  const { db, clock } = await fresh();
  unwrap(await setFleetPausedFromCli(db, true));
  await clock.advance(2_000);
  expect(unwrap(await setFleetPaused(db, pause(false)))).toMatchObject({
    paused: false,
    changed: true,
  });
  expect(await stored(db, FLEET_PAUSED_KEY)).toEqual({
    value: 0,
    updated_at: T0 + 2_000,
  });
  const rows = unwrap(await listAudit(db));
  expect(rows.map((r) => [r.actor, r.action, r.payload_json])).toEqual([
    ["operator", "fleet.pause", JSON.stringify({ via: "frm" })],
    ["operator", "fleet.resume", JSON.stringify({ via: "rest" })],
  ]);
});

test("a fleet.paused that reads neither 0 nor 1 is repaired by a pause, audited", async () => {
  const { db } = await fresh();
  unwrap(
    await seedRows(db, {
      settings: [{ key: FLEET_PAUSED_KEY, value_json: '"yes"', updated_at: 1 }],
    }),
  );
  expect(await getFleetOverview(db)).toMatchObject({
    ok: false,
    error: { class: "internal" },
  });
  expect(unwrap(await setFleetPaused(db, pause(true))).changed).toBe(true);
  expect((await stored(db, FLEET_PAUSED_KEY))?.value).toBe(1);
});

test("a pause with no actor is refused and writes nothing", async () => {
  const { db } = await fresh();
  expect(
    await setFleetPaused(db, { paused: true, actor: " ", via: "rest" }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect((await stored(db, FLEET_PAUSED_KEY))?.value).toBe(0);
  expect(unwrap(await listAudit(db))).toEqual([]);
});

test("the migrations seed every whitelisted key at its default", async () => {
  const { db } = await fresh();
  const rows = unwrap(await getSettingRows(db, OPERATOR_SETTING_KEYS));
  for (const key of OPERATOR_SETTING_KEYS) {
    expect([key, rows.get(key)?.value]).toEqual([
      key,
      OPERATOR_SETTINGS[key].default,
    ]);
  }
});

test("putOperatorSettings writes each change with a settings.put row {from, to}; an unchanged key is skipped", async () => {
  const { db, clock } = await fresh();
  await clock.advance(3_000);
  const changes = unwrap(
    await putOperatorSettings(
      db,
      { "admission.recheck_ms": 2_000, "backup.keep": 14, "backup.enabled": 0 },
      "operator",
    ),
  );
  expect(changes).toEqual([
    { key: "admission.recheck_ms", from: 5_000, to: 2_000 },
    { key: "backup.enabled", from: 1, to: 0 },
  ]);
  expect(await stored(db, "admission.recheck_ms")).toEqual({
    value: 2_000,
    updated_at: T0 + 3_000,
  });
  const rows = unwrap(await listAudit(db));
  expect(
    rows.map((r) => [r.action, r.target_kind, r.target_id, r.payload_json]),
  ).toEqual([
    [
      "settings.put",
      "setting",
      "admission.recheck_ms",
      JSON.stringify({ via: "rest", from: 5_000, to: 2_000 }),
    ],
    [
      "settings.put",
      "setting",
      "backup.enabled",
      JSON.stringify({ via: "rest", from: 1, to: 0 }),
    ],
  ]);
});

test.each([
  [{ "admission.recheck_ms": 2_000, "executors.untrusted_roles": [] }],
  [{ "admission.recheck_ms": 2_000, "fleet.paused": 1 }],
  [{ "admission.recheck_ms": 2_000, "backup.at_utc_hour": 24 }],
  [{ "admission.recheck_ms": "2000" }],
  [{}],
])("%j is refused whole: nothing written, nothing audited", async (patch) => {
  const { db } = await fresh();
  expect(await putOperatorSettings(db, patch, "operator")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect((await stored(db, "admission.recheck_ms"))?.value).toBe(5_000);
  expect(unwrap(await listAudit(db))).toEqual([]);
});
