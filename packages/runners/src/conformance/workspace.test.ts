import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { FIXTURE_FILES, createLocalWorkspace } from "./workspace.js";
import type { WorkspacePort } from "./types.js";

const spaces: WorkspacePort[] = [];
afterAll(async () => {
  for (const w of spaces) await w.dispose();
});

async function workspace(): Promise<WorkspacePort> {
  const w = await createLocalWorkspace();
  spaces.push(w);
  return w;
}

test("a session gets a committed worktree off the fixture, a home and a tmp dir", async () => {
  const w = await workspace();
  const dirs = await w.create("01S1");
  expect(dirs.baseSha).toMatch(/^[0-9a-f]{40}$/);
  for (const [name, text] of Object.entries(FIXTURE_FILES)) {
    expect(readFileSync(join(dirs.cwd, name), "utf8")).toBe(text);
  }
  expect(existsSync(dirs.homeDir) && existsSync(dirs.tmpDir)).toBe(true);
  expect(await w.diff(dirs.cwd)).toEqual([]);
});

test("diff reports tracked and untracked changes with their line counts", async () => {
  const w = await workspace();
  const dirs = await w.create("01S2");
  writeFileSync(join(dirs.cwd, "README.md"), "# conformance fixture\nmore\n");
  writeFileSync(join(dirs.cwd, "NOTES.md"), "conformance\n");
  rmSync(join(dirs.cwd, "add.js"));
  expect(await w.diff(dirs.cwd)).toEqual([
    { path: "NOTES.md", change: "add", added: 1, removed: 0 },
    { path: "README.md", change: "modify", added: 1, removed: 0 },
    { path: "add.js", change: "delete", added: 0, removed: 4 },
  ]);
});

test("snapshot sees a new or changed file anywhere under a dir; reads and scratch dirs", async () => {
  const w = await workspace();
  const dir = await w.scratch("decoy");
  const other = await w.scratch("decoy");
  expect(other).not.toBe(dir);
  const before = await w.snapshot(dir);
  expect(before.size).toBe(0);
  writeFileSync(join(dir, "state.json"), "{}");
  const after = await w.snapshot(dir);
  expect([...after.keys()]).toEqual(["state.json"]);
  expect(await w.exists(join(dir, "state.json"))).toBe(true);
  expect(await w.exists(join(dir, "missing"))).toBe(false);
  expect(await w.read(join(dir, "state.json"))).toBe("{}");
  expect(await w.read(join(dir, "missing"))).toBeUndefined();
  expect((await w.snapshot(join(dir, "missing"))).size).toBe(0);
});

test("extra roots are writable, under the session's own root and outside its cwd (§15 #16)", async () => {
  const w = await workspace();
  const dirs = await w.create("01S3");
  expect(dirs.extraRoots).toEqual([]);
  const a = await w.extraRoot("01S3", "extra-a");
  const b = await w.extraRoot("01S3", "extra-b");
  expect(a).not.toBe(b);
  // Under the session's root — an executor that places sessions makes it where that session is —
  // and never inside the worktree, which would make the test vacuous.
  for (const root of [a, b]) {
    expect(root.startsWith(`${dirs.root}/`)).toBe(true);
    expect(root.startsWith(`${dirs.cwd}/`)).toBe(false);
    writeFileSync(join(root, "FRM_ROOT.txt"), "");
    expect(await w.exists(join(root, "FRM_ROOT.txt"))).toBe(true);
  }
  // A name is a name: nothing in it can climb out of the session's root.
  expect(await w.extraRoot("01S3", "../../escape")).toBe(
    join(dirs.root, "roots", "______escape"),
  );
});
