// The workspace step (§9.2) against real git: a source repo, its --mirror clone, worktrees per
// session through the local executor. Processes are reaped in afterAll.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FakeClock, TEMPLATES, hashDoctrine } from "@bayon/core";
import {
  getSession,
  listSessionsInStates,
  listSessionWorktrees,
  type Db,
} from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { createFixtureAdapter } from "@bayon/runners/fixture";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  AGENT_ID,
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const DOCTRINE = "# rules\nbe careful\n";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

interface SetupOptions {
  /** PATH for git and the runner: a fake git goes first. */
  readonly path?: string;
  readonly settings?: Readonly<Record<string, number>>;
  readonly prefix?: string;
  /** The agent's max_concurrency; default the column's 1 (admission's real default). */
  readonly maxConcurrency?: number;
  /** No mirror before the first spawn, which clones it. */
  readonly firstUse?: boolean;
  /** The repo row's origin_url; default the source repo. */
  readonly origin?: string;
}

async function setup(o: SetupOptions = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome(o.prefix);
  const src = join(home.path, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "DOCTRINE.md"), DOCTRINE);
  writeFileSync(join(src, "README.md"), "hello\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "one");
  const mirror = join(home.path, "mirror.git");
  if (o.firstUse !== true) {
    git(home.path, "clone", "-q", "--mirror", src, mirror);
  }
  unwrap(
    await seedRows(t.db, {
      ...lifecycleRows({
        ...(o.settings === undefined ? {} : { settings: o.settings }),
        ...(o.maxConcurrency === undefined
          ? {}
          : { maxConcurrency: o.maxConcurrency }),
      }),
      repos: [
        {
          id: "repo",
          name: "repo",
          origin_url: o.origin ?? src,
          mirror_path: mirror,
          doctrine_paths_json: '["DOCTRINE.md", "MISSING.md"]',
        },
      ],
      workspaces: [{ id: "ws", name: "ws", kind: "single" }],
      workspace_repos: [
        {
          workspace_id: "ws",
          repo_id: "repo",
          rel_path: "repo",
          role: "primary",
        },
      ],
    }),
  );
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: createFixtureAdapter({ clock }),
    path: o.path,
  });
  cleanups.push(async () => {
    started.lifecycle.shutdown();
    const live = await listSessionsInStates(t.db, ["idle", "running"]);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await executor.cleanup(s.executor_ref, "hard");
    }
    t.cleanup();
    home.cleanup();
  });
  const spawn = async (id: string) => {
    unwrap(
      await started.lifecycle.handlers.spawn.handle(
        spawnPayload(id, { workspace_id: "ws" }),
        CMD,
      ),
    );
  };
  return {
    ...started,
    db: t.db,
    clock,
    slots,
    src,
    mirror,
    home: home.path,
    spawn,
  };
}

const session = async (db: Db, id: string) => unwrap(await getSession(db, id));

const WAIT = { timeout: 10_000, interval: 5 };
const GIT_TIMEOUT_MS = 30_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: gone
  }
}

/**
 * A `git` whose first fetch never answers, as over a dead network (no network is touched);
 * every other call is the real git. It writes its pid, then becomes `tail -f /dev/null`.
 */
function hangingGit(): { readonly path: string; readonly pidFile: string } {
  const bin = mkdtempSync("/tmp/frm-fix-sup-");
  const pidFile = join(bin, "hung.pid");
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const script = [
    "#!/bin/sh",
    `case " $* " in *" fetch "*) [ -e '${pidFile}' ] || { echo $$ > '${pidFile}'; exec tail -f /dev/null; } ;; esac`,
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(bin, "git"), script, { mode: 0o755 });
  cleanups.push(async () => {
    // The executor ran it as its own process group: reap the group if the test did not.
    const pid = existsSync(pidFile)
      ? Number(readFileSync(pidFile, "utf8").trim())
      : NaN;
    if (Number.isSafeInteger(pid) && pid > 1 && isAlive(pid)) {
      process.kill(-pid, "SIGKILL");
    }
    rmSync(bin, { recursive: true, force: true });
  });
  return { path: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, pidFile };
}

/** A `git` that logs each clone it is asked for, then is the real git. */
function countingGit(): {
  readonly path: string;
  readonly clones: () => string[];
} {
  const bin = mkdtempSync("/tmp/frm-fix-git-");
  const log = join(bin, "clones.log");
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const script = [
    "#!/bin/sh",
    `case " $* " in *" clone "*) echo "$*" >> '${log}' ;; esac`,
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(bin, "git"), script, { mode: 0o755 });
  cleanups.push(async () => rmSync(bin, { recursive: true, force: true }));
  return {
    path: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    clones: () =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

describe("workspace step on real git", { timeout: 30_000 }, () => {
  test("two concurrent spawns on one mirror each get work/<id>/<rel> on frm/<id> at the base sha", async () => {
    // Two sessions of one agent at once on purpose: the mirror, not the agent's concurrency.
    const h = await setup({ maxConcurrency: 2 });
    const base = git(h.src, "rev-parse", "HEAD");
    await Promise.all([h.spawn("WA"), h.spawn("WB")]);
    await h.lifecycle.settled();
    const doctrine = await hashDoctrine([
      { path: "DOCTRINE.md", content: DOCTRINE },
    ]);
    for (const id of ["WA", "WB"]) {
      expect(await session(h.db, id)).toMatchObject({
        state: "idle",
        doctrine_hash: doctrine,
      });
      const [wt] = unwrap(await listSessionWorktrees(h.db, id));
      const path = join(h.home, "work", id, "repo");
      expect(wt).toMatchObject({
        path,
        branch: `frm/${id}`,
        base_sha: base,
        state: "active",
      });
      expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`frm/${id}`);
      expect(git(path, "rev-parse", "HEAD")).toBe(base);
      expect(readFileSync(join(path, "README.md"), "utf8")).toBe("hello\n");
    }
  });

  test("two concurrent first spawns of a repo with no mirror make exactly one clone", async () => {
    const counting = countingGit();
    // Two sessions of one agent at once on purpose: the first-use clone, not the agent's concurrency.
    const h = await setup({
      path: counting.path,
      firstUse: true,
      maxConcurrency: 2,
    });
    expect(existsSync(h.mirror)).toBe(false);
    const base = git(h.src, "rev-parse", "HEAD");
    await Promise.all([h.spawn("M1"), h.spawn("M2")]);
    await h.lifecycle.settled();
    for (const id of ["M1", "M2"]) {
      expect((await session(h.db, id)).state).toBe("idle");
      expect(unwrap(await listSessionWorktrees(h.db, id))[0]).toMatchObject({
        branch: `frm/${id}`,
        base_sha: base,
        state: "active",
      });
    }
    expect(counting.clones()).toHaveLength(1);
    // Cloned on first use, and carrying the hardened config: no destructive push
    // default, and the refspec Bayon's own fetches use.
    expect(git(h.mirror, "config", "--get", "remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
    expect(git(h.mirror, "config", "--get", "gc.worktreePruneExpire")).toBe(
      "never",
    );
    expect(readdirSync(h.home).filter((n) => n.includes(".clone-"))).toEqual(
      [],
    );
  });

  test("a first spawn whose origin_url starts with '-' is refused `validation`: no clone, no mirror, no worktree", async () => {
    const counting = countingGit();
    const h = await setup({
      path: counting.path,
      firstUse: true,
      origin: "--upload-pack=touch /tmp/frm-pwned",
    });
    await h.spawn("B1");
    await h.lifecycle.settled();
    expect(await session(h.db, "B1")).toMatchObject({
      state: "exited",
      exit_reason: "error",
      error_class: "validation",
      error_message: expect.stringContaining("starts with '-'"),
    });
    expect(counting.clones()).toEqual([]);
    expect(existsSync(h.mirror)).toBe(false);
    expect(unwrap(await listSessionWorktrees(h.db, "B1"))).toEqual([]);
    expect(h.slots.capacity().used).toBe(0);
  });

  test("a pinned checkout is a detached worktree at the sha, with no ref on the mirror (H2)", async () => {
    const h = await setup();
    const base = git(h.src, "rev-parse", "HEAD");
    unwrap(
      await h.lifecycle.spawnInternal({
        payload: {
          session_id: "PIN1",
          agent_id: AGENT_ID,
          role: "reviewer",
          run_class: "review",
          workspace_id: "ws",
        },
        run: {
          seq: 1,
          trigger: "gate",
          template: TEMPLATES.operator,
          inputs: { task: "go" },
        },
        workspace: { at: { sha: base, baseSha: base } },
      }),
    );
    await vi.waitFor(async () => {
      await h.lifecycle.settled();
      expect((await session(h.db, "PIN1")).state).toBe("idle");
    }, WAIT);
    const [wt] = unwrap(await listSessionWorktrees(h.db, "PIN1"));
    const path = join(h.home, "work", "PIN1", "repo");
    expect(wt).toMatchObject({
      path,
      branch: `detached@${base.slice(0, 12)}`,
      base_sha: base,
      state: "active",
    });
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(path, "rev-parse", "HEAD")).toBe(base);
    expect(git(h.mirror, "for-each-ref", "refs/heads/frm/")).toBe("");
  });

  test("a later fetch moves the base and keeps every session's frm/* branch (no --prune)", async () => {
    // F1 stays idle while F2 spawns: two live sessions of one agent, on purpose.
    const h = await setup({ maxConcurrency: 2 });
    await h.spawn("F1");
    await h.lifecycle.settled();
    const first = git(h.mirror, "rev-parse", "refs/heads/frm/F1");
    writeFileSync(join(h.src, "README.md"), "hello again\n");
    git(h.src, "commit", "-q", "-am", "two");
    const moved = git(h.src, "rev-parse", "HEAD");
    await h.spawn("F2");
    await h.lifecycle.settled();
    expect(unwrap(await listSessionWorktrees(h.db, "F2"))[0]?.base_sha).toBe(
      moved,
    );
    expect(git(h.mirror, "rev-parse", "refs/heads/frm/F1")).toBe(first);
    expect(first).not.toBe(moved);
  });

  test("a failing worktree add exits spawn_failed, leaves the row orphan and the directory as it was", async () => {
    const h = await setup();
    const path = join(h.home, "work", "WX", "repo");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "keep.txt"), "mine\n");
    await h.spawn("WX");
    await h.lifecycle.settled();
    expect(await session(h.db, "WX")).toMatchObject({
      state: "exited",
      exit_reason: "error",
      error_class: "spawn_failed",
    });
    expect(
      unwrap(await listSessionWorktrees(h.db, "WX")).map((w) => w.state),
    ).toEqual(["orphan"]);
    expect(existsSync(join(path, "keep.txt"))).toBe(true);
  });

  test("a fetch that never answers times out: git is killed, the spawn fails `timeout`, the mirror is free again", async () => {
    const fake = hangingGit();
    const h = await setup({
      path: fake.path,
      settings: { "workspace.git_timeout_ms": GIT_TIMEOUT_MS },
      prefix: "frm-fix-sup-",
      // T2 must reach the mirror's mutex while T1 holds it: two admitted sessions of one agent.
      maxConcurrency: 2,
    });
    await h.spawn("T1");
    const hung = await vi.waitFor(() => {
      const pid = Number(readFileSync(fake.pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      return pid;
    }, WAIT);
    await h.spawn("T2"); // queued behind T1 on the mirror's mutex
    await vi.waitFor(
      async () => expect((await session(h.db, "T2")).state).toBe("preparing"),
      WAIT,
    );
    expect(isAlive(hung)).toBe(true);

    await h.clock.advance(GIT_TIMEOUT_MS);
    await vi.waitFor(async () => {
      await h.lifecycle.settled();
      expect((await session(h.db, "T2")).state).toBe("idle");
    }, WAIT);
    expect(await session(h.db, "T1")).toMatchObject({
      state: "exited",
      exit_reason: "error",
      error_class: "timeout",
      error_message: expect.stringContaining("git fetch"),
    });
    expect(isAlive(hung)).toBe(false);
    expect(unwrap(await listSessionWorktrees(h.db, "T1"))).toEqual([]);
    expect(unwrap(await listSessionWorktrees(h.db, "T2"))[0]).toMatchObject({
      state: "active",
      base_sha: git(h.src, "rev-parse", "HEAD"),
    });
    expect(h.slots.capacity().used).toBe(1); // T2's: T1 released its own
  });
});
