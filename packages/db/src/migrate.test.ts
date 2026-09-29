import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_RUN_CLASSES, FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { listRunClasses } from "./repos/fleet.js";
import { getSession } from "./repos/sessions.js";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "./testing.js";

const SPINE_TABLES = [
  "agents",
  "audit_log",
  "commands",
  "events",
  "executors",
  "missions",
  "models",
  "profiles",
  "prompt_templates",
  "repos",
  "run_classes",
  "runners",
  "runs",
  "sessions",
  "settings",
  "spend",
  "supervisor_state",
  "tickets",
  "workspace_repos",
  "workspaces",
  "worktrees",
];
/** 003_work's tables, its FTS tables included; migrate-003.test.ts covers them. */
const WORK_TABLES = [
  "approvals",
  "findings",
  "gates",
  "handoffs",
  "handoffs_fts",
  "human_requests",
  "knowledge",
  "knowledge_fts",
  "messages",
  "role_bindings",
  "ticket_events",
  "ticket_exports",
  "ticket_links",
  "ticket_repos",
  "tickets_fts",
];
/** 004_pulse's tables; migrate-004.test.ts covers them. */
const PULSE_TABLES = ["probes", "pulse_checks", "pulses"];
/** 009_conformance's tables; migrate-009.test.ts covers them. */
const CONFORMANCE_TABLES = ["conformance_probes", "runner_certifications"];
/** 012_fleet's tables; migrate-012.test.ts covers them. */
const FLEET_TABLES = ["backups", "budgets"];
/** 019_attention_acks' table; migrate-019.test.ts covers it. */
const ATTENTION_TABLES = ["attention_acks"];
/** 036_qa_harness's table; migrate-036.test.ts covers it. */
const QA_TABLES = ["qa_runs"];
/** 037_delivery's table; migrate-037.test.ts covers it. */
const DELIVERY_TABLES = ["deliveries"];
/** The notifications migration's tables; its own test covers them. */
const NOTIFY_TABLES = [
  "notification_cursors",
  "notification_deliveries",
  "notifications",
];
/** 041_jira_push's tables; migrate-041.test.ts covers them. */
const JIRA_PUSH_TABLES = ["jira_push_cursors", "jira_pushes"];
/** 051_runner_updates' tables; migrate-051.test.ts covers them. */
const RUNNER_UPDATE_TABLES = ["runner_update_dismissals", "runner_updates"];
const TABLES = [
  ...SPINE_TABLES,
  ...WORK_TABLES,
  ...PULSE_TABLES,
  ...CONFORMANCE_TABLES,
  ...FLEET_TABLES,
  ...ATTENTION_TABLES,
  ...QA_TABLES,
  ...DELIVERY_TABLES,
  ...NOTIFY_TABLES,
  ...JIRA_PUSH_TABLES,
  ...RUNNER_UPDATE_TABLES,
].toSorted();
const VIEWS = ["v_fleet", "v_needs_attention", "v_ticket_economics"];

/** The shipped migrations, oldest first. A test that plants a file numbers it after them. */
const NAMES = [
  "spine",
  "seed",
  "work",
  "pulse",
  "handoff_writing",
  "tool_call_index",
  "gates",
  "gate_retries",
  "conformance",
  "executor_health_detail",
  "gate_poll",
  "fleet",
  "reconciler",
  "watchdog",
  "worktree_sweep",
  "agent_git_author",
  "run_class_ceilings",
  "runs_ended_at_index",
  "attention_acks",
  "parity_check",
  "spawn_failed_arm",
  "phase_change_handoffs",
  "gate_round",
  "lint_check",
  "stale_holder",
  "login_in_place",
  "project_local_roots",
  "tickets_workspace_index",
  "project_paused",
  "staff_approval",
  "project_timeline",
  "attach_intent",
  "jira_source",
  "notifications",
  "why_stuck",
  "qa_harness",
  "project_docs",
  "delivery",
  "push_url",
  "merge_close",
  "jira_push",
  "jira_quick_sync",
  "ci_checks",
  "attention_clock",
  "model_certifications",
  "operator_models",
  "delivery_since",
  "step_tiers",
  "context_compression",
  "model_standby",
  "runner_updates",
  "drift_rounds_max",
];
const SHIPPED = NAMES.map((name, i) => ({ version: i + 1, name }));
const LATEST = SHIPPED.length;
const tag = (version: number, name: string) =>
  `${String(version).padStart(3, "0")}_${name}`;
/** A planted migration file, numbered `ahead` after the latest shipped one. */
const planted = (name: string, suffix = ".sql", ahead = 1) =>
  `${tag(LATEST + ahead, name)}${suffix}`;
/** Versions 1 to n. */
const versions = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

/** An empty database file: no tables, not even _migrations. */
async function emptyDb(): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to: 0 }));
  cleanups.push(t.cleanup);
  return t.db;
}

/** A writable copy of the migrations directory, for tests that plant or edit files. */
function migrationsCopy(): { path: string; url: URL } {
  const path = mkdtempSync(join(tmpdir(), "bayon-migrations-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  cpSync(new URL("../migrations/", import.meta.url), path, { recursive: true });
  return { path, url: pathToFileURL(`${path}/`) };
}

/** The schema in a fixed order, without rootpage (a page number, not a definition). */
function dump(db: Db): string {
  const { raw } = unwrap(internalsOf(db));
  const rows = raw
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
    )
    .all();
  return JSON.stringify(rows);
}

const validation = { ok: false, error: { class: "validation" } };

test("up on an empty file creates every table and view, and records each migration", async () => {
  const db = await emptyDb();
  const status = unwrap(await migrateUp(db));
  expect(status.tables).toEqual(TABLES);
  expect(status.views).toEqual(VIEWS);
  expect(status.applied).toEqual(
    SHIPPED.map((m) => ({
      ...m,
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      appliedAt: T0,
    })),
  );
  expect(status.pending).toEqual([]);
  expect(status.drifted).toEqual([]);
});

test("001 alone creates exactly the 21 spine tables and v_fleet", async () => {
  const status = unwrap(await migrateUp(await emptyDb(), { to: 1 }));
  expect(status.tables).toEqual(SPINE_TABLES);
  expect(status.views).toEqual(["v_fleet"]);
});

test("status reports pending then applied; a second up is a no-op", async () => {
  const db = await emptyDb();
  expect(unwrap(await migrationStatus(db))).toEqual({
    applied: [],
    pending: SHIPPED,
    drifted: [],
    tables: [],
    views: [],
  });
  const first = unwrap(await migrateUp(db));
  const schema = dump(db);
  await clock.advance(1000);
  expect(unwrap(await migrateUp(db))).toEqual(first); // appliedAt unchanged: nothing re-ran
  expect(dump(db)).toBe(schema);
  expect(unwrap(await migrationStatus(db))).toEqual(first);
});

test.each(versions(LATEST))(
  "migration %i runs on an empty and on a seeded database",
  async (version) => {
    const empty = await emptyDb();
    const onEmpty = unwrap(await migrateUp(empty, { to: version }));
    expect(onEmpty.applied.map((m) => m.version).at(-1)).toBe(version);

    const seeded = await emptyDb();
    unwrap(await migrateUp(seeded, { to: version - 1 }));
    unwrap(await seedSpine(seeded, version - 1));
    const onSeeded = unwrap(await migrateUp(seeded, { to: version }));
    expect(onSeeded.applied.map((m) => m.version).at(-1)).toBe(version);
  },
);

test("002 keeps the rows seeded at 001", async () => {
  const db = await emptyDb();
  unwrap(await migrateUp(db, { to: 1 }));
  unwrap(await seedSpine(db, 1));
  unwrap(await migrateUp(db));
  const names = unwrap(await listRunClasses(db)).map((c) => c.name);
  expect(names.toSorted()).toEqual(
    [SPINE_SEED.runClass, ...DEFAULT_RUN_CLASSES.map((c) => c.name)].toSorted(),
  );
  const session = unwrap(await getSession(db, SPINE_SEED.sessionId));
  expect(session.run_class).toBe(SPINE_SEED.runClass);
});

test("up, down to nothing, then up again leaves an identical schema", async () => {
  const db = await emptyDb();
  unwrap(await migrateUp(db));
  const schema = dump(db);
  for (const left of versions(LATEST).map((v) => LATEST - v)) {
    const status = unwrap(await migrateDown(db));
    expect(status.applied.map((m) => m.version)).toEqual(versions(left));
  }
  expect(unwrap(await migrationStatus(db))).toMatchObject({
    applied: [],
    pending: SHIPPED,
    tables: [],
    views: [],
  });
  unwrap(await migrateUp(db));
  expect(dump(db)).toBe(schema);
});

test("down with nothing applied is a validation error", async () => {
  expect(await migrateDown(await emptyDb())).toMatchObject(validation);
});

test("down without a paired .down.sql is a validation error", async () => {
  const dir = migrationsCopy();
  unlinkSync(join(dir.path, `${tag(LATEST, NAMES.at(-1) ?? "")}.down.sql`));
  const db = await emptyDb();
  unwrap(await migrateUp(db, { dir: dir.url }));
  expect(await migrateDown(db, { dir: dir.url })).toMatchObject(validation);
});

test("an edited applied migration is drifted, and up and down refuse", async () => {
  const dir = migrationsCopy();
  const db = await emptyDb();
  unwrap(await migrateUp(db, { dir: dir.url }));
  appendFileSync(join(dir.path, "002_seed.sql"), "\n-- edited after apply\n");
  const status = unwrap(await migrationStatus(db, { dir: dir.url }));
  expect(status.drifted).toEqual([{ version: 2, name: "seed" }]);
  const conflict = { ok: false, error: { class: "conflict" } };
  expect(await migrateUp(db, { dir: dir.url })).toMatchObject(conflict);
  expect(await migrateDown(db, { dir: dir.url })).toMatchObject(conflict);
});

test.each([
  ["an unknown file", "notes.txt", "hello"],
  ["an orphan .down.sql", planted("extra", ".down.sql"), "SELECT 1;"],
  ["a gap in the versions", planted("gap", ".sql", 2), "SELECT 1;"],
  ["a duplicate version", "002_other.sql", "SELECT 1;"],
  ["BEGIN inside a file", planted("txn"), "BEGIN;\nCREATE TABLE x (id TEXT);"],
  ["COMMIT inside a file", planted("txn"), "CREATE TABLE x (id TEXT); COMMIT;"],
  ["PRAGMA inside a file", planted("pragma"), "PRAGMA foreign_keys = OFF;"],
])("%s is a validation error", async (_, name, body) => {
  const dir = migrationsCopy();
  writeFileSync(join(dir.path, name), body);
  const db = await emptyDb();
  expect(await migrationStatus(db, { dir: dir.url })).toMatchObject(validation);
  expect(await migrateUp(db, { dir: dir.url })).toMatchObject(validation);
});

test("BEGIN or COMMIT inside a string literal is accepted, not mistaken for a statement", async () => {
  const dir = migrationsCopy();
  writeFileSync(
    join(dir.path, planted("literal")),
    [
      "CREATE TABLE x (id TEXT);",
      "INSERT INTO x (id) VALUES ('BEGIN');",
      "INSERT INTO x (id) VALUES ('it''s a COMMIT, not a keyword');",
    ].join("\n"),
  );
  const db = await emptyDb();
  const status = unwrap(await migrateUp(db, { dir: dir.url }));
  expect(status.applied.map((m) => m.version)).toEqual(versions(LATEST + 1));
  const { raw } = unwrap(internalsOf(db));
  expect(raw.prepare("SELECT id FROM x ORDER BY id").all()).toEqual([
    { id: "BEGIN" },
    { id: "it's a COMMIT, not a keyword" },
  ]);
});

test("a real BEGIN; statement is still rejected even alongside a literal containing BEGIN", async () => {
  const dir = migrationsCopy();
  writeFileSync(
    join(dir.path, planted("mixed")),
    [
      "CREATE TABLE x (id TEXT);",
      "INSERT INTO x (id) VALUES ('BEGIN');",
      "BEGIN;",
    ].join("\n"),
  );
  const db = await emptyDb();
  expect(await migrateUp(db, { dir: dir.url })).toMatchObject(validation);
});

test.each([
  ["BEGIN", "BEGIN;"],
  ["PRAGMA", "PRAGMA foreign_keys = OFF;"],
  ["SAVEPOINT", "SAVEPOINT s;"],
])(
  "a %s statement after a '--' literal is still rejected, not hidden as a line comment",
  async (_, statement) => {
    const dir = migrationsCopy();
    writeFileSync(
      join(dir.path, planted("dashdash")),
      `INSERT INTO x (id) VALUES ('--'); ${statement}`,
    );
    const db = await emptyDb();
    expect(await migrateUp(db, { dir: dir.url })).toMatchObject(validation);
  },
);

test("a '/*' opened by a literal must not swallow a real statement up to a later, unrelated '*/'", async () => {
  const dir = migrationsCopy();
  writeFileSync(
    join(dir.path, planted("slashstar")),
    [
      "CREATE TABLE x (id TEXT);",
      "INSERT INTO x (id) VALUES ('token /* not really a comment');",
      "BEGIN;",
      "/* a real trailing comment */",
    ].join("\n"),
  );
  const db = await emptyDb();
  expect(await migrateUp(db, { dir: dir.url })).toMatchObject(validation);
});

test("the same '/*'-in-a-literal shape is accepted when nothing forbidden follows", async () => {
  const dir = migrationsCopy();
  writeFileSync(
    join(dir.path, planted("slashstar_ok")),
    [
      "CREATE TABLE x (id TEXT);",
      "INSERT INTO x (id) VALUES ('token /* not really a comment');",
      "/* a real trailing comment */",
    ].join("\n"),
  );
  const db = await emptyDb();
  const status = unwrap(await migrateUp(db, { dir: dir.url }));
  expect(status.applied.map((m) => m.version)).toEqual(versions(LATEST + 1));
});

test("trigger bodies (BEGIN … END inside CREATE TRIGGER) are not transaction control", async () => {
  const dir = migrationsCopy();
  writeFileSync(
    join(dir.path, planted("trigger")),
    [
      "CREATE TABLE x (id TEXT);",
      "CREATE TABLE y (id TEXT);",
      "CREATE TRIGGER x_copy AFTER INSERT ON x BEGIN",
      "  INSERT INTO y (id) VALUES (new.id);",
      "END;",
    ].join("\n"),
  );
  const db = await emptyDb();
  const status = unwrap(await migrateUp(db, { dir: dir.url }));
  expect(status.applied.map((m) => m.version)).toEqual(versions(LATEST + 1));
});

test("an unterminated string literal fails closed as a validation error", async () => {
  const dir = migrationsCopy();
  writeFileSync(
    join(dir.path, planted("unterminated")),
    "CREATE TABLE x (id TEXT);\nINSERT INTO x (id) VALUES ('never closed;",
  );
  const db = await emptyDb();
  expect(await migrationStatus(db, { dir: dir.url })).toMatchObject(validation);
  expect(await migrateUp(db, { dir: dir.url })).toMatchObject(validation);
});

test("an unterminated block comment fails closed as a validation error", async () => {
  const dir = migrationsCopy();
  writeFileSync(
    join(dir.path, planted("unterminated_comment")),
    "CREATE TABLE x (id TEXT);\n/* never closed\nBEGIN;",
  );
  const db = await emptyDb();
  expect(await migrateUp(db, { dir: dir.url })).toMatchObject(validation);
});

test("hidden files in the migrations directory are ignored", async () => {
  const dir = migrationsCopy();
  writeFileSync(join(dir.path, ".DS_Store"), "");
  const status = unwrap(
    await migrationStatus(await emptyDb(), { dir: dir.url }),
  );
  expect(status.pending).toHaveLength(LATEST);
});

test("a migration that leaves a foreign-key violation is rolled back", async () => {
  const dir = migrationsCopy();
  writeFileSync(
    join(dir.path, planted("orphan")),
    [
      "CREATE TABLE p (id TEXT PRIMARY KEY);",
      "CREATE TABLE c (p_id TEXT REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED);",
      "INSERT INTO c VALUES ('missing');",
    ].join("\n"),
  );
  const db = await emptyDb();
  expect(await migrateUp(db, { dir: dir.url })).toMatchObject(validation);
  const status = unwrap(await migrationStatus(db, { dir: dir.url }));
  expect(status.applied.map((m) => m.version)).toEqual(versions(LATEST));
  expect(status.pending).toEqual([{ version: LATEST + 1, name: "orphan" }]);
  expect(status.tables).toEqual(TABLES);
});

test("a migration that ends the transaction itself is a validation error", async () => {
  const dir = migrationsCopy();
  writeFileSync(
    join(dir.path, planted("end")),
    "CREATE TABLE x (id TEXT);\nEND;",
  );
  const db = await emptyDb();
  expect(await migrateUp(db, { dir: dir.url })).toMatchObject(validation);
});

test("a migration with invalid SQL fails and is not recorded", async () => {
  const dir = migrationsCopy();
  writeFileSync(join(dir.path, planted("broken")), "CREATE TABLE (;");
  const db = await emptyDb();
  expect(await migrateUp(db, { dir: dir.url })).toMatchObject({ ok: false });
  const status = unwrap(await migrationStatus(db, { dir: dir.url }));
  expect(status.pending).toEqual([{ version: LATEST + 1, name: "broken" }]);
});

test("up to an unknown version is a validation error", async () => {
  const db = await emptyDb();
  expect(await migrateUp(db, { to: LATEST + 1 })).toMatchObject(validation);
  expect(await migrateUp(db, { to: -1 })).toMatchObject(validation);
  expect(await migrateUp(db, { to: 1.5 })).toMatchObject(validation);
});

test("a missing migrations directory is a validation error", async () => {
  const url = pathToFileURL(join(tmpdir(), "bayon-no-such-dir/"));
  expect(await migrationStatus(await emptyDb(), { dir: url })).toMatchObject(
    validation,
  );
});
