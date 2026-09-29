import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import {
  SPINE_SEED,
  dumpAllRows,
  modelRow,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "./testing.js";

// 049_context_compression: the project's switch (workspaces.context_compression), the
// session's pinned ruleset and saving, the run's saving, and `compression` in the certificate's key.
// On an empty and on a seeded database: every project is off, every certificate a compression-off
// one, an ON and an OFF certificate of one model coexist, and down is 048's schema byte for byte,
// keeping the OFF certificates.
const THIS = 49;
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const raw = (db: Db) => unwrap(internalsOf(db)).raw;
const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

const TABLES = ["workspaces", "sessions", "spend", "runner_certifications"];

/** The four tables' and their indexes' stored text: what down must restore exactly. */
const schemaText = (db: Db): unknown[] =>
  raw(db)
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE tbl_name IN (${TABLES.map(() => "?").join(", ")}) ORDER BY name`,
    )
    .all(...TABLES);

const columns = (db: Db, table: string): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .pluck()
        .all(),
    );

const keyOf = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      raw(db)
        .prepare(
          "SELECT name FROM pragma_table_info('runner_certifications') WHERE pk > 0 ORDER BY pk",
        )
        .pluck()
        .all(),
    );

const certRows = (db: Db): unknown[] =>
  raw(db).prepare("SELECT * FROM runner_certifications ORDER BY 1, 2, 3").all();

const cert = (
  runnerId: string,
  executorId: string,
  modelId: string,
  at: number,
) => ({
  runner_id: runnerId,
  executor_id: executorId,
  model_id: modelId,
  model: `${modelId}-string`,
  runner_version: `v-${runnerId}`,
  suite_version: "2",
  kit_hash: `sha256:kit-${modelId}`,
  caps_hash: "sha256:caps",
  result_json: `{"runner":"${runnerId}"}`,
  report_path: `/r/${modelId}.md`,
  gate_eligible: 1,
  passed_at: at,
  certified_at: at,
});

/** A certificate row with `compression`, inserted raw: the typed seeders predate nothing here. */
function insertCert(
  db: Db,
  row: ReturnType<typeof cert>,
  compression: number,
): void {
  raw(db)
    .prepare(
      `INSERT INTO runner_certifications (runner_id, executor_id, model_id, compression, model,
         runner_version, suite_version, kit_hash, caps_hash, result_json, report_path,
         gate_eligible, passed_at, certified_at)
       VALUES (@runner_id, @executor_id, @model_id, @compression, @model, @runner_version,
         @suite_version, @kit_hash, @caps_hash, @result_json, @report_path, @gate_eligible,
         @passed_at, @certified_at)`,
    )
    .run({ ...row, compression });
}

test("049 on an empty database: the switch, the pins, compression in the key; down is 048's text; up again", async () => {
  const db = await dbAt(THIS - 1);
  const before = schemaText(db);
  expect(keyOf(db)).toEqual(["runner_id", "executor_id", "model_id"]);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(columns(db, "workspaces").at(-1)).toBe("context_compression");
  expect(columns(db, "sessions").slice(-2)).toEqual([
    "context_ruleset",
    "tokens_saved",
  ]);
  expect(columns(db, "spend").at(-1)).toBe("tokens_saved");
  expect(keyOf(db)).toEqual([
    "runner_id",
    "executor_id",
    "model_id",
    "compression",
  ]);
  // No leftovers of the rebuild.
  expect(
    raw(db)
      .prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_048'")
      .all(),
  ).toEqual([]);

  // The switch: off by default, 0 or 1 only.
  raw(db)
    .prepare(
      "INSERT INTO workspaces (id, name, kind) VALUES ('p', 'p', 'single')",
    )
    .run();
  expect(
    raw(db).prepare("SELECT context_compression FROM workspaces").pluck().get(),
  ).toBe(0);
  expect(() =>
    raw(db).prepare("UPDATE workspaces SET context_compression = 2").run(),
  ).toThrow(/CHECK/);
  raw(db).prepare("DELETE FROM workspaces").run();

  // An ON and an OFF certificate of one (runner, executor, model) coexist; a third value does not.
  unwrap(await seedSpine(db, THIS));
  const { runnerId, executorId } = SPINE_SEED;
  unwrap(await seedRows(db, { models: [modelRow(runnerId, "cheap")] }));
  const row = cert(runnerId, executorId, `${runnerId}.cheap`, 10);
  insertCert(db, row, 0);
  insertCert(db, { ...row, kit_hash: "sha256:kit-on" }, 1);
  expect(() => insertCert(db, row, 0)).toThrow(/UNIQUE|PRIMARY KEY/);
  expect(() => insertCert(db, row, 2)).toThrow(/CHECK/);
  expect(
    raw(db)
      .prepare(
        "SELECT compression, kit_hash FROM runner_certifications ORDER BY compression",
      )
      .all(),
  ).toEqual([
    { compression: 0, kit_hash: `sha256:kit-${runnerId}.cheap` },
    { compression: 1, kit_hash: "sha256:kit-on" },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(schemaText(db)).toEqual(before);
  // Down kept the OFF certificate alone.
  expect(
    raw(db).prepare("SELECT kit_hash FROM runner_certifications").pluck().all(),
  ).toEqual([`sha256:kit-${runnerId}.cheap`]);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
});

test("049 on a seeded database: every project off, every certificate off; the rest untouched; down keeps the OFF rows", async () => {
  const db = await dbAt(THIS - 1);
  unwrap(await seedSpine(db, THIS - 1));
  const { runnerId, executorId, sessionId } = SPINE_SEED;
  unwrap(
    await seedRows(db, {
      executors: [{ id: "ctr", kind: "container", config_json: "{}" }],
      models: [modelRow(runnerId, "cheap"), modelRow(runnerId, "complex")],
      workspaces: [
        { id: "ws-a", name: "a", kind: "single", paused: 1 },
        {
          id: "ws-b",
          name: "b",
          kind: "multi",
          review_tier: "complex",
          staff_approval: 1,
        },
      ],
      runner_certifications: [
        cert(runnerId, executorId, `${runnerId}.cheap`, 10),
        cert(runnerId, executorId, `${runnerId}.complex`, 11),
        cert(runnerId, "ctr", `${runnerId}.cheap`, 12),
      ],
    }),
  );
  raw(db)
    .prepare(
      `INSERT INTO runs (id, session_id, seq, trigger, prompt_path, prompt_hash, context_hash,
         state, started_at)
       VALUES ('run-1', ?, 1, 'operator', '/p', 'h', 'h', 'ok', 1)`,
    )
    .run(sessionId);
  raw(db)
    .prepare(
      `INSERT INTO spend (id, run_id, session_id, phase, runner_id, model, tokens_in,
         tokens_tool_result, cost_usd, cost_source, ts)
       VALUES ('sp-1', 'run-1', ?, 'fixture_only', ?, 'm', 7, NULL, 0.5, 'reported', 1)`,
    )
    .run(sessionId, runnerId);
  const snapshot = (d: Db) => ({
    workspaces: raw(d).prepare("SELECT * FROM workspaces ORDER BY id").all(),
    sessions: raw(d).prepare("SELECT * FROM sessions ORDER BY id").all(),
    spend: raw(d).prepare("SELECT * FROM spend ORDER BY id").all(),
    certs: certRows(d),
  });
  const before = snapshot(db);
  const others = (d: Db) =>
    dumpAllRows(d).then((rows) =>
      Object.entries(unwrap(rows)).filter(
        ([table]) => ![...TABLES, "_migrations"].includes(table),
      ),
    );
  const othersBefore = await others(db);

  unwrap(await migrateUp(db, { to: THIS }));
  const after = snapshot(db);
  expect(after.workspaces).toEqual(
    before.workspaces.map((row) => ({
      ...(row as object),
      context_compression: 0,
    })),
  );
  expect(after.sessions).toEqual(
    before.sessions.map((row) => ({
      ...(row as object),
      context_ruleset: null,
      tokens_saved: null,
    })),
  );
  expect(after.spend).toEqual(
    before.spend.map((row) => ({ ...(row as object), tokens_saved: null })),
  );
  // Every certificate carried over whole, as a compression-off one.
  expect(
    after.certs.map((row) => {
      const { compression, ...rest } = row as { compression: number };
      expect(compression).toBe(0);
      return rest;
    }),
  ).toEqual(before.certs);
  expect(await others(db)).toEqual(othersBefore);

  // The project turned on, a session pinned, a run's saving, and an ON certificate beside an OFF one.
  raw(db).prepare("UPDATE workspaces SET context_compression = 1").run();
  raw(db)
    .prepare(
      "UPDATE sessions SET context_ruleset = 'ctx1', tokens_saved = 400 WHERE id = ?",
    )
    .run(sessionId);
  raw(db).prepare("UPDATE spend SET tokens_saved = 400").run();
  insertCert(
    db,
    {
      ...cert(runnerId, executorId, `${runnerId}.cheap`, 20),
      kit_hash: "sha256:on",
    },
    1,
  );

  unwrap(await migrateDown(db));
  expect(snapshot(db)).toEqual(before);
  expect(await others(db)).toEqual(othersBefore);
});
