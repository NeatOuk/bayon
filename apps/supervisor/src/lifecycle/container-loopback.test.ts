// A fixture session on a container executor over the loopback: the real
// ContainerExecutor with a stand-in docker, so all but ssh and docker runs for real: the placed
// paths, the push into its mirror over git's ext:: transport, the clone --reference in the
// "container", the home claimed through it, the trust rule and the label reaper.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FakeClock,
  hashDoctrine,
  judgeExecutorHealth,
  type HealthLimits,
} from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listSessionsInStates,
  listSessionWorktrees,
  type GateRow,
} from "@bayon/db";
import {
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ContainerExecutor,
  LocalExecutor,
  SlotCounter,
  type ExecutorHealthReport,
} from "@bayon/executors";
import {
  installFakeDocker,
  LoopbackTransport,
  type FakeDocker,
} from "@bayon/executors/testing";
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

const CTR = "ctr-loop";
const T0 = 1_700_000_000_000;
const WAIT = { timeout: 20_000, interval: 50 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const SCRIPT: FixtureScriptInput = { runs: [{ events: [TURN] }] };
const DOCTRINE = "# rules\nbe careful\n";

/** Health is, and needs a real docker; here the executor is always healthy. */
class LoopbackContainer extends ContainerExecutor {
  override health(limits: HealthLimits): Promise<ExecutorHealthReport> {
    return Promise.resolve(
      judgeExecutorHealth({ checkedAt: T0, disk: [], clockSkewMs: 0, limits }),
    );
  }
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

let home: ReturnType<typeof tempHome>;
let t: TempDb;
let started: Started;
let local: LocalExecutor;
let executor: LoopbackContainer;
/** The sessions the container executor holds a container for (listOwned). */
const ownedSessions = async (): Promise<string[]> =>
  (await executor.listOwned()).map((o) => o.sessionId);
let docker: FakeDocker;
let remoteRoot = "";
let baseSha = "";
let hostMirror = "";

beforeAll(async () => {
  home = tempHome("frm-ctrl-");
  remoteRoot = join(home.path, "remote");
  mkdirSync(remoteRoot);
  const src = join(home.path, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "DOCTRINE.md"), DOCTRINE);
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "one");
  // No mirror here: the first spawn clones the supervisor's own from origin_url.
  hostMirror = join(home.path, "mirror.git");
  baseSha = git(src, "rev-parse", "HEAD");
  const clock = new FakeClock(T0);
  t = unwrap(await tempDb(clock));
  const rows = lifecycleRows({ script: SCRIPT });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      executors: [
        // Local is trusted, as boot upserts it (rule 4); the container is not.
        ...rows.executors.map((e) => ({ ...e, trust: "trusted" })),
        {
          id: CTR,
          kind: "container",
          config_json: "{}",
          slots: 2,
          trust: "untrusted",
          egress_policy: "allowlist",
        },
      ],
      repos: [
        {
          id: "repo_1",
          name: "repo_1",
          origin_url: src,
          mirror_path: hostMirror,
          doctrine_paths_json: '["DOCTRINE.md"]',
        },
      ],
      workspaces: [{ id: "ws", name: "ws", kind: "single" }],
      workspace_repos: [
        {
          workspace_id: "ws",
          repo_id: "repo_1",
          rel_path: "repo",
          role: "primary",
        },
      ],
    }),
  );
  docker = installFakeDocker(join(home.path, "fake"), CTR);
  const slots = new SlotCounter(2);
  executor = new LoopbackContainer({
    id: CTR,
    slots,
    frmHome: home.path,
    config: {
      ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
      remote_root: remoteRoot,
      image: "frm/test",
      min_free_pct: 0,
      heartbeat_ms: 200,
      kill_grace_ms: 1_000,
      env_path: `${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    transport: new LoopbackTransport({ ...docker.env, HOME: home.path }),
    paths: {
      sessions: join(remoteRoot, "work"),
      run: join(remoteRoot, "run"),
      shim: "/opt/frm/exec-shim.mjs",
    },
  });
  const localSlots = new SlotCounter(4);
  local = new LocalExecutor({ id: EXECUTOR_ID, slots: localSlots });
  started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor: local,
    slots: localSlots,
    others: [{ executor, slots }],
    // The loopback's "image" is this host: its program, not the image's.
    adapter: createFixtureAdapter({ clock, command: FIXTURE_COMMAND }),
  });
});

afterAll(async () => {
  await started.lifecycle.shutdown();
  const live = await listSessionsInStates(t.db, ["idle", "running"]);
  for (const s of live.ok ? live.value : []) {
    if (s.executor_ref === null) continue;
    const owner = s.executor_id === CTR ? executor : local;
    await owner.cleanup(s.executor_ref, "hard").catch(() => undefined);
  }
  await executor.close();
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
const stop = (id: string, mode: "graceful" | "kill") =>
  started.lifecycle.handlers.stop.handle({ session_id: id, mode }, CMD);

describe(
  "a session on a container executor (loopback)",
  { timeout: 60_000 },
  () => {
    test("a builder: its mirror pushed, a clone --reference, its paths and home placed, run to terminal", async () => {
      unwrap(
        await spawn("S1", {
          executor_id: CTR,
          workspace_id: "ws",
          prompt: "go",
        }),
      );
      await vi.waitFor(async () => {
        expect(await kinds("S1")).toContain("terminal");
        expect((await session("S1")).state).toBe("idle");
      }, WAIT);
      const root = join(remoteRoot, "work", "S1");
      const s = await session("S1");
      expect(s).toMatchObject({
        executor_id: CTR,
        session_root: root,
        home_dir: join(root, ".frm", "home"),
      });
      expect(s.executor_ref).toMatch(
        /^ctr:ctr-loop:[0-9a-f]{12}:[0-9a-f]{16}$/,
      );
      const [w] = unwrap(await listSessionWorktrees(t.db, "S1"));
      expect(w).toMatchObject({
        path: join(root, "repo"),
        branch: "frm/S1",
        base_sha: baseSha,
        state: "active",
      });
      // The supervisor's mirror was cloned on first use, then pushed into the executor's own.
      expect(git(hostMirror, "config", "--get", "remote.origin.fetch")).toBe(
        "+refs/heads/*:refs/remotes/origin/*",
      );
      const remoteMirror = join(remoteRoot, "mirror", "repo_1.git");
      expect(git(remoteMirror, "rev-parse", "refs/heads/main")).toBe(baseSha);
      expect(
        readFileSync(
          join(root, "repo", ".git", "objects", "info", "alternates"),
          "utf8",
        ).trim(),
      ).toBe(join(remoteMirror, "objects"));
      expect(git(join(root, "repo"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
        "frm/S1",
      );
      // The home was claimed through the executor, in the session's root; none was made here.
      expect(
        readFileSync(join(root, ".frm", "home", ".frm-home.lock"), "utf8"),
      ).toBe("S1");
      expect(
        existsSync(join(home.path, "runtime", "sessions", "S1", "home")),
      ).toBe(false);
      // Doctrine was read from the supervisor's mirror at the commit the clone holds.
      expect(s.doctrine_hash).toBe(
        await hashDoctrine([{ path: "DOCTRINE.md", content: DOCTRINE }]),
      );
    });

    test("its end removes its container, by label, and keeps its clone", async () => {
      expect(await ownedSessions()).toContain("S1");
      unwrap(await stop("S1", "graceful"));
      await vi.waitFor(async () => {
        expect(["resumable", "exited"]).toContain((await session("S1")).state);
        expect(await ownedSessions()).not.toContain("S1");
      }, WAIT);
      expect(existsSync(join(remoteRoot, "work", "S1", "repo", ".git"))).toBe(
        true,
      );
    });

    test("the trust rule: a listed role or a flagged spawn is refused on local, admitted on the container", async () => {
      // Gate 4, trust, refuses before the row: the spawn fails with its gate.
      const s2 = await spawn("S2", { role: "investigator" });
      const s3 = await spawn("S3", { untrusted_input: true });
      for (const refused of [s2, s3]) {
        expect(refused).toMatchObject({
          ok: false,
          error: { class: "admission_refused", cause: { gate: "trust" } },
        });
      }
      expect(!s2.ok && s2.error.message).toContain(
        "role investigator is in executors.untrusted_roles",
      );
      expect(!s3.ok && s3.error.message).toContain("flagged untrusted_input");
      unwrap(await spawn("S4", { role: "investigator", executor_id: CTR }));
      await vi.waitFor(
        async () => expect((await session("S4")).state).toBe("idle"),
        WAIT,
      );
    });

    test("each pass releases a container whose session ended here, and keeps a live one and a stranger's", async () => {
      unwrap(await stop("S4", "kill"));
      await vi.waitFor(
        async () => expect(await ownedSessions()).not.toContain("S4"),
        WAIT,
      );
      unwrap(await spawn("S5", { executor_id: CTR }));
      await vi.waitFor(
        async () => expect((await session("S5")).state).toBe("idle"),
        WAIT,
      );
      // Left behind as if the end-reaper had failed; and one no session here owns.
      writeFileSync(join(docker.state, "S4"), `c${"f".repeat(63)}\n`);
      writeFileSync(join(docker.state, "STRANGER"), `c${"e".repeat(63)}\n`);
      await started.lifecycle.reconcile();
      const owned = await ownedSessions();
      expect(owned).not.toContain("S4");
      expect(owned).toEqual(expect.arrayContaining(["S5", "STRANGER"]));
    });

    test("each pass drops the pin refs of decided gates and exited sessions from every mirror, and keeps the rest", async () => {
      // One gate per kind: (ticket, kind, attempt) is unique.
      const gate = (
        id: string,
        kind: GateRow["kind"],
        state: GateRow["state"],
      ) => ({
        id,
        ticket_id: "ticket-1",
        kind,
        state,
        attempt: 1,
        subject_kind: "diff",
        subject_ref: "x",
        started_at: T0,
      });
      unwrap(
        await seedRows(t.db, {
          tickets: [ticketRow(1, { workspace_id: "ws" })],
          gates: [
            gate("g-done", "code_review", "passed"),
            gate("g-live", "plan_review", "running"),
          ],
        }),
      );
      const mirrors = join(remoteRoot, "mirror");
      const m1 = join(mirrors, "repo_1.git");
      // A second mirror on the same executor: the sweep reads every one.
      const m2 = join(mirrors, "repo_2.git");
      git(mirrors, "init", "-q", "--bare", m2);
      git(m2, "fetch", "-q", m1, "+refs/heads/main:refs/heads/main");
      // S4, stopped above, is the exited session: S2 is refused by the trust gate before any row
      // exists since admission v1, so it has none.
      const drop = ["refs/frm/gate/g-done", "refs/frm/pin/S4"];
      const keep = [
        "refs/frm/gate/g-live", // still running
        "refs/frm/gate/g-nobody", // no row here: another supervisor's
        "refs/frm/pin/S5", // a live session
        "refs/frm/pin/NOSUCH", // no row here
      ];
      for (const ref of [...drop, ...keep]) git(m1, "update-ref", ref, baseSha);
      git(m2, "update-ref", "refs/frm/gate/g-done", baseSha);
      expect((await session("S4")).state).toBe("exited");
      expect((await session("S5")).state).toBe("idle");
      await started.lifecycle.reconcile();
      const pinsIn = (repo: string) =>
        git(repo, "for-each-ref", "--format=%(refname)", "refs/frm/")
          .split("\n")
          .filter(Boolean)
          .toSorted();
      expect(pinsIn(m1)).toEqual(keep.toSorted());
      expect(pinsIn(m2)).toEqual([]);
      expect(git(m1, "rev-parse", "refs/heads/main")).toBe(baseSha);
    });
  },
);
