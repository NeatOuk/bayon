// `frm roots list | add <path> | remove <path>`: projects.local_roots one folder at a time, through
// the same audited writer and --yes gate as `frm settings set projects.local_roots`.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, LOCAL_ROOTS_KEY } from "@bayon/core";
import { getSettings, listAuditPage, openDb, type Db } from "@bayon/db";
import { migrateUp } from "@bayon/db/operator";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { parseCli } from "./cli.js";
import {
  operatorCwd,
  parseRootsCli,
  runRootsCommand,
  type RootsCommand,
} from "./roots.js";
import { parseSettingsCli, runSettingsCommand } from "./settings.js";

const T0 = 1_700_000_000_000;
// Real paths: the temp dir is behind a symlink on macOS (/var -> /private/var).
const dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-roots-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const home = join(dir, "home");
const lines: string[] = [];
const io = {
  env: { FRM_HOME: home },
  clock: new FakeClock(T0),
  out: (line: string) => lines.push(line),
  err: (line: string) => lines.push(line),
};

const folder = (name: string): string => {
  const path = join(dir, "folders", name);
  mkdirSync(path, { recursive: true });
  return path;
};

const withDb = async <T>(f: (db: Db) => Promise<T>): Promise<T> => {
  const opened = await openDb({
    path: join(home, "foreman.db"),
    clock: new FakeClock(T0),
  });
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    return await f(opened.value);
  } finally {
    await opened.value.close();
  }
};

const roots = (): Promise<unknown> =>
  withDb(async (db) => {
    const rows = await getSettings(db, [LOCAL_ROOTS_KEY]);
    if (!rows.ok) throw new Error(rows.error.message);
    return rows.value.get(LOCAL_ROOTS_KEY);
  });

const audits = (): Promise<
  readonly {
    action: string;
    target_id: string | null;
    payload_json: string | null;
  }[]
> =>
  withDb(async (db) => {
    const page = await listAuditPage(db, { limit: 20 });
    if (!page.ok) throw new Error(page.error.message);
    return page.value.rows;
  });

const run = (cmd: RootsCommand): Promise<number> => {
  lines.length = 0;
  return runRootsCommand(cmd, io);
};

const add = (path: string, yes = true) => run({ action: "add", path, yes });
const remove = (path: string, yes = true) =>
  run({ action: "remove", path, yes });

describe("parseRootsCli", () => {
  test("list, add <path> and remove <path>, with --yes", () => {
    expect(parseRootsCli(["roots", "list"])).toEqual({
      ok: true,
      value: { action: "list" },
    });
    expect(parseRootsCli(["roots"])).toEqual({
      ok: true,
      value: { action: "list" },
    });
    expect(parseRootsCli(["roots", "add", "/a", "--yes"])).toEqual({
      ok: true,
      value: { action: "add", path: "/a", yes: true },
    });
    expect(parseRootsCli(["roots", "remove", "/a"])).toEqual({
      ok: true,
      value: { action: "remove", path: "/a", yes: false },
    });
  });

  test("a missing path, an extra word or an unknown action is usage", () => {
    for (const argv of [
      ["roots", "add"],
      ["roots", "add", "/a", "/b"],
      ["roots", "list", "/a"],
      ["roots", "drop", "/a"],
    ]) {
      const parsed = parseRootsCli(argv);
      expect(!parsed.ok && parsed.error.message, argv.join(" ")).toMatch(
        /usage: frm roots list \| frm roots add <path>/,
      );
    }
  });

  test("frm routes `roots` to it", () => {
    expect(parseCli(["roots", "add", "/a", "--yes"])).toEqual({
      ok: true,
      value: {
        command: "roots",
        options: { action: "add", path: "/a", yes: true },
      },
    });
  });
});

describe("runRootsCommand", () => {
  beforeEach(async () => {
    rmSync(home, { recursive: true, force: true });
    rmSync(join(dir, "folders"), { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    await withDb(async (db) => {
      const migrated = await migrateUp(db, {});
      if (!migrated.ok) throw new Error(migrated.error.message);
    });
  });

  test("list on a fresh database: none allowed", async () => {
    expect(await run({ action: "list" })).toBe(0);
    expect(lines.join("\n")).toContain("no folder is allowed");
  });

  test("add appends the real path, audited like settings set; list shows it", async () => {
    const a = folder("a");
    const b = folder("b");
    expect(await add(a)).toBe(0);
    expect(await add(b)).toBe(0);
    expect(await roots()).toEqual([a, b]);
    expect(lines.join("\n")).toContain("(audited: settings.put via frm)");
    const rows = await audits();
    expect(rows.map((r) => [r.action, r.target_id])).toEqual([
      ["settings.put", LOCAL_ROOTS_KEY],
      ["settings.put", LOCAL_ROOTS_KEY],
    ]);
    expect(
      rows.map((r) => JSON.parse(r.payload_json ?? "null") as unknown),
    ).toContainEqual({ via: "frm", from: [a], to: [a, b] });
    expect(await run({ action: "list" })).toBe(0);
    expect(lines).toEqual([`${LOCAL_ROOTS_KEY}:`, `  ${a}`, `  ${b}`]);
  });

  test("add resolves a relative path and a symlink to the real folder", async () => {
    const real = folder("real");
    const link = join(dir, "folders", "link");
    symlinkSync(real, link);
    expect(await add(link)).toBe(0);
    expect(await roots()).toEqual([real]);
  });

  test("add is idempotent: the same folder again writes nothing, and no duplicate", async () => {
    const a = folder("a");
    expect(await add(a)).toBe(0);
    expect(await add(`${a}/`)).toBe(0);
    expect(lines.join("\n")).toContain("already");
    expect(await roots()).toEqual([a]);
    expect(await audits()).toHaveLength(1);
  });

  test("add refuses a path that does not exist, or a file, and writes nothing", async () => {
    expect(await add(join(dir, "folders", "missing"))).toBe(1);
    expect(lines.join("\n")).toMatch(/does not exist/);
    const file = join(folder("f"), "file.txt");
    writeFileSync(file, "");
    expect(await add(file)).toBe(1);
    expect(lines.join("\n")).toMatch(/not a directory/);
    expect(await roots()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  test("add and remove are security changes: without --yes they explain and write nothing", async () => {
    const a = folder("a");
    expect(await add(a, false)).toBe(2);
    const said = lines.join("\n");
    expect(said).toContain("New project form");
    expect(said).toContain("repeat the command with --yes");
    expect(await roots()).toEqual([]);
    expect(await add(a)).toBe(0);
    expect(await remove(a, false)).toBe(2);
    expect(await roots()).toEqual([a]);
  });

  test("remove drops the folder by its real path, keeping the others", async () => {
    const a = folder("a");
    const b = folder("b");
    await add(a);
    await add(b);
    const link = join(dir, "folders", "to-a");
    symlinkSync(a, link);
    expect(await remove(link)).toBe(0);
    expect(await roots()).toEqual([b]);
    expect(lines.join("\n")).toContain("(audited: settings.put via frm)");
  });

  test("remove takes the given string when the folder is gone", async () => {
    const a = folder("a");
    const b = folder("b");
    await add(a);
    await add(b);
    rmSync(a, { recursive: true });
    expect(await remove(a)).toBe(0);
    expect(await roots()).toEqual([b]);
  });

  test("remove of a folder not on the list writes nothing", async () => {
    const a = folder("a");
    expect(await remove(a)).toBe(0);
    expect(lines.join("\n")).toContain("not on the list");
    expect(await audits()).toEqual([]);
  });

  test("settings set projects.local_roots still replaces the whole list", async () => {
    const a = folder("a");
    const b = folder("b");
    await add(a);
    const parsed = parseSettingsCli([
      "settings",
      "set",
      LOCAL_ROOTS_KEY,
      b,
      "--yes",
    ]);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(await runSettingsCommand(parsed.value, io)).toBe(0);
    expect(await roots()).toEqual([b]);
  });

  test("no home and no database: the reason, exit 2", async () => {
    lines.length = 0;
    expect(await runRootsCommand({ action: "list" }, { ...io, env: {} })).toBe(
      2,
    );
    expect(lines.join("\n")).toContain("set FRM_HOME (or FRM_DB)");
  });
});

test("a relative path is from pnpm's INIT_CWD only under the frm script", () => {
  expect(
    operatorCwd(
      { INIT_CWD: "/home/op/src", npm_lifecycle_event: "frm" },
      "/repo",
    ),
  ).toBe("/home/op/src");
  expect(
    operatorCwd(
      { INIT_CWD: "/elsewhere", npm_lifecycle_event: "build" },
      "/repo",
    ),
  ).toBe("/repo");
  expect(operatorCwd({ INIT_CWD: "/elsewhere" }, "/repo")).toBe("/repo");
  expect(operatorCwd({ npm_lifecycle_event: "frm" }, "/repo")).toBe("/repo");
});

test("add and remove resolve a relative path against the cwd they are given", async () => {
  const base = join(dir, "rel");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  await withDb(async (db) => {
    const migrated = await migrateUp(db, {});
    if (!migrated.ok) throw new Error(migrated.error.message);
  });
  mkdirSync(join(base, "sub"), { recursive: true });
  lines.length = 0;
  expect(
    await runRootsCommand(
      { action: "add", path: "sub", yes: true },
      { ...io, cwd: base },
    ),
  ).toBe(0);
  expect(await roots()).toEqual([join(base, "sub")]);
});
