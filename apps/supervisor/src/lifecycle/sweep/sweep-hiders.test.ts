// CRITICAL-1 on real git: each way config or the index can hide a
// change is set, and each ends kept with its file intact, under its own reason. Then Q5/N2: disposable
// ignored entries go with the worktree; anything else ignored keeps it.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedRows, tempDb, unwrap, type SeedRows } from "@bayon/db/testing";
import { afterAll, describe, expect, test } from "vitest";
import { FORBIDDEN_TOKENS } from "./argv.js";
import {
  adminOf,
  cleanupWorlds,
  git,
  sweepWorld,
  type GitCall,
  type OpenDb,
} from "./testing/sweep-world.js";

const seen: GitCall[] = [];
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

async function setup(files?: Readonly<Record<string, string>>) {
  const w = await sweepWorld(open);
  const r = await w.repo("app", files);
  return {
    w,
    r,
    async pass() {
      await w.pass();
      seen.push(...w.calls());
    },
  };
}

describe(
  "CRITICAL-1: hidden changes keep the worktree",
  { timeout: 60_000 },
  () => {
    test("status.showUntrackedFiles=no in the mirror's shared config, and in config.worktree: dirty", async () => {
      const { w, r, pass } = await setup();
      const shared = await w.worktree({ sid: "s1", repo: r });
      git(shared.path, "config", "status.showUntrackedFiles", "no");
      writeFileSync(join(shared.path, "hidden.txt"), "x\n");
      await pass();
      expect(await w.row(shared.rowId)).toMatchObject({ kept_reason: "dirty" });
      expect(existsSync(join(shared.path, "hidden.txt"))).toBe(true);

      git(r.mirror, "config", "--unset", "status.showUntrackedFiles");
      // git reads extensions.* only in a format-1 repository, and with worktreeConfig on, the bare
      // mirror's core.bare moves to its own config.worktree (or every linked worktree reads it).
      git(r.mirror, "config", "core.repositoryformatversion", "1");
      git(r.mirror, "config", "extensions.worktreeConfig", "true");
      git(r.mirror, "config", "--unset", "core.bare");
      writeFileSync(
        join(r.mirror, "config.worktree"),
        "[core]\n\tbare = true\n",
      );
      const perTree = await w.worktree({ sid: "s2", repo: r });
      writeFileSync(
        join(adminOf(perTree.path), "config.worktree"),
        "[status]\n\tshowUntrackedFiles = no\n",
      );
      writeFileSync(join(perTree.path, "hidden.txt"), "x\n");
      expect(git(perTree.path, "status", "--porcelain")).toBe("");
      await pass();
      expect(await w.row(perTree.rowId)).toMatchObject({
        kept_reason: "dirty",
      });
      expect(existsSync(join(perTree.path, "hidden.txt"))).toBe(true);
    });

    test("assume-unchanged and skip-worktree over a modified file: unverifiable (C1c, N1)", async () => {
      const { w, r, pass } = await setup({ "a.txt": "a\n", "b.txt": "b\n" });
      const assumed = await w.worktree({ sid: "s1", repo: r });
      git(assumed.path, "update-index", "--assume-unchanged", "a.txt");
      writeFileSync(join(assumed.path, "a.txt"), "changed\n");
      const skipped = await w.worktree({ sid: "s2", repo: r });
      git(skipped.path, "update-index", "--skip-worktree", "b.txt");
      writeFileSync(join(skipped.path, "b.txt"), "changed\n");
      expect(git(assumed.path, "status", "--porcelain")).toBe("");
      await pass();
      for (const wt of [assumed, skipped]) {
        expect(await w.row(wt.rowId)).toMatchObject({
          kept_reason: "unverifiable",
        });
        expect((await w.row(wt.rowId)).kept_detail).toContain("index bits");
      }
    });

    test("the shared info/exclude and core.excludesFile turn untracked files into ignored ones: ignored (Q5, N1)", async () => {
      const { w, r, pass } = await setup();
      const excluded = await w.worktree({ sid: "s1", repo: r });
      mkdirSync(join(r.mirror, "info"), { recursive: true });
      appendFileSync(join(r.mirror, "info", "exclude"), "secret.txt\n");
      writeFileSync(join(excluded.path, "secret.txt"), "mine\n");
      const byFile = await w.worktree({ sid: "s2", repo: r });
      const excludes = join(w.root, "excludes");
      writeFileSync(excludes, "private.txt\n");
      git(r.mirror, "config", "core.excludesFile", excludes);
      writeFileSync(join(byFile.path, "private.txt"), "mine\n");
      await pass();
      expect(await w.row(excluded.rowId)).toMatchObject({
        kept_reason: "ignored",
      });
      expect((await w.row(excluded.rowId)).kept_detail).toContain("secret.txt");
      expect(await w.row(byFile.rowId)).toMatchObject({
        kept_reason: "ignored",
      });
      expect(existsSync(join(excluded.path, "secret.txt"))).toBe(true);
      expect(existsSync(join(byFile.path, "private.txt"))).toBe(true);
    });
  },
);

describe("Q5 and N2: the ignored inventory", { timeout: 60_000 }, () => {
  test("disposable entries (node_modules/, build/, target/, .mypy_cache/, .ruff_cache/) go with the worktree", async () => {
    const { w, r, pass } = await setup({
      "README.md": "x\n",
      ".gitignore":
        "node_modules/\nbuild/\ntarget/\n.mypy_cache/\n.ruff_cache/\n",
    });
    const wt = await w.worktree({ sid: "s1", repo: r });
    for (const d of [
      "node_modules/pkg",
      "build/out",
      "target/debug",
      ".mypy_cache/x",
      ".ruff_cache/y",
      "sub/node_modules/z",
    ]) {
      mkdirSync(join(wt.path, d), { recursive: true });
      writeFileSync(join(wt.path, d, "f"), "generated\n");
    }
    await pass();
    expect((await w.row(wt.rowId)).state).toBe("removed");
    expect(existsSync(wt.path)).toBe(false);
  });

  test(".foreman/ at the root holding only hand-off packets goes; with another file, or below the root, it is ignored", async () => {
    const { w, r, pass } = await setup();
    mkdirSync(join(r.mirror, "info"), { recursive: true });
    appendFileSync(join(r.mirror, "info", "exclude"), ".foreman/\n");
    const packets = await w.worktree({ sid: "s1", repo: r });
    mkdirSync(join(packets.path, ".foreman"));
    writeFileSync(join(packets.path, ".foreman", "handoff-1.md"), "packet\n");
    const notes = await w.worktree({ sid: "s2", repo: r });
    mkdirSync(join(notes.path, ".foreman"));
    writeFileSync(join(notes.path, ".foreman", "handoff-1.md"), "packet\n");
    writeFileSync(join(notes.path, ".foreman", "notes.md"), "mine\n");
    const deep = await w.worktree({ sid: "s3", repo: r });
    mkdirSync(join(deep.path, "sub", ".foreman"), { recursive: true });
    writeFileSync(
      join(deep.path, "sub", ".foreman", "handoff-1.md"),
      "packet\n",
    );
    await pass();
    expect((await w.row(packets.rowId)).state).toBe("removed");
    expect(await w.row(notes.rowId)).toMatchObject({ kept_reason: "ignored" });
    expect(await w.row(deep.rowId)).toMatchObject({ kept_reason: "ignored" });
    expect(existsSync(join(notes.path, ".foreman", "notes.md"))).toBe(true);
  });

  test("no argv of this file's sweeps carries a forbidden token", () => {
    expect(seen.length).toBeGreaterThan(20);
    for (const c of seen) {
      for (const token of FORBIDDEN_TOKENS) expect(c.args).not.toContain(token);
    }
  });
});
