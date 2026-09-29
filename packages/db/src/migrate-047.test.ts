import { FakeClock, type DeliveryRowState } from "@bayon/core";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { listDeliveryCandidates } from "./repos/delivery-reads.js";
import {
  dumpAllRows,
  seedRows,
  seedSpine,
  sqlClockFollowsDate,
  tempDb,
  unwrap,
} from "./testing.js";

// 047_delivery_since: workspaces gains delivery_since, when delivery was turned on. On an
// empty and on a seeded database: a project that already delivers is marked with the migration's
// own time (SQLite's clock, pointed here at a faked date so the mark is exact) — or with the oldest
// start of a delivery still in flight, so the sweep keeps finishing it — one that delivers nothing
// stays NULL, nothing else changes, and down is 046's workspaces table byte for byte.
const THIS = 47;
const clock = new FakeClock(1_700_000_000_000);
/** The system date the migration runs at: its mark, to the millisecond. */
const MIGRATED_AT = Date.UTC(2026, 8, 26, 12, 0, 0, 345);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MIGRATED_AT);
});
afterEach(() => {
  vi.useRealTimers();
});

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  unwrap(sqlClockFollowsDate(t.db));
  return t.db;
}

const raw = (db: Db) => unwrap(internalsOf(db)).raw;
const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

/** The workspaces table's and its indexes' stored text: what down must restore exactly. */
const schemaText = (db: Db): unknown[] =>
  raw(db)
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'workspaces' ORDER BY name",
    )
    .all();

const Column = z.object({
  name: z.string(),
  type: z.string(),
  notnull: z.int(),
  dflt_value: z.string().nullable(),
});
const columns = (db: Db) =>
  z
    .array(Column)
    .parse(
      raw(db)
        .prepare(
          `SELECT name, type, "notnull", dflt_value FROM pragma_table_info('workspaces') ORDER BY cid`,
        )
        .all(),
    );

const marks = (db: Db): unknown[] =>
  raw(db)
    .prepare("SELECT id, delivery_since FROM workspaces ORDER BY id")
    .all();

test("047 on an empty database: a nullable delivery_since; down is 046's text; up again", async () => {
  const db = await dbAt(THIS - 1);
  const before = schemaText(db);
  expect(columns(db).map((c) => c.name)).not.toContain("delivery_since");

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(columns(db).at(-1)).toEqual({
    name: "delivery_since",
    type: "INTEGER",
    notnull: 0,
    dflt_value: null,
  });
  // A project filed after the migration is marked by its writer, not by a default.
  unwrap(
    await seedRows(db, {
      workspaces: [{ id: "P", name: "P", kind: "single" }],
    }),
  );
  expect(marks(db)).toEqual([{ id: "P", delivery_since: null }]);
  raw(db).prepare("DELETE FROM workspaces").run();

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(schemaText(db)).toEqual(before);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
});

const DAY = 86_400_000;
/** When the migration's clock says it is now, less `days`. */
const ago = (days: number): number => MIGRATED_AT - days * DAY;

/**
 * A 046 database with four projects and their history, every ticket having entered its status
 * (`entered`) and some with a delivery row — as the delivery job left them before 047:
 *   P-none  delivers nothing.
 *   P-push  push: its one row is `pushed`, which is finished in a push project.
 *   P-pr    pull_request: a ticket never delivered; one whose pull request is open (finished, and
 *           oldest); one whose push failed 2 days ago and one pushed yesterday still waiting for its
 *           pull request (both in flight — the older is the mark).
 *   P-done  pull_request: only a merged and a closed delivery, both finished.
 */
async function seeded046(): Promise<Db> {
  const db = await dbAt(THIS - 1);
  unwrap(await seedSpine(db, THIS - 1));
  const tickets: readonly (readonly [string, string, string, number])[] = [
    // id, project, status, entered (days ago)
    ["T-none", "P-none", "done", 9],
    ["T-pushed", "P-push", "done", 4],
    ["T-hist", "P-pr", "done", 9],
    ["T-open", "P-pr", "done", 8],
    ["T-fail", "P-pr", "done", 3],
    ["T-await", "P-pr", "qa_human", 5],
    ["T-merged", "P-done", "done", 7],
    ["T-closed", "P-done", "done", 6],
  ];
  const delivery = (
    ticket: string,
    state: DeliveryRowState,
    startedDaysAgo: number,
    prUrl: string | null,
  ) => ({
    id: `D-${ticket}`,
    ticket_id: ticket,
    repo_id: "r1",
    branch: "frm/s1",
    head_sha: "a".repeat(40),
    state,
    pr_url: prUrl,
    started_at: ago(startedDaysAgo),
  });
  const project = (id: string, mode?: "push" | "pull_request") => ({
    id,
    name: id,
    kind: "single" as const,
    ...(mode === undefined ? {} : { delivery_mode: mode }),
  });
  unwrap(
    await seedRows(db, {
      repos: [{ id: "r1", name: "r1", mirror_path: "/m/r1.git" }],
      workspaces: [
        project("P-none"),
        project("P-push", "push"),
        project("P-pr", "pull_request"),
        project("P-done", "pull_request"),
      ],
      tickets: tickets.map(([id, workspace, status, days], i) => ({
        id,
        num: i + 1,
        title: id,
        type: "chore" as const,
        status,
        origin: "operator",
        workspace_id: workspace,
        created_at: ago(days + 1),
        updated_at: ago(days),
      })),
      ticket_events: tickets.map(([id, , status, days]) => ({
        ticket_id: id,
        ts: ago(days),
        actor_kind: "operator",
        kind: "transition",
        from_status: "code_review",
        to_status: status,
      })),
      deliveries: [
        delivery("T-pushed", "pushed", 4, null),
        delivery("T-open", "pr_open", 8, "https://forge.test/pull/1"),
        delivery("T-fail", "failed", 2, null),
        delivery("T-await", "pushed", 1, null),
        delivery("T-merged", "merged", 7, "https://forge.test/pull/2"),
        delivery("T-closed", "closed", 6, "https://forge.test/pull/3"),
      ],
    }),
  );
  return db;
}

const EXPECTED_MARKS = [
  { id: "P-done", delivery_since: MIGRATED_AT },
  { id: "P-none", delivery_since: null },
  { id: "P-pr", delivery_since: ago(2) },
  { id: "P-push", delivery_since: MIGRATED_AT },
];

test("047 on a seeded database: delivering projects are marked at the migration, or at their oldest delivery in flight; the rest untouched; down keeps the rows", async () => {
  const db = await seeded046();
  const workspacesBefore = raw(db)
    .prepare("SELECT * FROM workspaces ORDER BY id")
    .all();
  const others = (d: Db) =>
    dumpAllRows(d).then((rows) =>
      Object.entries(unwrap(rows)).filter(
        ([table]) => !["workspaces", "_migrations"].includes(table),
      ),
    );
  const othersBefore = await others(db);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(marks(db)).toEqual(EXPECTED_MARKS);
  const markOf = new Map(EXPECTED_MARKS.map((m) => [m.id, m.delivery_since]));
  expect(raw(db).prepare("SELECT * FROM workspaces ORDER BY id").all()).toEqual(
    workspacesBefore.map((row) => ({
      ...(row as { id: string }),
      delivery_since: markOf.get((row as { id: string }).id),
    })),
  );
  expect(await others(db)).toEqual(othersBefore);

  unwrap(await migrateDown(db));
  expect(raw(db).prepare("SELECT * FROM workspaces ORDER BY id").all()).toEqual(
    workspacesBefore,
  );
  expect(await others(db)).toEqual(othersBefore);
});

test("after 047 a delivery in flight keeps its ticket due; history and finished deliveries do not come back", async () => {
  const db = await seeded046();
  unwrap(await migrateUp(db));
  const due = unwrap(
    await listDeliveryCandidates(db, { limit: 50, after: null }),
  ).map((c) => c.id);
  // T-fail's retry and T-await's pull request are still the sweep's; nothing else of the history is.
  expect(due.toSorted()).toEqual(["T-await", "T-fail"]);
});
