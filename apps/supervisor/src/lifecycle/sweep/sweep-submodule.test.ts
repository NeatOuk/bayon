// HIGH-1 on real git: super → mid → leaf plus a submodule named
// vendor/lib, checked out with -c-only registration. Clean and published goes (g7);
// unpublished, dirty below an ignore=dirty, content in an emptied directory or an unpopulated
// gitlink, a half-made gitdir: each is kept, nothing deleted that was not proved clean and published.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  type Repo,
  type SweepWorld,
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

/** A plain origin with one commit, as a repo row and mirror without a workspace. */
async function origin(
  w: SweepWorld,
  id: string,
  shape: (dir: string) => void = () => undefined,
): Promise<Repo> {
  const dir = join(w.root, "origins", id);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, `${id}.txt`), `${id}\n`);
  shape(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", id);
  return w.bareRepo(id, dir);
}

interface SubWorld {
  readonly w: SweepWorld;
  readonly sup: Repo;
  readonly mid: Repo;
  readonly leaf: Repo;
  readonly lib: Repo;
  add(
    sid: string,
    o?: { readonly skipMid?: boolean },
  ): Promise<{ path: string; rowId: string }>;
  pass(): Promise<void>;
}

async function subWorld(): Promise<SubWorld> {
  const w = await sweepWorld(open);
  const leaf = await origin(w, "leaf");
  const lib = await origin(w, "lib");
  // mid's .gitmodules says ignore=dirty for leaf: --ignore-submodules=none at the top cannot see it (g15).
  const mid = await origin(w, "mid", (dir) => {
    git(dir, "submodule", "add", "-q", leaf.mirror, "lf");
    git(dir, "config", "-f", ".gitmodules", "submodule.lf.ignore", "dirty");
  });
  const sup = await origin(w, "super", (dir) => {
    git(dir, "submodule", "add", "-q", mid.mirror, "md");
    git(
      dir,
      "submodule",
      "add",
      "-q",
      "--name",
      "vendor/lib",
      lib.mirror,
      "vendor/lib",
    );
  });
  await w.seed({
    workspaces: [{ id: "ws-sub", name: "ws-sub", kind: "submodule" }],
    workspace_repos: [
      {
        workspace_id: "ws-sub",
        repo_id: "super",
        rel_path: "super",
        role: "primary",
      },
      {
        workspace_id: "ws-sub",
        repo_id: "mid",
        rel_path: "md",
        role: "dep",
        submodule_path: "md",
      },
      {
        workspace_id: "ws-sub",
        repo_id: "leaf",
        rel_path: "md/lf",
        role: "dep",
        submodule_path: "md/lf",
      },
      {
        workspace_id: "ws-sub",
        repo_id: "lib",
        rel_path: "vendor/lib",
        role: "dep",
        submodule_path: "vendor/lib",
      },
    ],
  });
  const register = (
    dir: string,
    name: string,
    path: string,
    mirror: string,
  ): void => {
    git(
      dir,
      "-c",
      "protocol.allow=never",
      "-c",
      `submodule.${name}.url=${mirror}`,
      "-c",
      `submodule.${name}.active=true`,
      "-c",
      `submodule.${name}.update=checkout`,
      "submodule",
      "--quiet",
      "update",
      "--init",
      "--checkout",
      "--no-recommend-shallow",
      "--",
      path,
    );
  };
  const shas = JSON.stringify({
    v: 1,
    git: "test",
    shas: [
      { path: "md", repo_id: "mid", sha: mid.base },
      { path: "md/lf", repo_id: "leaf", sha: leaf.base },
      { path: "vendor/lib", repo_id: "lib", sha: lib.base },
    ],
  });
  return {
    w,
    sup,
    mid,
    leaf,
    lib,
    async add(sid, o = {}) {
      const wt = await w.worktree({
        sid,
        repo: sup,
        workspace: "ws-sub",
        submoduleShas: shas,
      });
      if (o.skipMid !== true) {
        register(wt.path, "md", "md", mid.mirror);
        git(join(wt.path, "md"), "checkout", "-q", "-b", `frm/${sid}`);
        register(join(wt.path, "md"), "lf", "lf", leaf.mirror);
        git(join(wt.path, "md", "lf"), "checkout", "-q", "-b", `frm/${sid}`);
      }
      register(wt.path, "vendor/lib", "vendor/lib", lib.mirror);
      git(join(wt.path, "vendor", "lib"), "checkout", "-q", "-b", `frm/${sid}`);
      return wt;
    },
    async pass() {
      await w.pass();
      seen.push(...w.calls());
      w.clearCalls();
    },
  };
}

const configKeys = (mirror: string): string => {
  try {
    return git(mirror, "config", "--get-regexp", "^submodule\\.");
  } catch {
    return "";
  }
};

describe("HIGH-1: submodule worktrees", { timeout: 90_000 }, () => {
  test("clean and published goes (g7): no deinit, no config key, the admin entry gone, the branch kept", async () => {
    const s = await subWorld();
    const wt = await s.add("s1");
    const admin = adminOf(wt.path);
    await s.pass();
    expect(await s.w.row(wt.rowId)).toMatchObject({
      state: "removed",
      kept_reason: null,
    });
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(admin)).toBe(false);
    for (const r of [s.sup, s.mid, s.leaf, s.lib])
      expect(configKeys(r.mirror)).toBe("");
    expect(git(s.sup.mirror, "rev-parse", "refs/heads/frm/s1")).toBe(
      s.sup.base,
    );
  });

  test("g15: an untracked file in the leaf under mid's ignore=dirty is dirty", async () => {
    const s = await subWorld();
    const wt = await s.add("s1");
    writeFileSync(join(wt.path, "md", "lf", "u.txt"), "mine\n");
    expect(
      git(wt.path, "status", "--porcelain", "--ignore-submodules=none"),
    ).toBe("");
    await s.pass();
    expect(await s.w.row(wt.rowId)).toMatchObject({ kept_reason: "dirty" });
    expect(existsSync(join(wt.path, "md", "lf", "u.txt"))).toBe(true);
  });

  test("vendor/lib (g16): an unpublished commit is flagged, its gitdir intact; once published it goes, with module and super bundles", async () => {
    const s = await subWorld();
    const wt = await s.add("s1");
    const inner = join(wt.path, "vendor", "lib");
    git(inner, "commit", "-q", "--allow-empty", "-m", "lib work");
    const work = git(inner, "rev-parse", "HEAD");
    git(wt.path, "add", "vendor/lib");
    git(wt.path, "commit", "-q", "-m", "bump lib");
    const admin = adminOf(wt.path);
    await s.pass();
    const kept = await s.w.row(wt.rowId);
    expect(kept).toMatchObject({ state: "active", kept_reason: "unpublished" });
    expect(kept.kept_detail).toContain("vendor/lib");
    expect(existsSync(join(admin, "modules", "vendor", "lib", "HEAD"))).toBe(
      true,
    );
    // publish, simulated: the commit into lib's mirror under refs/frm.
    git(
      s.lib.mirror,
      "fetch",
      "-q",
      join(admin, "modules", "vendor", "lib"),
      `+refs/heads/frm/s1:refs/frm/pub/s1`,
    );
    await s.pass();
    expect((await s.w.row(wt.rowId)).state).toBe("removed");
    const archive = join(s.w.home, "archive", "worktrees");
    expect(existsSync(join(archive, `${wt.rowId}.bundle`))).toBe(true);
    const moduleBundle = join(archive, `${wt.rowId}.1.bundle`);
    expect(git(s.lib.mirror, "bundle", "list-heads", moduleBundle)).toContain(
      work,
    );
  });

  test("a file written into the emptied leaf before its parent's step survives: remove_failed, modules/ kept", async () => {
    const s = await subWorld();
    const wt = await s.add("s1");
    const admin = adminOf(wt.path);
    const leafDir = join(wt.path, "md", "lf");
    s.w.hooks.afterModuleEmptied = (checkout) => {
      if (checkout.endsWith(join("md", "lf")))
        writeFileSync(join(checkout, "late.txt"), "mine\n");
    };
    await s.pass();
    expect(await s.w.row(wt.rowId)).toMatchObject({
      state: "active",
      kept_reason: "remove_failed",
    });
    expect(readFileSync(join(leafDir, "late.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(admin, "modules"))).toBe(true);
  });

  test("content in an unpopulated gitlink directory is dirty (g17)", async () => {
    const s = await subWorld();
    const wt = await s.add("s1", { skipMid: true });
    writeFileSync(join(wt.path, "md", "stray.txt"), "mine\n");
    expect(
      git(wt.path, "status", "--porcelain", "--ignore-submodules=none"),
    ).toBe("");
    await s.pass();
    expect(await s.w.row(wt.rowId)).toMatchObject({ kept_reason: "dirty" });
    expect((await s.w.row(wt.rowId)).kept_detail).toContain("unpopulated");
  });

  test("a half-made gitdir (no HEAD) fails the walk closed: unverifiable", async () => {
    const s = await subWorld();
    const wt = await s.add("s1");
    mkdirSync(join(adminOf(wt.path), "modules", "half", "objects"), {
      recursive: true,
    });
    await s.pass();
    expect(await s.w.row(wt.rowId)).toMatchObject({
      kept_reason: "unverifiable",
    });
    expect(existsSync(join(wt.path, "md", "m.txt"))).toBe(false); // mid's file is mid.txt
    expect(existsSync(join(wt.path, "md", "mid.txt"))).toBe(true);
  });

  test("g6: deleting the module gitdirs first leaves git refusing the removal (why B12 empties first)", async () => {
    const s = await subWorld();
    const wt = await s.add("s1");
    rmSync(join(adminOf(wt.path), "modules"), { recursive: true });
    expect(() => git(s.sup.mirror, "worktree", "remove", wt.path)).toThrow();
    expect(existsSync(wt.path)).toBe(true);
  });

  test("review CRITICAL: a file written into an emptied module directory right before `worktree remove` stops it; the next pass keeps it dirty", async () => {
    const s = await subWorld();
    const wt = await s.add("s1");
    const late = join(wt.path, "vendor", "lib", "late.txt");
    s.w.hooks.beforeRemove = () => {
      writeFileSync(late, "written after every other check\n");
    };
    await s.pass();
    expect(await s.w.row(wt.rowId)).toMatchObject({
      state: "active",
      kept_reason: "remove_failed",
    });
    expect(readFileSync(late, "utf8")).toContain("after every other check");
    delete s.w.hooks.beforeRemove;
    await s.pass();
    expect(await s.w.row(wt.rowId)).toMatchObject({
      state: "active",
      kept_reason: "dirty",
    });
    expect(existsSync(late)).toBe(true);
  });

  test("NEW-3: a pass killed after renaming modules/ leaves modules.frm-removing; the next pass finishes the delete and removes the row", async () => {
    const s = await subWorld();
    const wt = await s.add("s1");
    const admin = adminOf(wt.path);
    // What B12 and B14's rename leave: every checkout emptied, its directory kept.
    for (const dir of [join(wt.path, "md"), join(wt.path, "vendor", "lib")]) {
      for (const name of readdirSync(dir)) {
        rmSync(join(dir, name), { recursive: true });
      }
    }
    renameSync(join(admin, "modules"), join(admin, "modules.frm-removing"));
    expect(
      git(wt.path, "status", "--porcelain", "--ignore-submodules=none"),
    ).toBe("");
    await s.pass();
    expect(await s.w.row(wt.rowId)).toMatchObject({
      state: "removed",
      kept_reason: null,
    });
    expect(existsSync(admin)).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
  });

  test("no argv of this file's sweeps carries a forbidden token", () => {
    expect(seen.length).toBeGreaterThan(50);
    for (const c of seen) {
      for (const token of FORBIDDEN_TOKENS) expect(c.args).not.toContain(token);
      expect(c.args).not.toContain("submodule");
    }
  });
});
