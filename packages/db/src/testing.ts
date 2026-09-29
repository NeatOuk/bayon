// @bayon/db/testing: helpers for *.test.ts only. no-sql.test.ts fails any other importer.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  FakeClock,
  err,
  ok,
  type Result,
  type TicketStatus,
} from "@bayon/core";
import type { Insertable, Selectable, Updateable } from "kysely";
import { z } from "zod";
import {
  all,
  execute,
  first,
  internalsOf,
  openDb,
  qb,
  read,
  write,
  type Db,
  type R,
} from "./connection.js";
import { capture, failure } from "./errors.js";
import { migrateUp } from "./migrate.js";
import { insertEventsBatch, type EventInsert } from "./repos/events.js";
import type { NewRun } from "./repos/runs.js";
import { createSession, type NewSession } from "./repos/sessions.js";
import type { NewTicket, TicketActor } from "./repos/ticket-writes.js";
import type {
  AuditLogTable,
  CommandRow,
  DB,
  ModelsTable,
  SessionRow,
  TicketsTable,
} from "./schema.js";
import type { NeedsAttentionRow } from "./schema-work.js";

/**
 * The API's command writer, for supervisor tests: apps/supervisor may not import @bayon/db/api
 * (no-sql.test.ts), yet its claimer tests need commands to claim.
 */
export { insertCommand } from "./repos/commands.js";

/** The supervisor's adopt re-mint, for API tests: apps/api may not import @bayon/db/supervisor. */
export { setSessionTokenHash } from "./repos/sessions.js";

/** The supervisor's update-check write, for API tests that need an open runner update. */
export { recordRunnerUpdate } from "./repos/runner-updates.js";

/** The API's judgement write, for supervisor tests playing handoff_write (wires the tool). */
export { writeHandoffJudgement } from "./repos/handoffs.js";

/**
 * The API's waive and status writers, for the supervisor's machine-step sweep tests:
 * they play the operator's waive of a round's last failed gate, and an unblock back into review.
 */
export { waiveGate } from "./repos/gate-writes.js";
export { transitionTicket } from "./repos/ticket-transition.js";
/** The API's role-binding writer, for the supervisor's per-model resolve and pick tests. */
export { putRoleBinding } from "./repos/role-bindings.js";

export interface TempDb {
  readonly db: Db;
  readonly path: string;
  /** Closes the database and removes its directory. */
  cleanup(): void;
}

/**
 * A database file in a fresh temp directory (never :memory:, since WAL matters), migrated to
 * `to`: by default the latest, and 0 leaves the file empty. Busy-retry jitter is pinned to 1×,
 * so the retries wait exactly 25, 50 and 100 ms.
 */
export async function tempDb(
  clock: FakeClock,
  o: { to?: number } = {},
): R<TempDb> {
  const dir = capture(() => mkdtempSync(join(tmpdir(), "bayon-db-")));
  if (!dir.ok) return dir;
  const path = join(dir.value, "foreman.db");
  const removeDir = () => rmSync(dir.value, { recursive: true, force: true });
  const opened = await openDb({ path, clock, random: () => 0.5 });
  if (!opened.ok) {
    removeDir();
    return opened;
  }
  const db = opened.value;
  const cleanup = () => {
    const ix = internalsOf(db);
    if (ix.ok) ix.value.raw.close();
    removeDir();
  };
  if (o.to !== 0) {
    const migrated = await migrateUp(db, { to: o.to });
    if (!migrated.ok) {
      cleanup();
      return migrated;
    }
  }
  return ok({ db, path, cleanup });
}

/** The ids seedSpine writes. */
export const SPINE_SEED = {
  runnerId: "fixture",
  executorId: "local",
  agentId: "agent-fixture",
  agentName: "fixture",
  /** A run class 002 does not seed, so a 001 database can hold a session. */
  runClass: "fixture_only",
  sessionId: "session-fixture",
} as const;

const HASH = "0".repeat(64);

/**
 * A valid NewSession for the seeded spine. The MCP token hash is fresh on every call, as a
 * minted token's is: 003 makes sessions.mcp_token_hash unique.
 */
export const newSessionInput = (): NewSession => ({
  agent_id: SPINE_SEED.agentId,
  role: "builder",
  run_class: SPINE_SEED.runClass,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  session_root: "/tmp/bayon-fixture/work",
  home_dir: "/tmp/bayon-fixture/home",
  config_hash: HASH,
  raw_log_path: "/tmp/bayon-fixture/raw.jsonl",
  mcp_token_hash: randomBytes(32).toString("hex"),
});

/** A valid NewRun for `sessionId`. */
export const newRunInput = (sessionId: string): NewRun => ({
  session_id: sessionId,
  trigger: "operator",
  prompt_path: "/tmp/bayon-fixture/prompts/run-1.md",
  prompt_hash: HASH,
  context_hash: HASH,
});

/** The operator, as the actor of a ticket write. */
export const OPERATOR: TicketActor = {
  actor_kind: "operator",
  actor_id: "operator",
};

/** A valid NewTicket: a backlog chore the operator filed. */
export const newTicketInput = (o: Partial<NewTicket> = {}): NewTicket => ({
  title: "fixture ticket",
  type: "chore",
  status: "backlog",
  origin: "operator",
  ...o,
});

/**
 * A models row for seedRows: id `<runner>.<tier>`, active, priced. Certification is per model
 * (045), so a test that stores one seeds the models it certifies.
 */
export const modelRow = (
  runnerId: string,
  tier: "complex" | "standard" | "cheap",
  o: Partial<Insertable<ModelsTable>> = {},
): Insertable<ModelsTable> => ({
  id: `${runnerId}.${tier}`,
  runner_id: runnerId,
  tier,
  model: `${runnerId}-${tier}-model`,
  price_in_per_mtok: tier === "cheap" ? 1 : tier === "standard" ? 3 : 15,
  active: 1,
  ...o,
});

/** A raw tickets row for seedRows, id `ticket-<num>`: a ticket as 001 could hold it. */
export const ticketRow = (
  num: number,
  o: Partial<Insertable<TicketsTable>> = {},
): Insertable<TicketsTable> => ({
  id: `ticket-${num}`,
  num,
  title: `ticket ${num}`,
  type: "chore",
  status: "backlog",
  origin: "operator",
  created_at: 0,
  updated_at: 0,
  ...o,
});

/**
 * Seeds rows valid at schema `version`. 0 seeds nothing. From 1 on it seeds the spine: a runner,
 * an executor, an agent, the fixture_only run class and an idle session (SPINE_SEED). A later
 * migration that needs more rows extends this per version.
 */
export async function seedSpine(db: Db, version: number): R<void> {
  if (!Number.isInteger(version) || version < 0) {
    return err(
      failure("validation", `version must be an integer >= 0, not ${version}`),
    );
  }
  if (version === 0) return ok(undefined);
  return write(db, (ix) => {
    const now = ix.clock.now();
    const { runnerId, executorId, agentId, agentName, runClass, sessionId } =
      SPINE_SEED;
    execute(
      ix,
      qb.insertInto("runners").values({
        id: runnerId,
        kind: "script",
        adapter: "fixture",
        caps_json: "{}",
      }),
    );
    execute(
      ix,
      qb
        .insertInto("executors")
        .values({ id: executorId, kind: "local", config_json: "{}" }),
    );
    execute(
      ix,
      qb.insertInto("agents").values({
        id: agentId,
        name: agentName,
        kind: "builder",
        runner_id: runnerId,
        executor_id: executorId,
        created_at: now,
      }),
    );
    execute(
      ix,
      qb.insertInto("run_classes").values({
        name: runClass,
        context_tokens_cap: 1_000,
        max_turns: 5,
        max_tool_calls: 10,
        wall_clock_ms: 60_000,
        cost_cap_usd: 0.1,
        handoff_at_turns: 0,
        default_tier: "cheap",
      }),
    );
    execute(
      ix,
      qb.insertInto("sessions").values({
        ...newSessionInput(),
        id: sessionId,
        state: "idle",
        created_at: now,
      }),
    );
    return ok(undefined);
  });
}

/**
 * v_needs_attention read raw, as the migration the database is at defines it: for a migration test
 * at a version before 044, whose view still aged its arms on SQLite's own clock and held
 * budget_warn. From 044 the raw view lists timed rows at any age: read listNeedsAttention there.
 */
export function rawAttentionForTest(db: Db): R<NeedsAttentionRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("v_needs_attention")
        .select(["why", "ref", "ticket_id"])
        .orderBy("why")
        .orderBy("ref")
        .orderBy("ticket_id"),
    ),
  );
}

/** SQLite's date functions, each with the index of its time value (`strftime`'s follows its format). */
const SQL_DATE_FUNCTIONS = [
  ["date", 0],
  ["time", 0],
  ["datetime", 0],
  ["julianday", 0],
  ["unixepoch", 0],
  ["strftime", 1],
] as const;

/** A private connection that computes with SQLite's own date functions, for sqlClockFollowsDate. */
let sqlDates: Database.Database | undefined;

/**
 * Points this connection's SQLite date functions at JavaScript's clock: a time value of 'now', or
 * none, becomes `Date.now()`, so `vi.setSystemTime` moves SQL's clock with JavaScript's, as
 * faketime would move the whole process (a SQL read of the real clock cannot hide from a
 * test that fakes the date). Any other time value is left as it is, and SQLite computes every
 * result, on a private in-memory connection. The SQL is fixed here (Invariant 6).
 */
export function sqlClockFollowsDate(db: Db): Result<void> {
  const ix = internalsOf(db);
  if (!ix.ok) return ix;
  const raw = ix.value.raw;
  return capture(() => {
    const dates = (sqlDates ??= new Database(":memory:"));
    for (const [name, at] of SQL_DATE_FUNCTIONS) {
      raw.function(
        name,
        { varargs: true, deterministic: false },
        (...args: unknown[]): unknown => {
          const value = args[at];
          const now =
            args.length <= at ||
            (typeof value === "string" && value.toLowerCase() === "now");
          const bound = now
            ? [
                ...args.slice(0, at),
                Date.now() / 1000,
                "unixepoch",
                ...args.slice(at + 1),
              ]
            : args;
          const marks = bound.map(() => "?").join(", ");
          return dates
            .prepare(`SELECT ${name}(${marks})`)
            .pluck()
            .get(...bound);
        },
      );
    }
  });
}

/** Sets busy_timeout on this connection, so a test's BUSY fails at once instead of waiting 5 s. */
export async function setBusyTimeoutForTest(db: Db, ms: number): R<void> {
  if (!Number.isInteger(ms) || ms < 0) {
    return err(
      failure("validation", `busy_timeout must be an integer >= 0, not ${ms}`),
    );
  }
  const ix = internalsOf(db);
  if (!ix.ok) return ix;
  return capture(() => {
    ix.value.raw.pragma(`busy_timeout = ${ms}`);
  });
}

/** A `runner_certifications` row as 044 held it: keyed (runner, executor), no model. */
export interface Pre045Certification {
  readonly runner_id: string;
  readonly executor_id: string;
  readonly runner_version: string;
  readonly suite_version: string;
  readonly kit_hash: string;
  readonly caps_hash: string;
  readonly result_json: string;
  readonly gate_eligible: number;
  readonly passed_at: number | null;
  readonly certified_at: number;
}

/**
 * Inserts a certification into a database at 044, the way one stored before certification was
 * per model looked: for tests that carry one across 045. The SQL stays here.
 */
export async function seedPre045CertificationForTest(
  db: Db,
  row: Pre045Certification,
): R<void> {
  const ix = internalsOf(db);
  if (!ix.ok) return ix;
  return capture(() => {
    ix.value.raw
      .prepare(
        `INSERT INTO runner_certifications (runner_id, executor_id, runner_version, suite_version,
           kit_hash, caps_hash, result_json, gate_eligible, passed_at, certified_at)
         VALUES (@runner_id, @executor_id, @runner_version, @suite_version, @kit_hash,
           @caps_hash, @result_json, @gate_eligible, @passed_at, @certified_at)`,
      )
      .run(row);
  });
}

/** The tables a test may make refuse inserts (failInsertsForTest). */
export type FailableTable = "handoffs";

/**
 * Makes every insert into `table` fail, through a RAISE trigger, until the returned undo drops it:
 * for tests of a writer's failure path (MEDIUM-4). The SQL stays here (Invariant 6).
 */
export async function failInsertsForTest(
  db: Db,
  table: FailableTable,
): R<() => R<void>> {
  const ix = internalsOf(db);
  if (!ix.ok) return ix;
  const raw = ix.value.raw;
  const name = `test_fail_insert_${table}`;
  const made = capture(() => {
    raw.exec(
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'failInsertsForTest: ${table}'); END`,
    );
  });
  if (!made.ok) return made;
  return ok(async () =>
    capture(() => {
      raw.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }),
  );
}

// Writers for tests outside packages/db, which may not import @bayon/db/supervisor (no-sql.test.ts):
// they let an API or web test play the supervisor against a real database.

/** A pending session with this id on the seeded spine (seedSpine first). */
export function addSession(db: Db, id: string): R<SessionRow> {
  return createSession(db, { ...newSessionInput(), id });
}

/**
 * Appends `count` assistant_text events to a session the way ingest does: one batch in one
 * transaction, raw offsets continuing the session's. Resolves to their ids, ascending.
 */
export async function appendEvents(
  db: Db,
  sessionId: string,
  count: number,
  /** Truncation columns for every appended event: a capped payload on disk (§8.5). */
  extra: Partial<
    Pick<EventInsert, "payload_path" | "bytes_original" | "truncated">
  > = {},
): R<number[]> {
  const last = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("events")
        .select((eb) => eb.fn.max("raw_offset").as("offset"))
        .where("session_id", "=", sessionId),
    ),
  );
  if (!last.ok) return last;
  const ix = internalsOf(db);
  if (!ix.ok) return ix;
  const start = (last.value?.offset ?? -1) + 1;
  const ts = ix.value.clock.now();
  const rows = Array.from({ length: count }, (_, i): EventInsert => ({
    session_id: sessionId,
    ts,
    kind: "assistant_text",
    runner_type: "text",
    text: `event ${start + i}`,
    payload_json: "{}",
    raw_offset: start + i,
    ...extra,
  }));
  const inserted = await insertEventsBatch(db, rows);
  if (!inserted.ok) return inserted;
  const { inserted: n, lastId } = inserted.value;
  return ok(
    lastId === null
      ? []
      : Array.from({ length: n }, (_, i) => lastId - n + 1 + i),
  );
}

/**
 * Appends one `terminal` event with `payload` to a session the way ingest does, its raw offset after
 * the session's last: for a reader of what a run's terminal carries (context totals).
 */
export async function appendTerminalForTest(
  db: Db,
  sessionId: string,
  payload: Readonly<Record<string, unknown>>,
): R<void> {
  const last = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("events")
        .select((eb) => eb.fn.max("raw_offset").as("offset"))
        .where("session_id", "=", sessionId),
    ),
  );
  if (!last.ok) return last;
  const ix = internalsOf(db);
  if (!ix.ok) return ix;
  const inserted = await insertEventsBatch(db, [
    {
      session_id: sessionId,
      ts: ix.value.clock.now(),
      kind: "terminal",
      runner_type: "result",
      payload_json: JSON.stringify(payload),
      raw_offset: (last.value?.offset ?? -1) + 1,
    },
  ]);
  return inserted.ok ? ok(undefined) : inserted;
}

/** Every command, oldest first. */
export function listCommands(db: Db): R<CommandRow[]> {
  return read(db, (ix) =>
    all(ix, qb.selectFrom("commands").selectAll().orderBy("ts").orderBy("id")),
  );
}

/** Every audit_log row, oldest first: API tests may not read it with SQL of their own. */
export function listAudit(db: Db): R<Selectable<AuditLogTable>[]> {
  return read(db, (ix) =>
    all(ix, qb.selectFrom("audit_log").selectAll().orderBy("id")),
  );
}

const REFUSE_TICKETS = "frm_test_refuse_tickets";

/**
 * Makes every `tickets` insert for `workspaceId` fail, until `allowTickets` lifts it: the one thing
 * no repository offers, and the only way to prove a transaction rolls back **whole** rather than
 * leaving half its work behind (the harness ticket and the QA mode that asked for it
 * commit together or not at all).
 *
 * Here rather than at the call site because Invariant 6 puts every SQL statement in this package,
 * test helpers included.
 */
export function refuseTickets(db: Db, workspaceId: string): void {
  raw(db).exec(
    `CREATE TRIGGER ${REFUSE_TICKETS} BEFORE INSERT ON tickets ` +
      `WHEN NEW.workspace_id = '${workspaceId}' ` +
      `BEGIN SELECT RAISE(ABORT, 'refused by refuseTickets'); END`,
  );
}

/** Lifts `refuseTickets`. */
export function allowTickets(db: Db): void {
  raw(db).exec(`DROP TRIGGER ${REFUSE_TICKETS}`);
}

function raw(db: Db) {
  const ix = internalsOf(db);
  if (!ix.ok) throw new Error(ix.error.message);
  return ix.value.raw;
}

const TableNames = z.array(z.object({ name: z.string() }));

/**
 * Every row of every table, the FTS shadow tables included, by table name: for a test that must
 * search the whole database, e.g. that a secret reached no row.
 */
export function dumpAllRows(
  db: Db,
): R<Readonly<Record<string, readonly unknown[]>>> {
  return read(db, (ix) => {
    const tables = TableNames.parse(
      ix.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(),
    );
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        ix.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
      ]),
    );
  });
}

// Parents before children, so every foreign key holds as rows go in.
const SEED_ORDER = [
  "runners",
  "executors",
  "models",
  "repos",
  "workspaces",
  "workspace_repos",
  "missions",
  "profiles",
  "agents",
  "run_classes",
  "settings",
  "prompt_templates",
  "tickets",
  "sessions",
  "runs",
  "worktrees",
  "events",
  "spend",
  "commands",
  "supervisor_state",
  "audit_log",
  // 003_work
  "role_bindings",
  "ticket_repos",
  "ticket_events",
  "ticket_links",
  "ticket_exports",
  "gates",
  "findings",
  "handoffs",
  "messages",
  "human_requests",
  "approvals",
  "knowledge",
  // 004_pulse
  "probes",
  "pulses",
  "pulse_checks",
  // 009_conformance
  "runner_certifications",
  "conformance_probes",
  // 012_fleet
  "budgets",
  "backups",
  // 037_delivery
  "deliveries",
] as const satisfies readonly (keyof DB)[];

/** Rows to insert, by table. */
export type SeedRows = {
  readonly [T in (typeof SEED_ORDER)[number]]?: readonly Insertable<DB[T]>[];
};

/**
 * Inserts `rows` in one transaction, parents first: the operator config a test needs. A settings
 * row overrides the value a migration seeded (004 seeds `preflight.margin_pct`, `pulse.*`, …).
 */
export function seedRows(db: Db, rows: SeedRows): R<void> {
  return write(db, (ix) => {
    for (const row of rows.settings ?? []) {
      const { value_json, updated_at } = row;
      execute(
        ix,
        qb
          .insertInto("settings")
          .values(row)
          .onConflict((oc) =>
            oc.column("key").doUpdateSet({ value_json, updated_at }),
          ),
      );
    }
    for (const table of SEED_ORDER.filter((t) => t !== "settings")) {
      for (const row of rows[table] ?? []) {
        // SeedRows already typed the row for its table; the cast only joins the two unions.
        execute(ix, qb.insertInto(table).values(row as never));
      }
    }
    return ok(undefined);
  });
}

/**
 * Tables whose rows an operator edits mid-run: capacity, switches, caps (tests), a
 * project's pause (the supervisor may not import the API's writer), plus sessions, which
 * a test arranges into the state a supervisor would otherwise have to reach for it, and repos —
 * a push target moved after a delivery (039), past the API's shape rule so a test may point one at
 * a local bare repository — and deliveries, to stand a row up as a migration older than 039 wrote it.
 */
export type EditableTable =
  | "executors"
  | "agents"
  | "budgets"
  | "sessions"
  | "workspaces"
  | "repos"
  | "deliveries"
  | "models";

/** A patch for one row of `T`. */
export type RowPatch<T extends EditableTable> = Updateable<DB[T]>;

/** Updates one row by id, as an operator's edit would; `not_found` when no row has that id. */
export function updateRowForTest<T extends EditableTable>(
  db: Db,
  table: T,
  id: string,
  patch: RowPatch<T>,
): R<void> {
  return write(db, (ix) => {
    // The tables share an `id` key; the casts only join their unions, as seedRows does.
    const row = first(
      ix,
      qb
        .updateTable(table as "executors")
        .set(patch as Updateable<DB["executors"]>)
        .where("id", "=", id)
        .returning("id"),
    );
    return row === undefined
      ? err(failure("not_found", `${table} ${id} does not exist`))
      : ok(undefined);
  });
}

/**
 * Session `S-<n>` (a builder, running) holding ticket `ticket-<n>`, each with its open run `R-<n>`
 * (no terminal event): the gate tests' workers and fixing runs.
 */
export function seedHolders(db: Db, nums: readonly number[]): R<void> {
  return seedRows(db, {
    sessions: nums.map((n) => ({
      ...newSessionInput(),
      id: `S-${n}`,
      state: "running",
      ticket_id: `ticket-${n}`,
      created_at: 0,
    })),
    runs: nums.map((n) => ({
      ...newRunInput(`S-${n}`),
      id: `R-${n}`,
      seq: 1,
      state: "running",
      started_at: 0,
    })),
  });
}

/** The gate tests' clock start. */
export const GATE_NOW = Date.UTC(2026, 8, 13, 12);

/**
 * A temp database at the latest schema with `ticket-1…n` in `statuses`, each held by seedHolders
 * (gate writer tests).
 */
export async function gateDb(
  statuses: readonly TicketStatus[],
): Promise<TempDb & { readonly clock: FakeClock }> {
  const clock = new FakeClock(GATE_NOW);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedSpine(t.db, 8));
  unwrap(
    await seedRows(t.db, {
      tickets: statuses.map((status, i) => ticketRow(i + 1, { status })),
    }),
  );
  unwrap(
    await seedHolders(
      t.db,
      statuses.map((_, i) => i + 1),
    ),
  );
  return { ...t, clock };
}

/** A result's value; an error result throws, carrying the FrmError as the cause. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.class}: ${result.error.message}`, {
    cause: result.error,
  });
}
