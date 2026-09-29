import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { tempDb, unwrap } from "./testing.js";

// 043_ci_checks (M8.3): `qa_mode` gains `ci` (with the rule that it needs pull requests
// at review_passed), the CI columns, `qa_runs.source`, the CI progress on `deliveries` and the grace
// setting — on an empty database and on one holding projects, runs and deliveries, up, down and up.
const THIS = 43;
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const run = (db: Db, sql: string, ...params: unknown[]): void => {
  rawOf(db)
    .prepare(sql)
    .run(...params);
};
const all = (db: Db, sql: string): unknown => rawOf(db).prepare(sql).all();

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const Names = z.array(z.object({ name: z.string() }));
const columnsOf = (db: Db, table: string): string[] =>
  Names.parse(
    rawOf(db)
      .prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)
      .all(),
  ).map((c) => c.name);

const WS =
  "INSERT INTO workspaces (id, name, kind, qa_mode, qa_cmd, qa_junit, delivery_mode, delivery_when) VALUES (?, ?, 'single', ?, ?, ?, ?, ?)";

/** A project, its ticket, a QA run and a delivery: what 043 must carry over untouched. */
function seed(db: Db): void {
  run(
    db,
    WS,
    "W1",
    "W1",
    "command",
    "make check",
    "out/junit.xml",
    "none",
    "review_passed",
  );
  run(db, WS, "W2", "W2", "none", null, null, "pull_request", "review_passed");
  run(
    db,
    "INSERT INTO repos (id, name, mirror_path) VALUES ('R', 'R', '/m/r.git')",
  );
  run(
    db,
    "INSERT INTO tickets (id, num, title, type, status, origin, created_at, updated_at) VALUES ('T1', 1, 't', 'chore', 'qa_harness', 'operator', 1, 1)",
  );
  run(
    db,
    "INSERT INTO qa_runs (id, ticket_id, state, command, exit_code, started_at) VALUES ('Q1', 'T1', 'passed', 'make check', 0, 1)",
  );
  run(
    db,
    "INSERT INTO deliveries (id, ticket_id, repo_id, branch, head_sha, state, pr_url, pr_number, started_at) VALUES ('D1', 'T1', 'R', 'frm/s', 'abc', 'pr_open', 'https://forge.test/pull/1', 1, 1)",
  );
}

test("043 on an empty database adds ci and its columns; down removes them; up again", async () => {
  const db = await dbAt(THIS - 1);
  const before = {
    workspaces: columnsOf(db, "workspaces"),
    qa_runs: columnsOf(db, "qa_runs"),
    deliveries: columnsOf(db, "deliveries"),
  };

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(columnsOf(db, "workspaces").slice(-3)).toEqual([
    "qa_junit",
    "qa_ci_checks_json",
    "qa_ci_timeout_ms",
  ]);
  expect(columnsOf(db, "qa_runs").at(-1)).toBe("source");
  expect(columnsOf(db, "deliveries").slice(-4)).toEqual([
    "ci_gate_id",
    "ci_sha",
    "ci_done",
    "ci_total",
  ]);
  expect(
    all(db, "SELECT value_json FROM settings WHERE key = 'qa.ci_grace_ms'"),
  ).toEqual([{ value_json: "600000" }]);

  // ci is a mode, but only beside pull requests opened when review passes.
  run(db, WS, "W", "W", "ci", null, null, "pull_request", "review_passed");
  expect(() =>
    run(db, WS, "W3", "W3", "ci", null, null, "push", "review_passed"),
  ).toThrow(/CHECK/);
  expect(() =>
    run(db, WS, "W4", "W4", "ci", null, null, "pull_request", "done"),
  ).toThrow(/CHECK/);
  // …and a delivery change away from it is refused too.
  expect(() =>
    run(db, "UPDATE workspaces SET delivery_mode = 'push' WHERE id = 'W'"),
  ).toThrow(/CHECK/);
  // 036's two rules still hold.
  expect(() =>
    run(db, WS, "W5", "W5", "nope", null, null, "none", "review_passed"),
  ).toThrow(/CHECK/);
  expect(() =>
    run(db, WS, "W6", "W6", "command", " ", null, "none", "review_passed"),
  ).toThrow(/CHECK/);
  run(
    db,
    "INSERT INTO tickets (id, num, title, type, status, origin, created_at, updated_at) VALUES ('T', 1, 't', 'chore', 'qa_harness', 'operator', 1, 1)",
  );
  run(
    db,
    "INSERT INTO qa_runs (id, ticket_id, state, started_at, source) VALUES ('Q', 'T', 'passed', 1, 'ci')",
  );
  expect(() =>
    run(
      db,
      "INSERT INTO qa_runs (id, ticket_id, state, started_at, source) VALUES ('Q2', 'T', 'passed', 1, 'robot')",
    ),
  ).toThrow(/CHECK/);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(columnsOf(db, "workspaces").toSorted()).toEqual(
    before.workspaces.toSorted(),
  );
  expect(columnsOf(db, "qa_runs")).toEqual(before.qa_runs);
  expect(columnsOf(db, "deliveries")).toEqual(before.deliveries);
  // The ci project runs no harness now; 036's CHECK is back.
  expect(all(db, "SELECT id, qa_mode FROM workspaces")).toEqual([
    { id: "W", qa_mode: "none" },
  ]);
  expect(() => run(db, "UPDATE workspaces SET qa_mode = 'ci'")).toThrow(
    /CHECK/,
  );
  expect(
    all(db, "SELECT key FROM settings WHERE key = 'qa.ci_grace_ms'"),
  ).toEqual([]);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
});

test("043 on a seeded database keeps every project, run and delivery as it was", async () => {
  const db = await dbAt(THIS - 1);
  seed(db);
  const WS_COLS =
    "id, qa_mode, qa_cmd, qa_timeout_ms, qa_secrets_json, qa_reports_json, qa_junit, delivery_mode, delivery_when";
  const snapshot = () => ({
    workspaces: all(db, `SELECT ${WS_COLS} FROM workspaces ORDER BY id`),
    runs: all(
      db,
      "SELECT id, ticket_id, state, command, exit_code, started_at FROM qa_runs",
    ),
    deliveries: all(
      db,
      "SELECT id, state, head_sha, pr_url, pr_number FROM deliveries",
    ),
  });
  const before = snapshot();

  unwrap(await migrateUp(db, { to: THIS }));
  expect(snapshot()).toEqual(before);
  // Every run so far was a command's; nothing has been read from any CI.
  expect(all(db, "SELECT source FROM qa_runs")).toEqual([
    { source: "command" },
  ]);
  expect(
    all(db, "SELECT ci_gate_id, ci_sha, ci_done, ci_total FROM deliveries"),
  ).toEqual([
    { ci_gate_id: null, ci_sha: null, ci_done: null, ci_total: null },
  ]);
  expect(
    all(db, "SELECT qa_ci_checks_json, qa_ci_timeout_ms FROM workspaces"),
  ).toEqual([
    { qa_ci_checks_json: null, qa_ci_timeout_ms: null },
    { qa_ci_checks_json: null, qa_ci_timeout_ms: null },
  ]);
  // A setting the operator already chose is kept.
  unwrap(await migrateDown(db));
  run(
    db,
    "INSERT INTO settings (key, value_json, updated_at) VALUES ('qa.ci_grace_ms', '120000', 1)",
  );
  unwrap(await migrateUp(db, { to: THIS }));
  expect(
    all(db, "SELECT value_json FROM settings WHERE key = 'qa.ci_grace_ms'"),
  ).toEqual([{ value_json: "120000" }]);

  unwrap(await migrateDown(db));
  expect(snapshot()).toEqual(before);
});

const viewText = (db: Db): unknown =>
  all(db, "SELECT sql FROM sqlite_schema WHERE name = 'v_needs_attention'");

test("043's attention view leaves a waiting CI gate out of the running gate_stuck arm; down restores 035's", async () => {
  const db = await dbAt(THIS - 1);
  const before = viewText(db);
  seed(db);
  // Both started long ago: a command harness past the gate clock, and a CI gate on its own wait.
  run(
    db,
    "INSERT INTO gates (id, ticket_id, kind, state, subject_kind, subject_ref, started_at, attempt) VALUES ('G-cmd', 'T1', 'qa_harness', 'running', 'workspace', 'x', 1, 1), ('G-ci', 'T1', 'qa_harness', 'running', 'pull_request', 'x', 1, 2)",
  );
  const stuck = () =>
    all(
      db,
      "SELECT ref FROM v_needs_attention WHERE why = 'gate_stuck' ORDER BY ref",
    );
  expect(stuck()).toEqual([{ ref: "G-ci" }, { ref: "G-cmd" }]);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(stuck()).toEqual([{ ref: "G-cmd" }]);

  unwrap(await migrateDown(db));
  expect(viewText(db)).toEqual(before);
  expect(stuck()).toEqual([{ ref: "G-ci" }, { ref: "G-cmd" }]);
});
