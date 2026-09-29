// Multi-repo and submodule workspaces on a container executor over the loopback (// §6, §12): the real ContainerExecutor with a stand-in docker, so the pushes (base refs, submodule
// pins), the one workspace exec, each repo's clone --reference and the in-container submodule
// checkouts run for real. The loopback's git is this host's, so the floor (N1) is reached only by
// a second container whose stand-in git reports Debian bookworm's 2.39.5.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FakeClock,
  SubmoduleShas,
  judgeExecutorHealth,
  parseGitVersion,
  type HealthLimits,
} from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listSessionsInStates,
  listSessionWorktrees,
} from "@bayon/db";
import { seedRows, tempDb, unwrap, type TempDb } from "@bayon/db/testing";
import {
  ContainerExecutor,
  LocalExecutor,
  SlotCounter,
  type ExecutorHealthReport,
} from "@bayon/executors";
import { installFakeDocker, LoopbackTransport } from "@bayon/executors/testing";
import {
  FIXTURE_COMMAND,
  createFixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { SessionSpawnPayload } from "./payloads.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
  type Started,
} from "./testing/fixtures.js";
import { git, makeSource, repoRow } from "./testing/multi-world.js";

const CTR = "ctr-mr";
const OLD = "ctr-old";
const T0 = 1_700_000_000_000;
const WAIT = { timeout: 30_000, interval: 50 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const SCRIPT: FixtureScriptInput = { runs: [{ events: [TURN] }] };

/** Health is, and needs a real docker; here the executor is always healthy. */
class LoopbackContainer extends ContainerExecutor {
  override health(limits: HealthLimits): Promise<ExecutorHealthReport> {
    return Promise.resolve(
      judgeExecutorHealth({ checkedAt: T0, disk: [], clockSkewMs: 0, limits }),
    );
  }
}

let home: ReturnType<typeof tempHome>;
let t: TempDb;
let started: Started;
let local: LocalExecutor;
let remoteRoot = "";
let oldRoot = "";
const containers: LoopbackContainer[] = [];
const src: Record<string, string> = {};

/** A container executor over the loopback; `binFirst` goes first on its programs' PATH. */
function loopback(id: string, root: string, binFirst = "") {
  mkdirSync(root, { recursive: true });
  const docker = installFakeDocker(join(home.path, `fake-${id}`), id);
  const slots = new SlotCounter(2);
  const executor = new LoopbackContainer({
    id,
    slots,
    frmHome: home.path,
    config: {
      ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
      remote_root: root,
      image: "frm/test",
      min_free_pct: 0,
      heartbeat_ms: 200,
      kill_grace_ms: 1_000,
      env_path: `${binFirst}${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    transport: new LoopbackTransport({ ...docker.env, HOME: home.path }),
    paths: {
      sessions: join(root, "work"),
      run: join(root, "run"),
      shim: "/opt/frm/exec-shim.mjs",
    },
  });
  containers.push(executor);
  return { executor, slots };
}

beforeAll(async () => {
  home = tempHome("frm-ctrm-");
  remoteRoot = join(home.path, "remote");
  oldRoot = join(home.path, "remote-old");
  src["app"] = makeSource(home.path, "app");
  src["lib"] = makeSource(home.path, "lib");
  src["leaf"] = makeSource(home.path, "leaf");
  src["mid"] = makeSource(home.path, "mid");
  git(src["mid"], "submodule", "add", "-q", src["leaf"], "vendor/leaf");
  git(src["mid"], "commit", "-q", "-m", "leaf");
  src["super"] = makeSource(home.path, "super");
  git(src["super"], "submodule", "add", "-q", src["mid"], "libs/mid");
  git(src["super"], "commit", "-q", "-m", "mid");
  const clock = new FakeClock(T0);
  t = unwrap(await tempDb(clock));
  // Each test's builder stays idle beside the next: three of the one agent at once.
  const rows = lifecycleRows({ script: SCRIPT, maxConcurrency: 3 });
  const container = (id: string) => ({
    id,
    kind: "container" as const,
    config_json: "{}",
    slots: 2,
    trust: "untrusted",
    egress_policy: "allowlist",
  });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      executors: [
        ...rows.executors.map((e) => ({ ...e, trust: "trusted" })),
        container(CTR),
        container(OLD),
      ],
      repos: [
        repoRow(home.path, "app", src["app"]),
        repoRow(home.path, "lib", src["lib"]),
        repoRow(home.path, "super", src["super"], 1),
        repoRow(home.path, "mid", src["mid"], 1),
        repoRow(home.path, "leaf", src["leaf"]),
      ],
      workspaces: [
        { id: "wm", name: "wm", kind: "multi" },
        { id: "wsub", name: "wsub", kind: "submodule" },
      ],
      workspace_repos: [
        {
          workspace_id: "wm",
          repo_id: "app",
          rel_path: "app",
          role: "primary",
        },
        { workspace_id: "wm", repo_id: "lib", rel_path: "lib", role: "dep" },
        {
          workspace_id: "wsub",
          repo_id: "super",
          rel_path: "super",
          role: "primary",
        },
        {
          workspace_id: "wsub",
          repo_id: "mid",
          rel_path: "super/libs/mid",
          role: "dep",
          submodule_path: "libs/mid",
        },
        {
          workspace_id: "wsub",
          repo_id: "leaf",
          rel_path: "super/libs/mid/vendor/leaf",
          role: "dep",
          submodule_path: "libs/mid/vendor/leaf",
        },
      ],
    }),
  );
  // Debian bookworm's git, as the image's is: a stand-in for `--version`, the real git otherwise.
  const oldBin = join(home.path, "old-git");
  mkdirSync(oldBin);
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  writeFileSync(
    join(oldBin, "git"),
    [
      "#!/bin/sh",
      'if [ "$*" = "--version" ]; then echo "git version 2.39.5"; exit 0; fi',
      `exec '${realGit}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const ctr = loopback(CTR, remoteRoot);
  const old = loopback(OLD, oldRoot, `${oldBin}:`);
  const localSlots = new SlotCounter(4);
  local = new LocalExecutor({ id: EXECUTOR_ID, slots: localSlots });
  started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor: local,
    slots: localSlots,
    others: [ctr, old],
    // The loopback's "image" is this host: its program, not the image's.
    adapter: createFixtureAdapter({ clock, command: FIXTURE_COMMAND }),
  });
});

afterAll(async () => {
  await started.lifecycle.shutdown();
  const live = await listSessionsInStates(t.db, ["idle", "running"]);
  for (const s of live.ok ? live.value : []) {
    if (s.executor_ref === null) continue;
    const owner = containers.find((c) => c.id === s.executor_id) ?? local;
    await owner.cleanup(s.executor_ref, "hard").catch(() => undefined);
  }
  for (const c of containers) await c.close();
  t.cleanup();
  home.cleanup();
});

const session = async (id: string) => unwrap(await getSession(t.db, id));
const kinds = async (id: string) =>
  unwrap(
    await getEventsSince(t.db, { sessionId: id, since: 0, limit: 1000 }),
  ).rows.map((e) => e.kind);
const spawn = (id: string, extra: Partial<SessionSpawnPayload> = {}) =>
  started.lifecycle.handlers.spawn.handle(spawnPayload(id, extra), CMD);
const ranToTerminal = (id: string) =>
  vi.waitFor(async () => {
    expect({ s: await session(id), kinds: await kinds(id) }).toMatchObject({
      s: { state: "idle" },
      kinds: expect.arrayContaining(["terminal"]),
    });
  }, WAIT);
const pinsIn = (id: string) =>
  git(
    join(remoteRoot, "mirror", `${id}.git`),
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/frm/pin/",
  );

describe(
  "multi-repo and submodule workspaces on a container (loopback)",
  { timeout: 90_000 },
  () => {
    test("multi-repo: each repo pushed into its own mirror and cloned --reference as a sibling under the root; terminal ok", async () => {
      unwrap(
        await spawn("CM", {
          executor_id: CTR,
          workspace_id: "wm",
          prompt: "go",
        }),
      );
      await ranToTerminal("CM");
      const root = join(remoteRoot, "work", "CM");
      const rows = unwrap(await listSessionWorktrees(t.db, "CM"));
      expect(rows.map((r) => [r.repo_id, r.path, r.branch]).toSorted()).toEqual(
        [
          ["app", join(root, "app"), "frm/CM"],
          ["lib", join(root, "lib"), "frm/CM"],
        ],
      );
      for (const id of ["app", "lib"]) {
        const clone = join(root, id);
        expect(git(clone, "rev-parse", "HEAD")).toBe(
          git(src[id] ?? "", "rev-parse", "HEAD"),
        );
        expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("frm/CM");
        expect(
          readFileSync(
            join(clone, ".git", "objects", "info", "alternates"),
            "utf8",
          ).trim(),
        ).toBe(join(remoteRoot, "mirror", `${id}.git`, "objects"));
      }
    });

    test("submodule: gitlink commits pinned in the child mirrors, submodules checked out in the container, SHAs and git recorded; once it ends the pass drops the pins and the root stays", async () => {
      unwrap(
        await spawn("CS", {
          executor_id: CTR,
          workspace_id: "wsub",
          prompt: "go",
        }),
      );
      await ranToTerminal("CS");
      const root = join(remoteRoot, "work", "CS");
      const midSha = git(src["super"] ?? "", "rev-parse", "HEAD:libs/mid");
      const leafSha = git(src["mid"] ?? "", "rev-parse", "HEAD:vendor/leaf");
      const [row, ...more] = unwrap(await listSessionWorktrees(t.db, "CS"));
      expect(more).toEqual([]);
      expect(
        SubmoduleShas.parse(JSON.parse(row?.submodule_shas_json ?? "null")),
      ).toEqual({
        v: 1,
        git: parseGitVersion(git(home.path, "--version")),
        shas: [
          { path: "libs/mid", repo_id: "mid", sha: midSha },
          { path: "libs/mid/vendor/leaf", repo_id: "leaf", sha: leafSha },
        ],
      });
      expect(
        readFileSync(
          join(root, "super", "libs", "mid", "vendor", "leaf", "README.md"),
          "utf8",
        ),
      ).toBe("leaf\n");
      expect(pinsIn("mid")).toBe(`refs/frm/pin/CS ${midSha}`);
      expect(pinsIn("leaf")).toBe(`refs/frm/pin/CS ${leafSha}`);
      unwrap(
        await started.lifecycle.handlers.stop.handle(
          { session_id: "CS", mode: "kill" },
          CMD,
        ),
      );
      await vi.waitFor(
        async () => expect((await session("CS")).state).toBe("exited"),
        WAIT,
      );
      // dropSessionPins keys on worktree rows (the superproject's alone): the pass sweeps the rest.
      await started.lifecycle.reconcile();
      expect(pinsIn("mid")).toBe("");
      expect(pinsIn("leaf")).toBe("");
      expect(existsSync(join(root, "super", ".git"))).toBe(true);
    });

    test("N1: a container whose git reports 2.39.5 refuses a submodule workspace, naming the version and the floor, before any push or clone", async () => {
      unwrap(await spawn("CO", { executor_id: OLD, workspace_id: "wsub" }));
      await vi.waitFor(
        async () =>
          expect(await session("CO")).toMatchObject({
            state: "exited",
            error_class: "validation",
            error_message: expect.stringContaining(
              "git 2.39.5 is not fixed for CVE-2024-32002 and CVE-2025-48384",
            ),
          }),
        WAIT,
      );
      expect((await session("CO")).error_message).toContain(
        "the floor is 2.50.1",
      );
      expect(unwrap(await listSessionWorktrees(t.db, "CO"))).toEqual([]);
      expect(existsSync(join(oldRoot, "work", "CO", "super"))).toBe(false);
      expect(existsSync(join(oldRoot, "mirror", "super.git"))).toBe(false);
    });
  },
);
