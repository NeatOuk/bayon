import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, seedSpine, tempDb, ticketRow, unwrap } from "./testing.js";

// The notifications migration: the outbox, its deliveries and the notifier's
// watermarks, and the fourteen seeded `notify.*` settings, on an empty database and on one already
// holding projects, tickets and an operator's own value; up, down and up again.
//
// Planned as 035 after 034. The runner refuses a gap, so it is 034 until that lands:
// the rename is the two SQL files, this file's name and VERSION.
const VERSION = 34;

const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const Names = z.array(z.object({ name: z.string() }));
const tablesOf = (db: Db) =>
  Names.parse(
    rawOf(db)
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'notification%' ORDER BY name",
      )
      .all(),
  ).map((r) => r.name);

const Setting = z.array(z.object({ key: z.string(), value_json: z.string() }));
const notifySettings = (db: Db) =>
  Object.fromEntries(
    Setting.parse(
      rawOf(db)
        .prepare(
          "SELECT key, value_json FROM settings WHERE key LIKE 'notify.%' ORDER BY key",
        )
        .all(),
    ).map((r) => [r.key, r.value_json]),
  );

const SEEDED = {
  "notify.base_url": '""',
  "notify.email.enabled": "0",
  "notify.email.events": "127",
  "notify.email.from": '""',
  "notify.email.to": '""',
  "notify.mac.enabled": "0",
  "notify.mac.events": "127",
  "notify.ntfy.enabled": "0",
  "notify.ntfy.events": "127",
  "notify.poll_ms": "15000",
  "notify.quiet_end_hour": "-1",
  "notify.quiet_start_hour": "-1",
  "notify.webhook.enabled": "0",
  "notify.webhook.events": "127",
};

const insertNotification = (
  db: Db,
  id: string,
  key: string,
  o: object = {},
) => {
  const row = {
    id,
    event_kind: "question",
    dedupe_key: key,
    workspace_id: null,
    ticket_id: null,
    title: "t",
    body: "b",
    link_path: "#/inbox",
    created_at: 1,
    ...o,
  };
  return rawOf(db)
    .prepare(
      "INSERT INTO notifications (id, event_kind, dedupe_key, workspace_id, ticket_id, title, body, link_path, created_at) VALUES (@id, @event_kind, @dedupe_key, @workspace_id, @ticket_id, @title, @body, @link_path, @created_at)",
    )
    .run(row);
};

test("on an empty database: three tables, their checks and keys, the settings seeded; down removes all", async () => {
  const db = await dbAt(VERSION - 1);
  expect(tablesOf(db)).toEqual([]);
  expect(notifySettings(db)).toEqual({});

  unwrap(await migrateUp(db, { to: VERSION }));
  expect(await version(db)).toBe(VERSION);
  expect(tablesOf(db)).toEqual([
    "notification_cursors",
    "notification_deliveries",
    "notifications",
  ]);
  expect(notifySettings(db)).toEqual(SEEDED);

  insertNotification(db, "N1", "request:1");
  // The dedupe key is unique: the database refuses a second row for one moment.
  expect(() => insertNotification(db, "N2", "request:1")).toThrow(/UNIQUE/);
  // The caps and the hash path are the table's own checks, whatever writes it.
  expect(() =>
    insertNotification(db, "N3", "k3", { body: "x".repeat(1_001) }),
  ).toThrow(/CHECK/);
  expect(() => insertNotification(db, "N4", "k4", { title: "" })).toThrow(
    /CHECK/,
  );
  expect(() =>
    insertNotification(db, "N5", "k5", { link_path: "https://evil.test/" }),
  ).toThrow(/CHECK/);
  const delivery = rawOf(db).prepare(
    "INSERT INTO notification_deliveries (notification_id, channel, state, last_error) VALUES (?, ?, ?, ?)",
  );
  delivery.run("N1", "ntfy", "pending", null);
  expect(() => delivery.run("N1", "ntfy", "pending", null)).toThrow(
    /UNIQUE|PRIMARY/,
  );
  expect(() => delivery.run("N1", "mac", "queued", null)).toThrow(/CHECK/);
  expect(() => delivery.run("N1", "email", "failed", "e".repeat(501))).toThrow(
    /CHECK/,
  );
  expect(() => delivery.run("NOPE", "mac", "pending", null)).toThrow(
    /FOREIGN KEY/,
  );
  const defaults = z
    .object({ state: z.string(), attempts: z.int() })
    .parse(
      rawOf(db)
        .prepare(
          "SELECT state, attempts FROM notification_deliveries WHERE channel = 'ntfy'",
        )
        .get(),
    );
  expect(defaults).toEqual({ state: "pending", attempts: 0 });
  // A notification's deliveries go with it.
  rawOf(db).prepare("DELETE FROM notifications WHERE id = 'N1'").run();
  expect(
    rawOf(db)
      .prepare("SELECT count(*) AS n FROM notification_deliveries")
      .get(),
  ).toEqual({ n: 0 });

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(VERSION - 1);
  expect(tablesOf(db)).toEqual([]);
  expect(notifySettings(db)).toEqual({});

  unwrap(await migrateUp(db, { to: VERSION }));
  expect(notifySettings(db)).toEqual(SEEDED);
});

test("on a seeded database: every row kept, an operator's own value kept, links to tickets and projects hold", async () => {
  const db = await dbAt(VERSION - 1);
  unwrap(await seedSpine(db, 1));
  unwrap(
    await seedRows(db, {
      workspaces: [{ id: "shop", name: "shop", kind: "single" }],
      tickets: [ticketRow(1, { workspace_id: "shop" })],
    }),
  );
  rawOf(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('notify.mac.enabled', '1', 1)",
    )
    .run();
  const counts = () =>
    rawOf(db)
      .prepare(
        "SELECT (SELECT count(*) FROM tickets) AS tickets, (SELECT count(*) FROM workspaces) AS workspaces",
      )
      .get();
  const before = counts();

  unwrap(await migrateUp(db, { to: VERSION }));
  expect(counts()).toEqual(before);
  expect(notifySettings(db)).toEqual({ ...SEEDED, "notify.mac.enabled": "1" });
  insertNotification(db, "N1", "qa_human:1", {
    workspace_id: "shop",
    ticket_id: "ticket-1",
  });
  expect(() =>
    insertNotification(db, "N2", "qa_human:2", { ticket_id: "NOPE" }),
  ).toThrow(/FOREIGN KEY/);

  unwrap(await migrateDown(db));
  expect(counts()).toEqual(before);
  // The operator's value goes with the rest: down restores 033's settings exactly.
  expect(notifySettings(db)).toEqual({});
});
