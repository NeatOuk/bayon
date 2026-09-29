//, the pull-the-plug cycle in miniature (M4-n's `frm smoke --m4` extends it): the
// supervisor as a child (dist/main.js) with its fixture runners; every group but an escaped
// straggler's SIGKILLed at once, twice. After each restart: S1 (mid-turn) and S3 (idle) adopted,
// the straggler killed before its session's adopt (Invariant 12), S4 (queued) re-admitted, no
// command left claimed (the idempotent one re-delivered, the other failed), every raw log at least
// as long as its committed end, and no process of S1's or S3's but their runners.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock } from "@bayon/core";
import {
  getCommand,
  getSession,
  listRuns,
  openDb,
  readHeartbeat,
  type Db,
  type SessionRow,
} from "@bayon/db";
import { claimCommand, migrateUp } from "@bayon/db/supervisor";
import {
  insertCommand,
  listCommands,
  seedRows,
  unwrap,
} from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  createFixtureAdapter,
  FIXTURE_CAPS,
  FIXTURE_RUNNER_ID,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { currentKey } from "../conformance/decertify.js";
import { committedEnd } from "../ingest/segment.js";
import { dbPath, homeTag, rawLogPath } from "../paths.js";
import { certifyPair } from "./testing/certify.js";
import { AGENT_ID, EXECUTOR_ID, lifecycleRows } from "./testing/fixtures.js";
import { startMcpStub } from "./testing/mcp-stub.js";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const MAIN = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const WAIT = { timeout: 45_000, interval: 50 };
const STEP = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
/** S1's agent: run 1 holds at its gate, so the first plug finds it mid-turn. */
const HELD: FixtureScriptInput = {
  runs: [{ events: [STEP], gate: "release" }],
};
/** S3's and S4's agent: run 1 ends, the session idles. */
const DONE: FixtureScriptInput = { runs: [{ events: [STEP] }] };
const SECOND_AGENT = "agent-2";

/** The children's FRM_MCP_URL: every spawn and adopt gates on it answering. */
const mcp = await startMcpStub();
const children: ChildProcess[] = [];
const runners = new Set<number>();
const dbs: Db[] = [];
const homes: string[] = [];
afterAll(async () => {
  for (const child of children) killGroup(child.pid);
  for (const pid of runners) killGroup(pid);
  for (const db of dbs) await db.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  await mcp.close();
});

beforeAll(() => {
  // The child runs the compiled supervisor; tsc -b is incremental, and a no-op after `pnpm -w build`.
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-b", PACKAGE], { stdio: "inherit" });
}, 180_000);

/** SIGKILL to the group `pid` leads, else to `pid` alone; a gone one is fine. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid < 2) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
      return;
    } catch {
      // no such group or process: try the next, or it is gone
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pidOf = (ref: string | null): number => Number(ref?.split(":")[1]);
const gone = (c: ChildProcess): boolean =>
  c.exitCode !== null || c.signalCode !== null;

function supervise(home: string, n: number): ChildProcess {
  const log = openSync(join(home, `supervisor-${n}.log`), "a");
  const child = spawn(process.execPath, [MAIN], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      FRM_HOME: home,
      // Its own /mcp: never the default URL, where the operator's live API may or may not be.
      FRM_MCP_URL: mcp.url,
    },
    stdio: ["ignore", log, log],
    detached: true,
  });
  closeSync(log);
  children.push(child);
  return child;
}

/** Up once its heartbeat carries its pid: migrations and registration are done. */
async function ready(db: Db, child: ChildProcess): Promise<void> {
  await vi.waitFor(async () => {
    expect(unwrap(await readHeartbeat(db))?.pid).toBe(child.pid);
  }, WAIT);
}

/**
 * A tagged node process in its own group: a descendant of `sessionId`'s runner that escaped its
 * group, as a daemonized dev server would. node, not /bin/sleep: macOS hides a platform binary's
 * environment from ps.
 */
function straggler(home: string, sessionId: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 120000)"],
    {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        FRM_HOME_TAG: homeTag(home),
        FRM_SESSION_ID: sessionId,
      },
      detached: true,
      stdio: "ignore",
    },
  );
  children.push(child);
  return child;
}

/** Pulls the plug: SIGKILL to the supervisor's group and every runner's group, at once. */
async function plug(
  child: ChildProcess,
  runnerPids: readonly number[],
): Promise<void> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  for (const pid of [child.pid ?? 0, ...runnerPids]) killGroup(pid);
  await exited;
  await vi.waitFor(() => {
    for (const pid of runnerPids) expect(isAlive(pid)).toBe(false);
  }, WAIT);
}

const session = async (db: Db, id: string): Promise<SessionRow> =>
  unwrap(await getSession(db, id));

/** Adopted: idle, on a process other than `previous`. */
async function adopted(
  db: Db,
  id: string,
  previous: string | null,
): Promise<SessionRow> {
  let found: SessionRow | undefined;
  await vi.waitFor(async () => {
    found = await session(db, id);
    expect(found.state).toBe("idle");
    expect(found.executor_ref).not.toBeNull();
    expect(found.executor_ref).not.toBe(previous);
  }, WAIT);
  if (found === undefined) throw new Error(`no session ${id}`);
  runners.add(pidOf(found.executor_ref));
  return found;
}

const spawnCommand = (id: string, agent: string) =>
  insertCommand(dbs[0] as Db, {
    type: "session.spawn",
    payload: {
      session_id: id,
      agent_id: agent,
      role: "builder",
      run_class: "build",
      prompt: "go",
    },
  });

describe("pulling the plug", { timeout: 300_000 }, () => {
  test("SIGKILL every group at once, twice: adopted, the escaped straggler killed first, the queued one re-admitted, no command left claimed, the raw logs whole", async () => {
    const home = realpathSync(mkdtempSync("/tmp/frm-plug-"));
    homes.push(home);
    const db = unwrap(await openDb({ path: dbPath(home), clock: systemClock }));
    dbs.push(db);
    // No disk floor from the first boot's health pass on: the local executor measures this host's
    // real disk under FRM_HOME, and restarts are under test here, not free space.
    unwrap(await migrateUp(db));
    unwrap(
      await seedRows(db, {
        settings: [
          {
            key: "admission.disk_min_free_pct",
            value_json: "0",
            updated_at: 0,
          },
        ],
      }),
    );
    let sup = supervise(home, 1);
    await ready(db, sup);
    // The runner and executor rows come from the supervisor's registration; the agents after them.
    const held = lifecycleRows({ script: HELD });
    const done = lifecycleRows({ script: DONE });
    unwrap(
      await seedRows(db, {
        profiles: [
          ...held.profiles,
          ...done.profiles.map((p) => ({
            ...p,
            id: "profile-2",
            name: "profile-2",
          })),
        ],
        agents: [
          ...held.agents,
          ...done.agents.map((a) => ({
            ...a,
            id: SECOND_AGENT,
            name: SECOND_AGENT,
            profile_id: "profile-2",
          })),
        ],
      }),
    );
    // 012's require_certified=1: the fixture pair is certified through certify(),
    // pinned to the very key each boot checks (decertify.ts currentKey), so it outlives both
    // restarts as a real conformance run's would. S4's re-admission re-checks it (gates 1–5).
    // Every fixture tier runs the same model string, so one key pins all its certificates.
    const registration = createFixtureAdapter({
      clock: systemClock,
    }).registration();
    const key = await currentKey(
      registration,
      registration.models[0]?.model ?? "fixture-model",
    );
    await certifyPair(db, {
      runnerId: FIXTURE_RUNNER_ID,
      runnerVersion: key.runner_version,
      caps: FIXTURE_CAPS,
      executorId: EXECUTOR_ID,
      at: Date.now(),
      kitHash: key.kit_hash,
    });
    unwrap(await spawnCommand("S1", AGENT_ID));
    unwrap(await spawnCommand("S3", SECOND_AGENT));
    await vi.waitFor(async () => {
      expect((await session(db, "S1")).state).toBe("running");
      expect(unwrap(await listRuns(db, "S3"))[0]?.state).toBe("ok");
      expect((await session(db, "S3")).state).toBe("idle");
    }, WAIT);
    expect(mcp.probes()).toBeGreaterThan(0); // admitted on this test's /mcp
    // agent-2 runs at 012's max_concurrency=1: S4 queues behind the idle S3.
    unwrap(await spawnCommand("S4", SECOND_AGENT));
    await vi.waitFor(async () => {
      expect(await session(db, "S4")).toMatchObject({
        state: "pending",
        queued_reason: "concurrency",
      });
    }, WAIT);

    for (const [cycle, strayOf] of [
      [1, "S3"],
      [2, "S1"],
    ] as const) {
      const before = {
        S1: await session(db, "S1"),
        S3: await session(db, "S3"),
      };
      const runnerPids = [
        pidOf(before.S1.executor_ref),
        pidOf(before.S3.executor_ref),
      ];
      for (const pid of runnerPids) runners.add(pid);
      const stray = straggler(home, strayOf);
      await plug(sup, runnerPids);
      expect(gone(stray)).toBe(false); // it escaped the plug with its own group
      // Claimed when the plug was pulled: one idempotent command, one not.
      const health = unwrap(
        await insertCommand(db, {
          type: "executor.health",
          payload: { executor_id: EXECUTOR_ID },
        }),
      ).id;
      const interrupt = unwrap(
        await insertCommand(db, {
          type: "session.interrupt",
          payload: { session_id: "S1" },
        }),
      ).id;
      // One millisecond, so their (ts, id) order is the ULIDs' random part: either may come first.
      const claimed = [
        unwrap(await claimCommand(db))?.id,
        unwrap(await claimCommand(db))?.id,
      ];
      expect(claimed.toSorted()).toEqual([health, interrupt].toSorted());

      sup = supervise(home, cycle + 1);
      await ready(db, sup);
      const s1 = await adopted(db, "S1", before.S1.executor_ref);
      const s3 = await adopted(db, "S3", before.S3.executor_ref);
      expect(s1.runner_session_id).toBe(before.S1.runner_session_id);
      await vi.waitFor(() => expect(gone(stray)).toBe(true), WAIT);
      await vi.waitFor(async () => {
        const claimed = unwrap(await listCommands(db)).filter(
          (c) => c.state === "claimed",
        );
        expect(claimed).toEqual([]);
        expect(unwrap(await getCommand(db, health))).toMatchObject({
          state: "done",
          attempts: 2,
        });
        expect(unwrap(await getCommand(db, interrupt)).state).toBe("failed");
        expect(await session(db, "S4")).toMatchObject({
          state: "pending",
          queued_reason: "concurrency",
        });
      }, WAIT);
      expect(
        JSON.parse(unwrap(await getCommand(db, interrupt)).error ?? "{}"),
      ).toMatchObject({ class: "interrupted", retryable: true });
      for (const id of ["S1", "S3"]) {
        const end = unwrap(await committedEnd(db, id));
        expect(statSync(rawLogPath(home, id)).size).toBeGreaterThanOrEqual(end);
      }
      // Of S1's and S3's, only their adopted runners run: nothing escaped survives the restart.
      const scan = new LocalExecutor({
        id: "scan",
        slots: new SlotCounter(1),
        homeTag: homeTag(home),
      });
      const pids = (await scan.listOwned())
        .filter((o) => o.sessionId === "S1" || o.sessionId === "S3")
        .map((o) => pidOf(o.ref));
      expect(new Set(pids)).toEqual(
        new Set([pidOf(s1.executor_ref), pidOf(s3.executor_ref)]),
      );
    }
    expect(unwrap(await listRuns(db, "S1"))[0]).toMatchObject({
      state: "interrupted",
    });

    // S3 ends: the re-admitted S4 takes agent-2's one place and runs to its terminal.
    unwrap(
      await insertCommand(db, {
        type: "session.stop",
        payload: { session_id: "S3", mode: "kill" },
      }),
    );
    await vi.waitFor(async () => {
      expect(unwrap(await listRuns(db, "S4"))[0]?.state).toBe("ok");
      expect(await session(db, "S4")).toMatchObject({
        state: "idle",
        queued_reason: null,
        spawn_request_json: null,
      });
    }, WAIT);
    runners.add(pidOf((await session(db, "S4")).executor_ref));
    killGroup(sup.pid);
  });
});
