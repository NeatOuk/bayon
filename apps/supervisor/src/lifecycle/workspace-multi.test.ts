// Multi-repo and submodule workspaces end to end on real git: the
// fixture runner on the local executor, every mirror cloned on first use, a certified pair
// (admission's require_certified=1) and admission's real max_concurrency unless a test says why.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeClock,
  SubmoduleShas,
  parseGitVersion,
  type HandoffFacts,
} from "@bayon/core";
import { listSessionWorktrees, listTicketHandoffs } from "@bayon/db";
import {
  createSession,
  insertWorktree,
  setWorktreeState,
  updateSessionState,
} from "@bayon/db/supervisor";
import { seedRows, tempDb, unwrap, type SeedRows } from "@bayon/db/testing";
import type { SpawnSpec } from "@bayon/runners";
import { FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  T0,
  TICKET,
  TURN,
  WAIT,
  git,
  kindsOf,
  mirrorOf,
  multiRows,
  session,
  settle,
  startMultiWorld,
  submoduleRows,
  waitState,
  type MultiWorld,
  type WorldOptions,
} from "./testing/multi-world.js";
import {
  AGENT_ID,
  CMD,
  EXECUTOR_ID,
  spawnPayload,
} from "./testing/fixtures.js";
import { publishSubmodules, type PublishDeps } from "./publish-submodules.js";
import { KeyedQueue } from "./session-queue.js";
import { DEFAULT_SETTINGS } from "./settings.js";

/** A world on its own temp database (only tests import @bayon/db/testing). */
async function multiWorld(o: WorldOptions): Promise<MultiWorld> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  return startMultiWorld({
    ...o,
    clock,
    db: t.db,
    dropDb: t.cleanup,
    seed: async (rows) => {
      unwrap(await seedRows(t.db, rows as SeedRows));
    },
  });
}

const worlds: MultiWorld[] = [];
const bins: string[] = [];
afterAll(async () => {
  for (const w of worlds) await w.cleanup();
  for (const b of bins) rmSync(b, { recursive: true, force: true });
});
const keep = (w: MultiWorld): MultiWorld => {
  worlds.push(w);
  return w;
};

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const realGit = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

/** A `git` first on PATH: `body` runs first (sh, with "$*" the arguments), then the real git. */
function fakeGit(body: string): {
  readonly path: string;
  readonly dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "frm-mr-git-"));
  bins.push(dir);
  writeFileSync(
    join(dir, "git"),
    ["#!/bin/sh", body, `exec '${realGit}' "$@"`, ""].join("\n"),
    { mode: 0o755 },
  );
  return { path: `${dir}:${PATH}`, dir };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const head = (dir: string) => git(dir, "rev-parse", "HEAD");
const work = (w: MultiWorld, sid: string, ...rest: string[]) =>
  join(w.home, "work", sid, ...rest);

/** publishSubmodules' deps on the world's local executor. */
const publishDeps = (w: MultiWorld): PublishDeps => ({
  db: w.db,
  exec: {
    settings: DEFAULT_SETTINGS,
    clock: w.clock,
    frmHome: w.home,
    path: PATH,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  },
  executor: w.executor,
  mirrors: new KeyedQueue(),
});

describe("multi-repo workspaces", { timeout: 60_000 }, () => {
  test("both mirrors cloned on first use; sibling worktrees on frm/<sid> at their bases, the primary's row first; the extra root written and committed; terminal ok", async () => {
    const sid = "MR1";
    let sources = { app: "", lib: "" };
    const w = keep(
      await multiWorld({
        rows: (home) => {
          const made = multiRows(home);
          sources = made.sources;
          return made.rows;
        },
        script: (home) => ({
          runs: [
            {
              events: [TURN],
              appends: [
                { path: "app.txt", text: "app\n" },
                {
                  path: join(home, "work", sid, "lib", "lib.txt"),
                  text: "lib\n",
                },
              ],
              commit: "work in both",
            },
          ],
        }),
      }),
    );
    await w.spawn(sid, { prompt: "go" });
    await settle(w, async () => {
      expect(await kindsOf(w.db, sid)).toContain("terminal");
      expect((await session(w.db, sid)).state).toBe("idle");
    });
    for (const id of ["app", "lib"])
      expect(existsSync(mirrorOf(w.home, id))).toBe(true);
    const rows = unwrap(await listSessionWorktrees(w.db, sid));
    const byRepo = new Map(rows.map((r) => [r.repo_id, r]));
    expect(byRepo.get("app")).toMatchObject({
      path: work(w, sid, "app"),
      branch: `frm/${sid}`,
      base_sha: head(sources.app),
      state: "active",
    });
    expect(byRepo.get("lib")).toMatchObject({
      path: work(w, sid, "lib"),
      branch: `frm/${sid}`,
      base_sha: head(sources.lib),
    });
    // M6: the primary's id is the lowest even under a frozen clock.
    expect(rows.map((r) => r.id).toSorted()[0]).toBe(byRepo.get("app")?.id);
    expect(git(work(w, sid, "app"), "show", "HEAD:app.txt")).toBe("app");
    expect(git(work(w, sid, "lib"), "show", "HEAD:lib.txt")).toBe("lib");
    const events = await kindsOf(w.db, sid);
    expect(events.at(-1)).toBe("terminal");
  });

  test("two spawns over the same two mirrors in opposite orders both succeed, one clone per mirror: no deadlock", async () => {
    const counting = fakeGit(
      `case " $* " in *" clone "*) echo "$*" >> "$(dirname "$0")/clones.log" ;; esac`,
    );
    const w = keep(
      await multiWorld({
        path: counting.path,
        // Two builders of the one agent at once: that is the race under test.
        maxConcurrency: 2,
        rows: (home) => {
          const made = multiRows(home);
          return {
            ...made.rows,
            workspaces: [
              ...made.rows.workspaces,
              { id: "ws-rev", name: "ws-rev", kind: "multi" as const },
            ],
            workspace_repos: [
              ...made.rows.workspace_repos,
              {
                workspace_id: "ws-rev",
                repo_id: "lib",
                rel_path: "lib",
                role: "primary",
              },
              {
                workspace_id: "ws-rev",
                repo_id: "app",
                rel_path: "app",
                role: "dep",
              },
            ],
          };
        },
      }),
    );
    await Promise.all([
      w.spawn("DA"),
      w.spawn("DB", { workspace_id: "ws-rev" }),
    ]);
    await settle(w, async () => {
      expect((await session(w.db, "DA")).state).toBe("idle");
      expect((await session(w.db, "DB")).state).toBe("idle");
    });
    const clones = readFileSync(join(counting.dir, "clones.log"), "utf8")
      .trim()
      .split("\n");
    expect(clones).toHaveLength(2);
  });

  test("hooks and fsmonitor set on a mirror never run in the supervisor (M2)", async () => {
    const markers = mkdtempSync(join(tmpdir(), "frm-mr-hook-"));
    bins.push(markers);
    let app = "";
    const w = keep(
      await multiWorld({
        rows: (home) => {
          const made = multiRows(home);
          app = made.sources.app;
          return made.rows;
        },
      }),
    );
    // The mirror exists before the spawn, with a hook that would leave a marker.
    const mirror = mirrorOf(w.home, "app");
    git(w.home, "clone", "-q", "--mirror", app, mirror);
    const hook = join(mirror, "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch '${join(markers, "hook")}'\n`, {
      mode: 0o755,
    });
    await w.spawn("HK");
    await waitState(w, "HK", "idle");
    expect(existsSync(join(markers, "hook"))).toBe(false);
    // Control: the same hook does run for a plain `git worktree add`.
    git(
      mirror,
      "worktree",
      "add",
      "-q",
      "--detach",
      join(markers, "control"),
      "HEAD",
    );
    expect(existsSync(join(markers, "hook"))).toBe(true);
  });

  test("a failure mid-prepare keeps every directory: exited(error, spawn_failed), both rows orphan, repo 1's worktree and branch intact", async () => {
    const sid = "FX";
    const w = keep(await multiWorld({ rows: (home) => multiRows(home).rows }));
    // lib's worktree path is taken: its `git worktree add` fails after app's succeeded.
    mkdirSync(work(w, sid, "lib"), { recursive: true });
    writeFileSync(work(w, sid, "lib", "keep.txt"), "mine\n");
    await w.spawn(sid);
    await settle(w, async () =>
      expect(await session(w.db, sid)).toMatchObject({
        state: "exited",
        exit_reason: "error",
        error_class: "spawn_failed",
      }),
    );
    const rows = unwrap(await listSessionWorktrees(w.db, sid));
    expect(rows.map((r) => [r.repo_id, r.state]).toSorted()).toEqual([
      ["app", "orphan"],
      ["lib", "orphan"],
    ]);
    expect(existsSync(work(w, sid, "app", ".git"))).toBe(true);
    expect(readFileSync(work(w, sid, "lib", "keep.txt"), "utf8")).toBe(
      "mine\n",
    );
    expect(
      git(mirrorOf(w.home, "app"), "rev-parse", `refs/heads/frm/${sid}`),
    ).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("submodule workspaces", { timeout: 60_000 }, () => {
  test("three mirrors cloned on first use, one worktree whose start SHAs and git are recorded; submodules on frm/<sid>; nothing in the mirror's config; .gitmodules update= and shallow= overridden; terminal ok", async () => {
    const sid = "SM1";
    let sources = { leaf: "", mid: "", sup: "" };
    const w = keep(
      await multiWorld({
        rows: (home) => {
          const made = submoduleRows(home, {
            gitmodules: (sup) => {
              git(
                sup,
                "config",
                "-f",
                ".gitmodules",
                "submodule.libs/mid.update",
                "rebase",
              );
              git(
                sup,
                "config",
                "-f",
                ".gitmodules",
                "submodule.libs/mid.shallow",
                "true",
              );
            },
          });
          sources = made.sources;
          return made.rows;
        },
        script: () => ({ runs: [{ events: [TURN] }] }),
      }),
    );
    await w.spawn(sid, { prompt: "go" });
    await settle(w, async () => {
      // The row rides along, so a failure shows why the spawn ended.
      expect({
        s: await session(w.db, sid),
        kinds: await kindsOf(w.db, sid),
      }).toMatchObject({
        s: { state: "idle" },
        kinds: expect.arrayContaining(["terminal"]),
      });
    });
    for (const id of ["super", "mid", "leaf"]) {
      expect(existsSync(mirrorOf(w.home, id))).toBe(true);
    }
    const [row, ...more] = unwrap(await listSessionWorktrees(w.db, sid));
    expect(more).toEqual([]);
    const midSha = git(sources.sup, "rev-parse", "HEAD:libs/mid");
    const leafSha = git(sources.mid, "rev-parse", "HEAD:vendor/leaf");
    expect(
      SubmoduleShas.parse(JSON.parse(row?.submodule_shas_json ?? "null")),
    ).toEqual({
      v: 1,
      git: parseGitVersion(git(w.home, "--version")),
      shas: [
        { path: "libs/mid", repo_id: "mid", sha: midSha },
        { path: "libs/mid/vendor/leaf", repo_id: "leaf", sha: leafSha },
      ],
    });
    const nested = work(w, sid, "super", "libs", "mid", "vendor", "leaf");
    expect(readFileSync(join(nested, "README.md"), "utf8")).toBe("leaf\n");
    expect(
      git(
        work(w, sid, "super", "libs", "mid"),
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ),
    ).toBe(`frm/${sid}`);
    // -c-only registration: the shared mirror's config names no submodule (fact 8a).
    expect(() =>
      git(
        w.home,
        "config",
        "-f",
        join(mirrorOf(w.home, "super"), "config"),
        "--get-regexp",
        "^submodule\\.",
      ),
    ).toThrow();
    // M1: --checkout overrode update=rebase (the submodule is at its gitlink, on frm/<sid>, not
    // rebased onto anything), --no-recommend-shallow the shallow= key.
    expect(
      git(
        work(w, sid, "super", "libs", "mid"),
        "rev-parse",
        "--is-shallow-repository",
      ),
    ).toBe("false");
  });

  test("a builder's submodule commits are published into their own mirrors, nested ones too, and answered as the HEADs the hand-off facts carry; a container's worktree is left to the sync-back", async () => {
    const sid = "SM7";
    const w = keep(
      await multiWorld({
        rows: (home) => submoduleRows(home).rows,
        script: () => ({ runs: [{ events: [TURN] }] }),
      }),
    );
    await w.spawn(sid, { prompt: "go" });
    await settle(w, async () =>
      expect(await session(w.db, sid)).toMatchObject({ state: "idle" }),
    );
    const sup = work(w, sid, "super");
    const mid = join(sup, "libs", "mid");
    const leaf = join(mid, "vendor", "leaf");
    git(leaf, "commit", "-q", "--allow-empty", "-m", "leaf work");
    git(mid, "commit", "-q", "--allow-empty", "-m", "mid work");
    const [row] = unwrap(await listSessionWorktrees(w.db, sid));
    const wt = {
      path: row?.path ?? "",
      workspace_id: row?.workspace_id ?? "",
      repo_id: row?.repo_id ?? "",
      branch: row?.branch ?? "",
    };
    // Until it is published a commit lives only in the worktree's modules/ (the ticket's cause).
    expect(() =>
      git(mirrorOf(w.home, "mid"), "cat-file", "-e", `${head(mid)}^{commit}`),
    ).toThrow();
    const published = unwrap(await publishSubmodules(publishDeps(w), wt));
    expect(published).toEqual([
      { path: "libs/mid", repo_id: "mid", sha: head(mid) },
      { path: "libs/mid/vendor/leaf", repo_id: "leaf", sha: head(leaf) },
    ]);
    for (const [id, dir] of [
      ["mid", mid],
      ["leaf", leaf],
    ] as const) {
      // In the child's own mirror, on the session's branch, where a gate and the sweep read.
      expect(
        git(mirrorOf(w.home, id), "rev-parse", `refs/heads/frm/${sid}`),
      ).toBe(head(dir));
    }
    // Idempotent: a second publish is the same answer, so a gate and the hand-off may both run it.
    expect(unwrap(await publishSubmodules(publishDeps(w), wt))).toEqual(
      published,
    );
    // A container's worktree is not on this host and its mirrors are the executor's.
    const placed: PublishDeps = {
      ...publishDeps(w),
      executor: Object.assign(
        Object.create(w.executor) as PublishDeps["executor"],
        {
          placeSession: (id: string) => ({
            root: `/srv/${id}`,
            home: `/srv/${id}/home`,
            tmp: `/srv/${id}/tmp`,
          }),
        },
      ),
    };
    expect(unwrap(await publishSubmodules(placed, wt))).toEqual([]);
  });

  //, HIGH 1 and MEDIUM 7, on real git. The fetch source used to be whatever
  // `rev-parse --absolute-git-dir` answered *in the submodule directory*, and the refspec was
  // `+refs/heads/frm/*` forced. Both of those read agent-writable content: discovery walks up, a
  // `.git` file names any repository it likes, and `frm/*` is every session's namespace, not this
  // one's. Each is checked here by doing what an agent can do, and asserting on the child's mirror.
  test("a submodule whose gitdir is not its own is passed over, and only this session's branch is published", async () => {
    const sid = "SM8";
    const w = keep(
      await multiWorld({
        rows: (home) => submoduleRows(home).rows,
        script: () => ({ runs: [{ events: [TURN] }] }),
      }),
    );
    await w.spawn(sid, { prompt: "go" });
    await settle(w, async () =>
      expect(await session(w.db, sid)).toMatchObject({ state: "idle" }),
    );
    const sup = work(w, sid, "super");
    const mid = join(sup, "libs", "mid");
    const leaf = join(mid, "vendor", "leaf");
    git(leaf, "commit", "-q", "--allow-empty", "-m", "leaf work");
    git(mid, "commit", "-q", "--allow-empty", "-m", "mid work");
    const [row] = unwrap(await listSessionWorktrees(w.db, sid));
    const wt = {
      path: row?.path ?? "",
      workspace_id: row?.workspace_id ?? "",
      repo_id: row?.repo_id ?? "",
      branch: row?.branch ?? "",
    };
    const midMirror = mirrorOf(w.home, "mid");
    const dotGit = join(mid, ".git");
    const link = readFileSync(dotGit, "utf8");
    const superGitDir = git(sup, "rev-parse", "--absolute-git-dir");
    const midGitDir = git(mid, "rev-parse", "--absolute-git-dir");
    const leafGitDir = git(leaf, "rev-parse", "--absolute-git-dir");
    // The layout this all rests on: each module gitdir under its *parent's*, nested the same way.
    expect(midGitDir).toBe(`${superGitDir}/modules/libs/mid`);
    expect(leafGitDir).toBe(`${midGitDir}/modules/vendor/leaf`);

    // 1. No repository in the directory (deinit, a removed .git, a commit predating the gitlink):
    //    discovery walks up and answers with the superproject's gitdir.
    rmSync(dotGit);
    expect(git(mid, "rev-parse", "--absolute-git-dir")).toBe(superGitDir);
    let published = unwrap(await publishSubmodules(publishDeps(w), wt));
    expect(published.map((p) => p.path)).not.toContain("libs/mid");
    // The child's mirror holds no branch of this session's, and above all not a superproject commit
    // force-pointed at one — which the hand-off packet would have printed as the submodule's head.
    expect(() =>
      git(midMirror, "rev-parse", `refs/heads/frm/${sid}`),
    ).toThrow();
    expect(() =>
      git(midMirror, "cat-file", "-e", `${head(sup)}^{commit}`),
    ).toThrow();

    // 2. A `.git` file is content an agent writes: it can name any repository on this host.
    writeFileSync(dotGit, `gitdir: ${leafGitDir}\n`);
    expect(git(mid, "rev-parse", "--absolute-git-dir")).toBe(leafGitDir);
    published = unwrap(await publishSubmodules(publishDeps(w), wt));
    expect(published.map((p) => p.path)).not.toContain("libs/mid");
    expect(() =>
      git(midMirror, "rev-parse", `refs/heads/frm/${sid}`),
    ).toThrow();

    // 3. Restored, the guard lets the real thing through: the check is on the gitdir, not on the
    //    submodule being awkward.
    writeFileSync(dotGit, link);
    // 4. And an agent may branch anywhere in frm/: `+refs/heads/frm/*` forced published every one
    //    of them, so a session could rewrite another session's branch in a shared mirror.
    const other = `frm/${sid}-other`;
    const kept = git(midMirror, "rev-parse", "HEAD");
    git(midMirror, "update-ref", `refs/heads/${other}`, kept);
    git(mid, "branch", other, "HEAD");
    published = unwrap(await publishSubmodules(publishDeps(w), wt));
    expect(published).toEqual([
      { path: "libs/mid", repo_id: "mid", sha: head(mid) },
      { path: "libs/mid/vendor/leaf", repo_id: "leaf", sha: head(leaf) },
    ]);
    expect(git(midMirror, "rev-parse", `refs/heads/frm/${sid}`)).toBe(
      head(mid),
    );
    expect(git(midMirror, "rev-parse", `refs/heads/${other}`)).toBe(kept);
    expect(kept).not.toBe(head(mid));
  });

  test("a .gitmodules update=!command is refused `validation` in phase R: nothing runs, no row, no worktree", async () => {
    const sid = "SM6";
    const pwnedDir = mkdtempSync(join(tmpdir(), "frm-mr-pwned-"));
    bins.push(pwnedDir);
    const pwned = join(pwnedDir, "pwned");
    const w = keep(
      await multiWorld({
        rows: (home) =>
          submoduleRows(home, {
            gitmodules: (sup) =>
              git(
                sup,
                "config",
                "-f",
                ".gitmodules",
                "submodule.libs/mid.update",
                `!touch ${pwned}`,
              ),
          }).rows,
      }),
    );
    await w.spawn(sid);
    await settle(w, async () =>
      expect(await session(w.db, sid)).toMatchObject({
        state: "exited",
        error_class: "validation",
        error_message: expect.stringContaining("update=!command"),
      }),
    );
    expect(unwrap(await listSessionWorktrees(w.db, sid))).toEqual([]);
    expect(existsSync(work(w, sid, "super"))).toBe(false);
    expect(existsSync(pwned)).toBe(false);
  });

  test("an undeclared submodule is refused `validation` in phase R: no row, no worktree", async () => {
    const sid = "SM2";
    const w = keep(
      await multiWorld({
        rows: (home) => submoduleRows(home, { declareLeaf: false }).rows,
      }),
    );
    await w.spawn(sid);
    await settle(w, async () =>
      expect(await session(w.db, sid)).toMatchObject({
        state: "exited",
        error_class: "validation",
        error_message: expect.stringContaining(
          'submodule "libs/mid/vendor/leaf" (url',
        ),
      }),
    );
    expect(unwrap(await listSessionWorktrees(w.db, sid))).toEqual([]);
    expect(existsSync(work(w, sid, "super"))).toBe(false);
  });

  test("a git below the floor is refused before any mirror is cloned (M3)", async () => {
    const sid = "SM3";
    const old = fakeGit(
      'if [ "$*" = "--version" ]; then echo "git version 2.39.5"; exit 0; fi',
    );
    const w = keep(
      await multiWorld({
        path: old.path,
        rows: (home) => submoduleRows(home).rows,
      }),
    );
    await w.spawn(sid);
    await settle(w, async () =>
      expect(await session(w.db, sid)).toMatchObject({
        state: "exited",
        error_class: "validation",
        error_message: expect.stringContaining(
          "git 2.39.5 is not fixed for CVE-2024-32002",
        ),
      }),
    );
    expect(unwrap(await listSessionWorktrees(w.db, sid))).toEqual([]);
    expect(existsSync(mirrorOf(w.home, "super"))).toBe(false);
  });

  test("a failing submodule update orphans the superproject's row and keeps its directory", async () => {
    const sid = "SM4";
    const failing = fakeGit(
      'case " $* " in *" submodule "*) echo "no submodules today" >&2; exit 1 ;; esac',
    );
    const w = keep(
      await multiWorld({
        path: failing.path,
        rows: (home) => submoduleRows(home).rows,
      }),
    );
    await w.spawn(sid);
    await settle(w, async () =>
      expect(await session(w.db, sid)).toMatchObject({
        state: "exited",
        exit_reason: "error",
        error_class: "spawn_failed",
      }),
    );
    expect(
      unwrap(await listSessionWorktrees(w.db, sid)).map((r) => r.state),
    ).toEqual(["orphan"]);
    expect(existsSync(work(w, sid, "super", ".git"))).toBe(true);
  });

  test("a stop during a stuck submodule update kills the helper with git; the directories stay", async () => {
    const sid = "SM5";
    const helperDir = mkdtempSync(join(tmpdir(), "frm-mr-helper-"));
    bins.push(helperDir);
    const pidFile = join(helperDir, "helper.pid");
    const stuck = fakeGit(
      `case " $* " in *" submodule "*) sleep 60 & echo $! > '${pidFile}'; wait; exit 1 ;; esac`,
    );
    const w = keep(
      await multiWorld({
        path: stuck.path,
        rows: (home) => submoduleRows(home).rows,
      }),
    );
    await w.spawn(sid);
    const helper = await vi.waitFor(() => {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      return pid;
    }, WAIT);
    expect(isAlive(helper)).toBe(true);
    await w.lifecycle.stop(sid, "kill");
    await settle(w, async () =>
      expect(await session(w.db, sid)).toMatchObject({
        state: "exited",
        exit_reason: "killed",
      }),
    );
    await vi.waitFor(() => expect(isAlive(helper)).toBe(false), WAIT);
    expect(existsSync(work(w, sid, "super", ".git"))).toBe(true);
    expect(
      unwrap(await listSessionWorktrees(w.db, sid)).map((r) => r.state),
    ).toEqual(["orphan"]);
  });
});

/** A hand-off's facts, as short as the schema allows. */
const facts = (from: string): HandoffFacts => ({
  v: 1,
  ticket: { id: TICKET, key: "T-1", status: "building" },
  session: { id: from, role: "builder", run_class: "build" },
  repos: [],
  commands: [],
  gates: [],
  findings_open: 0,
  questions: [],
  spend: { session_usd: 0, ticket_usd: 0 },
  counters: {
    turns: 1,
    max_turns: 10,
    tool_calls: 0,
    context_peak_tokens: null,
    context_cap: 1_000,
  },
  events: { first_id: null, last_id: null },
  gathered_at: 0,
  why: "the session died",
});

describe("successors and adoption across repos", { timeout: 60_000 }, () => {
  async function predecessorWithHandoff(capture: Map<string, SpawnSpec>) {
    const w = keep(
      await multiWorld({
        rows: (home) => multiRows(home).rows,
        adapter: (base) => ({
          ...base,
          spawn: async (spec, ex) => {
            capture.set(spec.sessionId, spec);
            return base.spawn(spec, ex);
          },
        }),
      }),
    );
    await w.spawn("P");
    await waitState(w, "P", "idle");
    await w.lifecycle.stop("P", "kill");
    await waitState(w, "P", "exited");
    unwrap(
      await seedRows(w.db, {
        handoffs: [
          {
            id: "H1",
            ticket_id: TICKET,
            from_session_id: "P",
            reason: "session_death",
            facts_json: JSON.stringify(facts("P")),
            quality: "degraded",
            packet_path: ".foreman/handoff-1.md",
            packet_hash: "0".repeat(64),
            created_at: 0,
          },
        ],
      }),
    );
    return w;
  }

  test("a successor inherits every worktree at once: the primary as cwd, the other as an extra root (Q6)", async () => {
    const specs = new Map<string, SpawnSpec>();
    const w = await predecessorWithHandoff(specs);
    await w.spawn("S", { handoff_id: "H1" });
    await waitState(w, "S", "idle");
    expect(unwrap(await listSessionWorktrees(w.db, "P"))).toEqual([]);
    expect(
      unwrap(await listSessionWorktrees(w.db, "S"))
        .map((r) => r.repo_id)
        .toSorted(),
    ).toEqual(["app", "lib"]);
    expect(specs.get("S")).toMatchObject({
      cwd: work(w, "P", "app"),
      extraRoots: [work(w, "P", "lib")],
    });
    expect(existsSync(work(w, "P", "app", ".foreman", "handoff-1.md"))).toBe(
      true,
    );
  });

  test("a held set without the primary is refused, and nothing moves", async () => {
    const w = await predecessorWithHandoff(new Map());
    const app = unwrap(await listSessionWorktrees(w.db, "P")).find(
      (r) => r.repo_id === "app",
    );
    unwrap(await setWorktreeState(w.db, app?.id ?? "", "merged"));
    const refused = await w.lifecycle.handlers.spawn.handle(
      spawnPayload("S2", {
        workspace_id: "ws",
        ticket_id: TICKET,
        handoff_id: "H1",
      }),
      CMD,
    );
    expect(refused).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining(
          "lack the workspace's primary repo app",
        ),
      },
    });
    expect(
      unwrap(await listSessionWorktrees(w.db, "P")).map((r) => r.repo_id),
    ).toContain("lib");
  });

  test("a chain that never had a worktree is placed afresh across every repo: the primary as cwd, the other as an extra root, the packet in the primary's", async () => {
    const specs = new Map<string, SpawnSpec>();
    const w = keep(
      await multiWorld({
        rows: (home) => multiRows(home).rows,
        adapter: (base) => ({
          ...base,
          spawn: async (spec, ex) => {
            specs.set(spec.sessionId, spec);
            return base.spawn(spec, ex);
          },
        }),
      }),
    );
    // The ticket's holder a restart cut short in `preparing`, before its workspace step: no row.
    const runtime = join(w.home, "runtime", "sessions", "pre");
    unwrap(
      await createSession(w.db, {
        id: "pre",
        agent_id: AGENT_ID,
        ticket_id: TICKET,
        role: "builder",
        run_class: "build",
        runner_id: FIXTURE_RUNNER_ID,
        executor_id: EXECUTOR_ID,
        workspace_id: "ws",
        session_root: work(w, "pre"),
        home_dir: join(runtime, "home"),
        config_hash: "0".repeat(64),
        raw_log_path: join(runtime, "logs", "stdout.jsonl"),
        mcp_token_hash: "token-hash-pre",
      }),
    );
    unwrap(
      await updateSessionState(w.db, "pre", {
        from: ["pending"],
        to: "preparing",
      }),
    );
    await w.lifecycle.reconcile();
    await w.lifecycle.settled();
    const [h] = unwrap(await listTicketHandoffs(w.db, TICKET)).filter(
      (row) => row.from_session_id === "pre",
    );
    expect(h).toMatchObject({ quality: "degraded", reason: "session_death" });

    await w.spawn("S", { handoff_id: h?.id ?? "" });
    await waitState(w, "S", "idle");
    expect(
      unwrap(await listSessionWorktrees(w.db, "S"))
        .map((r) => r.repo_id)
        .toSorted(),
    ).toEqual(["app", "lib"]);
    expect(specs.get("S")).toMatchObject({
      cwd: work(w, "S", "app"),
      extraRoots: [work(w, "S", "lib")],
    });
    expect(
      existsSync(join(work(w, "S", "app"), h?.packet_path ?? "missing")),
    ).toBe(true);
  });

  test("adopt (H2): a killed multi-repo session resumes with the primary as cwd and the extra root, never an orphan row", async () => {
    const adopted = new Map<string, SpawnSpec>();
    const w = keep(
      await multiWorld({
        rows: (home) => multiRows(home).rows,
        script: () => ({ runs: [{ events: [TURN], gate: "release" }] }),
        adapter: (base) => ({
          ...base,
          adopt: async (spec, ex) => {
            adopted.set(spec.sessionId, spec);
            return base.adopt(spec, ex);
          },
        }),
      }),
    );
    await w.spawn("K", { prompt: "go" });
    await settle(w, async () =>
      expect(await kindsOf(w.db, "K")).toContain("turn_start"),
    );
    // An orphan row of lib beside the live one: were it counted, rootsOf would refuse two of a repo.
    unwrap(
      await insertWorktree(w.db, {
        session_root: work(w, "K"),
        workspace_id: "ws",
        repo_id: "lib",
        path: work(w, "K", "lib-old"),
        branch: "frm/old",
        base_sha: "0".repeat(40),
        session_id: "K",
        state: "orphan",
      }),
    );
    const ref = (await session(w.db, "K")).executor_ref ?? "";
    const died = w.logs.filter((l) =>
      l.msg.startsWith("the runner exited"),
    ).length;
    process.kill(Number(ref.split(":")[1]), "SIGKILL");
    await settle(w, async () =>
      expect(
        w.logs.filter((l) => l.msg.startsWith("the runner exited")).length,
      ).toBe(died + 1),
    );
    await w.lifecycle.reconcile();
    await w.lifecycle.settled();
    expect(adopted.get("K")).toMatchObject({
      cwd: work(w, "K", "app"),
      extraRoots: [work(w, "K", "lib")],
    });
    expect((await session(w.db, "K")).executor_ref).not.toBe(ref);
  });
});
