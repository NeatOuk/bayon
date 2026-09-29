import { FakeClock, budgetWindow, newId } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { capture } from "./errors.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { listBudgets } from "./repos/budgets.js";
import { setExecutorHealth } from "./repos/config.js";
import type { SpendTable } from "./schema.js";
import type { BackupsTable, BudgetsTable } from "./schema-fleet.js";
import type { AttentionWhy } from "./schema-work.js";
import {
  rawAttentionForTest,
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "./testing.js";

// 012_fleet: budgets and backups, sessions.queued_reason, the M4 settings, and
// v_needs_attention rebuilt with budget_warn, worktree_dirty, executor_unhealthy and backup_failed
// after 005's arms.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number, at: FakeClock = clock): Promise<Db> {
  const t = unwrap(await tempDb(at, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

/** A database at 012 with the spine seeded, plus a second agent with a session and a run each. */
async function spineAt12(at: FakeClock = clock): Promise<Db> {
  const db = await dbAt(12, at);
  unwrap(await seedSpine(db, 12));
  unwrap(
    await seedRows(db, {
      agents: [
        {
          id: "agent-2",
          name: "second",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          created_at: 0,
        },
      ],
      sessions: [
        {
          ...newSessionInput(),
          id: "session-2",
          agent_id: "agent-2",
          state: "idle",
          created_at: 0,
        },
      ],
      runs: [run("R-1", SPINE_SEED.sessionId), run("R-2", "session-2")],
    }),
  );
  return db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const exec = (db: Db, statement: string): void => {
  rawOf(db).prepare(statement).run();
};

/** The schema in a fixed order, without rootpage. */
const dump = (db: Db): string =>
  JSON.stringify(
    rawOf(db)
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      )
      .all(),
  );

const Settings = z.array(z.object({ key: z.string(), value_json: z.string() }));
const settingsOf = (db: Db) =>
  Settings.parse(
    rawOf(db)
      .prepare("SELECT key, value_json FROM settings ORDER BY key")
      .all(),
  );

const View = z.array(z.object({ sql: z.string() }));
const viewSql = (db: Db): string =>
  View.parse(
    rawOf(db)
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'v_needs_attention'",
      )
      .all(),
  )[0]?.sql ?? "";

const Columns = z.array(z.object({ name: z.string() }));
const columnsOf = (db: Db, table: string): string[] =>
  Columns.parse(
    rawOf(db)
      .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
      .all(table),
  ).map((c) => c.name);

/** A raw insert, so a test can hand the CHECKs values the Kysely types would refuse. */
const insert = (
  db: Db,
  table: "budgets" | "backups",
  row: Readonly<Record<string, string | number | null>>,
) => {
  const keys = Object.keys(row);
  return capture(() =>
    rawOf(db)
      .prepare(
        `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row)),
  );
};

/** The plan's M4 contracts, by key. */
const M4_SETTINGS = [
  { key: "admission.disk_min_free_pct", value_json: "10" },
  { key: "admission.recheck_ms", value_json: "5000" },
  { key: "admission.require_certified", value_json: "1" },
  { key: "backup.at_utc_hour", value_json: "3" },
  { key: "backup.enabled", value_json: "1" },
  { key: "backup.keep", value_json: "14" },
  { key: "executor.clock_skew_max_ms", value_json: "5000" },
  { key: "fleet.paused", value_json: "0" },
  { key: "reconciler.command_requeue_ms", value_json: "300000" },
  { key: "watchdog.circuit_failed_runs", value_json: "3" },
  { key: "watchdog.retry_storm_backoff_ms", value_json: "900000" },
  { key: "watchdog.retry_storm_count", value_json: "5" },
  { key: "watchdog.retry_storm_window_ms", value_json: "600000" },
  { key: "watchdog.silent_ms", value_json: "1800000" },
  { key: "worktree.recheck_ms", value_json: "3600000" },
];
const M4_KEYS = new Set(M4_SETTINGS.map((s) => s.key));
const m4 = (db: Db) => settingsOf(db).filter((s) => M4_KEYS.has(s.key));

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const validation = { ok: false, error: { class: "validation" } };
const conflict = { ok: false, error: { class: "conflict" } };

const armOf = async (db: Db, why: AttentionWhy) =>
  unwrap(await rawAttentionForTest(db))
    .filter((row) => row.why === why)
    .map(({ ref, ticket_id }) => ({ ref, ticket_id }));

function run(id: string, session_id: string) {
  return {
    ...newRunInput(session_id),
    id,
    seq: 1,
    state: "ok" as const,
    started_at: 0,
  };
}

const budget = (
  id: string,
  o: Partial<Insertable<BudgetsTable>> = {},
): Insertable<BudgetsTable> => ({
  id,
  scope: "fleet",
  period: "day",
  cap_usd: 10,
  updated_at: 0,
  ...o,
});

const backup = (
  id: string,
  ended_at: number,
  o: Partial<Insertable<BackupsTable>> = {},
): Insertable<BackupsTable> => ({
  id,
  started_at: ended_at - 10,
  ended_at,
  outcome: "ok",
  path: `/backups/${id}.db.enc`,
  ...o,
});

/** A spend row of `tokens` (tokens_in + tokens_out) on run R-1 (the spine's agent) or R-2. */
const spend = (
  id: string,
  runId: "R-1" | "R-2",
  cost_usd: number,
  tokens: number,
  ts: number,
): Insertable<SpendTable> => ({
  id,
  run_id: runId,
  session_id: runId === "R-1" ? SPINE_SEED.sessionId : "session-2",
  phase: "build",
  runner_id: SPINE_SEED.runnerId,
  model: "fixture-model",
  tokens_in: tokens - 10,
  tokens_out: 10,
  cost_usd,
  cost_source: "reported",
  ts,
});

// ─── up and down ─────────────────────────────────────────────────────────────

test("012 on an empty database: budgets, backups, sessions.queued_reason, every M4 setting, no budget", async () => {
  const db = await dbAt(0);
  unwrap(await migrateUp(db, { to: 12 }));
  expect(unwrap(await migrationStatus(db)).tables).toEqual(
    expect.arrayContaining(["backups", "budgets"]),
  );
  expect(columnsOf(db, "sessions").at(-1)).toBe("queued_reason");
  expect(m4(db)).toEqual(M4_SETTINGS);
  // 002 seeds budget.daily_cap_usd null: no cap, so no budget.
  expect(unwrap(await listBudgets(db))).toEqual([]);
  expect(unwrap(await rawAttentionForTest(db))).toEqual([]);
});

test("012 on a seeded database keeps every session row as it was, queued_reason NULL", async () => {
  const db = await dbAt(11);
  unwrap(await seedSpine(db, 11));
  const session = () =>
    rawOf(db)
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(SPINE_SEED.sessionId);
  const before = session();
  unwrap(await migrateUp(db, { to: 12 }));
  expect(session()).toEqual({ ...(before as object), queued_reason: null });
});

test("012 keeps every 005 arm byte for byte and appends the four M4 arms", async () => {
  const at11 = viewSql(await dbAt(11));
  const at12 = viewSql(await dbAt(12));
  expect(at12.slice(0, at11.length)).toBe(at11);
  const added = [...at12.slice(at11.length).matchAll(/SELECT '(\w+)'/g)];
  expect(added.map((m) => m[1])).toEqual([
    "budget_warn",
    "worktree_dirty",
    "executor_unhealthy",
    "backup_failed",
  ]);
});

test("012 down on an empty database leaves 011's schema exactly; up again gives 012's", async () => {
  const at11 = dump(await dbAt(11));
  const at12 = dump(await dbAt(12));
  const db = await dbAt(12);
  unwrap(await migrateDown(db));
  expect(dump(db)).toBe(at11);
  unwrap(await migrateUp(db, { to: 12 }));
  expect(dump(db)).toBe(at12);
});

test("012 down on a seeded database leaves exactly 011's schema and settings, and keeps the sessions", async () => {
  const db = await dbAt(11);
  unwrap(await seedSpine(db, 11));
  const schemaAt11 = dump(db);
  const settingsAt11 = settingsOf(db);
  unwrap(await migrateUp(db, { to: 12 }));
  unwrap(
    await seedRows(db, {
      budgets: [budget("b-1")],
      backups: [backup("k-1", 100)],
    }),
  );
  exec(db, "UPDATE sessions SET state = 'pending', queued_reason = 'slot'");
  const status = unwrap(await migrateDown(db));
  expect(status.applied.at(-1)?.version).toBe(11);
  expect(dump(db)).toBe(schemaAt11);
  expect(settingsOf(db)).toEqual(settingsAt11);
  expect(rawOf(db).prepare("SELECT id, state FROM sessions").all()).toEqual([
    { id: SPINE_SEED.sessionId, state: "pending" },
  ]);
  unwrap(await migrateUp(db, { to: 12 }));
  expect(m4(db)).toEqual(M4_SETTINGS);
  expect(unwrap(await listBudgets(db))).toEqual([]);
});

// ─── seeds ───────────────────────────────────────────────────────────────────

test.each([
  ["null (002's seed): no row", "null", []],
  ["a number: one fleet/day row", "12.5", [12.5]],
  ["zero: a cap that stops everything", "0", [0]],
  ["a JSON string: no row", '"12.5"', []],
  ["negative: no row", "-1", []],
  ["not JSON: no row", "twelve", []],
] as const)(
  "the budget seed, budget.daily_cap_usd %s",
  async (_, value_json, caps) => {
    const db = await dbAt(11);
    unwrap(
      await seedRows(db, {
        settings: [{ key: "budget.daily_cap_usd", value_json, updated_at: 0 }],
      }),
    );
    unwrap(await migrateUp(db, { to: 12 }));
    const rows = unwrap(await listBudgets(db));
    expect(rows.map((row) => row.cap_usd)).toEqual(caps);
    for (const row of rows) {
      expect(row).toMatchObject({
        scope: "fleet",
        scope_ref: null,
        period: "day",
        cap_tokens: null,
        warn_pct: 70,
        on_breach: "pause_admission",
      });
      // A ULID minted by the migration on the wall clock: it sorts between ids of a minute either side.
      expect(row.id).toMatch(ULID);
      expect(row.id > newId(Date.now() - 60_000)).toBe(true);
      expect(row.id < newId(Date.now() + 60_000)).toBe(true);
    }
    // The setting stays: the M2 readers keep using it until M4-c.
    expect(settingsOf(db)).toContainEqual({
      key: "budget.daily_cap_usd",
      value_json,
    });
  },
);

test("an M4 setting the operator already set keeps its value (OR IGNORE)", async () => {
  const db = await dbAt(11);
  const tuned: Readonly<Record<string, string>> = {
    "backup.keep": "30",
    "fleet.paused": "1",
  };
  unwrap(
    await seedRows(db, {
      settings: Object.entries(tuned).map(([key, value_json]) => ({
        key,
        value_json,
        updated_at: 0,
      })),
    }),
  );
  unwrap(await migrateUp(db, { to: 12 }));
  expect(m4(db)).toEqual(
    M4_SETTINGS.map((s) => ({
      key: s.key,
      value_json: tuned[s.key] ?? s.value_json,
    })),
  );
});

// ─── CHECKs ──────────────────────────────────────────────────────────────────

const shared = await spineAt12();
const month = {
  id: "b-month",
  scope: "fleet",
  period: "month",
  cap_usd: 10,
  updated_at: 0,
};

test.each([
  ["on_breach 'kill', deferred past M4", { on_breach: "kill" }],
  ["an unknown scope", { scope: "team" }],
  ["an unknown period", { period: "week" }],
  ["a fleet budget naming an agent", { scope_ref: SPINE_SEED.agentId }],
  ["an agent budget naming no agent", { scope: "agent" }],
  ["an agent that does not exist", { scope: "agent", scope_ref: "nobody" }],
  ["no cap at all", { cap_usd: null }],
  ["a negative cap", { cap_usd: -1 }],
  ["a negative token cap", { cap_usd: null, cap_tokens: -1 }],
  ["warn_pct 0", { warn_pct: 0 }],
  ["warn_pct 101", { warn_pct: 101 }],
] as const)("budgets refuse %s", (_, o) => {
  expect(insert(shared, "budgets", { ...month, ...o })).toMatchObject(
    validation,
  );
});

test("one budget per scope and period: the fleet's day, an agent's day and the fleet's month are three", async () => {
  const db = await spineAt12();
  const day = {
    id: "b-1",
    scope: "fleet",
    period: "day",
    cap_usd: 1,
    updated_at: 0,
  };
  const agentDay = { ...day, id: "b-3", scope: "agent", scope_ref: "agent-2" };
  expect(insert(db, "budgets", day)).toMatchObject({ ok: true });
  expect(insert(db, "budgets", { ...day, id: "b-2" })).toMatchObject(conflict);
  expect(insert(db, "budgets", agentDay)).toMatchObject({ ok: true });
  expect(insert(db, "budgets", { ...agentDay, id: "b-4" })).toMatchObject(
    conflict,
  );
  expect(
    insert(db, "budgets", {
      ...agentDay,
      id: "b-5",
      scope_ref: SPINE_SEED.agentId,
    }),
  ).toMatchObject({ ok: true });
  expect(
    insert(db, "budgets", { ...day, id: "b-6", period: "month" }),
  ).toMatchObject({ ok: true });
});

const okBackup = {
  id: "k",
  started_at: 1,
  ended_at: 2,
  outcome: "ok",
  path: "/b.enc",
};

test.each([
  ["an ok backup without its file", { path: null }],
  ["a failed backup without a reason", { outcome: "failed", path: null }],
  ["an end before its start", { started_at: 3 }],
  ["an unknown outcome", { outcome: "partial" }],
] as const)("backups refuse %s", (_, o) => {
  expect(insert(shared, "backups", { ...okBackup, ...o })).toMatchObject(
    validation,
  );
});

// ─── v_needs_attention's M4 arms: each appears, and goes when its cause clears ──

test("budget_warn: a budget at warn_pct of its dollar or token cap appears, and goes when the cap is raised", async () => {
  const db = await spineAt12();
  // The view reads the wall clock (unixepoch()), so the spend is stamped now.
  const now = Date.now();
  unwrap(
    await seedRows(db, {
      budgets: [
        budget("b-usd", { cap_usd: 10 }),
        budget("b-tokens", {
          scope: "agent",
          scope_ref: SPINE_SEED.agentId,
          period: "month",
          cap_usd: null,
          cap_tokens: 1000,
        }),
      ],
      spend: [spend("sp-1", "R-1", 6.5, 650, now)],
    }),
  );
  expect(await armOf(db, "budget_warn")).toEqual([]);
  unwrap(await seedRows(db, { spend: [spend("sp-2", "R-1", 0.5, 50, now)] }));
  expect(await armOf(db, "budget_warn")).toEqual([
    { ref: "b-tokens", ticket_id: null },
    { ref: "b-usd", ticket_id: null },
  ]);
  exec(db, "UPDATE budgets SET cap_usd = 100 WHERE id = 'b-usd'");
  exec(db, "UPDATE budgets SET cap_tokens = 1001 WHERE id = 'b-tokens'");
  expect(await armOf(db, "budget_warn")).toEqual([]);
});

test("budget_warn counts only its scope and its window, the same sums listBudgets computes", async () => {
  const wall = new FakeClock(Date.now());
  const db = await spineAt12(wall);
  const now = wall.now();
  const lastMonth = budgetWindow("month", now).start - 1;
  unwrap(
    await seedRows(db, {
      budgets: [
        budget("b-agent", { scope: "agent", scope_ref: SPINE_SEED.agentId }),
        budget("b-fleet", { period: "month", cap_usd: 100 }),
      ],
      spend: [
        spend("sp-mine", "R-1", 6, 100, now),
        spend("sp-other", "R-2", 9, 100, now),
        spend("sp-old", "R-1", 9, 100, lastMonth),
      ],
    }),
  );
  const spent = async () =>
    unwrap(await listBudgets(db)).map((b) => [b.id, b.spent_usd]);
  // The agent's day: 6 of 10, under 70 %; the fleet's month: 15 of 100.
  expect(await spent()).toEqual([
    ["b-agent", 6],
    ["b-fleet", 15],
  ]);
  expect(await armOf(db, "budget_warn")).toEqual([]);
  unwrap(await seedRows(db, { spend: [spend("sp-more", "R-1", 1, 100, now)] }));
  expect(await spent()).toEqual([
    ["b-agent", 7],
    ["b-fleet", 16],
  ]);
  expect(await armOf(db, "budget_warn")).toEqual([
    { ref: "b-agent", ticket_id: null },
  ]);
});

test("worktree_dirty: a worktree kept dirty appears with its ticket, and goes once removed", async () => {
  const db = await spineAt12();
  unwrap(
    await seedRows(db, {
      repos: [{ id: "repo-1", name: "repo", mirror_path: "/mirrors/repo.git" }],
      workspaces: [{ id: "ws-1", name: "ws", kind: "single" }],
      tickets: [ticketRow(1)],
      worktrees: [
        {
          id: "wt-1",
          session_root: "/work/t-1",
          workspace_id: "ws-1",
          repo_id: "repo-1",
          path: "/work/t-1/repo",
          branch: "agent/T-1",
          base_sha: "0".repeat(40),
          ticket_id: "ticket-1",
          session_id: SPINE_SEED.sessionId,
          state: "idle",
          created_at: 0,
        },
      ],
    }),
  );
  expect(await armOf(db, "worktree_dirty")).toEqual([]);
  exec(db, "UPDATE worktrees SET state = 'dirty'");
  expect(await armOf(db, "worktree_dirty")).toEqual([
    { ref: "wt-1", ticket_id: "ticket-1" },
  ]);
  exec(db, "UPDATE worktrees SET state = 'removed'");
  expect(await armOf(db, "worktree_dirty")).toEqual([]);
});

test("executor_unhealthy: an enabled executor that failed its health check appears, and goes when healthy", async () => {
  const db = await spineAt12();
  const local = SPINE_SEED.executorId;
  expect(await armOf(db, "executor_unhealthy")).toEqual([]);
  unwrap(
    await setExecutorHealth(db, local, "unhealthy", { failures: ["disk"] }),
  );
  expect(await armOf(db, "executor_unhealthy")).toEqual([
    { ref: local, ticket_id: null },
  ]);
  // A disabled executor is scheduled nowhere, so its health needs no one.
  exec(db, "UPDATE executors SET enabled = 0");
  expect(await armOf(db, "executor_unhealthy")).toEqual([]);
  exec(db, "UPDATE executors SET enabled = 1");
  unwrap(await setExecutorHealth(db, local, "healthy", {}));
  expect(await armOf(db, "executor_unhealthy")).toEqual([]);
});

test("backup_failed: the newest attempt failed appears, and goes when a later one succeeds", async () => {
  const db = await dbAt(12);
  const failed = { outcome: "failed", path: null, error: "disk full" } as const;
  unwrap(await seedRows(db, { backups: [backup("k-1", 100, failed)] }));
  expect(await armOf(db, "backup_failed")).toEqual([
    { ref: "k-1", ticket_id: null },
  ]);
  unwrap(await seedRows(db, { backups: [backup("k-2", 200)] }));
  expect(await armOf(db, "backup_failed")).toEqual([]);
  // Only the newest counts: k-1's old failure does not come back with k-3's.
  unwrap(await seedRows(db, { backups: [backup("k-3", 300, failed)] }));
  expect(await armOf(db, "backup_failed")).toEqual([
    { ref: "k-3", ticket_id: null },
  ]);
});
