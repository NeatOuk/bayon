// Stale mirror temp dirs: only `.<base>.clone-XXXXXX`
// real directories older than max(the setting, 2 × git timeout) go; the mirror, lookalikes, links,
// files and young ones stay.
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { seedRows, tempDb, unwrap, type SeedRows } from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { sweepMirrorTemps } from "./mirror-tmp.js";
import {
  cleanupWorlds,
  sweepWorld,
  T0,
  type OpenDb,
} from "./testing/sweep-world.js";

afterAll(cleanupWorlds);

/** Each world's own temp database (only tests import @bayon/db/testing). */
const open: OpenDb = async (clock) => {
  const t = unwrap(await tempDb(clock));
  return {
    db: t.db,
    drop: t.cleanup,
    seed: async (rows) => {
      unwrap(await seedRows(t.db, rows as SeedRows));
    },
  };
};

const FLOOR = 2 * 300_000; // 2 × workspace.git_timeout_ms's default, above the setting given

function aged(path: string, ageMs: number): void {
  const at = (T0 - ageMs) / 1000;
  for (const p of [
    path,
    join(path, "objects"),
    join(path, "objects", "pack"),
  ]) {
    if (existsSync(p)) utimesSync(p, at, at);
  }
}

function clone(path: string): void {
  mkdirSync(join(path, "objects", "pack"), { recursive: true });
  writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n");
}

test("only a stale `.<base>.clone-XXXXXX` directory goes", async () => {
  const w = await sweepWorld(open);
  const r = await w.repo("app");
  const parent = dirname(r.mirror);
  const at = (name: string) => join(parent, name);
  clone(at(".app.git.clone-Ab12Cd"));
  aged(at(".app.git.clone-Ab12Cd"), FLOOR + 1);
  clone(at(".app.git.clone-Young1"));
  aged(at(".app.git.clone-Young1"), FLOOR - 1);
  clone(at(".app.git.clone-Floor1"));
  aged(at(".app.git.clone-Floor1"), FLOOR);
  clone(at(".app.git.clone-Ab12Cde"));
  aged(at(".app.git.clone-Ab12Cde"), FLOOR * 10);
  clone(at(".other.git.clone-Ab12Cd"));
  aged(at(".other.git.clone-Ab12Cd"), FLOOR * 10);
  writeFileSync(at(".app.git.clone-File12"), "a file\n");
  symlinkSync(at(".other.git.clone-Ab12Cd"), at(".app.git.clone-Link12"));
  aged(r.mirror, FLOOR * 10);

  expect(
    await sweepMirrorTemps(w.deps, 1_000, new AbortController().signal),
  ).toBe(1);
  expect(existsSync(at(".app.git.clone-Ab12Cd"))).toBe(false);
  for (const kept of [
    ".app.git.clone-Young1",
    ".app.git.clone-Floor1",
    ".app.git.clone-Ab12Cde",
    ".other.git.clone-Ab12Cd",
    ".app.git.clone-File12",
    ".app.git.clone-Link12",
  ]) {
    expect(existsSync(at(kept)), kept).toBe(true);
  }
  expect(existsSync(join(r.mirror, "HEAD"))).toBe(true);
});

test("the setting's age wins when it is above twice the git timeout; the pass runs it", async () => {
  const w = await sweepWorld(open);
  const r = await w.repo("app");
  const stale = join(dirname(r.mirror), ".app.git.clone-Zz99Yy");
  clone(stale);
  aged(stale, FLOOR + 1);
  await w.setting("worktree.mirror_tmp_min_age_ms", String(FLOOR * 2));
  expect((await w.pass()).temps).toBe(0);
  expect(existsSync(stale)).toBe(true);
  aged(stale, FLOOR * 2 + 1);
  expect((await w.pass()).temps).toBe(1);
  expect(existsSync(stale)).toBe(false);
});
