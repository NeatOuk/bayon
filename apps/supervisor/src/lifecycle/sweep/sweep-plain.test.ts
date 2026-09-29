// The worktree sweep on real git, plain worktrees: the Done-when
// cases, the ticket guard, M1's own-branch rule with NEW-2's archive bundle, held rows, gone paths,
// locks, not-its-own paths, containers, relative gitdirs, reviewers and removal failures.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedRows, tempDb, unwrap, type SeedRows } from "@bayon/db/testing";
import { afterAll, describe, expect, test } from "vitest";
import { markWorktreeRemoved } from "@bayon/db/supervisor";
import { FORBIDDEN_TOKENS } from "./argv.js";
import {
  HOUR,
  T0,
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

async function world(o: { readonly symlinkHome?: boolean } = {}) {
  const w = await sweepWorld(open, o);
  const pass = w.pass;
  return {
    ...w,
    async pass() {
      const summary = await pass();
      seen.push(...w.calls());
      return summary;
    },
  };
}

describe("the sweep on real git: plain worktrees", { timeout: 60_000 }, () => {
  test("Done-when: a clean, merged worktree ends removed; its branch stays in the mirror", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({ sid: "s1", repo: r });
    expect(await w.pass()).toMatchObject({ removed: 1, aborted: null });
    expect(existsSync(wt.path)).toBe(false);
    expect(await w.row(wt.rowId)).toMatchObject({
      state: "removed",
      kept_reason: null,
    });
    expect(git(r.mirror, "rev-parse", "refs/heads/frm/s1")).toBe(r.base);
    expect(existsSync(join(w.home, "archive"))).toBe(false); // merged: no bundle
    expect(
      w.logs.find((l) => l.msg === "sweep: worktree removed")?.obj,
    ).toMatchObject({
      ms: expect.any(Number),
    });
  });

  test("Done-when: a dirty worktree is kept and flagged, its files intact, on worktree_dirty", async () => {
    const w = await world();
    const r = await w.repo("app");
    const modified = await w.worktree({ sid: "s1", repo: r });
    writeFileSync(join(modified.path, "README.md"), "changed\n");
    const staged = await w.worktree({ sid: "s2", repo: r });
    writeFileSync(join(staged.path, "new.txt"), "new\n");
    git(staged.path, "add", "new.txt");
    const untracked = await w.worktree({ sid: "s3", repo: r });
    writeFileSync(join(untracked.path, "notes.txt"), "mine\n");
    expect(await w.pass()).toMatchObject({ flagged: 3, removed: 0 });
    for (const [wt, file] of [
      [modified, "README.md"],
      [staged, "new.txt"],
      [untracked, "notes.txt"],
    ] as const) {
      const row = await w.row(wt.rowId);
      expect(row).toMatchObject({ state: "active", kept_reason: "dirty" });
      expect(row.kept_detail).toContain(file);
      expect(existsSync(join(wt.path, file))).toBe(true);
    }
    expect(await w.attention()).toEqual(
      [modified, staged, untracked]
        .map((wt) => `worktree_dirty ${wt.rowId}`)
        .toSorted(),
    );
  });

  test("Done-when: a file written between phase A and phase B stops the removal", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({ sid: "s1", repo: r });
    w.hooks.beforeRecheck = () => {
      writeFileSync(
        join(wt.path, "late.txt"),
        "written after the first check\n",
      );
    };
    expect(await w.pass()).toMatchObject({ removed: 0, flagged: 1 });
    expect(await w.row(wt.rowId)).toMatchObject({
      state: "active",
      kept_reason: "dirty",
    });
    expect(readFileSync(join(wt.path, "late.txt"), "utf8")).toContain("after");
  });

  test("Done-when: a file written after the re-checks meets git's own refusal (the -c pairs reach it)", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({ sid: "s1", repo: r });
    git(wt.path, "config", "status.showUntrackedFiles", "no"); // the shared config
    w.hooks.beforeRemove = () => {
      writeFileSync(join(wt.path, "later.txt"), "x\n");
    };
    expect(await w.pass()).toMatchObject({ removed: 0, flagged: 1 });
    expect(await w.row(wt.rowId)).toMatchObject({ kept_reason: "dirty" });
    expect(existsSync(join(wt.path, "later.txt"))).toBe(true);
    const removes = w.calls().filter((c) => c.args.includes("remove"));
    expect(removes).toHaveLength(1);
    expect(removes[0]?.args).toEqual(
      expect.arrayContaining([
        "status.showUntrackedFiles=all",
        "core.untrackedCache=false",
      ]),
    );
  });

  test("the ticket guard: clean but unmerged on an open ticket is kept, unflagged; merged on an open ticket too", async () => {
    const w = await world();
    const r = await w.repo("app");
    const unmerged = await w.worktree({
      sid: "s1",
      repo: r,
      ticket: "ticket-2",
    });
    git(unmerged.path, "commit", "-q", "--allow-empty", "-m", "work");
    const merged = await w.worktree({ sid: "s2", repo: r, ticket: "ticket-2" });
    expect(await w.pass()).toMatchObject({ kept: 2, removed: 0, flagged: 0 });
    for (const wt of [unmerged, merged]) {
      expect(await w.row(wt.rowId)).toMatchObject({
        state: "active",
        kept_reason: null,
      });
    }
    expect(await w.attention()).toEqual([]);
  });

  test("M1 + NEW-2: a squash-merged builder on a done ticket goes, after a verified archive bundle that survives a prune", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({ sid: "s1", repo: r });
    writeFileSync(join(wt.path, "a.txt"), "feature\n");
    git(wt.path, "add", "a.txt");
    git(wt.path, "commit", "-q", "-m", "feature");
    const head = git(wt.path, "rev-parse", "HEAD");
    // Upstream squash-merges it: the base moves, HEAD is never its ancestor.
    writeFileSync(join(r.origin, "a.txt"), "feature\n");
    git(r.origin, "add", "a.txt");
    git(r.origin, "commit", "-q", "-m", "feature (squash)");
    expect(await w.pass()).toMatchObject({ removed: 1 });
    expect(existsSync(wt.path)).toBe(false);
    const bundle = join(w.home, "archive", "worktrees", `${wt.rowId}.bundle`);
    expect(statSync(bundle).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(bundle)).mode & 0o777).toBe(0o700);
    git(r.mirror, "bundle", "verify", "-q", bundle);
    expect(git(r.mirror, "bundle", "list-heads", bundle)).toContain(head);
    // g19: a prune drops frm/s1, and the bundle still holds the work. The pass hardens the mirror
    // before it fetches now (MEDIUM-3), so a plain `fetch --prune origin` reads
    // the narrow refspec and leaves the branch alone — the destructive form has to be asked for by
    // name, which is what writing that refspec was for.
    git(r.mirror, "fetch", "-q", "--prune", "origin");
    expect(git(r.mirror, "rev-parse", "refs/heads/frm/s1")).toBe(head);
    git(r.mirror, "fetch", "-q", "--prune", "origin", "+refs/*:refs/*");
    expect(() =>
      git(r.mirror, "rev-parse", "--verify", "-q", "refs/heads/frm/s1"),
    ).toThrow();
    git(r.mirror, "fetch", "-q", bundle, "HEAD:refs/heads/recovered");
    expect(git(r.mirror, "rev-parse", "refs/heads/recovered")).toBe(head);
  });

  test("M1: a detached commit on a done ticket is unpublished; an unwritable archive fails the removal, nothing lost", async () => {
    const w = await world();
    const r = await w.repo("app");
    const detached = await w.worktree({ sid: "s1", repo: r, detached: true });
    git(detached.path, "commit", "-q", "--allow-empty", "-m", "only here");
    const own = await w.worktree({ sid: "s2", repo: r });
    git(own.path, "commit", "-q", "--allow-empty", "-m", "on its branch");
    writeFileSync(join(w.home, "archive"), "not a directory\n");
    await w.pass();
    expect(await w.row(detached.rowId)).toMatchObject({
      kept_reason: "unpublished",
    });
    expect(await w.row(own.rowId)).toMatchObject({
      state: "active",
      kept_reason: "remove_failed",
    });
    expect(existsSync(own.path)).toBe(true);
    expect(await w.attention()).toEqual(
      [
        `worktree_kept ${detached.rowId}`,
        `worktree_kept ${own.rowId}`,
      ].toSorted(),
    );
  });

  test("held rows run no git: an open ticket's pending hand-off, a resumable holder, a holder still live", async () => {
    const w = await world();
    const r = await w.repo("app");
    await w.worktree({ sid: "s1", repo: r, ticket: "ticket-2" });
    await w.seed({
      handoffs: [
        {
          id: "h1",
          ticket_id: "ticket-2",
          from_session_id: "s1",
          reason: "ceiling",
          facts_json: "{}",
          packet_path: "/p",
          packet_hash: "h",
          created_at: T0,
        },
      ],
    });
    await w.worktree({ sid: "s2", repo: r, holder: "resumable" });
    await w.worktree({ sid: "s3", repo: r });
    w.live.add("s3");
    expect(await w.pass()).toMatchObject({ skipped: 3, visited: 0 });
    expect(w.calls()).toEqual([]);
  });

  test("M2: a pending hand-off on a done, split or parked ticket holds nothing", async () => {
    const w = await world();
    const r = await w.repo("app");
    const done = await w.worktree({ sid: "s1", repo: r });
    const split = await w.worktree({ sid: "s2", repo: r, ticket: "ticket-3" });
    const parked = await w.worktree({ sid: "s3", repo: r, ticket: "ticket-4" });
    await w.seed({
      handoffs: [
        {
          id: "h1",
          ticket_id: "ticket-1",
          from_session_id: "s1",
          reason: "ceiling",
          facts_json: "{}",
          packet_path: "/p",
          packet_hash: "h",
          created_at: T0,
        },
        {
          id: "h2",
          ticket_id: "ticket-3",
          from_session_id: "s2",
          reason: "ceiling",
          facts_json: "{}",
          packet_path: "/p",
          packet_hash: "h",
          created_at: T0,
        },
      ],
    });
    await w.pass();
    expect((await w.row(done.rowId)).state).toBe("removed");
    expect((await w.row(split.rowId)).state).toBe("removed");
    expect((await w.row(parked.rowId)).state).toBe("removed");
  });

  test("M3: gone paths: an orphan with no admin entry and a done row go with no git; an open row is unverifiable; modules/ is unpublished", async () => {
    const w = await world();
    const r = await w.repo("app");
    const orphan = await w.worktree({
      sid: "s1",
      repo: r,
      add: false,
      state: "orphan",
      ticket: "ticket-2",
    });
    const done = await w.worktree({ sid: "s2", repo: r });
    rmSync(done.path, { recursive: true });
    const open = await w.worktree({ sid: "s3", repo: r, ticket: "ticket-2" });
    rmSync(open.path, { recursive: true });
    const mods = await w.worktree({ sid: "s4", repo: r });
    const admin = adminOf(mods.path);
    rmSync(mods.path, { recursive: true });
    mkdirSync(join(admin, "modules", "x"), { recursive: true });
    await w.pass();
    expect(w.calls()).toEqual([]);
    expect((await w.row(orphan.rowId)).state).toBe("removed");
    expect((await w.row(done.rowId)).state).toBe("removed");
    expect(await w.row(open.rowId)).toMatchObject({
      state: "active",
      kept_reason: "unverifiable",
    });
    expect(await w.row(mods.rowId)).toMatchObject({
      kept_reason: "unpublished",
    });
    expect(existsSync(join(admin, "modules", "x"))).toBe(true);
  });

  test("M3: with $FRM_HOME/work missing the pass aborts and writes nothing", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({ sid: "s1", repo: r, add: false });
    renameSync(join(w.home, "work"), join(w.home, "work.unmounted"));
    expect((await w.pass()).aborted).toContain("is missing");
    expect(await w.row(wt.rowId)).toMatchObject({
      state: "active",
      kept_reason: null,
    });
    expect(w.calls()).toEqual([]);
    expect(w.logs.some((l) => l.level === "error")).toBe(true);
  });

  test("a fresh home: no live worktree and no work/ yet, so work/ is made quietly", async () => {
    const w = await world();
    rmSync(join(w.home, "work"), { recursive: true, force: true });
    expect((await w.pass()).aborted).toBeNull();
    expect(statSync(join(w.home, "work")).isDirectory()).toBe(true);
    expect(
      w.logs.filter((l) => l.level === "error" || l.level === "warn"),
    ).toEqual([]);
  });

  test("a home that had worktrees, all removed now: a missing work/ still aborts, nothing made", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({ sid: "s-gone", repo: r, add: false });
    const row = await w.row(wt.rowId);
    unwrap(await markWorktreeRemoved(w.db, row));
    rmSync(join(w.home, "work"), { recursive: true, force: true });
    expect((await w.pass()).aborted).toContain("is missing");
    expect(existsSync(join(w.home, "work"))).toBe(false);
  });

  test("M5: a row ended less than min_ended_ms ago waits, unflagged; then it goes", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({
      sid: "s1",
      repo: r,
      endedAt: T0 - 10 * 60_000,
    });
    expect(await w.pass()).toMatchObject({ kept: 1 });
    expect(await w.row(wt.rowId)).toMatchObject({
      state: "active",
      kept_reason: null,
    });
    await w.clock.advance(HOUR);
    expect(await w.pass()).toMatchObject({ removed: 1 });
  });

  test("a locked worktree (a killed `worktree add`) is kept and flagged, never unlocked", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({ sid: "s1", repo: r });
    git(r.mirror, "worktree", "lock", "--reason", "initializing", wt.path);
    await w.pass();
    expect(await w.row(wt.rowId)).toMatchObject({
      kept_reason: "locked",
      kept_detail: "initializing",
    });
    expect(existsSync(join(adminOf(wt.path), "locked"))).toBe(true);
  });

  test("a path inside some other repo is unverifiable, and no status runs there", async () => {
    const w = await world();
    const r = await w.repo("app");
    const outer = join(w.home, "work", "s1");
    mkdirSync(join(outer, "app"), { recursive: true });
    git(outer, "init", "-q");
    const wt = await w.worktree({ sid: "s1", repo: r, add: false });
    await w.pass();
    expect(await w.row(wt.rowId)).toMatchObject({
      kept_reason: "unverifiable",
    });
    expect(w.calls().some((c) => c.args.includes("status"))).toBe(false);
  });

  test("a container row is never looked at: no stat, no git, no flag", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({
      sid: "s1",
      repo: r,
      add: false,
      executor: "ctr",
    });
    expect(await w.pass()).toMatchObject({ skipped: 1 });
    expect(await w.row(wt.rowId)).toMatchObject({
      state: "active",
      kept_reason: null,
    });
    expect(w.calls()).toEqual([]);
  });

  test("NEW-1: relative gitdir files and a symlinked FRM_HOME: check 3 passes, and a gone submodule row's entry is found", async () => {
    const w = await world({ symlinkHome: true });
    const r = await w.repo("app");
    const rel = await w.worktree({
      sid: "s1",
      repo: r,
      addArgs: ["-c", "worktree.useRelativePaths=true"],
    });
    expect(readFileSync(join(adminOf(rel.path), "gitdir"), "utf8")).toMatch(
      /^\.\./,
    );
    const shas = JSON.stringify({ v: 1, git: "test", shas: [] });
    const gone = await w.worktree({
      sid: "s2",
      repo: r,
      submoduleShas: shas,
      addArgs: ["-c", "worktree.useRelativePaths=true"],
    });
    rmSync(gone.path, { recursive: true });
    const lost = await w.worktree({
      sid: "s3",
      repo: r,
      submoduleShas: shas,
      add: false,
    });
    await w.pass();
    expect((await w.row(rel.rowId)).state).toBe("removed");
    expect((await w.row(gone.rowId)).state).toBe("removed");
    expect(await w.row(lost.rowId)).toMatchObject({
      state: "active",
      kept_reason: "unverifiable",
    });
  });

  test("reviewers (N4): a clean reviewer on an open ticket goes; one with a commit of its own is unpublished", async () => {
    const w = await world();
    const r = await w.repo("app");
    await w.gate("g1", "ticket-2");
    const clean = await w.worktree({
      sid: "r1",
      repo: r,
      gate: "g1",
      ticket: "ticket-2",
      detached: true,
    });
    const own = await w.worktree({
      sid: "r2",
      repo: r,
      gate: "g1",
      ticket: "ticket-2",
      detached: true,
    });
    git(own.path, "commit", "-q", "--allow-empty", "-m", "a reviewer's own");
    await w.pass();
    expect((await w.row(clean.rowId)).state).toBe("removed");
    expect(await w.row(own.rowId)).toMatchObject({
      kept_reason: "unpublished",
    });
    expect(git(own.path, "log", "-1", "--format=%s")).toBe("a reviewer's own");
  });

  test("L1: a per-worktree ref on no shared ref is unpublished; an operation in progress is dirty", async () => {
    const w = await world();
    const r = await w.repo("app");
    const refd = await w.worktree({ sid: "s1", repo: r });
    git(
      refd.path,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "kept by a worktree ref only",
    );
    git(refd.path, "update-ref", "refs/worktree/keep", "HEAD");
    git(refd.path, "reset", "-q", "--hard", r.base);
    const rebasing = await w.worktree({ sid: "s2", repo: r });
    mkdirSync(join(adminOf(rebasing.path), "rebase-merge"));
    await w.pass();
    expect(await w.row(refd.rowId)).toMatchObject({
      kept_reason: "unpublished",
    });
    expect((await w.row(refd.rowId)).kept_detail).toContain(
      "refs/worktree/keep",
    );
    expect(await w.row(rebasing.rowId)).toMatchObject({ kept_reason: "dirty" });
  });

  test("L3: a shallow mirror proves nothing: unverifiable; every sweep git call carries GIT_NO_LAZY_FETCH", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({ sid: "s1", repo: r });
    writeFileSync(join(r.mirror, "shallow"), `${r.base}\n`);
    await w.pass();
    expect(await w.row(wt.rowId)).toMatchObject({
      kept_reason: "unverifiable",
    });
    expect(w.calls().length).toBeGreaterThan(0);
    expect(w.calls().every((c) => c.env === "1")).toBe(true);
  });

  test("remove_failed, then the next pass retries and removes it", async () => {
    const w = await world();
    const r = await w.repo("app");
    const wt = await w.worktree({ sid: "s1", repo: r });
    const admin = adminOf(wt.path);
    w.hooks.beforeRemove = () => {
      writeFileSync(join(admin, "locked"), "");
    };
    await w.pass();
    expect(await w.row(wt.rowId)).toMatchObject({
      kept_reason: "remove_failed",
    });
    delete w.hooks.beforeRemove;
    rmSync(join(admin, "locked"));
    await w.pass();
    expect(await w.row(wt.rowId)).toMatchObject({
      state: "removed",
      kept_reason: null,
    });
  });

  test("NEW-7: a malformed removal setting turns removal off; flagging goes on", async () => {
    const w = await world();
    const r = await w.repo("app");
    const clean = await w.worktree({ sid: "s1", repo: r });
    const dirty = await w.worktree({ sid: "s2", repo: r });
    writeFileSync(join(dirty.path, "x.txt"), "x\n");
    await w.setting("worktree.min_ended_ms", '"soon"');
    await w.pass();
    expect(await w.row(clean.rowId)).toMatchObject({
      state: "active",
      kept_reason: null,
    });
    expect(await w.row(dirty.rowId)).toMatchObject({ kept_reason: "dirty" });
    expect(
      w.logs.some((l) => l.msg === "sweep: a setting is missing or malformed"),
    ).toBe(true);
  });

  test("no argv of this file's sweeps carries a forbidden token", () => {
    expect(seen.length).toBeGreaterThan(50);
    for (const c of seen) {
      for (const token of FORBIDDEN_TOKENS) expect(c.args).not.toContain(token);
    }
    for (const c of seen.filter(
      (x) => x.args.includes("status") || x.args.includes("remove"),
    )) {
      expect(c.args).toContain("status.showUntrackedFiles=all");
    }
  });

  test("no sweep source names a forbidden token; only argv.ts builds `worktree remove`; reviewer cleanup is gone", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(sources).toContain("argv.ts");
    for (const f of sources) {
      const text = readFileSync(join(dir, f), "utf8");
      const scanned =
        f === "argv.ts"
          ? text.replace(/export const FORBIDDEN_TOKENS[\s\S]*?\];/, "")
          : text;
      for (const token of FORBIDDEN_TOKENS) {
        expect(scanned, f).not.toContain(`"${token}"`);
      }
      if (f !== "argv.ts")
        expect(scanned, f).not.toMatch(/"worktree",\s*"remove"/);
    }
    expect(existsSync(join(dir, "..", "..", "gates", "cleanup.ts"))).toBe(
      false,
    );
  });
});
