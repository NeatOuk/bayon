import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { seedRows, seedSpine, tempDb, unwrap } from "./testing.js";

// 015_worktree_sweep: worktrees.kept_reason and kept_detail, the sweep's settings, and
// v_needs_attention's exclusive worktree arms, on an empty and on a seeded database, down and up.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;

const Columns = z.array(z.object({ name: z.string() }));
const columnsOf = (db: Db, table: string): string[] =>
  Columns.parse(
    rawOf(db)
      .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
      .all(table),
  ).map((c) => c.name);

const KEYS = [
  "worktree.mirror_tmp_min_age_ms",
  "worktree.min_ended_ms",
  "worktree.remove_timeout_ms",
  "worktree.request_min_gap_ms",
  "worktree.disposable_ignored",
];
const Setting = z.array(z.object({ key: z.string(), value_json: z.string() }));
const settingsOf = (db: Db): Record<string, string> =>
  Object.fromEntries(
    Setting.parse(
      rawOf(db)
        .prepare(
          `SELECT key, value_json FROM settings WHERE key IN (${KEYS.map(() => "?").join(",")})`,
        )
        .all(...KEYS),
    ).map((s) => [s.key, s.value_json]),
  );

const Arm = z.array(z.object({ why: z.string(), ref: z.string() }));
const worktreeArms = (db: Db) =>
  Arm.parse(
    rawOf(db)
      .prepare(
        "SELECT why, ref FROM v_needs_attention WHERE why LIKE 'worktree_%' ORDER BY why, ref",
      )
      .all(),
  );

const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;

/** Worktree rows in every state 012 knew; kept_reason is set with SQL once 015 is in. */
async function seedWorktrees(db: Db): Promise<void> {
  unwrap(
    await seedRows(db, {
      repos: [{ id: "repo", name: "repo", mirror_path: "/m/repo" }],
      workspaces: [{ id: "ws", name: "ws", kind: "single" }],
      worktrees: (
        [
          ["w-active", "active"],
          ["w-dirty", "dirty"],
          ["w-idle", "idle"],
          ["w-removed", "removed"],
        ] as const
      ).map(([id, state]) => ({
        id,
        session_root: "/w",
        workspace_id: "ws",
        repo_id: "repo",
        path: `/w/${id}`,
        branch: "frm/x",
        base_sha: "abc",
        state,
        created_at: 0,
      })),
    }),
  );
}

const flag = (db: Db, id: string, reason: string | null): void => {
  rawOf(db)
    .prepare("UPDATE worktrees SET kept_reason = ? WHERE id = ?")
    .run(reason, id);
};

test("015 on an empty database: the columns, the settings, and down removes them", async () => {
  const db = await dbAt(14);
  expect(columnsOf(db, "worktrees")).not.toContain("kept_reason");
  expect(settingsOf(db)).toEqual({});
  unwrap(await migrateUp(db, { to: 15 }));
  expect(await version(db)).toBe(15);
  expect(columnsOf(db, "worktrees").slice(-2)).toEqual([
    "kept_reason",
    "kept_detail",
  ]);
  expect(settingsOf(db)).toEqual({
    "worktree.mirror_tmp_min_age_ms": "86400000",
    "worktree.min_ended_ms": "3600000",
    "worktree.remove_timeout_ms": "900000",
    "worktree.request_min_gap_ms": "60000",
    "worktree.disposable_ignored": expect.stringContaining('"node_modules/"'),
  });
  const disposable = z
    .array(z.string())
    .parse(JSON.parse(settingsOf(db)["worktree.disposable_ignored"] ?? ""));
  expect(disposable).toEqual([
    "node_modules/",
    "dist/",
    "build/",
    "target/",
    ".venv/",
    "__pycache__/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    ".turbo/",
    ".next/",
    "coverage/",
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(14);
  expect(columnsOf(db, "worktrees")).not.toContain("kept_reason");
  expect(columnsOf(db, "worktrees")).not.toContain("kept_detail");
  expect(settingsOf(db)).toEqual({});
  unwrap(await migrateUp(db, { to: 15 }));
  expect(Object.keys(settingsOf(db))).toHaveLength(KEYS.length);
});

test("015's CHECK takes only the six reasons", async () => {
  const db = await dbAt(15);
  await seedWorktrees(db);
  expect(() => flag(db, "w-active", "bogus")).toThrow(/CHECK/);
  for (const reason of [
    "dirty",
    "ignored",
    "locked",
    "unpublished",
    "unverifiable",
    "remove_failed",
    null,
  ]) {
    flag(db, "w-active", reason);
  }
});

test("015 on a seeded database: the worktree arms are exclusive, a removed row is never listed; down and up keep the rows", async () => {
  const db = await dbAt(14);
  unwrap(await seedSpine(db, 14));
  await seedWorktrees(db);
  // 012: the dirty state alone.
  expect(worktreeArms(db)).toEqual([{ why: "worktree_dirty", ref: "w-dirty" }]);
  unwrap(await migrateUp(db, { to: 15 }));
  expect(worktreeArms(db)).toEqual([{ why: "worktree_dirty", ref: "w-dirty" }]);

  flag(db, "w-active", "dirty");
  flag(db, "w-idle", "locked");
  flag(db, "w-dirty", "unpublished"); // the flag wins: one arm, never both
  flag(db, "w-removed", "dirty");
  expect(worktreeArms(db)).toEqual([
    { why: "worktree_dirty", ref: "w-active" },
    { why: "worktree_kept", ref: "w-dirty" },
    { why: "worktree_kept", ref: "w-idle" },
  ]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(14);
  const n = z
    .array(z.object({ n: z.number() }))
    .parse(
      rawOf(db).prepare("SELECT count(*) AS n FROM worktrees").all(),
    )[0]?.n;
  expect(n).toBe(4);
  // 012's view again: the state alone, no worktree_kept.
  expect(worktreeArms(db)).toEqual([{ why: "worktree_dirty", ref: "w-dirty" }]);
  unwrap(await migrateUp(db, { to: 15 }));
  expect(await version(db)).toBe(15);
  expect(worktreeArms(db)).toEqual([{ why: "worktree_dirty", ref: "w-dirty" }]);
});

test("an operator's own value for a sweep setting survives 015", async () => {
  const db = await dbAt(14);
  rawOf(db)
    .prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('worktree.min_ended_ms', '7200000', 0)",
    )
    .run();
  unwrap(await migrateUp(db, { to: 15 }));
  expect(settingsOf(db)["worktree.min_ended_ms"]).toBe("7200000");
});
