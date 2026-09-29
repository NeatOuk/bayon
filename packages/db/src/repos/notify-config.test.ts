// The notifier's three destination settings through the API door, against a real temp
// database: those three names and no other, each value checked by core's schema, every change
// audited as `notify.config` with both values, and an unchanged value writing neither row.
import {
  FakeClock,
  NOTIFY_BASE_URL_KEY,
  NOTIFY_EMAIL_FROM_KEY,
  NOTIFY_EMAIL_TO_KEY,
} from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import { listAudit, tempDb, unwrap, type TempDb } from "../testing.js";
import { getSettingRows } from "./config.js";
import {
  NOTIFY_CONFIG_ACTION,
  getNotifyConfig,
  putNotifyConfig,
} from "./notify-config.js";

const T0 = 1_700_000_000_000;
const OPERATOR = "operator";
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function fresh() {
  const t = unwrap(await tempDb(new FakeClock(T0)));
  opened.push(t);
  return t.db;
}

const stored = async (db: TempDb["db"], key: string) =>
  unwrap(await getSettingRows(db, [key])).get(key)?.value;

const configRows = async (db: TempDb["db"]) =>
  unwrap(await listAudit(db)).filter(
    (row) => row.action === NOTIFY_CONFIG_ACTION,
  );

test("a change writes the setting and one notify.config row naming both values", async () => {
  const db = await fresh();
  const written = unwrap(
    await putNotifyConfig(db, { email_to: "ops@example.test" }, OPERATOR),
  );
  expect(written).toEqual([
    {
      field: "email_to",
      key: NOTIFY_EMAIL_TO_KEY,
      from: "",
      to: "ops@example.test",
      auditId: expect.any(Number),
    },
  ]);
  expect(await stored(db, NOTIFY_EMAIL_TO_KEY)).toBe("ops@example.test");

  const rows = await configRows(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actor: OPERATOR,
    action: NOTIFY_CONFIG_ACTION,
    target_kind: "setting",
    target_id: NOTIFY_EMAIL_TO_KEY,
  });
  expect(JSON.parse(rows[0]?.payload_json ?? "null")).toEqual({
    field: "email_to",
    from: "",
    to: "ops@example.test",
  });
  expect(rows[0]?.id).toBe(written[0]?.auditId);
});

test("the value it already has writes neither row, so the alert is not sent twice", async () => {
  const db = await fresh();
  unwrap(
    await putNotifyConfig(db, { base_url: "https://b.example.test" }, OPERATOR),
  );
  const again = unwrap(
    await putNotifyConfig(db, { base_url: "https://b.example.test" }, OPERATOR),
  );
  expect(again).toEqual([]);
  expect(await configRows(db)).toHaveLength(1);
});

test("the previous value is carried, so the alert can name what it replaced", async () => {
  const db = await fresh();
  unwrap(await putNotifyConfig(db, { email_to: "old@example.test" }, OPERATOR));
  const changed = unwrap(
    await putNotifyConfig(db, { email_to: "new@example.test" }, OPERATOR),
  );
  expect(changed[0]).toMatchObject({
    from: "old@example.test",
    to: "new@example.test",
  });
});

test("all three at once, and getNotifyConfig reads them back", async () => {
  const db = await fresh();
  expect(unwrap(await getNotifyConfig(db))).toEqual({
    email_to: "",
    email_from: "",
    base_url: "",
  });
  unwrap(
    await putNotifyConfig(
      db,
      {
        email_to: "ops@example.test",
        email_from: "bayon@example.test",
        base_url: "https://bayon.example.test:5173",
      },
      OPERATOR,
    ),
  );
  expect(unwrap(await getNotifyConfig(db))).toEqual({
    email_to: "ops@example.test",
    email_from: "bayon@example.test",
    base_url: "https://bayon.example.test:5173",
  });
  expect(await configRows(db)).toHaveLength(3);
});

test("an empty string unsets a field", async () => {
  const db = await fresh();
  unwrap(await putNotifyConfig(db, { email_to: "ops@example.test" }, OPERATOR));
  unwrap(await putNotifyConfig(db, { email_to: "" }, OPERATOR));
  expect(unwrap(await getNotifyConfig(db)).email_to).toBe("");
});

test.each([
  [{ email_to: "not-an-address" }, "email_to"],
  [{ email_from: "a@b@c" }, "email_from"],
  [{ base_url: "https://bayon.example.test/inbox" }, "base_url"],
  [{ base_url: "https://user:pw@bayon.example.test" }, "base_url"],
  [{ base_url: "notaurl" }, "base_url"],
])("%j is refused and writes nothing", async (patch, field) => {
  const db = await fresh();
  const refused = await putNotifyConfig(db, patch, OPERATOR);
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.error.class).toBe("validation");
    expect(refused.error.message).toContain(field);
  }
  expect(await configRows(db)).toHaveLength(0);
  expect(unwrap(await getNotifyConfig(db))).toEqual({
    email_to: "",
    email_from: "",
    base_url: "",
  });
});

test("only those three keys are writable, and one bad name refuses the whole patch", async () => {
  const db = await fresh();
  for (const patch of [
    { "notify.email.to": "ops@example.test" },
    { "admission.require_certified": 0 },
    { "executors.untrusted_roles": "reviewer" },
  ]) {
    const refused = await putNotifyConfig(db, patch, OPERATOR);
    expect(refused.ok).toBe(false);
  }
  const mixed = await putNotifyConfig(
    db,
    { email_to: "ops@example.test", "backup.keep": 1 },
    OPERATOR,
  );
  expect(mixed.ok).toBe(false);
  // The migration seeds the three empty, which is unset: a refused patch leaves them there.
  expect(await stored(db, NOTIFY_EMAIL_TO_KEY)).toBe("");
  expect(await configRows(db)).toHaveLength(0);
});

test("an empty patch and an actorless change are refused", async () => {
  const db = await fresh();
  expect((await putNotifyConfig(db, {}, OPERATOR)).ok).toBe(false);
  expect(
    (await putNotifyConfig(db, { email_from: "a@example.test" }, " ")).ok,
  ).toBe(false);
  expect(await stored(db, NOTIFY_EMAIL_FROM_KEY)).toBe("");
  expect(await stored(db, NOTIFY_BASE_URL_KEY)).toBe("");
});
