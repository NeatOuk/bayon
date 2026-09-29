// The GUI's one write to `projects.local_roots` (§14 amendment), against a real temp
// database: it appends and never replaces, a root already covered changes nothing, and every change
// is audited as the operator's with both lists.
import { FakeClock, LOCAL_ROOTS_KEY } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import { listAudit, tempDb, unwrap, type TempDb } from "../testing.js";
import { getSettingRows } from "./config.js";
import { upsertSetting } from "./fleet-control.js";
import { write } from "../connection.js";
import { LOCAL_ROOTS_VIA_GUI, addLocalRoot } from "./local-roots.js";

const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function fresh(roots?: readonly string[]) {
  const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  opened.push(t);
  if (roots !== undefined) {
    unwrap(
      await write(t.db, (ix) => {
        upsertSetting(ix, LOCAL_ROOTS_KEY, JSON.stringify(roots), 1);
        return { ok: true, value: undefined } as const;
      }),
    );
  }
  return t.db;
}

const stored = async (db: TempDb["db"]) =>
  unwrap(await getSettingRows(db, [LOCAL_ROOTS_KEY])).get(LOCAL_ROOTS_KEY)
    ?.value;

const rootRows = async (db: TempDb["db"]) =>
  unwrap(await listAudit(db)).filter(
    (row) => row.target_id === LOCAL_ROOTS_KEY,
  );

test("appends to the roots already there, and audits both lists", async () => {
  const db = await fresh(["/srv/a"]);
  const added = unwrap(
    await addLocalRoot(db, "/Users/me/ttm", "operator", {
      path: "/Users/me/ttm/",
      scope: "folder",
    }),
  );
  expect(added).toEqual({
    root: "/Users/me/ttm",
    roots: ["/srv/a", "/Users/me/ttm"],
    changed: true,
  });
  expect(await stored(db)).toEqual(["/srv/a", "/Users/me/ttm"]);
  const rows = await rootRows(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actor: "operator",
    action: "settings.put",
    target_kind: "setting",
  });
  expect(JSON.parse(rows[0]?.payload_json ?? "null")).toEqual({
    path: "/Users/me/ttm/",
    scope: "folder",
    via: LOCAL_ROOTS_VIA_GUI,
    from: ["/srv/a"],
    to: ["/srv/a", "/Users/me/ttm"],
  });
});

test("with no row yet, the list starts with the one root", async () => {
  const db = await fresh();
  const added = unwrap(await addLocalRoot(db, "/Users/me/ttm", "operator"));
  expect(added.roots).toEqual(["/Users/me/ttm"]);
  expect(await stored(db)).toEqual(["/Users/me/ttm"]);
});

test.each([
  ["the same root", "/Users/me/ttm"],
  ["a folder inside one", "/Users/me/ttm/sub"],
])(
  "%s already allowed changes nothing and audits nothing",
  async (_n, root) => {
    const db = await fresh(["/Users/me/ttm"]);
    const added = unwrap(await addLocalRoot(db, root, "operator"));
    expect(added).toEqual({
      root,
      roots: ["/Users/me/ttm"],
      changed: false,
    });
    expect(await rootRows(db)).toEqual([]);
  },
);

test.each([
  ["a relative path", "ttm"],
  ["a .. segment", "/Users/me/../ttm"],
  ["an empty actor", "/Users/me/ttm", ""],
])("refuses %s, writing nothing", async (_n, root, actor = "operator") => {
  const db = await fresh(["/srv/a"]);
  const added = await addLocalRoot(db, root, actor);
  expect(added.ok).toBe(false);
  if (!added.ok) expect(added.error.class).toBe("validation");
  expect(await stored(db)).toEqual(["/srv/a"]);
  expect(await rootRows(db)).toEqual([]);
});

test("a stored list that no longer parses is refused rather than overwritten", async () => {
  const db = await fresh(["not absolute"]);
  const added = await addLocalRoot(db, "/Users/me/ttm", "operator");
  expect(added.ok).toBe(false);
  expect(await stored(db)).toEqual(["not absolute"]);
});
