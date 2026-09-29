// FOR-7's Done-when: restart the whole supervisor mid-run and the session keeps one events
// sequence, with no gap and no duplicate. The supervisor runs as a child (dist/main.js, built in
// beforeAll) and is SIGKILLed twice; the fixture runner, pipe-bound, dies on stdin EOF and is
// adopted via resume (amendment 2). Children lead their own process groups; afterAll reaps them.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock } from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listRuns,
  openDb,
  readHeartbeat,
  SUPERVISOR_RUNNER_TYPE,
  type Db,
  type EventRow,
  type SessionRow,
} from "@bayon/db";
import { migrateUp } from "@bayon/db/supervisor";
import { insertCommand, seedRows, unwrap } from "@bayon/db/testing";
import {
  FIXTURE_CAPS,
  FIXTURE_RUNNER_ID,
  FIXTURE_VERSION,
  createFixtureMapper,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { certifyPair } from "./testing/certify.js";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { dbPath, rawLogPath } from "../paths.js";
import { AGENT_ID, lifecycleRows } from "./testing/fixtures.js";
import { startMcpStub } from "./testing/mcp-stub.js";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const MAIN = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const WAIT = { timeout: 30_000, interval: 50 };
const SESSION = "restart-session";
const STEP = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
/** Three events, then the run holds at the gate: the supervisor dies with it open. */
const GATE: FixtureScriptInput = {
  runs: [{ events: [STEP, STEP, STEP], gate: "release" }],
};

/** The children's FRM_MCP_URL: the spawn and every adopt gate on it answering. */
const mcp = await startMcpStub();
const children: ChildProcess[] = [];
const runners = new Set<number>();
const dbs: Db[] = [];
const homes: string[] = [];
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const pid of runners) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const db of dbs) await db.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  await mcp.close();
});

beforeAll(() => {
  // The child runs the compiled supervisor; tsc -b is incremental, and a no-op after `pnpm -w build`.
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-b", PACKAGE], { stdio: "inherit" });
}, 180_000);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: gone
  }
}

const pidOf = (ref: string | null): number => Number(ref?.split(":")[1]);

function startSupervisor(home: string, n: number): ChildProcess {
  const log = openSync(join(home, `supervisor-${n}.log`), "a");
  const child = spawn(process.execPath, [MAIN], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
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

async function kill9(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL"); // the supervisor alone: runners lead their own groups
  await exited;
}

const events = async (db: Db): Promise<EventRow[]> =>
  unwrap(
    await getEventsSince(db, { sessionId: SESSION, since: 0, limit: 1000 }),
  ).rows;

/** Waits for the adopt: idle on a process other than `previous`. */
async function adopted(db: Db, previous: string | null): Promise<SessionRow> {
  let found: SessionRow | undefined;
  await vi.waitFor(async () => {
    found = unwrap(await getSession(db, SESSION));
    expect(found.state).toBe("idle");
    expect(found.executor_ref).not.toBeNull();
    expect(found.executor_ref).not.toBe(previous);
  }, WAIT);
  if (found === undefined) throw new Error("no session");
  runners.add(pidOf(found.executor_ref));
  return found;
}

/**
 * Re-maps each process segment of the raw log with a fresh mapper: the (runner_type, raw_offset)
 * set ingest must have stored — none missing (no gap), none twice (no duplicate).
 */
function fromRawLog(home: string, starts: readonly number[]): string[] {
  const raw = readFileSync(rawLogPath(home, SESSION));
  const keys: string[] = [];
  starts.forEach((start, i) => {
    const end = starts[i + 1] ?? raw.length;
    const mapper = createFixtureMapper();
    for (let offset = start; offset < end;) {
      const nl = raw.indexOf(0x0a, offset);
      const stop = nl === -1 || nl >= end ? end : nl;
      const bytes = raw.subarray(offset, stop);
      const partial = stop === end && raw[end - 1] !== 0x0a && nl !== stop;
      for (const e of mapper.map({ offset, bytes, ts: 0, partial })) {
        keys.push(`${e.runner_type}@${offset + e.ordinal}`);
      }
      offset = stop + 1;
    }
  });
  return keys.toSorted();
}

/** The runner's rows are exactly the raw log's, in id order = raw_offset order. */
async function expectOneSequence(
  db: Db,
  home: string,
  starts: readonly number[],
): Promise<EventRow[]> {
  const rows = await events(db);
  const runner = rows.filter((r) => r.runner_type !== SUPERVISOR_RUNNER_TYPE);
  const byOffset = runner
    .toSorted((a, b) => (a.raw_offset ?? 0) - (b.raw_offset ?? 0))
    .map((r) => r.id);
  expect(byOffset).toEqual(runner.map((r) => r.id));
  const stored = runner.map((r) => `${r.runner_type}@${r.raw_offset}`);
  expect(stored.toSorted()).toEqual(fromRawLog(home, starts));
  return rows;
}

describe("restarting the whole supervisor", { timeout: 120_000 }, () => {
  test("SIGKILL mid-run, then again while idle: adopted each time, one events sequence, no gap, no duplicate", async () => {
    const home = realpathSync(mkdtempSync("/tmp/frm-lc-"));
    homes.push(home);
    const db = unwrap(await openDb({ path: dbPath(home), clock: systemClock }));
    dbs.push(db);
    // No disk floor from the first boot's health pass on: the local executor measures this host's
    // real disk under FRM_HOME, and a restart is under test here, not free space.
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
    let supervisor = startSupervisor(home, 1);
    await ready(db, supervisor);
    // The runner and executor rows come from the supervisor's registration; the operator's
    // profile and agent go in once they exist (foreign keys).
    const rows = lifecycleRows({ script: GATE });
    unwrap(
      await seedRows(db, { profiles: rows.profiles, agents: rows.agents }),
    );
    // 012's require_certified=1: the fixture pair is certified through certify().
    await certifyPair(db, {
      runnerId: FIXTURE_RUNNER_ID,
      runnerVersion: FIXTURE_VERSION,
      caps: FIXTURE_CAPS,
      executorId: "local",
      at: systemClock.now(),
    });
    unwrap(
      await insertCommand(db, {
        type: "session.spawn",
        payload: {
          session_id: SESSION,
          agent_id: AGENT_ID,
          role: "builder",
          run_class: "build",
          prompt: "hold at the gate",
        },
      }),
    );
    await vi.waitFor(async () => {
      const steps = (await events(db)).filter((e) => e.kind === "turn_start");
      expect(steps).toHaveLength(3);
    }, WAIT);
    const first = unwrap(await getSession(db, SESSION));
    expect(first).toMatchObject({ state: "running", raw_segment_offset: 0 });
    expect(mcp.probes()).toBeGreaterThan(0); // admitted on this test's /mcp
    runners.add(pidOf(first.executor_ref));
    const beforeKill = await events(db);

    // Cycle 1: the supervisor dies with run 1 open.
    await kill9(supervisor);
    await vi.waitFor(
      () => expect(isAlive(pidOf(first.executor_ref))).toBe(false),
      WAIT,
    );
    supervisor = startSupervisor(home, 2);
    await ready(db, supervisor);
    const second = await adopted(db, first.executor_ref);
    expect(second.runner_session_id).toBe(first.runner_session_id);
    expect(unwrap(await listRuns(db, SESSION))).toMatchObject([
      { seq: 1, state: "interrupted" },
    ]);
    const starts = [0, second.raw_segment_offset ?? -1];
    const afterFirst = await expectOneSequence(db, home, starts);
    expect(afterFirst.slice(0, beforeKill.length)).toEqual(beforeKill);
    // Separately: the supervisor's own rows, one terminal for the interrupted run, at -seq.
    const own = afterFirst.filter(
      (e) => e.runner_type === SUPERVISOR_RUNNER_TYPE,
    );
    expect(own).toMatchObject([{ kind: "terminal", raw_offset: -1 }]);
    expect(JSON.parse(own[0]?.payload_json ?? "{}")).toMatchObject({
      outcome: "interrupted",
    });

    // Cycle 2: the supervisor dies again, the session idle; the adopt adds no row.
    await kill9(supervisor);
    await vi.waitFor(
      () => expect(isAlive(pidOf(second.executor_ref))).toBe(false),
      WAIT,
    );
    supervisor = startSupervisor(home, 3);
    await ready(db, supervisor);
    const third = await adopted(db, second.executor_ref);
    expect(third.runner_session_id).toBe(first.runner_session_id);
    const afterSecond = await expectOneSequence(db, home, [
      ...starts,
      third.raw_segment_offset ?? -1,
    ]);
    expect(afterSecond).toEqual(afterFirst);

    // A clean stop leaves the runner to end on stdin EOF (it is adopted on the next boot).
    const exited = new Promise((resolve) => supervisor.once("exit", resolve));
    supervisor.kill("SIGTERM");
    await exited;
    await vi.waitFor(
      () => expect(isAlive(pidOf(third.executor_ref))).toBe(false),
      WAIT,
    );
  });
});
